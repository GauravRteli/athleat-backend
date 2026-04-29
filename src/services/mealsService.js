const { pool, query } = require("../config/postgres");

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function shapeMeal(row, foods = []) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    blueprint_note: row.blueprint_note,
    instructions: row.instructions,
    tags: row.tags || [],
    category: row.category,
    sub_category: row.sub_category,
    image_url: row.image_url,
    image_prompt: row.image_prompt,
    energy_kj: row.energy_kj != null ? Number(row.energy_kj) : null,
    energy_kcal: row.energy_kcal != null ? Number(row.energy_kcal) : null,
    protein_g: row.protein_g != null ? Number(row.protein_g) : null,
    carb_g: row.carb_g != null ? Number(row.carb_g) : null,
    fat_g: row.fat_g != null ? Number(row.fat_g) : null,
    source: row.source,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    foods,
  };
}

function shapeFood(row) {
  return {
    id: row.id,
    meal_id: row.meal_id,
    food_id: row.food_id,
    food_name: row.food_name,
    weight_g: row.weight_g != null ? Number(row.weight_g) : null,
    energy_kj: row.energy_kj != null ? Number(row.energy_kj) : null,
    protein_g: row.protein_g != null ? Number(row.protein_g) : null,
    carb_g: row.carb_g != null ? Number(row.carb_g) : null,
    fat_g: row.fat_g != null ? Number(row.fat_g) : null,
    sort_order: row.sort_order,
  };
}

function computeTotals(foods = []) {
  return foods.reduce(
    (acc, f) => ({
      energy_kj: acc.energy_kj + (num(f.energy_kj) || 0),
      protein_g: acc.protein_g + (num(f.protein_g) || 0),
      carb_g: acc.carb_g + (num(f.carb_g) || 0),
      fat_g: acc.fat_g + (num(f.fat_g) || 0),
    }),
    { energy_kj: 0, protein_g: 0, carb_g: 0, fat_g: 0 },
  );
}

async function listMeals({ category, search } = {}) {
  const conditions = ["is_active = true"];
  const params = [];
  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`title ILIKE $${params.length}`);
  }
  const result = await query(
    `SELECT * FROM public.meals WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT 200`,
    params,
  );
  return result.rows.map((r) => shapeMeal(r));
}

async function getMealById(id) {
  const mealRes = await query(`SELECT * FROM public.meals WHERE id = $1 LIMIT 1`, [id]);
  if (!mealRes.rows[0]) return null;
  const foodsRes = await query(
    `SELECT * FROM public.meal_foods WHERE meal_id = $1 ORDER BY sort_order, id`,
    [id],
  );
  return shapeMeal(mealRes.rows[0], foodsRes.rows.map(shapeFood));
}

async function createMeal(payload) {
  const foods = Array.isArray(payload.foods) ? payload.foods : [];
  const totals = payload.totals || computeTotals(foods);
  const energy_kj = num(totals.energy_kj);
  const energy_kcal = energy_kj != null ? Math.round(energy_kj / 4.184) : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const mealRes = await client.query(
      `INSERT INTO public.meals
        (title, description, blueprint_note, instructions, tags, category, sub_category,
         image_url, image_prompt, energy_kj, energy_kcal, protein_g, carb_g, fat_g, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        payload.title,
        payload.description || null,
        payload.blueprint_note || payload.blueprintNote || null,
        payload.instructions || null,
        payload.tags || [],
        payload.category || null,
        payload.sub_category || null,
        payload.image_url || null,
        payload.image_prompt || null,
        energy_kj,
        energy_kcal,
        num(totals.protein_g),
        num(totals.carb_g),
        num(totals.fat_g),
        payload.source || "kerry",
        payload.created_by || null,
      ],
    );
    const meal = mealRes.rows[0];

    for (let i = 0; i < foods.length; i++) {
      const f = foods[i];
      await client.query(
        `INSERT INTO public.meal_foods
           (meal_id, food_id, food_name, weight_g, energy_kj, protein_g, carb_g, fat_g, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          meal.id,
          f.food_id || null,
          f.food_name,
          num(f.weight_g || f.weight_grams),
          num(f.energy_kj),
          num(f.protein_g),
          num(f.carb_g),
          num(f.fat_g),
          i,
        ],
      );
    }

    await client.query("COMMIT");
    return await getMealById(meal.id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateMeal(id, payload) {
  const foods = Array.isArray(payload.foods) ? payload.foods : null;
  const totals = payload.totals || (foods ? computeTotals(foods) : null);
  const energy_kj = totals ? num(totals.energy_kj) : null;
  const energy_kcal = energy_kj != null ? Math.round(energy_kj / 4.184) : null;

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
    set("blueprint_note", payload.blueprint_note ?? payload.blueprintNote);
    set("instructions", payload.instructions);
    set("tags", payload.tags);
    set("category", payload.category);
    set("sub_category", payload.sub_category);
    set("image_url", payload.image_url);
    set("image_prompt", payload.image_prompt);
    if (totals) {
      set("energy_kj", energy_kj);
      set("energy_kcal", energy_kcal);
      set("protein_g", num(totals.protein_g));
      set("carb_g", num(totals.carb_g));
      set("fat_g", num(totals.fat_g));
    }

    if (fields.length) {
      fields.push("updated_at = now()");
      values.push(id);
      await client.query(
        `UPDATE public.meals SET ${fields.join(", ")} WHERE id = $${i}`,
        values,
      );
    }

    if (foods) {
      await client.query(`DELETE FROM public.meal_foods WHERE meal_id = $1`, [id]);
      for (let idx = 0; idx < foods.length; idx++) {
        const f = foods[idx];
        await client.query(
          `INSERT INTO public.meal_foods
             (meal_id, food_id, food_name, weight_g, energy_kj, protein_g, carb_g, fat_g, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            f.food_id || null,
            f.food_name,
            num(f.weight_g || f.weight_grams),
            num(f.energy_kj),
            num(f.protein_g),
            num(f.carb_g),
            num(f.fat_g),
            idx,
          ],
        );
      }
    }
    await client.query("COMMIT");
    return await getMealById(id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function softDeleteMeal(id) {
  await query(
    `UPDATE public.meals SET is_active = false, updated_at = now() WHERE id = $1`,
    [id],
  );
}

module.exports = {
  listMeals,
  getMealById,
  createMeal,
  updateMeal,
  softDeleteMeal,
};
