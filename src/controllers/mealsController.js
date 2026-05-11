const {
  listMeals,
  getMealById,
  createMeal,
  updateMeal,
  softDeleteMeal,
} = require("../services/mealsService");

// `item_ids` can come in as either a CSV string ("12,34") or repeated query
// params ("?item_ids=12&item_ids=34"). Normalise both shapes here.
function parseItemIdsParam(value) {
  if (value == null || value === "") return undefined;
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

async function getAll(req, res, next) {
  try {
    const data = await listMeals({
      category: req.query.category || undefined,
      categoryId: req.query.category_id || undefined,
      subCategoryId: req.query.sub_category_id || undefined,
      search: req.query.search || undefined,
      itemIds: parseItemIdsParam(req.query.item_ids),
    });
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function getOne(req, res, next) {
  try {
    const data = await getMealById(req.params.id);
    if (!data) return res.status(404).json({ error: "Meal not found" });
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function postMeal(req, res, next) {
  try {
    const data = await createMeal(req.body || {});
    return res.status(201).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function patchMeal(req, res, next) {
  try {
    const data = await updateMeal(req.params.id, req.body || {});
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function deleteMeal(req, res, next) {
  try {
    await softDeleteMeal(req.params.id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getAll, getOne, postMeal, patchMeal, deleteMeal };
