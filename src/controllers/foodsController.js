const {
  listFoods,
  getFoodById,
  createFood,
  updateFood,
  deleteFood,
} = require("../services/foodsService");

async function getAll(req, res, next) {
  try {
    const { rows, total, limit, offset } = await listFoods({
      search: req.query.search || undefined,
      category: req.query.category || undefined,
      categoryId: req.query.category_id || undefined,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.status(200).json({ data: rows, total, limit, offset });
  } catch (error) {
    return next(error);
  }
}

async function getOne(req, res, next) {
  try {
    const data = await getFoodById(req.params.id);
    if (!data) return res.status(404).json({ error: "Food not found" });
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function postFood(req, res, next) {
  try {
    const data = await createFood(req.body || {});
    return res.status(201).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function patchFood(req, res, next) {
  try {
    const data = await updateFood(req.params.id, req.body || {});
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function removeFood(req, res, next) {
  try {
    await deleteFood(req.params.id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getAll, getOne, postFood, patchFood, removeFood };
