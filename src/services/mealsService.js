// =============================================================================
// mealsService — adapter onto the legacy bigserial `public.meals` table.
//
// Reads aggregate macros from `public.item_meals` and joins to `public.items`
// for ingredient names. Categories / sub-categories / tags come from the
// `meal_category`, `meal_sub_category`, `meal_tag` join tables.
//
// Dashboard-only fields are mapped onto existing legacy columns:
//   blueprint_note  → public.meals.note
//   image_url       → public.meals.image
// No schema changes are made (per user instruction — use existing columns only).
// =============================================================================

const { pool, query } = require("../config/postgres");

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const parseEnergy = (val) => {
  if (val === null || val === undefined) return null;
  const m = String(val).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

function totalsFromIngredients(rows) {
  return rows.reduce(
    (acc, r) => ({
      energy_kj: acc.energy_kj + (parseEnergy(r.energy) || 0),
      protein_g: acc.protein_g + (num(r.protein) || 0),
      carb_g:    acc.carb_g    + (num(r.carbs)   || 0),
      fat_g:     acc.fat_g     + (num(r.fat)     || 0),
    }),
    { energy_kj: 0, protein_g: 0, carb_g: 0, fat_g: 0 },
  );
}

function shapeFood(row) {
  return {
    id: row.id,
    meal_id: row.meal_id,
    item_id: row.item_id,
    food_id: row.item_id,
    food_name: row.item_title || row.title || `Item #${row.item_id}`,
    weight_g: num(row.item_qty),
    weight_grams: num(row.item_qty),
    qty: row.item_qty,
    unit: row.item_qty_unit,
    energy_kj: parseEnergy(row.energy),
    protein_g: num(row.protein),
    carb_g: num(row.carbs),
    fat_g: num(row.fat),
    selected_qty_unit: row.selected_qty_unit,
    sort_order: row.order,
    image: row.item_image,
  };
}

function shapeMeal(row, foods = [], categories = [], subCategories = [], tags = []) {
  const totals = totalsFromIngredients(
    foods.map((f) => ({
      energy: f.energy_kj != null ? `${f.energy_kj}kJ` : null,
      protein: f.protein_g,
      carbs: f.carb_g,
      fat: f.fat_g,
    })),
  );
  const energy_kcal =
    totals.energy_kj != null ? Math.round(totals.energy_kj / 4.184) : null;

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    blueprint_note: row.note,        // legacy meals.note doubles as Kerry's blueprint note
    note: row.note,
    instructions: null,              // not stored in legacy schema
    image_url: row.image,
    image: row.image,
    image_prompt: null,              // not stored in legacy schema
    user_id: row.user_id,
    source: row.user_id ? "user" : "kerry",
    is_active: true,
    energy_kj: Math.round(totals.energy_kj),
    energy_kcal,
    protein_g: Math.round(totals.protein_g * 10) / 10,
    carb_g: Math.round(totals.carb_g * 10) / 10,
    fat_g: Math.round(totals.fat_g * 10) / 10,
    totals: {
      energy_kj: Math.round(totals.energy_kj),
      protein_g: Math.round(totals.protein_g * 10) / 10,
      carb_g: Math.round(totals.carb_g * 10) / 10,
      fat_g: Math.round(totals.fat_g * 10) / 10,
    },
    categories,
    sub_categories: subCategories,
    tags,
    category: categories[0]?.name || null,           // back-compat: surface first cat as `category`
    sub_category: subCategories[0]?.title || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    foods,
  };
}

async function fetchMealFoods(mealId, client = null) {
  const exec = client ? client.query.bind(client) : query;
  const result = await exec(
    `SELECT im.*, i.title AS item_title, i.image AS item_image
       FROM public.item_meals im
       LEFT JOIN public.items i ON i.id = im.item_id
       WHERE im.meal_id = $1
       ORDER BY im."order" NULLS LAST, im.id ASC`,
    [mealId],
  );
  return result.rows.map(shapeFood);
}

async function fetchMealCategories(mealId, client = null) {
  const exec = client ? client.query.bind(client) : query;
  const result = await exec(
    `SELECT fc.id, fc.name
       FROM public.meal_category mc
       JOIN public.food_categories fc ON fc.id = mc.category_id
      WHERE mc.meal_id = $1
      ORDER BY fc.name`,
    [mealId],
  );
  return result.rows;
}

async function fetchMealSubCategories(mealId, client = null) {
  const exec = client ? client.query.bind(client) : query;
  const result = await exec(
    `SELECT sc.id, sc.title, sc.image
       FROM public.meal_sub_category msc
       JOIN public.sub_categories sc ON sc.id = msc.sub_category_id
      WHERE msc.meal_id = $1
      ORDER BY sc.title`,
    [mealId],
  );
  return result.rows;
}

async function fetchMealTags(mealId, client = null) {
  const exec = client ? client.query.bind(client) : query;
  const result = await exec(
    `SELECT t.id, t.name, t.icon
       FROM public.meal_tag mt
       JOIN public.tags t ON t.id = mt.tag_id
      WHERE mt.meal_id = $1
      ORDER BY t.name`,
    [mealId],
  );
  return result.rows;
}

async function getMealById(id, client = null) {
  const exec = client ? client.query.bind(client) : query;
  const mealRes = await exec(`SELECT * FROM public.meals WHERE id = $1 LIMIT 1`, [id]);
  if (!mealRes.rows[0]) return null;
  const [foods, categories, subCategories, tags] = await Promise.all([
    fetchMealFoods(id, client),
    fetchMealCategories(id, client),
    fetchMealSubCategories(id, client),
    fetchMealTags(id, client),
  ]);
  return shapeMeal(mealRes.rows[0], foods, categories, subCategories, tags);
}

async function listMeals({
  category,
  categoryId,
  subCategoryId,
  search,
  itemIds,
  limit = 200,
} = {}) {
  const conditions = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`m.title ILIKE $${params.length}`);
  }
  if (category) {
    params.push(category);
    conditions.push(
      `EXISTS (
         SELECT 1 FROM public.meal_category mc
         JOIN public.food_categories fc ON fc.id = mc.category_id
         WHERE mc.meal_id = m.id AND fc.name = $${params.length}
       )`,
    );
  }
  // Filter by category id via the meal_category join table (UI dropdown).
  if (categoryId) {
    params.push(Number(categoryId));
    conditions.push(
      `EXISTS (
         SELECT 1 FROM public.meal_category mc
         WHERE mc.meal_id = m.id AND mc.category_id = $${params.length}
       )`,
    );
  }
  // Filter by sub-category id via the meal_sub_category join table.
  if (subCategoryId) {
    params.push(Number(subCategoryId));
    conditions.push(
      `EXISTS (
         SELECT 1 FROM public.meal_sub_category msc
         WHERE msc.meal_id = m.id AND msc.sub_category_id = $${params.length}
       )`,
    );
  }
  // Filter by ingredient ids — AND semantics: the meal must include ALL of
  // the requested items via the `item_meals` join table.
  const cleanItemIds = cleanIds(itemIds);
  if (cleanItemIds && cleanItemIds.length) {
    params.push(cleanItemIds);
    const countIdx = params.length;
    conditions.push(
      `m.id IN (
         SELECT im.meal_id
           FROM public.item_meals im
          WHERE im.item_id = ANY($${countIdx}::bigint[])
          GROUP BY im.meal_id
         HAVING COUNT(DISTINCT im.item_id) = ${cleanItemIds.length}
       )`,
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(Math.min(Number(limit) || 200, 500));
  const result = await query(
    `SELECT m.*
       FROM public.meals m
       ${where}
      ORDER BY m.created_at DESC NULLS LAST, m.id DESC
      LIMIT $${params.length}`,
    params,
  );

  // Fetch foods/categories/subs/tags in batch to avoid N+1 round-trips.
  const ids = result.rows.map((r) => r.id);
  if (!ids.length) return [];

  const [foodsRes, catsRes, subsRes, tagsRes] = await Promise.all([
    query(
      `SELECT im.*, i.title AS item_title, i.image AS item_image
         FROM public.item_meals im
         LEFT JOIN public.items i ON i.id = im.item_id
        WHERE im.meal_id = ANY($1::bigint[])
        ORDER BY im.meal_id, im."order" NULLS LAST, im.id ASC`,
      [ids],
    ),
    query(
      `SELECT mc.meal_id, fc.id, fc.name
         FROM public.meal_category mc
         JOIN public.food_categories fc ON fc.id = mc.category_id
        WHERE mc.meal_id = ANY($1::bigint[])`,
      [ids],
    ),
    query(
      `SELECT msc.meal_id, sc.id, sc.title, sc.image
         FROM public.meal_sub_category msc
         JOIN public.sub_categories sc ON sc.id = msc.sub_category_id
        WHERE msc.meal_id = ANY($1::bigint[])`,
      [ids],
    ),
    query(
      `SELECT mt.meal_id, t.id, t.name, t.icon
         FROM public.meal_tag mt
         JOIN public.tags t ON t.id = mt.tag_id
        WHERE mt.meal_id = ANY($1::bigint[])`,
      [ids],
    ),
  ]);

  const foodsByMeal = new Map();
  for (const r of foodsRes.rows) {
    const arr = foodsByMeal.get(r.meal_id) || [];
    arr.push(shapeFood(r));
    foodsByMeal.set(r.meal_id, arr);
  }
  const groupBy = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const arr = m.get(r.meal_id) || [];
      const { meal_id: _mid, ...rest } = r;
      arr.push(rest);
      m.set(r.meal_id, arr);
    }
    return m;
  };
  const catsByMeal = groupBy(catsRes.rows);
  const subsByMeal = groupBy(subsRes.rows);
  const tagsByMeal = groupBy(tagsRes.rows);

  return result.rows.map((row) =>
    shapeMeal(
      row,
      foodsByMeal.get(row.id) || [],
      catsByMeal.get(row.id) || [],
      subsByMeal.get(row.id) || [],
      tagsByMeal.get(row.id) || [],
    ),
  );
}

// ── Resolve the items.id for a given ingredient. If a payload provides a
// `food_id`/`item_id` we trust it; otherwise we case-insensitively match by
// title. If still no match, we insert a minimal items row (per-100g macros).
async function ensureItemId(client, food) {
  const explicit = food.item_id || food.food_id || food.id;
  if (explicit) {
    const r = await client.query("SELECT id FROM public.items WHERE id = $1", [explicit]);
    if (r.rows[0]) return r.rows[0].id;
  }
  if (food.food_name || food.title) {
    const name = food.food_name || food.title;
    const r = await client.query(
      "SELECT id FROM public.items WHERE LOWER(title) = LOWER($1) LIMIT 1",
      [name],
    );
    if (r.rows[0]) return r.rows[0].id;
    const energyKj = num(food.energy_kj);
    const ins = await client.query(
      `INSERT INTO public.items
         (title, protein, carbs, fat, energy, serving_size, serving_size_unit, image)
       VALUES ($1,$2,$3,$4,$5,$6,'g',$7)
       RETURNING id`,
      [
        name,
        num(food.protein_g) || 0,
        num(food.carb_g) || 0,
        num(food.fat_g) || 0,
        energyKj != null ? `${energyKj}kJ` : null,
        num(food.weight_g || food.weight_grams) ? String(num(food.weight_g || food.weight_grams)) : null,
        food.image || null,
      ],
    );
    return ins.rows[0].id;
  }
  throw new Error("ingredient must have item_id or food_name");
}

// Helper: clean an id array — coerce to numbers, drop nulls/dupes.
function cleanIds(arr) {
  if (!Array.isArray(arr)) return null;
  return Array.from(
    new Set(arr.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)),
  );
}

async function replaceMealJoins(client, mealId, payload) {
  // Each block: one DELETE + one bulk INSERT via UNNEST. Cuts ~2N round-trips
  // down to a constant 6 (DELETE + INSERT × 3 join tables) regardless of how
  // many categories / sub-categories / tags are attached.
  const cats = cleanIds(payload.category_ids);
  const subs = cleanIds(payload.sub_category_ids);
  const tagIds = cleanIds(payload.tag_ids);

  if (cats !== null) {
    await client.query("DELETE FROM public.meal_category WHERE meal_id = $1", [mealId]);
    if (cats.length) {
      await client.query(
        `INSERT INTO public.meal_category (meal_id, category_id)
         SELECT $1, UNNEST($2::bigint[])`,
        [mealId, cats],
      );
    }
  }
  if (subs !== null) {
    await client.query("DELETE FROM public.meal_sub_category WHERE meal_id = $1", [mealId]);
    if (subs.length) {
      await client.query(
        `INSERT INTO public.meal_sub_category (meal_id, sub_category_id)
         SELECT $1, UNNEST($2::bigint[])`,
        [mealId, subs],
      );
    }
  }
  if (tagIds !== null) {
    await client.query("DELETE FROM public.meal_tag WHERE meal_id = $1", [mealId]);
    if (tagIds.length) {
      await client.query(
        `INSERT INTO public.meal_tag (meal_id, tag_id)
         SELECT $1, UNNEST($2::bigint[])`,
        [mealId, tagIds],
      );
    }
  }
}

// Resolve the macros to store on item_meals for a given ingredient row.
// If the payload already provides macros, use them.
// Otherwise look up the parent items row and scale per-serving macros by
// (target weight / item.serving_size).
async function resolveIngredientMacros(client, food, itemId) {
  const provided = {
    protein: food.protein_g != null ? num(food.protein_g) : null,
    carbs: food.carb_g != null ? num(food.carb_g) : null,
    fat: food.fat_g != null ? num(food.fat_g) : null,
    energyKj: food.energy_kj != null ? num(food.energy_kj) : null,
  };
  const allProvided =
    provided.protein != null &&
    provided.carbs != null &&
    provided.fat != null &&
    provided.energyKj != null;
  if (allProvided) return provided;

  // Look up item's per-serving macros
  const r = await client.query(
    `SELECT protein, carbs, fat, energy, serving_size
       FROM public.items
       WHERE id = $1`,
    [itemId],
  );
  const item = r.rows[0];
  if (!item) return provided;

  const targetWeight = num(food.weight_g ?? food.weight_grams ?? food.qty);
  const servingSize = num(item.serving_size) || 100;
  const ratio = targetWeight > 0 && servingSize > 0 ? targetWeight / servingSize : 1;

  const itemEnergyKj = (() => {
    if (item.energy == null) return null;
    const m = String(item.energy).match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  })();

  return {
    protein: provided.protein ?? +(num(item.protein) * ratio).toFixed(2),
    carbs: provided.carbs ?? +(num(item.carbs) * ratio).toFixed(2),
    fat: provided.fat ?? +(num(item.fat) * ratio).toFixed(2),
    energyKj: provided.energyKj ?? (itemEnergyKj != null ? Math.round(itemEnergyKj * ratio) : null),
  };
}

// ── Helpers used by the fast-path bulk insert below. ───────────────────────
function ingredientWeightStr(f) {
  if (f.weight_g != null) return String(num(f.weight_g));
  if (f.weight_grams != null) return String(num(f.weight_grams));
  if (f.qty != null) return String(f.qty);
  return null;
}

function ingredientSelectedUnit(f) {
  if (!f.selected_qty_unit) return null;
  return typeof f.selected_qty_unit === "string"
    ? f.selected_qty_unit
    : JSON.stringify(f.selected_qty_unit);
}

// Quick check: payload supplies an explicit item_id and complete macros, so
// we can skip the per-row SELECT/INSERT dance in `ensureItemId` /
// `resolveIngredientMacros` and emit one bulk INSERT.
function canFastInsertIngredient(f) {
  const idOk = (f.item_id || f.food_id || f.id) != null;
  const macrosOk =
    f.protein_g != null &&
    f.carb_g != null &&
    f.fat_g != null &&
    f.energy_kj != null;
  return idOk && macrosOk;
}

// Bulk-insert all ingredients in one round-trip when every row qualifies.
// Uses parallel arrays + UNNEST so any list size is a single statement.
async function bulkInsertItemMeals(client, mealId, foods, idOverrides = null) {
  if (!foods.length) return;
  const itemIds = foods.map((f, i) => Number(idOverrides?.[i] ?? f.item_id ?? f.food_id ?? f.id));
  const orders  = foods.map((_f, i) => i);
  const qtys    = foods.map((f) => ingredientWeightStr(f));
  const units   = foods.map((f) => f.unit || f.weight_unit || "g");
  const carbs   = foods.map((f) => num(f.carb_g) ?? 0);
  const prots   = foods.map((f) => num(f.protein_g) ?? 0);
  const fats    = foods.map((f) => num(f.fat_g) ?? 0);
  const energies = foods.map((f) => (f.energy_kj != null ? `${num(f.energy_kj)}kJ` : null));
  const selUnits = foods.map((f) => ingredientSelectedUnit(f));

  await client.query(
    `INSERT INTO public.item_meals
       (item_id, meal_id, "order", item_qty, item_qty_unit,
        carbs, protein, fat, energy, selected_qty_unit)
     SELECT iid, $1, ord, qty, unit, c, p, f, e, to_jsonb(sel)
     FROM UNNEST(
       $2::bigint[],
       $3::int[],
       $4::text[],
       $5::text[],
       $6::numeric[],
       $7::numeric[],
       $8::numeric[],
       $9::text[],
       $10::text[]
     ) AS u(iid, ord, qty, unit, c, p, f, e, sel)`,
    [mealId, itemIds, orders, qtys, units, carbs, prots, fats, energies, selUnits],
  );
}

// Replace the meal's ingredient rows. Fast path: when every food carries an
// explicit item_id and macros (the LibraryPanel save flow), one DELETE + one
// bulk INSERT covers everything. Slow path falls back to the original
// per-row resolve loop for legacy callers (V3 carousel / AI) that may pass
// `food_name` only.
async function replaceMealFoods(client, mealId, foods) {
  await client.query("DELETE FROM public.item_meals WHERE meal_id = $1", [mealId]);
  if (!foods.length) return;

  if (foods.every(canFastInsertIngredient)) {
    await bulkInsertItemMeals(client, mealId, foods);
    return;
  }

  // Slow path — resolve per-row, but still emit a single bulk INSERT at the
  // end so we only pay one round-trip for the actual write.
  const resolvedItemIds = [];
  for (const f of foods) {
    resolvedItemIds.push(await ensureItemId(client, f));
  }
  // Fill any missing macros using the items table (per-serving × ratio).
  const filledFoods = [];
  for (let i = 0; i < foods.length; i++) {
    const f = foods[i];
    const macros = await resolveIngredientMacros(client, f, resolvedItemIds[i]);
    filledFoods.push({
      ...f,
      protein_g: macros.protein != null ? macros.protein : 0,
      carb_g: macros.carbs != null ? macros.carbs : 0,
      fat_g: macros.fat != null ? macros.fat : 0,
      energy_kj: macros.energyKj != null ? macros.energyKj : null,
    });
  }
  await bulkInsertItemMeals(client, mealId, filledFoods, resolvedItemIds);
}

async function createMeal(payload) {
  const foods = Array.isArray(payload.foods) ? payload.foods : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const mealRes = await client.query(
      `INSERT INTO public.meals (title, image, description, note, user_id)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        payload.title,
        payload.image_url || payload.image || null,
        payload.description || null,
        payload.blueprint_note || payload.blueprintNote || payload.note || null,
        payload.user_id || null,
      ],
    );
    const meal = mealRes.rows[0];

    if (foods.length) await replaceMealFoods(client, meal.id, foods);
    await replaceMealJoins(client, meal.id, payload);

    // Hydrate inside the same transaction to avoid a fresh pool connection
    // (and a window where the new meal isn't yet visible to other readers).
    const shaped = await getMealById(meal.id, client);
    await client.query("COMMIT");
    return shaped;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function updateMeal(id, payload) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const fields = [];
    const values = [];
    let i = 1;
    const set = (col, val) => {
      if (val === undefined) return;
      fields.push(`${col} = $${i++}`);
      values.push(val);
    };

    set("title", payload.title);
    set("description", payload.description);
    if (payload.image_url !== undefined) set("image", payload.image_url);
    else set("image", payload.image);
    const note =
      payload.blueprint_note !== undefined
        ? payload.blueprint_note
        : payload.blueprintNote !== undefined
        ? payload.blueprintNote
        : payload.note;
    set("note", note);
    set("user_id", payload.user_id);

    if (fields.length) {
      fields.push("updated_at = now()");
      values.push(id);
      await client.query(
        `UPDATE public.meals SET ${fields.join(", ")} WHERE id = $${i}`,
        values,
      );
    }

    if (Array.isArray(payload.foods)) {
      await replaceMealFoods(client, id, payload.foods);
    }
    await replaceMealJoins(client, id, payload);

    // Hydrate inside the same transaction (saves a connection acquire).
    const shaped = await getMealById(id, client);
    await client.query("COMMIT");
    return shaped;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function deleteMeal(id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM public.item_meals WHERE meal_id = $1`, [id]);
    await client.query(`DELETE FROM public.meal_category WHERE meal_id = $1`, [id]);
    await client.query(`DELETE FROM public.meal_sub_category WHERE meal_id = $1`, [id]);
    await client.query(`DELETE FROM public.meal_tag WHERE meal_id = $1`, [id]);
    await client.query(`DELETE FROM public.meals WHERE id = $1`, [id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Soft-delete is not natively supported on legacy meals (no is_active column).
// Keep the export name for backward compatibility but perform a real delete.
const softDeleteMeal = deleteMeal;

module.exports = {
  shapeMeal,
  shapeFood,
  listMeals,
  getMealById,
  createMeal,
  updateMeal,
  deleteMeal,
  softDeleteMeal,
};
