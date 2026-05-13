const {
  getTrainingPlan,
  upsertTrainingPlan,
  getGameDayPlan,
  upsertGameDayPlan,
  getLatestShoppingList,
  insertShoppingList,
} = require("../services/planningService");

// ── Training Day Plan ────────────────────────────────────────────────────────
async function getMyTrainingPlan(req, res, next) {
  try {
    const data = await getTrainingPlan(req.auth.studentId);
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function saveMyTrainingPlan(req, res, next) {
  try {
    const planData = req.body?.data ?? req.body?.planData ?? req.body ?? {};
    const submit = req.body?.submit === true || req.body?.status === "submitted";
    const data = await upsertTrainingPlan(req.auth.studentId, planData, { submit });
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

// ── Game Day Plan ────────────────────────────────────────────────────────────
async function getMyGameDayPlan(req, res, next) {
  try {
    const data = await getGameDayPlan(req.auth.studentId);
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function saveMyGameDayPlan(req, res, next) {
  try {
    const planData = req.body?.data ?? req.body?.planData ?? req.body ?? {};
    const submit = req.body?.submit !== false; // game day always counts as submitted
    const data = await upsertGameDayPlan(req.auth.studentId, planData, { submit });
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

// ── Shopping List ────────────────────────────────────────────────────────────
async function getMyShoppingList(req, res, next) {
  try {
    const data = await getLatestShoppingList(req.auth.studentId);
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function saveMyShoppingList(req, res, next) {
  try {
    const listData = req.body?.data ?? req.body?.listData ?? {};
    const serves   = req.body?.serves ?? listData?.serves ?? 1;
    const data = await insertShoppingList(req.auth.studentId, listData, serves);
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getMyTrainingPlan,
  saveMyTrainingPlan,
  getMyGameDayPlan,
  saveMyGameDayPlan,
  getMyShoppingList,
  saveMyShoppingList,
};
