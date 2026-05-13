// =============================================================================
// mealEmbeddings — semantic search support for the legacy `public.meals` table.
//
// Thin wrapper over the shared embedding stack in `services/rag/embeddings.js`:
// every meal gets a 1024-dim `text-embedding-3-large` vector (same model and
// dimension as `public.knowledge_chunks`, controlled by OPENAI_EMBEDDING_MODEL
// + RAG_VECTOR_DIMENSION in `backend/.env`).
//
// Public API:
//   • buildMealEmbeddingText(meal)        — canonical text we embed per meal.
//   • embedMealAndStore(client, mealId)   — write-path hook called inside the
//                                           mealsService transactions.
//   • buildAthleteQueryText(ctx)          — query text composed from V1/V2
//                                           history + prefs + slot.
//   • formatVectorLiteral(values)         — pgvector parameter literal.
//
// None of these throw. Embedding failures are logged + return `false` / `null`
// so a flaky OpenAI call never rolls back a meal write.
// =============================================================================

const { embedQuery } = require("./rag/embeddings");

// ─── helpers ────────────────────────────────────────────────────────────────

function trimStr(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function joinNonEmpty(parts, sep = " · ") {
  return parts
    .map(trimStr)
    .filter((s) => s.length > 0)
    .join(sep);
}

/**
 * pgvector accepts a `vector` parameter either as a balanced array literal
 * string (`[0.12,-0.04,...]`) or via the pg-vector driver. We use the literal
 * form so the existing `pg` driver doesn't need an extra dependency.
 *
 * Same pattern as `services/kez/composer.js#formatVectorLiteral` — kept local
 * here so callers don't need to cross-import between unrelated modules.
 */
function formatVectorLiteral(values) {
  if (!Array.isArray(values)) {
    throw new Error("formatVectorLiteral: expected an array of numbers");
  }
  return `[${values.join(",")}]`;
}

// ─── text shaping ───────────────────────────────────────────────────────────

/**
 * Canonical text we embed per meal. Keep the format stable — backfill and
 * runtime writes both call this so changing it would silently invalidate
 * previously stored vectors.
 *
 * `meal` is a shape with `title`, `description`, `note`, plus optional
 * `categories[]`, `sub_categories[]`, `tags[]`, `foods[]` (any of these may
 * be undefined — only the present pieces are included).
 */
function buildMealEmbeddingText(meal = {}) {
  const title = trimStr(meal.title);
  const description = trimStr(meal.description);
  const note = trimStr(meal.note || meal.blueprint_note);

  const categories = Array.isArray(meal.categories)
    ? meal.categories.map((c) => c?.name || c?.title || "").filter(Boolean)
    : [];
  const subCategories = Array.isArray(meal.sub_categories)
    ? meal.sub_categories.map((s) => s?.title || s?.name || "").filter(Boolean)
    : [];
  const tags = Array.isArray(meal.tags)
    ? meal.tags.map((t) => (typeof t === "string" ? t : t?.name || "")).filter(Boolean)
    : [];
  const foods = Array.isArray(meal.foods)
    ? meal.foods.map((f) => f?.food_name || f?.title || "").filter(Boolean)
    : [];

  return joinNonEmpty(
    [
      title,
      description,
      note,
      categories.length ? `Category: ${categories.join(", ")}` : "",
      subCategories.length ? `Sub: ${subCategories.join(", ")}` : "",
      tags.length ? `Tags: ${tags.join(", ")}` : "",
      foods.length ? `Ingredients: ${foods.join(", ")}` : "",
    ],
    " \n ",
  );
}

/**
 * Build the query text the carousel embeds and passes to `match_meals`.
 *
 * Goal: capture what the athlete actually eats / wants for this slot so the
 * vector search returns a contextually relevant top-N rather than category
 * order. Pulls together:
 *   • slot label / category (so the query has the right "Breakfast" flavour
 *     even though category is also a hard SQL filter — helps the ANN ranking).
 *   • V1 meal_text (what they ate first time) + V2 meal_text (what they tried
 *     in module). Trimmed to ~600 chars each, matching `mealCarouselPost`.
 *   • liked_foods list from prescreen / food_preferences (positive signal).
 *   • macro target band as a short prose hint so the embedding leans toward
 *     meals in the right calorie / protein zone.
 *
 * Returns "" when there's nothing useful — caller should treat empty as
 * "fall back to category-only ordering".
 */
function buildAthleteQueryText({
  slotCategory = null,
  slotLabel = null,
  v1MealText = null,
  v2MealText = null,
  // V3 picks the coach has already sent for this slot. Surfacing them as
  // a soft signal helps the ANN ranking push *adjacent* meals up instead
  // of returning the same picks again. Hard exclusion still happens via
  // `match_meals.exclude_meal_ids`.
  v3MealTexts = [],
  likedFoods = [],
  dislikedFoods = [],
  targetBand = null,
} = {}) {
  const safeLikes = Array.isArray(likedFoods)
    ? likedFoods.map(trimStr).filter(Boolean).slice(0, 25)
    : [];
  const safeDislikes = Array.isArray(dislikedFoods)
    ? dislikedFoods.map(trimStr).filter(Boolean).slice(0, 25)
    : [];
  const safePrev = Array.isArray(v3MealTexts)
    ? v3MealTexts.map(trimStr).filter(Boolean).slice(0, 5)
    : [];

  // Macro band as a one-liner — the embedding picks up "high protein" /
  // "moderate carbs" cues even if exact numbers don't transfer.
  const macroHint = (() => {
    if (!targetBand) return "";
    const parts = [];
    if (Number.isFinite(targetBand.p_low) && Number.isFinite(targetBand.p_high)) {
      parts.push(`protein ${targetBand.p_low}-${targetBand.p_high}g`);
    }
    if (Number.isFinite(targetBand.c_low) && Number.isFinite(targetBand.c_high)) {
      parts.push(`carbs ${targetBand.c_low}-${targetBand.c_high}g`);
    }
    if (Number.isFinite(targetBand.f_low) && Number.isFinite(targetBand.f_high)) {
      parts.push(`fat ${targetBand.f_low}-${targetBand.f_high}g`);
    }
    if (Number.isFinite(targetBand.kcal_low) && Number.isFinite(targetBand.kcal_high)) {
      parts.push(`energy ${targetBand.kcal_low}-${targetBand.kcal_high}kcal`);
    }
    return parts.length ? `Macros: ${parts.join(", ")}` : "";
  })();

  return joinNonEmpty(
    [
      slotCategory ? `Slot: ${trimStr(slotCategory)}` : "",
      slotLabel && slotLabel !== slotCategory ? `Label: ${trimStr(slotLabel)}` : "",
      v1MealText ? `Currently eats: ${trimStr(v1MealText).slice(0, 600)}` : "",
      v2MealText ? `Recently tried: ${trimStr(v2MealText).slice(0, 600)}` : "",
      safePrev.length
        ? `Previously suggested (avoid repeating): ${safePrev.join("; ")}`
        : "",
      safeLikes.length ? `Likes: ${safeLikes.join(", ")}` : "",
      safeDislikes.length ? `Avoids: ${safeDislikes.join(", ")}` : "",
      macroHint,
    ],
    " \n ",
  );
}

// ─── write path ─────────────────────────────────────────────────────────────

/**
 * Load the canonical embedding text for a single meal, joining the same
 * meal_category / meal_sub_category / meal_tag tables `mealsService.shapeMeal`
 * uses. Runs on the supplied client so it's transaction-aware.
 */
async function fetchMealEmbeddingPayload(client, mealId) {
  const mealRes = await client.query(
    `SELECT id, title, description, note FROM public.meals WHERE id = $1 LIMIT 1`,
    [mealId],
  );
  if (!mealRes.rows[0]) return null;
  const meal = mealRes.rows[0];

  const [catsRes, subsRes, tagsRes, foodsRes] = await Promise.all([
    client.query(
      `SELECT c.title AS name
         FROM public.meal_category mc
         JOIN public.categories c ON c.id = mc.category_id
        WHERE mc.meal_id = $1`,
      [mealId],
    ),
    client.query(
      `SELECT sc.title
         FROM public.meal_sub_category msc
         JOIN public.sub_categories sc ON sc.id = msc.sub_category_id
        WHERE msc.meal_id = $1`,
      [mealId],
    ),
    client.query(
      `SELECT t.name
         FROM public.meal_tag mt
         JOIN public.tags t ON t.id = mt.tag_id
        WHERE mt.meal_id = $1`,
      [mealId],
    ),
    client.query(
      `SELECT i.title AS food_name
         FROM public.item_meals im
         LEFT JOIN public.items i ON i.id = im.item_id
        WHERE im.meal_id = $1
        ORDER BY im."order" NULLS LAST, im.id ASC`,
      [mealId],
    ),
  ]);

  return {
    title: meal.title,
    description: meal.description,
    note: meal.note,
    categories: catsRes.rows,
    sub_categories: subsRes.rows,
    tags: tagsRes.rows.map((r) => r.name),
    foods: foodsRes.rows,
  };
}

/**
 * Generate the embedding for a meal and persist it on the same `client`
 * (so it lands in whichever transaction the caller is already running).
 *
 * Returns `true` on success, `false` on any failure. Never throws — write
 * path callers don't want OpenAI flakiness to roll back a legitimate meal
 * save. The next save / backfill picks up rows still missing an embedding.
 */
async function embedMealAndStore(client, mealId) {
  try {
    const payload = await fetchMealEmbeddingPayload(client, mealId);
    if (!payload) return false;

    const text = buildMealEmbeddingText(payload);
    if (!text) return false;

    let vec;
    try {
      vec = await embedQuery(text);
    } catch (err) {
      console.error(`[mealEmbeddings] embedQuery failed for meal ${mealId}:`, err.message || err);
      return false;
    }
    if (!Array.isArray(vec) || vec.length === 0) return false;

    await client.query(
      `UPDATE public.meals SET embedding = $1::vector WHERE id = $2`,
      [formatVectorLiteral(vec), mealId],
    );
    return true;
  } catch (err) {
    console.error(`[mealEmbeddings] embedMealAndStore failed for meal ${mealId}:`, err.message || err);
    return false;
  }
}

module.exports = {
  buildMealEmbeddingText,
  buildAthleteQueryText,
  embedMealAndStore,
  formatVectorLiteral,
};
