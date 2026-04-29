const { query } = require("../config/postgres");

function shape(row) {
  return {
    id: row.id,
    food_name: row.food_name,
    serving_label: row.serving_label,
    weight_g: row.weight_g != null ? Number(row.weight_g) : null,
    energy_kj: row.energy_kj != null ? Number(row.energy_kj) : null,
    energy_kcal: row.energy_kcal != null ? Number(row.energy_kcal) : null,
    protein_g: row.protein_g != null ? Number(row.protein_g) : null,
    carb_g: row.carb_g != null ? Number(row.carb_g) : null,
    fat_g: row.fat_g != null ? Number(row.fat_g) : null,
    fibre_g: row.fibre_g != null ? Number(row.fibre_g) : null,
    category: row.category,
    source: row.source,
    is_active: row.is_active,
    created_at: row.created_at,
  };
}

async function listFoods({ search, category, limit = 50 } = {}) {
  const conditions = ["is_active = true"];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`food_name ILIKE $${params.length}`);
  }
  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }
  params.push(Math.min(Number(limit) || 50, 200));
  const result = await query(
    `SELECT * FROM public.foods WHERE ${conditions.join(" AND ")} ORDER BY food_name ASC LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(shape);
}

async function createFood(payload) {
  const result = await query(
    `INSERT INTO public.foods
      (food_name, serving_label, weight_g, energy_kj, energy_kcal,
       protein_g, carb_g, fat_g, fibre_g, category, source, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12, true))
     RETURNING *`,
    [
      payload.food_name,
      payload.serving_label || null,
      payload.weight_g || null,
      payload.energy_kj || null,
      payload.energy_kcal || null,
      payload.protein_g || null,
      payload.carb_g || null,
      payload.fat_g || null,
      payload.fibre_g || null,
      payload.category || null,
      payload.source || null,
      payload.is_active,
    ],
  );
  return shape(result.rows[0]);
}

module.exports = { listFoods, createFood };
