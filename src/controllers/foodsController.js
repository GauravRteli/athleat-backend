const { listFoods, createFood } = require("../services/foodsService");

async function getAll(req, res, next) {
  try {
    const data = await listFoods({
      search: req.query.search || undefined,
      category: req.query.category || undefined,
      limit: req.query.limit,
    });
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

module.exports = { getAll, postFood };
