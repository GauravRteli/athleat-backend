// =============================================================================
// v3Carousel — Prompt 3 (Run Kez V3 Meal Selection) implementation.
//
// Database-first, AI-second. The flow is:
//   1. Embed an athlete-context query (V1 / V2 history + prefs + slot).
//   2. Pull a wide vector pool from `public.match_meals` (category-hard,
//      dislikes NOT excluded — we only flag).
//   3. Hydrate each candidate's ingredient names from `item_meals` + `items`.
//   4. Re-rank in JS using a weighted blend of cosine sim + V1/V2 ingredient
//      overlap + liked-foods overlap.
//   5. Take the top 10 as the Claude pool.
//   6. Build Prompt 3 verbatim from the v5.2 implementation guide.
//   7. Call Claude once; expect strict JSON of shape
//        { meals: [4], v2_slot, ai_generate_slot }.
//   8. Validate the picked meal_ids exist in the pool; backfill missing fields
//      from the matched row; tag dislikes via substring fallback.
//
// All functions exported here are PURE (no req/res, no controller plumbing) so
// `mealCarouselPost` stays a thin orchestrator and so the test script can
// exercise the pieces in isolation.
// =============================================================================

const { query } = require("../../config/postgres");
const { embedQuery } = require("../rag/embeddings");
const {
  buildAthleteQueryText,
  formatVectorLiteral,
} = require("../mealEmbeddings");
const { callLlmText, extractJsonObject } = require("./llm");

// Ranking weights (sum to 1.0). Tunable — keep these in sync with the
// docstring in the redesign plan.
const W_SIM = 0.55;
const W_OVERLAP = 0.3;
const W_LIKED = 0.15;

// Re-rank pool size and Claude pool size.
const VECTOR_K = 25;
const CLAUDE_POOL_SIZE = 10;
const FINAL_PICK_COUNT = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function lc(s) {
  return String(s || "").trim().toLowerCase();
}

function tokensFromText(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w && w.length >= 3),
  );
}

function ingredientsTokenSet(ingredients) {
  const out = new Set();
  for (const name of ingredients || []) {
    for (const tok of tokensFromText(name)) out.add(tok);
  }
  return out;
}

function intersectionSize(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
}

function kjToKcal(kj) {
  if (!Number.isFinite(Number(kj))) return 0;
  return Math.round(Number(kj) / 4.184);
}

function kcalToKj(kcal) {
  if (!Number.isFinite(Number(kcal))) return 0;
  return Math.round(Number(kcal) * 4.184);
}

// Split a `meal_analysis.meal_text` value ("Title — Description") into the
// same { title, description } shape `mealAnalysisPost` derives. Splitter
// matches the controller (`\s+[—-]\s+`).
function splitMealText(text) {
  const s = String(text || "").trim();
  if (!s) return { title: "", description: "" };
  const parts = s.split(/\s+[—-]\s+/);
  return {
    title: (parts[0] || "").trim(),
    description: (parts.slice(1).join(" — ") || "").trim(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Candidate pool
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bulk-hydrate ingredient lists for the matched meal ids. One round-trip
 * grouped by meal_id so re-ranking can compute overlap scores without N+1
 * queries.
 */
async function fetchIngredientsForMeals(mealIds) {
  if (!Array.isArray(mealIds) || !mealIds.length) return new Map();
  const ids = mealIds.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  if (!ids.length) return new Map();

  const { rows } = await query(
    `SELECT im.meal_id, i.title
       FROM public.item_meals im
       JOIN public.items i ON i.id = im.item_id
      WHERE im.meal_id = ANY($1::bigint[])
      ORDER BY im.meal_id, im."order" NULLS LAST, im.id ASC`,
    [ids],
  );

  const byMeal = new Map();
  for (const r of rows) {
    const k = Number(r.meal_id);
    const arr = byMeal.get(k) || [];
    arr.push(String(r.title || "").trim());
    byMeal.set(k, arr);
  }
  return byMeal;
}

/**
 * Run the vector retrieval + re-rank pipeline. Returns
 *   { pool: top10, leftover: rest, queryText, embedded }.
 *
 * `pool` items carry: id, title, description, macros, tags, ingredients[],
 *                     distance, simScore, overlapScore, likedScore, finalScore.
 */
async function buildCandidatePool({
  category,
  v1MealText = null,
  v2MealText = null,
  v3MealTexts = [],
  likedFoods = [],
  dislikedFoods = [],
  slotLabel = null,
  excludeIds = [],
  targetBand = null,
  vectorK = VECTOR_K,
  poolSize = CLAUDE_POOL_SIZE,
}) {
  const queryText = buildAthleteQueryText({
    slotCategory: category,
    slotLabel: slotLabel && slotLabel !== category ? slotLabel : null,
    v1MealText,
    v2MealText,
    v3MealTexts,
    likedFoods,
    dislikedFoods,
    targetBand,
  });

  console.log(`[v3Carousel] 🔎 vector retrieval (cat="${category}", k=${vectorK})`);
  console.log("[v3Carousel]   ⤷ athlete query text:\n", queryText);

  let matchedRows = [];
  let embedded = false;
  if (queryText) {
    try {
      const vec = await embedQuery(queryText);
      if (Array.isArray(vec) && vec.length) {
        embedded = true;
        // NOTE: empty dislikes array on purpose — Prompt 3 spec says "flag,
        // do NOT exclude". Hard-excluding here would deprive Claude of meals
        // it could otherwise recommend with a substitute.
        const { rows } = await query(
          `SELECT * FROM public.match_meals($1::vector, $2, $3::text[], $4, $5::bigint[])`,
          [
            formatVectorLiteral(vec),
            category || null,
            [], // disliked_foods → empty so they SURFACE for flagging
            vectorK,
            (excludeIds || []).map(Number).filter(Number.isFinite),
          ],
        );
        matchedRows = rows || [];
        console.log(`[v3Carousel]   ✓ match_meals returned ${matchedRows.length} rows`);
      }
    } catch (e) {
      console.error("[v3Carousel]   ✗ match_meals failed:", e.message || e);
    }
  }

  // Hydrate ingredient lists for every matched row up-front so re-ranking
  // can compute overlap without N+1.
  const ids = matchedRows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
  const ingredientsByMeal = await fetchIngredientsForMeals(ids);

  // Token sets for re-rank scoring.
  const v1Tokens = tokensFromText(v1MealText || "");
  const v2Tokens = tokensFromText(v2MealText || "");
  const eatenTokens = new Set([...v1Tokens, ...v2Tokens]);
  const likedTokens = new Set(
    (likedFoods || []).flatMap((f) => [...tokensFromText(f)]),
  );
  const dislikedLc = (dislikedFoods || []).map(lc).filter(Boolean);

  const scored = matchedRows.map((row) => {
    const mealId = Number(row.id);
    const ingredients = ingredientsByMeal.get(mealId) || [];
    const ingredientTokens = ingredientsTokenSet(ingredients);

    // `match_meals` already orders by `embedding <=> query` ASC, but only
    // returns the literal columns — distance itself isn't exposed. We
    // synthesise a sim score from rank: top row gets ~1, the row at index
    // (vectorK-1) gets ~0. This matches the formula given in the plan
    // closely enough for re-ranking.
    const rankIndex = matchedRows.indexOf(row);
    const simScore = Math.max(0, 1 - rankIndex / Math.max(1, vectorK - 1));

    const overlapScore = Math.min(
      1,
      intersectionSize(ingredientTokens, eatenTokens) / 5,
    );
    const likedScore = Math.min(
      1,
      intersectionSize(ingredientTokens, likedTokens) / 3,
    );
    const finalScore =
      W_SIM * simScore + W_OVERLAP * overlapScore + W_LIKED * likedScore;

    const { flag: dislikedFlag, substitute: dislikedSubstitute } = detectDisliked(
      ingredients,
      dislikedLc,
    );

    return {
      id: mealId,
      title: row.title,
      description: row.description || "",
      protein_g: round1(row.protein_g),
      carb_g: round1(row.carb_g),
      fat_g: round1(row.fat_g),
      energy_kj: round1(row.energy_kj),
      energy_kcal: kjToKcal(row.energy_kj),
      tags: Array.isArray(row.tags) ? row.tags : [],
      ingredients,
      simScore: round1(simScore * 100) / 100,
      overlapScore: round1(overlapScore * 100) / 100,
      likedScore: round1(likedScore * 100) / 100,
      finalScore: round1(finalScore * 100) / 100,
      disliked_flag: dislikedFlag,
      disliked_substitute: dislikedSubstitute,
    };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);
  const pool = scored.slice(0, poolSize);
  const leftover = scored.slice(poolSize);

  if (pool.length) {
    console.log("[v3Carousel]   ⤷ re-ranked top pool:");
    pool.forEach((p, i) => {
      console.log(
        `      ${String(i + 1).padStart(2, " ")}. id=${p.id} score=${p.finalScore} sim=${p.simScore} overlap=${p.overlapScore} liked=${p.likedScore} ${p.disliked_flag ? `[dislike:${p.disliked_flag}]` : ""} — ${p.title}`,
      );
    });
  } else {
    console.log("[v3Carousel]   ⤷ pool is empty — caller should fall back");
  }

  return { pool, leftover, queryText, embedded };
}

/**
 * Substring-based disliked detection. Returns { flag, substitute } where
 * `flag` is the ingredient name (as stored in items.title) and `substitute`
 * is a naive replacement hint. The intent is to surface the conflict so
 * Kerry edits the ingredient — never to filter the meal out.
 */
function detectDisliked(ingredients, dislikedLc) {
  if (!Array.isArray(ingredients) || !dislikedLc?.length) {
    return { flag: null, substitute: null };
  }
  for (const ingredient of ingredients) {
    const ingLc = lc(ingredient);
    for (const d of dislikedLc) {
      if (ingLc.includes(d)) {
        return {
          flag: ingredient,
          substitute: suggestSubstitute(d),
        };
      }
    }
  }
  return { flag: null, substitute: null };
}

// Lightweight substitute hints used only as a fallback when Claude doesn't
// supply one. Kerry always edits the ingredient by hand — this is just so the
// UI shows something useful next to the amber flag.
const FALLBACK_SUBSTITUTES = {
  mushroom: "baby spinach",
  mushrooms: "baby spinach",
  egg: "Greek yoghurt",
  eggs: "Greek yoghurt",
  fish: "chicken",
  salmon: "chicken",
  tuna: "chicken",
  tomato: "capsicum",
  tomatoes: "capsicum",
  onion: "spring onion",
  cheese: "feta",
  milk: "almond milk",
  peanut: "almond",
  peanuts: "almond",
  yoghurt: "cottage cheese",
};
function suggestSubstitute(disliked) {
  if (!disliked) return null;
  const k = lc(disliked);
  return FALLBACK_SUBSTITUTES[k] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Prompt 3 — verbatim from the v5.2 implementation guide
// ─────────────────────────────────────────────────────────────────────────────

function poolToVerifiedMealsBlock(pool) {
  if (!pool.length) return "(no verified meals available for this slot/category)";
  return pool
    .map((p) => {
      const kcal = p.energy_kcal || kjToKcal(p.energy_kj);
      const kj = Math.round(p.energy_kj);
      return `id=${p.id} | ${p.title} | P:${p.protein_g}g C:${p.carb_g}g F:${p.fat_g}g | ${kcal} cal (${kj} kJ)`;
    })
    .join("\n");
}

function buildPrompt3({
  athlete,
  prefs,
  slot,
  v1,
  v2,
  band,
  pool,
}) {
  const firstName = athlete.firstName || "Athlete";
  const lastName = athlete.lastName || "";
  const sex = athlete.sex || "Male";
  const weight = athlete.weight || "?";
  const height = athlete.height || "?";
  const age = athlete.age || "?";
  const goal = prefs.goal || "performance";
  const loadType = prefs.loadType || "moderate";

  const likedStr = Array.isArray(prefs.liked) && prefs.liked.length
    ? prefs.liked.join(", ")
    : "(none specified)";
  const dislikedStr = Array.isArray(prefs.disliked) && prefs.disliked.length
    ? prefs.disliked.join(", ")
    : "(none specified)";

  const missionLabel = slot.missionLabel || slot.label || "Meal";
  const slotLabel = slot.label || "Meal";

  const v1Title = v1.title || "(not provided)";
  const v1Desc = v1.description || "(not provided)";
  const v2Title = v2.title || "(not provided)";
  const v2Desc = v2.description || "(not provided)";

  const slotKcalLow = band?.kcal_low ?? "?";
  const slotKcalHigh = band?.kcal_high ?? "?";
  const slotKjLow = band?.kj_low ?? "?";
  const slotKjHigh = band?.kj_high ?? "?";
  const slotPLow = band?.p_low ?? "?";
  const slotPHigh = band?.p_high ?? "?";
  const slotCLow = band?.c_low ?? "?";
  const slotCHigh = band?.c_high ?? "?";

  return [
    "You are Virtual Kez. Kerry is selecting Version 3 meals for this athlete's mission slot.",
    "",
    `ATHLETE: ${firstName}${lastName ? ` ${lastName}` : ""}, ${sex}, ${weight}kg, ${height}cm, ${age}yo, rugby league.`,
    `Goal: ${goal}  -- weight_gain or weight_loss`,
    `Training load: ${loadType}  -- high, moderate, or low`,
    `Liked foods: ${likedStr}`,
    `Disliked foods: ${dislikedStr}  -- flag only, do not exclude the meal`,
    "",
    `MISSION SLOT: ${missionLabel} - ${slotLabel}`,
    `V1 (current meal): ${v1Title} - ${v1Desc}`,
    `V2 (improved attempt): ${v2Title} - ${v2Desc}`,
    "",
    "MEAL SPLIT TARGET FOR THIS SLOT:",
    `Energy target: ${slotKcalLow}-${slotKcalHigh} kcal (${slotKjLow}-${slotKjHigh} kJ)`,
    `Protein target: ${slotPLow}-${slotPHigh}g`,
    `Carb target: ${slotCLow}-${slotCHigh}g`,
    "(Kerry will adjust portions after selection - these are reference targets only)",
    "",
    `VERIFIED MEALS FROM DATABASE (${slotLabel} only, ranked by similarity to V1+V2 and ingredient overlap):`,
    poolToVerifiedMealsBlock(pool),
    "",
    "Return exactly this JSON structure - no other text:",
    "{",
    '  "meals": [',
    "    {",
    '      "meal_id": "[id from the list above]",',
    '      "title": "[meal title]",',
    '      "description": "[one sentence why this works for this athlete]",',
    '      "blueprint_note": "[one sentence Kerry coaching note for the athlete]",',
    '      "disliked_flag": "[ingredient name if a disliked food is in this meal, else null]",',
    '      "disliked_substitute": "[suggested replacement ingredient, else null]",',
    '      "slot_energy_kcal": [number],',
    '      "slot_energy_kj": [number],',
    '      "protein_g": [number],',
    '      "carb_g": [number],',
    '      "fat_g": [number]',
    "    }",
    "  ],",
    '  "v2_slot": {',
    '    "title": "[athlete v2 meal title]",',
    '    "description": "[v2 desc]",',
    '    "note": "Your V2 attempt - kept here for reference"',
    "  },",
    '  "ai_generate_slot": {',
    '    "prompt": "[a short prompt Gaurav can pass to DALL-E to generate a meal image]"',
    "  }",
    "}",
    "",
    "RULES:",
    `- Return ${FINAL_PICK_COUNT} meals from the verified database above + 1 v2_slot + 1 ai_generate_slot`,
    `- Pick by id only from the VERIFIED MEALS list — do NOT invent meal_ids`,
    "- Same meal category always - never change the type",
    "- Small swaps, not overhauls - find a better version of what they already eat",
    "- If a meal contains a disliked food: include the meal, set disliked_flag and disliked_substitute",
    "- EER targets are reference only - Kerry edits portions manually",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Response parsing + validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strict JSON parse of Claude's response. Validates every picked meal_id
 * exists in the pool; backfills missing numeric fields from the pool row;
 * normalises dislike flags. Throws when shape is unrecoverable so the
 * controller can fall back to the deterministic top-4.
 */
function parsePrompt3Response(raw, pool) {
  const text = String(raw || "").trim();
  const jsonStr = extractJsonObject(text) || text;
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Prompt 3 response is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Prompt 3 response is not a JSON object");
  }

  const poolById = new Map(pool.map((p) => [Number(p.id), p]));

  const meals = Array.isArray(parsed.meals) ? parsed.meals : [];
  const picked = [];
  const seen = new Set();
  for (const m of meals) {
    if (!m || typeof m !== "object") continue;
    const mealId = Number(m.meal_id);
    if (!Number.isFinite(mealId)) continue;
    if (seen.has(mealId)) continue;
    const poolRow = poolById.get(mealId);
    if (!poolRow) continue; // Claude hallucinated an id — drop it.
    seen.add(mealId);
    picked.push(mergePick(m, poolRow));
    if (picked.length >= FINAL_PICK_COUNT) break;
  }

  // Backfill with the top-ranked pool rows that weren't already picked, so
  // we always return FINAL_PICK_COUNT cards even if Claude returns fewer.
  if (picked.length < FINAL_PICK_COUNT) {
    for (const p of pool) {
      if (picked.length >= FINAL_PICK_COUNT) break;
      if (seen.has(Number(p.id))) continue;
      picked.push(mergePick({ meal_id: p.id }, p));
      seen.add(Number(p.id));
    }
  }

  return {
    meals: picked,
    v2_slot: normaliseV2Slot(parsed.v2_slot),
    ai_generate_slot: normaliseAiSlot(parsed.ai_generate_slot),
  };
}

function mergePick(claudePick, poolRow) {
  const proteinG = Number(claudePick.protein_g);
  const carbG = Number(claudePick.carb_g);
  const fatG = Number(claudePick.fat_g);
  const slotKcal = Number(claudePick.slot_energy_kcal);
  const slotKj = Number(claudePick.slot_energy_kj);

  return {
    meal_id: Number(poolRow.id),
    title: String(claudePick.title || poolRow.title || ""),
    description: String(claudePick.description || poolRow.description || ""),
    blueprint_note: String(claudePick.blueprint_note || ""),
    disliked_flag: claudePick.disliked_flag === null || claudePick.disliked_flag === undefined
      ? poolRow.disliked_flag || null
      : String(claudePick.disliked_flag).trim() || null,
    disliked_substitute:
      claudePick.disliked_substitute === null ||
      claudePick.disliked_substitute === undefined
        ? poolRow.disliked_substitute || null
        : String(claudePick.disliked_substitute).trim() || null,
    slot_energy_kcal: Number.isFinite(slotKcal) && slotKcal > 0
      ? slotKcal
      : poolRow.energy_kcal || kjToKcal(poolRow.energy_kj),
    slot_energy_kj: Number.isFinite(slotKj) && slotKj > 0
      ? slotKj
      : poolRow.energy_kj || kcalToKj(poolRow.energy_kcal),
    protein_g: Number.isFinite(proteinG) ? proteinG : poolRow.protein_g,
    carb_g: Number.isFinite(carbG) ? carbG : poolRow.carb_g,
    fat_g: Number.isFinite(fatG) ? fatG : poolRow.fat_g,
  };
}

function normaliseV2Slot(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    title: String(raw.title || "").trim() || null,
    description: String(raw.description || "").trim() || null,
    note: String(raw.note || "Your V2 attempt - kept here for reference").trim(),
  };
}

function normaliseAiSlot(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    prompt: String(raw.prompt || "").trim() || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Top-level orchestrator (LLM + fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Call Claude with Prompt 3 and parse the result. On any failure
 * (LLM error, malformed JSON, empty meals[]) returns the deterministic
 * top-4 from the pool — never throws to the caller.
 */
async function runPrompt3({ athlete, prefs, slot, v1, v2, band, pool }) {
  if (!pool.length) {
    return {
      meals: [],
      v2_slot: makeFallbackV2Slot(v2),
      ai_generate_slot: makeFallbackAiSlot({ slot, v1, v2, prefs }),
      source: "empty_pool",
      raw: null,
    };
  }

  const prompt = buildPrompt3({ athlete, prefs, slot, v1, v2, band, pool });
  console.log("[v3Carousel] 📝 Prompt 3 length =", prompt.length, "chars");

  let raw = "";
  try {
    raw = await callLlmText(prompt, {
      system:
        "You are Virtual Kez. Return STRICT JSON only — no markdown, no code fences, no commentary.",
      json: true,
    });
    console.log("[v3Carousel]   ✓ Claude responded, length =", raw.length, "chars");
  } catch (e) {
    console.error("[v3Carousel]   ✗ Claude call failed:", e.message || e);
    return {
      ...buildFallbackResponse({ pool, v1, v2, slot, prefs }),
      source: "claude_error",
      raw: null,
    };
  }

  try {
    const parsed = parsePrompt3Response(raw, pool);
    return {
      ...parsed,
      v2_slot: parsed.v2_slot || makeFallbackV2Slot(v2),
      ai_generate_slot:
        parsed.ai_generate_slot || makeFallbackAiSlot({ slot, v1, v2, prefs }),
      source: "claude",
      raw,
    };
  } catch (e) {
    console.error("[v3Carousel]   ✗ Prompt 3 parse failed:", e.message || e);
    return {
      ...buildFallbackResponse({ pool, v1, v2, slot, prefs }),
      source: "parse_error",
      raw,
    };
  }
}

function buildFallbackResponse({ pool, v1, v2, slot, prefs }) {
  const meals = pool.slice(0, FINAL_PICK_COUNT).map((p) => ({
    meal_id: Number(p.id),
    title: p.title,
    description: p.description || "",
    blueprint_note: "",
    disliked_flag: p.disliked_flag || null,
    disliked_substitute: p.disliked_substitute || null,
    slot_energy_kcal: p.energy_kcal || kjToKcal(p.energy_kj),
    slot_energy_kj: p.energy_kj,
    protein_g: p.protein_g,
    carb_g: p.carb_g,
    fat_g: p.fat_g,
  }));
  return {
    meals,
    v2_slot: makeFallbackV2Slot(v2),
    ai_generate_slot: makeFallbackAiSlot({ slot, v1, v2, prefs }),
  };
}

function makeFallbackV2Slot(v2) {
  if (!v2 || (!v2.title && !v2.description)) return null;
  return {
    title: v2.title || "Your V2 attempt",
    description: v2.description || "",
    note: "Your V2 attempt - kept here for reference",
  };
}

function makeFallbackAiSlot({ slot, v1, v2, prefs }) {
  const label = slot?.label || "meal";
  const liked = (prefs?.liked || []).slice(0, 3).join(", ");
  const sourceText =
    v2?.description || v1?.description || (liked ? `featuring ${liked}` : "");
  return {
    prompt:
      `Photorealistic plate of a high-performance rugby league athlete's ${label}` +
      (sourceText ? ` — ${sourceText}` : "") +
      `. Natural daylight, top-down, simple white ceramic plate, no garnish overload.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  buildCandidatePool,
  buildPrompt3,
  parsePrompt3Response,
  runPrompt3,
  detectDisliked,
  splitMealText,
  // Constants exported for the test script.
  W_SIM,
  W_OVERLAP,
  W_LIKED,
  VECTOR_K,
  CLAUDE_POOL_SIZE,
  FINAL_PICK_COUNT,
};
