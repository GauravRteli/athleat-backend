// =============================================================================
// foodsService — adapter onto the legacy `public.items` table.
//
// Exposes a per-100g normalised "food" shape compatible with the existing
// frontend contract (food_name / energy_kj / protein_g / carb_g / fat_g …).
// The legacy `items` row stores macros per serving + a numeric `serving_size`,
// so we normalise to per-100g for display.
// =============================================================================

const { query } = require("../config/postgres");

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// "441.0kJ" → 441
const parseEnergy = (val) => {
  if (val === null || val === undefined) return null;
  const m = String(val).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

function shapeItem(row) {
  const energyKj = parseEnergy(row.energy);
  return {
    id: row.id,
    food_name: row.title,
    title: row.title,
    description: row.description,
    note: row.note,
    image: row.image,
    serving_label: row.serving_size_unit
      ? `${row.serving_size || ""} ${row.serving_size_unit}`.trim()
      : row.serving_size || null,
    weight_g: num(row.serving_size),
    energy_kj: energyKj,
    energy_kcal: energyKj != null ? Math.round(energyKj / 4.184) : null,
    protein_g: num(row.protein),
    carb_g: num(row.carbs),
    fat_g: num(row.fat),
    fibre_g: parseEnergy(row.dietary_fibre),
    sodium: row.sodium,
    sugars: row.sugars,
    saturated: row.saturated,
    serving_per_pack: row.serving_per_pack,
    serving_size: row.serving_size,
    serving_size_unit: row.serving_size_unit,
    qty: row.qty,
    unit: row.unit,
    selected_qty_unit: row.selected_qty_unit,
    category: row.category,
    category_id: row.category_id,
    is_swiped: row.is_swiped,
    is_extra: row.is_extra,
    is_locked: row.is_locked,
    is_active: !row.is_locked, // legacy `items` has no is_active; expose `is_locked` inversely
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listFoods({
  search,
  category,
  categoryId,
  flagCategoryId,
  flagId,
  limit,
  offset,
} = {}) {
  const conditions = [];
  const joins = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`items.title ILIKE $${params.length}`);
  }
  if (category) {
    params.push(category);
    conditions.push(`items.category = $${params.length}`);
  }
  if (categoryId) {
    params.push(Number(categoryId));
    conditions.push(`items.category_id = $${params.length}`);
  }

  // Flag filters — items can be tagged with multiple flags via flag_item.
  // Specific flag wins over category when both are provided.
  if (flagId) {
    params.push(Number(flagId));
    joins.push(
      `JOIN public.flag_item fi ON fi.item_id = items.id AND fi.flag_id = $${params.length}`,
    );
  } else if (flagCategoryId) {
    params.push(Number(flagCategoryId));
    joins.push(
      `JOIN public.flag_item fi ON fi.item_id = items.id`,
      `JOIN public.flags_categories_flag fcf ON fcf.flag_id = fi.flag_id AND fcf.flag_category_id = $${params.length}`,
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const joinClause = joins.length ? joins.join("\n       ") : "";
  // DISTINCT guards against an item being duplicated when it's tagged with
  // multiple flags inside the same flag_category.
  const usingDistinct = joins.length > 0;
  const selectClause = usingDistinct ? "DISTINCT items.*" : "items.*";

  // Pagination — clamp limit to a generous max; offset must be >= 0.
  const lim = Math.max(1, Math.min(Number(limit) || 50, 5000));
  const off = Math.max(0, Number(offset) || 0);

  params.push(lim);
  const limIdx = params.length;
  params.push(off);
  const offIdx = params.length;

  // Counting with DISTINCT + window function is awkward, so when joins are
  // active we run a separate COUNT query; otherwise reuse the window count.
  let total = 0;
  let rows;
  if (usingDistinct) {
    const countResult = await query(
      `SELECT COUNT(DISTINCT items.id) AS total
         FROM public.items
         ${joinClause}
         ${where}`,
      params.slice(0, params.length - 2),
    );
    total = countResult.rows[0] ? Number(countResult.rows[0].total) : 0;

    const result = await query(
      `SELECT ${selectClause}
         FROM public.items
         ${joinClause}
         ${where}
        ORDER BY items.title ASC
        LIMIT $${limIdx} OFFSET $${offIdx}`,
      params,
    );
    rows = result.rows.map((row) => shapeItem(row));
  } else {
    const result = await query(
      `SELECT ${selectClause}, COUNT(*) OVER() AS __total
         FROM public.items
         ${where}
        ORDER BY items.title ASC
        LIMIT $${limIdx} OFFSET $${offIdx}`,
      params,
    );
    total = result.rows[0] ? Number(result.rows[0].__total) : 0;
    rows = result.rows.map((row) => {
      const { __total, ...rest } = row;
      return shapeItem(rest);
    });
  }

  return { rows, total, limit: lim, offset: off };
}

async function getFoodById(id) {
  const result = await query(`SELECT * FROM public.items WHERE id = $1 LIMIT 1`, [id]);
  return result.rows[0] ? shapeItem(result.rows[0]) : null;
}

async function createFood(payload) {
  // Map dashboard-style payload onto the legacy `items` columns.
  // The dashboard provides per-100g macros under {protein_g, carb_g, fat_g, energy_kj}.
  const energyKj = num(payload.energy_kj);
  const energyStr = energyKj != null ? `${energyKj}kJ` : payload.energy || null;

  const result = await query(
    `INSERT INTO public.items
       (title, description, note, protein, carbs, fat, energy,
        saturated, sugars, dietary_fibre, sodium,
        serving_per_pack, serving_size, serving_size_unit,
        category, image, qty, unit, selected_qty_unit,
        is_swiped, is_extra, is_locked, category_id, woolworth_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
             COALESCE($20,false), COALESCE($21,false), COALESCE($22,false), $23, $24)
     RETURNING *`,
    [
      payload.title || payload.food_name,
      payload.description || null,
      payload.note || null,
      num(payload.protein_g) ?? num(payload.protein) ?? 0,
      num(payload.carb_g) ?? num(payload.carbs) ?? 0,
      num(payload.fat_g) ?? num(payload.fat),
      energyStr,
      payload.saturated || null,
      payload.sugars || null,
      payload.dietary_fibre || (num(payload.fibre_g) != null ? `${num(payload.fibre_g)}g` : null),
      payload.sodium || null,
      payload.serving_per_pack || null,
      payload.serving_size || (num(payload.weight_g) != null ? String(num(payload.weight_g)) : null),
      payload.serving_size_unit || "g",
      payload.category || null,
      payload.image || null,
      payload.qty || null,
      payload.unit || null,
      payload.selected_qty_unit || null,
      payload.is_swiped,
      payload.is_extra,
      payload.is_locked,
      payload.category_id || null,
      payload.woolworth_json || null,
    ],
  );
  return shapeItem(result.rows[0]);
}

async function updateFood(id, payload) {
  const fields = [];
  const values = [];
  let i = 1;
  const set = (col, val) => {
    if (val === undefined) return;
    fields.push(`${col} = $${i++}`);
    values.push(val);
  };

  set("title", payload.title ?? payload.food_name);
  set("description", payload.description);
  set("note", payload.note);
  set("protein", payload.protein_g ?? payload.protein);
  set("carbs", payload.carb_g ?? payload.carbs);
  set("fat", payload.fat_g ?? payload.fat);
  if (payload.energy_kj !== undefined) set("energy", `${num(payload.energy_kj)}kJ`);
  else set("energy", payload.energy);
  set("saturated", payload.saturated);
  set("sugars", payload.sugars);
  set("dietary_fibre", payload.dietary_fibre);
  set("sodium", payload.sodium);
  set("serving_per_pack", payload.serving_per_pack);
  set("serving_size", payload.serving_size ?? (payload.weight_g != null ? String(payload.weight_g) : undefined));
  set("serving_size_unit", payload.serving_size_unit);
  set("category", payload.category);
  set("image", payload.image);
  set("qty", payload.qty);
  set("unit", payload.unit);
  set("selected_qty_unit", payload.selected_qty_unit);
  set("is_swiped", payload.is_swiped);
  set("is_extra", payload.is_extra);
  set("is_locked", payload.is_locked);
  set("category_id", payload.category_id);

  if (!fields.length) return await getFoodById(id);
  fields.push("updated_at = now()");
  values.push(id);
  await query(
    `UPDATE public.items SET ${fields.join(", ")} WHERE id = $${i}`,
    values,
  );
  return await getFoodById(id);
}

async function deleteFood(id) {
  await query(`DELETE FROM public.items WHERE id = $1`, [id]);
}

module.exports = {
  shapeItem,
  listFoods,
  getFoodById,
  createFood,
  updateFood,
  deleteFood,
};
