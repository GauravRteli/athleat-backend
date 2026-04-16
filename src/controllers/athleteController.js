const {
  getAthleteMe,
  getAthleteMissions,
  upsertUnlock,
  getFoodPrefs,
  upsertFoodPrefs,
} = require("../services/athleteService");
const { submitMissionVersion } = require("../services/studentService");

async function getMe(req, res, next) {
  try {
    const data = await getAthleteMe(req.auth.studentId);
    if (!data) return res.status(401).json({ error: "Unauthorized." });
    return res.status(200).json(data);
  } catch (error) {
    return next(error);
  }
}

async function postUnlock(req, res, next) {
  try {
    const moduleKey = String(req.body?.moduleKey || "").trim();
    if (!moduleKey) return res.status(400).json({ error: "moduleKey is required." });
    const data = await upsertUnlock(req.auth.studentId, moduleKey);
    return res.status(200).json(data);
  } catch (error) {
    return next(error);
  }
}

async function getFoodPreferences(req, res, next) {
  try {
    const data = await getFoodPrefs(req.auth.studentId);
    return res.status(200).json(data);
  } catch (error) {
    return next(error);
  }
}

async function postFoodPreferences(req, res, next) {
  try {
    const selections =
      req.body?.selections && typeof req.body.selections === "object" ? req.body.selections : {};
    const completedAt = req.body?.completedAt || new Date().toISOString();
    const data = await upsertFoodPrefs(req.auth.studentId, selections, completedAt);
    return res.status(200).json(data);
  } catch (error) {
    return next(error);
  }
}

async function getMissions(req, res, next) {
  try {
    const data = await getAthleteMissions(req.auth.studentId);
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function postSubmitMissionV1(req, res, next) {
  try {
    const missionId = String(req.params?.missionId || "").trim().toLowerCase();
    const data = await submitMissionVersion(
      req.auth.studentId,
      missionId,
      "v1",
      req.body?.v1 || {},
    );
    return res.status(200).json({ ok: true, ...data });
  } catch (error) {
    return next(error);
  }
}

async function postSubmitMissionV2(req, res, next) {
  try {
    const missionId = String(req.params?.missionId || "").trim().toLowerCase();
    const data = await submitMissionVersion(
      req.auth.studentId,
      missionId,
      "v2",
      req.body?.v2 || {},
    );
    return res.status(200).json({ ok: true, ...data });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getMe,
  postUnlock,
  getFoodPreferences,
  postFoodPreferences,
  getMissions,
  postSubmitMissionV1,
  postSubmitMissionV2,
};
