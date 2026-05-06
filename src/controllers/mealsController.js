const {
  listMeals,
  getMealById,
  createMeal,
  updateMeal,
  softDeleteMeal,
} = require("../services/mealsService");

async function getAll(req, res, next) {
  try {
    const data = await listMeals({
      category: req.query.category || undefined,
      categoryId: req.query.category_id || undefined,
      subCategoryId: req.query.sub_category_id || undefined,
      search: req.query.search || undefined,
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
