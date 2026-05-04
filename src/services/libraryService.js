// =============================================================================
// libraryService — read/write helpers for the legacy library taxonomy:
//   • food_categories
//   • sub_categories  (+ subcategory_category mapping)
//   • tags
// =============================================================================

const { query, pool } = require("../config/postgres");

// ───────────────────────────── categories ─────────────────────────────

async function listCategories() {
  // food_categories has only: id, name, created_at, updated_at (no image / description)
  const r = await query(
    `SELECT fc.id, fc.name, fc.created_at, fc.updated_at,
            (SELECT COUNT(*) FROM public.items i WHERE i.category_id = fc.id) AS food_count,
            (SELECT COUNT(*) FROM public.meal_category mc WHERE mc.category_id = fc.id) AS meal_count
       FROM public.food_categories fc
       ORDER BY fc.name ASC`,
  );
  return r.rows;
}

async function createCategory(payload) {
  const r = await query(
    `INSERT INTO public.food_categories (name) VALUES ($1) RETURNING *`,
    [payload.name],
  );
  return r.rows[0];
}

async function updateCategory(id, payload) {
  const fields = [];
  const values = [];
  let i = 1;
  if (payload.name !== undefined) { fields.push(`name = $${i++}`); values.push(payload.name); }
  if (!fields.length) return null;
  fields.push("updated_at = now()");
  values.push(id);
  const r = await query(
    `UPDATE public.food_categories SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    values,
  );
  return r.rows[0] || null;
}

async function deleteCategory(id) {
  await query(`DELETE FROM public.food_categories WHERE id = $1`, [id]);
}

// ───────────────────────────── sub categories ─────────────────────────────

async function listSubCategories({ categoryId } = {}) {
  if (categoryId) {
    const r = await query(
      `SELECT sc.*,
              (SELECT array_agg(category_id)
                 FROM public.subcategory_category
                WHERE sub_category_id = sc.id) AS category_ids
         FROM public.sub_categories sc
         JOIN public.subcategory_category sxc ON sxc.sub_category_id = sc.id
        WHERE sxc.category_id = $1
        ORDER BY sc.title ASC`,
      [Number(categoryId)],
    );
    return r.rows;
  }
  const r = await query(
    `SELECT sc.*,
            (SELECT array_agg(category_id)
               FROM public.subcategory_category
              WHERE sub_category_id = sc.id) AS category_ids
       FROM public.sub_categories sc
       ORDER BY sc.title ASC`,
  );
  return r.rows;
}

async function createSubCategory(payload) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `INSERT INTO public.sub_categories (title, description, image)
       VALUES ($1,$2,$3)
       RETURNING *`,
      [payload.title, payload.description || null, payload.image || null],
    );
    const sub = r.rows[0];
    if (Array.isArray(payload.category_ids)) {
      for (const cid of payload.category_ids) {
        await client.query(
          `INSERT INTO public.subcategory_category (category_id, sub_category_id)
           VALUES ($1,$2)`,
          [Number(cid), sub.id],
        );
      }
    }
    await client.query("COMMIT");
    return sub;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function updateSubCategory(id, payload) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fields = [];
    const values = [];
    let i = 1;
    if (payload.title !== undefined) { fields.push(`title = $${i++}`); values.push(payload.title); }
    if (payload.description !== undefined) { fields.push(`description = $${i++}`); values.push(payload.description); }
    if (payload.image !== undefined) { fields.push(`image = $${i++}`); values.push(payload.image); }
    if (fields.length) {
      fields.push("updated_at = now()");
      values.push(id);
      await client.query(
        `UPDATE public.sub_categories SET ${fields.join(", ")} WHERE id = $${i}`,
        values,
      );
    }
    if (Array.isArray(payload.category_ids)) {
      await client.query(
        `DELETE FROM public.subcategory_category WHERE sub_category_id = $1`,
        [id],
      );
      for (const cid of payload.category_ids) {
        await client.query(
          `INSERT INTO public.subcategory_category (category_id, sub_category_id)
           VALUES ($1,$2)`,
          [Number(cid), id],
        );
      }
    }
    await client.query("COMMIT");
    const r = await client.query(`SELECT * FROM public.sub_categories WHERE id = $1`, [id]);
    return r.rows[0] || null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function deleteSubCategory(id) {
  await query(`DELETE FROM public.sub_categories WHERE id = $1`, [id]);
}

// ───────────────────────────── tags ─────────────────────────────

async function listTags() {
  const r = await query(
    `SELECT id, name, icon, created_at, updated_at
       FROM public.tags
       ORDER BY name ASC`,
  );
  return r.rows;
}

async function createTag(payload) {
  const r = await query(
    `INSERT INTO public.tags (name, icon)
     VALUES ($1,$2)
     RETURNING *`,
    [payload.name, payload.icon || null],
  );
  return r.rows[0];
}

async function updateTag(id, payload) {
  const fields = [];
  const values = [];
  let i = 1;
  if (payload.name !== undefined) { fields.push(`name = $${i++}`); values.push(payload.name); }
  if (payload.icon !== undefined) { fields.push(`icon = $${i++}`); values.push(payload.icon); }
  if (!fields.length) return null;
  fields.push("updated_at = now()");
  values.push(id);
  const r = await query(
    `UPDATE public.tags SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    values,
  );
  return r.rows[0] || null;
}

async function deleteTag(id) {
  await query(`DELETE FROM public.tags WHERE id = $1`, [id]);
}

// ───────────────────────────── flag taxonomy ─────────────────────────────
//
// flag_categories  ← top-level groupings (Grains, Meat, Dairy …)
// flags            ← buckets inside a category (Cereals, Beef, Chicken …)
// flag_item        ← which items belong to which flag
//
// In the Library UI these are surfaced as "Category" and "Sub Category"
// filters; the underlying tables stay namespaced as flag_* in the schema.

async function listFlagCategories() {
  const r = await query(
    `SELECT id, name, created_at, updated_at
       FROM public.flag_categories
       ORDER BY id ASC`,
  );
  return r.rows;
}

async function listFlags({ flagCategoryId } = {}) {
  if (flagCategoryId) {
    const r = await query(
      `SELECT fl.id, fl.name, fcf.flag_category_id
         FROM public.flags fl
         JOIN public.flags_categories_flag fcf ON fcf.flag_id = fl.id
        WHERE fcf.flag_category_id = $1
        ORDER BY fl.name ASC`,
      [Number(flagCategoryId)],
    );
    return r.rows;
  }
  const r = await query(
    `SELECT fl.id, fl.name,
            (SELECT array_agg(flag_category_id)
               FROM public.flags_categories_flag
              WHERE flag_id = fl.id) AS flag_category_ids
       FROM public.flags fl
       ORDER BY fl.name ASC`,
  );
  return r.rows;
}

async function listFlagCatalog() {
  const res = await query(
    `SELECT
       fc.id   AS category_id,
       fc.name AS category_name,
       fl.id   AS flag_id,
       fl.name AS flag_name,
       i.id    AS item_id,
       i.title AS item_title,
       i.image AS item_image
     FROM public.flag_categories fc
     JOIN public.flags_categories_flag fcf
       ON fcf.flag_category_id = fc.id
     JOIN public.flags fl
       ON fl.id = fcf.flag_id
     LEFT JOIN public.flag_item fi
       ON fi.flag_id = fl.id
     LEFT JOIN public.items i
       ON i.id = fi.item_id
     ORDER BY fc.id ASC, fl.name ASC, i.title ASC`,
  );

  const categoriesById = new Map();
  for (const row of res.rows) {
    let cat = categoriesById.get(row.category_id);
    if (!cat) {
      cat = { id: row.category_id, name: row.category_name, flags: [], _flagsById: new Map() };
      categoriesById.set(row.category_id, cat);
    }
    let flag = cat._flagsById.get(row.flag_id);
    if (!flag) {
      flag = { id: row.flag_id, name: row.flag_name, items: [] };
      cat._flagsById.set(row.flag_id, flag);
      cat.flags.push(flag);
    }
    if (row.item_id != null) {
      flag.items.push({
        id: row.item_id,
        title: row.item_title,
        image: row.item_image || null,
      });
    }
  }

  return Array.from(categoriesById.values()).map(({ _flagsById, ...rest }) => rest);
}

module.exports = {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listSubCategories,
  createSubCategory,
  updateSubCategory,
  deleteSubCategory,
  listTags,
  createTag,
  updateTag,
  deleteTag,
  listFlagCategories,
  listFlags,
  listFlagCatalog,
};
