const { query } = require("../config/postgres");
const { DEV_UNLOCK_ALL_MISSIONS } = require("../config/devFlags");
const { toYyyyMmDd } = require("../utils/dateInput");
const { applyUnlockProgression } = require("./athleteService");
const MISSION_IDS = ["m1", "m2", "m3", "m4", "m5"];

function isValidMissionId(missionId) {
  return MISSION_IDS.includes(missionId);
}

// Linear mission unlock used for the Kerry dashboard read-only view (does NOT
// look at prescreen / food-prefs). The strict submit-time gate is in
// `assertSubmissionAllowed` below.
function isMissionUnlocked(missionsById, missionId) {
  if (DEV_UNLOCK_ALL_MISSIONS) return true;
  if (missionId === "m1") return true;
  const idx = MISSION_IDS.indexOf(missionId);
  if (idx <= 0) return false;
  const prevId = MISSION_IDS[idx - 1];
  // Spec: next mission's V1 only opens AFTER the previous mission's V2 is in.
  return !!missionsById[prevId]?.v2SubmittedAt;
}

// Strict per-submission gate. Returns `{ ok: true }` or `{ ok: false, reason }`
// so the frontend can show a meaningful message instead of "Mission is locked".
// Rules (matches the athlete-dashboard unlock chain):
//   - V1 of m1 requires `student_food_preferences.completed_at` (which itself
//     implies the prescreen step because food-prefs only unlocks after
//     prescreen via `applyUnlockProgression`).
//   - V1 of m2..m5 requires the PREVIOUS mission's V2 submission
//     (`missions.v2_submitted_at`).
//   - V2 of any mission requires that mission's V1 submission
//     (`missions.submitted_at`).
async function assertSubmissionAllowed(studentId, missionId, versionKey) {
  if (DEV_UNLOCK_ALL_MISSIONS) return { ok: true };
  if (!isValidMissionId(missionId)) {
    return { ok: false, reason: "Invalid mission id." };
  }
  if (!["v1", "v2"].includes(versionKey)) {
    return { ok: false, reason: "Invalid mission version." };
  }

  if (versionKey === "v2") {
    const r = await query(
      `SELECT submitted_at FROM public.missions
        WHERE student_id = $1 AND mission_id = $2 LIMIT 1`,
      [studentId, missionId],
    );
    if (r.rows[0]?.submitted_at) return { ok: true };
    return {
      ok: false,
      reason: `Submit ${missionId.toUpperCase()} V1 first before V2.`,
    };
  }

  // V1 — depends on the upstream step in the chain.
  if (missionId === "m1") {
    const r = await query(
      `SELECT completed_at FROM public.student_food_preferences
        WHERE student_id = $1 LIMIT 1`,
      [studentId],
    );
    if (r.rows[0]?.completed_at) return { ok: true };

    // No food-prefs row → check whether prescreen is even done so the FE
    // can point the athlete at the right step.
    const ps = await query(
      `SELECT 1 FROM public.prescreen WHERE student_id = $1 LIMIT 1`,
      [studentId],
    );
    if (!ps.rows.length) {
      return { ok: false, reason: "Complete your Pre-Screen first." };
    }
    return { ok: false, reason: "Complete Food Preferences first." };
  }

  const idx = MISSION_IDS.indexOf(missionId);
  const prevId = MISSION_IDS[idx - 1];
  const r = await query(
    `SELECT v2_submitted_at FROM public.missions
      WHERE student_id = $1 AND mission_id = $2 LIMIT 1`,
    [studentId, prevId],
  );
  if (r.rows[0]?.v2_submitted_at) return { ok: true };
  return {
    ok: false,
    reason: `Submit ${prevId.toUpperCase()} V2 first before starting ${missionId.toUpperCase()}.`,
  };
}

function countVersionPics(versionData) {
  if (!versionData || typeof versionData !== "object") return 0;
  return Object.values(versionData).filter((item) => {
    if (!item || typeof item !== "object") return false;
    return Boolean(item.url || item.localUrl);
  }).length;
}

function shapeMissionRow(row) {
  return {
    id: row.id,
    missionId: row.mission_id,
    status: row.status || "not_started",
    v1: row.v1 || null,
    v2: row.v2 || null,
    v3: row.v3 || null,
    submittedAt: row.submitted_at,
    v2SubmittedAt: row.v2_submitted_at,
    kerryFeedback: row.kerry_feedback || "",
    feedbackStatus: row.feedback_status || "none",
    feedbackApprovedAt: row.feedback_approved_at,
  };
}

async function listStudentsForDashboard() {
  const studentsRes = await query(`
    SELECT id, thinkific_user_id, full_name, email, created_at,
           quest_xp, best_streak, badges_earned,
           feedback_status, kerry_feedback, feedback_approved_at
    FROM public.students
    ORDER BY created_at DESC
  `);

  const students = studentsRes.rows;
  if (!students.length) return [];

  const ids = students.map((s) => s.id);

  const [prescreenRes, blueprintRes, missionsRes, questionsRes, foodPrefsRes] =
    await Promise.all([
      query(`SELECT * FROM public.prescreen WHERE student_id = ANY($1)`, [ids]),
      query(`SELECT * FROM public.blueprint_answers WHERE student_id = ANY($1)`, [ids]),
      query(`SELECT * FROM public.missions WHERE student_id = ANY($1) ORDER BY mission_id`, [ids]),
      query(`SELECT * FROM public.questions WHERE student_id = ANY($1) ORDER BY asked_at`, [ids]),
      query(
        `SELECT student_id, selections, completed_at FROM public.student_food_preferences WHERE student_id = ANY($1)`,
        [ids],
      ),
    ]);

  const prescreenMap = {};
  prescreenRes.rows.forEach((r) => { prescreenMap[r.student_id] = r; });

  const blueprintMap = {};
  blueprintRes.rows.forEach((r) => { blueprintMap[r.student_id] = r; });

  const missionsMap = {};
  missionsRes.rows.forEach((r) => {
    if (!missionsMap[r.student_id]) missionsMap[r.student_id] = {};
    missionsMap[r.student_id][r.mission_id] = r;
  });

  const questionsMap = {};
  questionsRes.rows.forEach((r) => {
    if (!questionsMap[r.student_id]) questionsMap[r.student_id] = [];
    questionsMap[r.student_id].push(r);
  });

  const foodPrefsMap = {};
  foodPrefsRes.rows.forEach((r) => {
    foodPrefsMap[r.student_id] = {
      selections: r.selections || {},
      completedAt: r.completed_at,
    };
  });

  return students.map((s) =>
    shapeDashboardStudent(
      s,
      prescreenMap[s.id],
      blueprintMap[s.id],
      missionsMap[s.id],
      questionsMap[s.id],
      foodPrefsMap[s.id],
    ),
  );
}

function shapeDashboardStudent(s, ps, bp, missions, questions, foodPrefs) {
  const prescreen = ps
    ? {
        dob: toYyyyMmDd(ps.dob) || ps.dob,
        schoolYear: ps.school_year,
        referral: ps.referral,
        ethnicity: ps.ethnicity,
        bloodTest: ps.blood_test,
        medical: ps.medical || [],
        medicalDates: ps.medical_dates,
        supplements: ps.supplements,
        sex: ps.sex,
        menstrual: ps.menstrual,
        height: ps.height_cm != null ? String(ps.height_cm) : null,
        weight: ps.weight_kg != null ? String(ps.weight_kg) : null,
        weightTrend: ps.weight_trend,
        livingWith: ps.living_with || [],
        cooking: ps.cooking,
        cookingSkills: ps.cooking_skills,
        favFoods: ps.fav_foods,
        dislikeFoods: ps.dislike_foods,
        dietaryReqs: ps.dietary_reqs || [],
        eatingStyle: ps.eating_style || [],
        takeaway: ps.takeaway_frequency,
        takeawayFoods: ps.takeaway_foods,
        goals: ps.goals || [],
        biggestChallenges: ps.biggest_challenges || [],
        mealPriority: ps.meal_priority,
        helpAreas: ps.help_areas || [],
        topQuestions: ps.top_questions,
        infoSources: ps.info_sources || [],
        activityType: ps.activity_type || [],
        daysLow: ps.days_low != null ? String(ps.days_low) : null,
        daysMed: ps.days_med != null ? String(ps.days_med) : null,
        daysHigh: ps.days_high != null ? String(ps.days_high) : null,
        sessionLength: ps.session_length,
        hungerGrid: ps.hunger_grid || {},
      }
    : {};

  const questAnswers = bp ? bp.answers : {};

  const shapedMissions = {};
  ["m1", "m2", "m3", "m4", "m5"].forEach((mid) => {
    const m = missions?.[mid];
    if (m) {
      shapedMissions[mid] = {
        id: m.id,
        status: m.status,
        submittedAt: m.submitted_at,
        v1: m.v1,
        v2: m.v2,
        v3: m.v3,
        v2SubmittedAt: m.v2_submitted_at,
        kerryFeedback: m.kerry_feedback || "",
        feedbackStatus: m.feedback_status || "none",
        feedbackApprovedAt: m.feedback_approved_at,
      };
    } else {
      shapedMissions[mid] = {
        status: "not_started",
        v1: null,
        v2: null,
        v3: null,
        kerryFeedback: "",
        feedbackStatus: "none",
      };
    }
  });

  const shapedQuestions = (questions || []).map((q) => ({
    id: q.id,
    text: q.text,
    askedAt: q.asked_at,
    status: q.status,
    reply: q.reply || "",
    repliedAt: q.replied_at,
  }));

  return {
    id: s.id,
    fullName: s.full_name,
    email: s.email,
    thinkificUserId: s.thinkific_user_id,
    submittedAt: s.created_at,
    questXP: s.quest_xp || 0,
    bestStreak: s.best_streak || 0,
    badgesEarned: (s.badges_earned || []).join(", "),
    feedbackStatus: s.feedback_status || "none",
    kerryFeedback: s.kerry_feedback || "",
    feedbackApprovedAt: s.feedback_approved_at,
    prescreen,
    questAnswers,
    missions: shapedMissions,
    questions: shapedQuestions,
    food_preferences: foodPrefs || { selections: {}, completedAt: null },
  };
}

async function updateStudentFeedback(studentId, kerryFeedback, feedbackStatus) {
  const feedbackApprovedAt = feedbackStatus === "approved" ? new Date().toISOString() : null;
  await query(
    `UPDATE public.students
     SET kerry_feedback = $1, feedback_status = $2, feedback_approved_at = $3
     WHERE id = $4`,
    [kerryFeedback, feedbackStatus, feedbackApprovedAt, studentId],
  );
}

async function updateMissionFeedback(studentId, missionId, kerryFeedback, feedbackStatus, v3) {
  const feedbackApprovedAt = feedbackStatus === "approved" ? new Date().toISOString() : null;
  await query(
    `UPDATE public.missions
     SET kerry_feedback = $1, feedback_status = $2, feedback_approved_at = $3, v3 = $4
     WHERE student_id = $5 AND mission_id = $6`,
    [kerryFeedback, feedbackStatus, feedbackApprovedAt, JSON.stringify(v3), studentId, missionId],
  );
}

async function replyToQuestion(questionId, reply) {
  await query(
    `UPDATE public.questions
     SET reply = $1, status = 'answered', replied_at = now()
     WHERE id = $2`,
    [reply, questionId],
  );
}

function shapePrescreenRow(row) {
  if (!row) return null;
  return {
    ...row,
    dob: toYyyyMmDd(row.dob) || row.dob || null,
  };
}

async function getStudentPrescreen(studentId) {
  const res = await query(
    `SELECT *
     FROM public.prescreen
     WHERE student_id = $1
     ORDER BY completed_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [studentId],
  );
  return shapePrescreenRow(res.rows[0]) || null;
}

async function upsertStudentPrescreen(studentId, payload) {
  const completedAt = payload.completed_at || new Date().toISOString();
  const hungerGrid = payload.hunger_grid || null;
  const values = [
    studentId,
    payload.dob || null,
    payload.school_year || null,
    payload.referral || null,
    payload.ethnicity || null,
    payload.blood_test || null,
    payload.medical || null,
    payload.medical_dates || null,
    payload.supplements || null,
    payload.sex || null,
    payload.menstrual || null,
    payload.height_cm != null && payload.height_cm !== "" ? Number(payload.height_cm) : null,
    payload.weight_kg != null && payload.weight_kg !== "" ? Number(payload.weight_kg) : null,
    payload.weight_trend || null,
    payload.living_with || null,
    payload.cooking || null,
    payload.cooking_skills || null,
    payload.fav_foods || null,
    payload.dislike_foods || null,
    payload.dietary_reqs || null,
    payload.eating_style || null,
    payload.takeaway_frequency || null,
    payload.takeaway_foods || null,
    payload.goals || null,
    payload.biggest_challenges || null,
    payload.meal_priority || null,
    payload.help_areas || null,
    payload.top_questions || null,
    payload.info_sources || null,
    payload.activity_type || null,
    payload.days_low != null && payload.days_low !== "" ? Number(payload.days_low) : null,
    payload.days_med != null && payload.days_med !== "" ? Number(payload.days_med) : null,
    payload.days_high != null && payload.days_high !== "" ? Number(payload.days_high) : null,
    payload.session_length || null,
    hungerGrid ? JSON.stringify(hungerGrid) : null,
    completedAt,
  ];

  const updateRes = await query(
    `UPDATE public.prescreen
     SET dob = $2,
         school_year = $3,
         referral = $4,
         ethnicity = $5,
         blood_test = $6,
         medical = $7,
         medical_dates = $8,
         supplements = $9,
         sex = $10,
         menstrual = $11,
         height_cm = $12,
         weight_kg = $13,
         weight_trend = $14,
         living_with = $15,
         cooking = $16,
         cooking_skills = $17,
         fav_foods = $18,
         dislike_foods = $19,
         dietary_reqs = $20,
         eating_style = $21,
         takeaway_frequency = $22,
         takeaway_foods = $23,
         goals = $24,
         biggest_challenges = $25,
         meal_priority = $26,
         help_areas = $27,
         top_questions = $28,
         info_sources = $29,
         activity_type = $30,
         days_low = $31,
         days_med = $32,
         days_high = $33,
         session_length = $34,
         hunger_grid = $35,
         completed_at = $36
     WHERE student_id = $1`,
    values,
  );

  if (updateRes.rowCount === 0) {
    await query(
      `INSERT INTO public.prescreen (
        student_id, dob, school_year, referral, ethnicity, blood_test,
        medical, medical_dates, supplements, sex, menstrual,
        height_cm, weight_kg, weight_trend, living_with, cooking, cooking_skills,
        fav_foods, dislike_foods, dietary_reqs, eating_style,
        takeaway_frequency, takeaway_foods, goals, biggest_challenges,
        meal_priority, help_areas, top_questions, info_sources, activity_type,
        days_low, days_med, days_high, session_length, hunger_grid, completed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17,
        $18, $19, $20, $21,
        $22, $23, $24, $25,
        $26, $27, $28, $29, $30,
        $31, $32, $33, $34, $35, $36
      )`,
      values,
    );
  }
  await applyUnlockProgression(studentId, "prescreen_submitted");
}

async function getStudentMissions(studentId) {
  const res = await query(
    `SELECT *
     FROM public.missions
     WHERE student_id = $1
     ORDER BY mission_id`,
    [studentId],
  );

  const byId = {};
  res.rows.forEach((row) => {
    byId[row.mission_id] = shapeMissionRow(row);
  });

  const missions = {};
  MISSION_IDS.forEach((mid) => {
    const existing = byId[mid] || {
      missionId: mid,
      status: "not_started",
      v1: null,
      v2: null,
      v3: null,
      submittedAt: null,
      v2SubmittedAt: null,
      kerryFeedback: "",
      feedbackStatus: "none",
      feedbackApprovedAt: null,
    };
    missions[mid] = {
      ...existing,
      unlocked: isMissionUnlocked({ ...byId, ...missions }, mid),
    };
  });

  return missions;
}

async function saveMissionProgress(studentId, missionId, payload = {}) {
  if (!isValidMissionId(missionId)) throw new Error("Invalid mission id");
  const missions = await getStudentMissions(studentId);
  if (!DEV_UNLOCK_ALL_MISSIONS && !missions[missionId]?.unlocked) {
    const err = new Error("Mission is locked");
    err.code = "MISSION_LOCKED";
    err.statusCode = 409;
    err.missionId = missionId;
    throw err;
  }

  const v1 = payload.v1 !== undefined ? payload.v1 : missions[missionId].v1;
  const v2 = payload.v2 !== undefined ? payload.v2 : missions[missionId].v2;

  await query(
    `INSERT INTO public.missions (student_id, mission_id, status, v1, v2)
     VALUES ($1, $2, 'not_started', $3, $4)
     ON CONFLICT (student_id, mission_id)
     DO UPDATE SET v1 = COALESCE(EXCLUDED.v1, public.missions.v1),
                   v2 = COALESCE(EXCLUDED.v2, public.missions.v2)`,
    [studentId, missionId, v1 ? JSON.stringify(v1) : null, v2 ? JSON.stringify(v2) : null],
  );
}

async function submitMissionVersion(studentId, missionId, versionKey, versionData) {
  // Strict unlock chain: prescreen → food-prefs → m1-v1 → m1-v2 → m2-v1 → ...
  // Validation happens inside `assertSubmissionAllowed` (also handles
  // invalid id / version inputs).
  const gate = await assertSubmissionAllowed(studentId, missionId, versionKey);
  if (!gate.ok) {
    const err = new Error(gate.reason || "Mission is locked");
    err.code = "MISSION_LOCKED";
    err.statusCode = 409;
    err.missionId = missionId;
    err.versionKey = versionKey;
    throw err;
  }
  const isComplete = countVersionPics(versionData) >= 3;

  if (versionKey === "v1") {
    await query(
      `INSERT INTO public.missions (student_id, mission_id, status, v1, submitted_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'submitted' THEN now() ELSE NULL END)
       ON CONFLICT (student_id, mission_id)
       DO UPDATE SET status = EXCLUDED.status,
                     v1 = EXCLUDED.v1,
                     submitted_at = CASE
                       WHEN EXCLUDED.status = 'submitted' THEN now()
                       ELSE public.missions.submitted_at
                     END`,
      [studentId, missionId, isComplete ? "submitted" : "in_progress", JSON.stringify(versionData)],
    );
    if (isComplete) {
      await applyUnlockProgression(studentId, "mission_v1_submitted", { missionId });
    }
    return { complete: isComplete, status: isComplete ? "submitted" : "in_progress" };
  }

  await query(
    `INSERT INTO public.missions (student_id, mission_id, status, v2, v2_submitted_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'submitted' THEN now() ELSE NULL END)
     ON CONFLICT (student_id, mission_id)
     DO UPDATE SET status = EXCLUDED.status,
                   v2 = EXCLUDED.v2,
                   v2_submitted_at = CASE
                     WHEN EXCLUDED.status = 'submitted' THEN now()
                     ELSE public.missions.v2_submitted_at
                   END`,
    [studentId, missionId, isComplete ? "submitted" : "in_progress", JSON.stringify(versionData)],
  );
  if (isComplete) {
    await applyUnlockProgression(studentId, "mission_v2_submitted", { missionId });
  }
  return { complete: isComplete, status: isComplete ? "submitted" : "in_progress" };
}

async function updateMissionSlotDesc(studentId, missionId, version, slotId, desc) {
  if (!isValidMissionId(missionId)) throw new Error("Invalid mission id");
  if (!["v1", "v2"].includes(version)) throw new Error("Invalid mission version");
  if (!slotId || typeof slotId !== "string") throw new Error("Invalid slot id");
  const cleanDesc = typeof desc === "string" ? desc : "";

  const result = await query(
    `UPDATE public.missions
       SET ${version} = jsonb_set(
         COALESCE(${version}, '{}'::jsonb),
         ARRAY[$3::text, 'desc'],
         to_jsonb($4::text),
         true
       )
     WHERE student_id = $1 AND mission_id = $2
     RETURNING ${version}`,
    [studentId, missionId, slotId, cleanDesc],
  );

  if (!result.rows?.[0]) throw new Error("Mission row not found");
  return result.rows[0][version] || null;
}

const SLOT_LOAD_DAY_VALUES = new Set(["rest", "lower", "moderate", "high"]);

function normalizeSlotLoadDay(loadDay) {
  if (loadDay == null || loadDay === "") return "";
  const s = String(loadDay).trim();
  const map = {
    "Rest Day": "rest",
    "Low Load": "lower",
    Moderate: "moderate",
    "High Load": "high",
    rest: "rest",
    lower: "lower",
    moderate: "moderate",
    high: "high",
  };
  const key = map[s] || map[s.toLowerCase()];
  if (!key || !SLOT_LOAD_DAY_VALUES.has(key)) {
    throw new Error("Invalid load day");
  }
  return key;
}

/** PATCH `loadDay` on a single slot inside missions.v1 / v2 (athlete upload load). */
async function updateMissionSlotLoadDay(studentId, missionId, version, slotId, loadDay) {
  if (!isValidMissionId(missionId)) throw new Error("Invalid mission id");
  if (!["v1", "v2"].includes(version)) throw new Error("Invalid mission version");
  if (!slotId || typeof slotId !== "string") throw new Error("Invalid slot id");
  const cleanLoad = normalizeSlotLoadDay(loadDay);

  const result = await query(
    `UPDATE public.missions
       SET ${version} = jsonb_set(
         COALESCE(${version}, '{}'::jsonb),
         ARRAY[$3::text, 'loadDay'],
         to_jsonb($4::text),
         true
       )
     WHERE student_id = $1 AND mission_id = $2
     RETURNING ${version}`,
    [studentId, missionId, slotId, cleanLoad],
  );

  if (!result.rows?.[0]) throw new Error("Mission row not found");
  return result.rows[0][version] || null;
}

// ────────────────────────────────────────────────────────────────────────────
// v5.2 — KerryDashboard additions
// ────────────────────────────────────────────────────────────────────────────

// PATCH a single slot title inside missions.v1 / v2 / v3 jsonb.
// Used by the v5.2 SlotCol title input (debounced 800 ms on the client).
async function updateMissionSlotTitle(studentId, missionId, version, slotId, title) {
  if (!isValidMissionId(missionId)) throw new Error("Invalid mission id");
  if (!["v1", "v2", "v3"].includes(version)) throw new Error("Invalid mission version");
  if (!slotId || typeof slotId !== "string") throw new Error("Invalid slot id");
  const cleanTitle = typeof title === "string" ? title : "";

  const result = await query(
    `UPDATE public.missions
       SET ${version} = jsonb_set(
         COALESCE(${version}, '{}'::jsonb),
         ARRAY[$3::text, 'title'],
         to_jsonb($4::text),
         true
       )
     WHERE student_id = $1 AND mission_id = $2
     RETURNING ${version}`,
    [studentId, missionId, slotId, cleanTitle],
  );

  if (!result.rows?.[0]) throw new Error("Mission row not found");
  return result.rows[0][version] || null;
}

// Get / Upsert athlete_eer_overrides — one row per (athlete_id, load_day).
// Schema (Phase 1.1 of the v5.2 task sheet):
//   id uuid pk, athlete_id (FK -> students.id), load_day text,
//   overrides jsonb, updated_at timestamptz default now().
async function getEerOverrides(studentId) {
  const result = await query(
    `SELECT athlete_id, load_day, overrides, updated_at
       FROM public.athlete_eer_overrides
      WHERE athlete_id = $1`,
    [studentId],
  );
  return result.rows.map((r) => ({
    athleteId: r.athlete_id,
    loadDay: r.load_day,
    overrides: r.overrides || {},
    updatedAt: r.updated_at,
  }));
}

async function saveEerOverrides(studentId, loadDay, overrides) {
  if (!["Lower", "Moderate", "High"].includes(loadDay)) {
    throw new Error("loadDay must be Lower | Moderate | High");
  }
  const payload = overrides && typeof overrides === "object" ? overrides : {};

  const result = await query(
    `INSERT INTO public.athlete_eer_overrides (athlete_id, load_day, overrides, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (athlete_id, load_day)
       DO UPDATE SET overrides = EXCLUDED.overrides, updated_at = now()
     RETURNING athlete_id, load_day, overrides, updated_at`,
    [studentId, loadDay, JSON.stringify(payload)],
  );

  const r = result.rows[0];
  return {
    athleteId: r.athlete_id,
    loadDay: r.load_day,
    overrides: r.overrides || {},
    updatedAt: r.updated_at,
  };
}

module.exports = {
  listStudentsForDashboard,
  updateStudentFeedback,
  updateMissionFeedback,
  replyToQuestion,
  getStudentPrescreen,
  upsertStudentPrescreen,
  getStudentMissions,
  saveMissionProgress,
  submitMissionVersion,
  assertSubmissionAllowed,
  updateMissionSlotDesc,
  updateMissionSlotLoadDay,
  updateMissionSlotTitle,
  getEerOverrides,
  saveEerOverrides,
};
