const {
  getAthleteMe,
  getAthleteMissions,
  upsertUnlock,
  getFoodPrefs,
  upsertFoodPrefs,
  getFoodPrefsCatalog,
  resolveAthleteChatFirstName,
  getPlannerNutritionTargets,
  applyUnlockProgression,
} = require("../services/athleteService");
const {
  submitMissionVersion,
  getStudentPrescreen,
  upsertStudentPrescreen,
} = require("../services/studentService");
const { getMissionConfig } = require("../services/missionConfigService");
const { postTestChat } = require("./chatController");
const { query } = require("../config/postgres");

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

async function getFoodPreferencesCatalog(req, res, next) {
  try {
    const data = await getFoodPrefsCatalog();
    return res.status(200).json({ categories: data });
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

/** Public mission copy (names, unlock hints, slot labels) — same rows Kerry edits in Admin. */
async function getMissionConfigForAthlete(req, res, next) {
  try {
    const data = await getMissionConfig();
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
    if (error?.code === "MISSION_LOCKED") {
      return res.status(error.statusCode || 409).json({
        ok: false,
        error: error.message,
        code: error.code,
        missionId: error.missionId,
      });
    }
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
    if (error?.code === "MISSION_LOCKED") {
      return res.status(error.statusCode || 409).json({
        ok: false,
        error: error.message,
        code: error.code,
        missionId: error.missionId,
      });
    }
    return next(error);
  }
}

/** Reuses `postTestChat` — sets `studentFirstName` from the authenticated athlete (not client input). */
async function postAthleteKnowledgeChat(req, res, next) {
  try {
    const me = await getAthleteMe(req.auth.studentId);
    if (!me?.athlete) return res.status(401).json({ error: "Unauthorized." });
    const fromDb = await resolveAthleteChatFirstName(req.auth.studentId);
    const first = String(fromDb || "").trim() || String(me.athlete.firstName || "").trim();
    const base = req.body && typeof req.body === "object" ? req.body : {};
    req.body = { ...base, studentFirstName: first };
    return postTestChat(req, res, next);
  } catch (error) {
    return next(error);
  }
}

async function getAthleteNutritionTargets(req, res, next) {
  try {
    const data = await getPlannerNutritionTargets(req.auth.studentId);
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function getAthletePrescreen(req, res, next) {
  try {
    const data = await getStudentPrescreen(req.auth.studentId);
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function postAthletePrescreen(req, res, next) {
  try {
    await upsertStudentPrescreen(req.auth.studentId, req.body || {});
    const newlyUnlocked = await applyUnlockProgression(
      req.auth.studentId,
      "prescreen_submitted",
    );
    return res.status(200).json({ ok: true, newlyUnlocked });
  } catch (error) {
    return next(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/athlete/meal-analysis/:id/submit
//
// Athlete acknowledges a Kez analysis Kerry has sent them. Stamped onto the
// meal_analysis row itself (not the mission), so a fresh Kez run naturally
// resets the submitted state on the new draft row.
//
// Only allowed if Kerry has already pressed "Send to athlete" (i.e.
// sent_to_athlete_at IS NOT NULL) and the row belongs to req.auth.studentId.
// ─────────────────────────────────────────────────────────────────────────────
async function postSubmitMealAnalysis(req, res, next) {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "analysis id required" });
    const { rows } = await query(
      `UPDATE public.meal_analysis
          SET athlete_submitted_at = COALESCE(athlete_submitted_at, now()),
              updated_at = now()
        WHERE id = $1
          AND student_id = $2
          AND sent_to_athlete_at IS NOT NULL
        RETURNING id, mission_id, slot_id, version,
                  sent_to_athlete_at, athlete_submitted_at`,
      [id, req.auth.studentId],
    );
    if (!rows.length) {
      return res
        .status(404)
        .json({ error: "Analysis not found, not yours, or not yet sent." });
    }
    return res.status(200).json({ analysis: rows[0] });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getMe,
  postUnlock,
  getFoodPreferences,
  postFoodPreferences,
  getFoodPreferencesCatalog,
  getMissions,
  getMissionConfigForAthlete,
  postSubmitMissionV1,
  postSubmitMissionV2,
  postAthleteKnowledgeChat,
  getAthleteNutritionTargets,
  getAthletePrescreen,
  postAthletePrescreen,
  postSubmitMealAnalysis,
};
