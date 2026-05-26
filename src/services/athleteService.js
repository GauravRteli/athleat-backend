const { query } = require("../config/postgres");
const { getEerConfig } = require("./eerConfigService");
const { computeDailyEER, classifyLoadFromPrescreen } = require("./kez/targets");
const { DEV_UNLOCK_ALL_MISSIONS } = require("../config/devFlags");
const {
  filterUnlocksForProgression,
  isModuleUnlockAllowed,
  isMissionGroupAccessible,
  missionModuleKeys,
} = require("./unlockProgression");
const MISSION_IDS = ["m1", "m2", "m3", "m4", "m5"];

function splitName(fullName) {
  const parts = String(fullName || "").trim().split(" ").filter(Boolean);
  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
  };
}

function shapeAthlete(row) {
  const fallback = splitName(row.full_name);
  return {
    id: row.id,
    firstName: row.first_name || fallback.firstName,
    lastName: row.last_name || fallback.lastName,
    email: row.email || "",
  };
}

async function getAthleteById(studentId) {
  const result = await query(
    `SELECT id, first_name, last_name, full_name, email
     FROM public.students WHERE id = $1 LIMIT 1`,
    [studentId],
  );
  return result.rows[0] || null;
}

/** First token for RAG / chat prompts — same fallbacks as `shapeAthlete` (trimmed DB first_name, else full_name). */
async function resolveAthleteChatFirstName(studentId) {
  const row = await getAthleteById(studentId);
  if (!row) return null;
  const fallback = splitName(row.full_name);
  const first = String(row.first_name || "").trim() || fallback.firstName || "";
  return first;
}

async function getAthleteMe(studentId) {
  const row = await getAthleteById(studentId);
  if (!row) return null;

  const unlockRes = await query(
    `SELECT module_key FROM public.student_unlocks WHERE student_id = $1 ORDER BY unlocked_at ASC`,
    [studentId],
  );
  const rawUnlocks = ["pre-screen", ...unlockRes.rows.map((r) => r.module_key)].filter(
    (v, i, arr) => arr.indexOf(v) === i,
  );

  const [missions, foodPrefs, prescreenRes] = await Promise.all([
    getAthleteMissions(studentId),
    getFoodPrefs(studentId),
    query(`SELECT 1 FROM public.prescreen WHERE student_id = $1 LIMIT 1`, [studentId]),
  ]);
  const unlocks = filterUnlocksForProgression(rawUnlocks, missions, {
    prescreenDone: prescreenRes.rows.length > 0,
    foodPrefsDone: !!foodPrefs.completedAt,
  });

  return { athlete: shapeAthlete(row), unlocks };
}

async function upsertUnlock(studentId, moduleKey) {
  const unlockRes = await query(
    `SELECT module_key FROM public.student_unlocks WHERE student_id = $1`,
    [studentId],
  );
  const rawUnlocks = ["pre-screen", ...unlockRes.rows.map((r) => r.module_key)];
  const missions = await getAthleteMissions(studentId);
  const foodPrefs = await getFoodPrefs(studentId);
  const prescreenRes = await query(
    `SELECT 1 FROM public.prescreen WHERE student_id = $1 LIMIT 1`,
    [studentId],
  );
  const gates = {
    prescreenDone: prescreenRes.rows.length > 0,
    foodPrefsDone: !!foodPrefs.completedAt,
  };
  if (!isModuleUnlockAllowed(moduleKey, rawUnlocks, missions, gates)) {
    return { moduleKey, skipped: true, reason: "Prerequisite step not complete." };
  }

  const res = await query(
    `INSERT INTO public.student_unlocks (student_id, module_key, unlocked_at)
     VALUES ($1, $2, now())
     ON CONFLICT (student_id, module_key)
     DO UPDATE SET unlocked_at = public.student_unlocks.unlocked_at
     RETURNING module_key, unlocked_at`,
    [studentId, moduleKey],
  );
  return {
    moduleKey: res.rows[0].module_key,
    unlockedAt: res.rows[0].unlocked_at,
  };
}

function toModuleKey(missionId, suffix) {
  const number = String(missionId || "").replace("m", "");
  return number ? `mission-${number}-${suffix}` : null;
}

function resolveMissionProgressionTargets(eventKey, missionId) {
  const idx = MISSION_IDS.indexOf(missionId);
  if (idx < 0) return [];
  if (eventKey === "mission_v1_submitted") {
    const key = toModuleKey(missionId, "v23");
    return key ? [key] : [];
  }
  if (eventKey === "mission_v2_submitted") {
    const nextMissionId = MISSION_IDS[idx + 1];
    if (!nextMissionId) return [];
    const key = toModuleKey(nextMissionId, "v1");
    return key ? [key] : [];
  }
  return [];
}

async function applyUnlockProgression(studentId, eventKey, context = {}) {
  const staticEventToUnlocks = {
    prescreen_submitted: ["food-preferences"],
    food_preferences_saved: ["mission-1-v1"],
  };
  const dynamicTargets = resolveMissionProgressionTargets(eventKey, context.missionId);
  const unlockTargets = [...(staticEventToUnlocks[eventKey] || []), ...dynamicTargets];
  if (!unlockTargets.length) return [];

  const newlyUnlocked = [];
  for (const moduleKey of unlockTargets) {
    const res = await query(
      `INSERT INTO public.student_unlocks (student_id, module_key, unlocked_at)
       VALUES ($1, $2, now())
       ON CONFLICT (student_id, module_key) DO NOTHING
       RETURNING module_key`,
      [studentId, moduleKey],
    );
    if (res.rows[0]?.module_key) newlyUnlocked.push(res.rows[0].module_key);
  }
  return newlyUnlocked;
}

function shapeMission(row) {
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

/** Pull Fuel/Repair/Protect tags from meal_analysis.model_meta (Kez Prompt 4). */
function tagsFromMealAnalysisMeta(modelMeta) {
  if (!modelMeta) return null;
  let meta = modelMeta;
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch {
      return null;
    }
  }
  const tags = meta?.tags;
  if (!tags || typeof tags !== "object") return null;
  const fuel = tags.fuel != null ? String(tags.fuel) : "";
  const repair = tags.repair != null ? String(tags.repair) : "";
  const protect = tags.protect != null ? String(tags.protect) : "";
  if (!fuel && !repair && !protect) return null;
  return { fuel, repair, protect };
}

/**
 * Attach the LATEST Kez analysis Kerry has sent onto each mission v1/v2/v3
 * slot for the athlete UI.
 *
 * Gating rules (must mirror frontend expectations):
 *   • Only rows where `sent_to_athlete_at IS NOT NULL` are surfaced.
 *   • If Kerry re-runs Kez a fresh row is INSERTed (no defaults), so the
 *     athlete instantly loses access to the previous analysis until Kerry
 *     presses "Send to athlete" again on the new one.
 *   • `athlete_submitted_at` powers the "Submit / ✓ Re-submitted" toggle.
 *
 * Per-slot payload added:
 *   {
 *     analysisId, sentAt, submittedAt,
 *     coachAnalysis (Kez Prompt-4 feedback_text),
 *     loadDay, mealText, macros, target, tags
 *   }
 */
async function attachMealAnalysisTagsToMissions(studentId, missions) {
  const { rows } = await query(
    `SELECT DISTINCT ON (mission_id, slot_id, version)
            id, mission_id, slot_id, version,
            load_day, meal_text, feedback_text,
            macro_totals, target_band, vs_targets,
            model_meta, sent_to_athlete_at, athlete_submitted_at
       FROM public.meal_analysis
      WHERE student_id = $1
        AND sent_to_athlete_at IS NOT NULL
      ORDER BY mission_id, slot_id, version, created_at DESC`,
    [studentId],
  );

  for (const row of rows) {
    const mission = missions[row.mission_id];
    if (!mission) continue;
    const slotId = row.slot_id;
    if (!slotId) continue;
    const verKey =
      row.version === "v2" ? "v2" : row.version === "v3" ? "v3" : "v1";

    const tags = tagsFromMealAnalysisMeta(row.model_meta);
    const versionData = mission[verKey];
    const base =
      versionData && typeof versionData === "object" && !Array.isArray(versionData)
        ? versionData
        : {};
    const slotPayload =
      base[slotId] && typeof base[slotId] === "object" ? { ...base[slotId] } : {};

    const sentKez = {
      analysisId: row.id,
      sentAt: row.sent_to_athlete_at,
      submittedAt: row.athlete_submitted_at,
      coachAnalysis: row.feedback_text || "",
      loadDay: row.load_day || null,
      mealText: row.meal_text || "",
      macros: row.macro_totals || {},
      target: row.target_band || {},
      vsTargets: row.vs_targets || {},
    };

    base[slotId] = {
      ...slotPayload,
      ...(tags ? { tags } : {}),
      sentKez,
    };
    mission[verKey] = base;
  }

  return missions;
}

async function getAthleteMissions(studentId) {
  const result = await query(
    `SELECT *
     FROM public.missions
     WHERE student_id = $1
     ORDER BY mission_id`,
    [studentId],
  );

  const byId = {};
  result.rows.forEach((row) => {
    byId[row.mission_id] = shapeMission(row);
  });

  const missions = {};
  MISSION_IDS.forEach((missionId) => {
    missions[missionId] =
      byId[missionId] ||
      {
        missionId,
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
  });

  const [unlockRes, foodPrefs, prescreenRes] = await Promise.all([
    query(
      `SELECT module_key FROM public.student_unlocks WHERE student_id = $1`,
      [studentId],
    ),
    getFoodPrefs(studentId),
    query(`SELECT 1 FROM public.prescreen WHERE student_id = $1 LIMIT 1`, [studentId]),
  ]);
  const rawUnlocks = ["pre-screen", ...unlockRes.rows.map((r) => r.module_key)];
  const effectiveUnlocks = filterUnlocksForProgression(rawUnlocks, missions, {
    prescreenDone: prescreenRes.rows.length > 0,
    foodPrefsDone: !!foodPrefs.completedAt,
  });

  MISSION_IDS.forEach((missionId, idx) => {
    const keys = missionModuleKeys(idx);
    missions[missionId].unlocked =
      DEV_UNLOCK_ALL_MISSIONS ||
      isMissionGroupAccessible(idx, missions, effectiveUnlocks, {
        v1Key: keys.v1,
        v23Key: keys.v23,
      });
  });

  await attachMealAnalysisTagsToMissions(studentId, missions);

  return missions;
}

async function getFoodPrefs(studentId) {
  const res = await query(
    `SELECT selections, completed_at
     FROM public.student_food_preferences
     WHERE student_id = $1
     LIMIT 1`,
    [studentId],
  );
  const row = res.rows[0];
  return {
    selections: row?.selections || {},
    completedAt: row?.completed_at || null,
  };
}

async function upsertFoodPrefs(studentId, selections, completedAt) {
  await query(
    `INSERT INTO public.student_food_preferences
      (student_id, selections, completed_at, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (student_id)
     DO UPDATE SET
       selections = EXCLUDED.selections,
       completed_at = EXCLUDED.completed_at,
       updated_at = now()`,
    [studentId, JSON.stringify(selections || {}), completedAt],
  );
  const newlyUnlocked = await applyUnlockProgression(studentId, "food_preferences_saved");
  return { ok: true, newlyUnlocked };
}

async function getFoodPrefsCatalog() {
  const res = await query(
    `SELECT
       fc.id   AS category_id,
       fc.name AS category_name,
       fl.id   AS flag_id,
       fl.name AS flag_name,
       fl.emoji AS flag_emoji,
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
      flag = { id: row.flag_id, name: row.flag_name, emoji: row.flag_emoji || null, items: [] };
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

/** Same EER math as Kerry dashboard (`computeDailyEER` + global `eer_config`). */
const PROTECT_BY_LOAD = { Lower: "5+ serves", Moderate: "5+ serves", High: "4+ serves" };

async function getPlannerNutritionTargets(studentId) {
  const prescreenRes = await query(
    `SELECT * FROM public.prescreen
     WHERE student_id = $1
     ORDER BY completed_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [studentId],
  );
  const ps = prescreenRes.rows[0] || {};
  const eerRow = await getEerConfig();
  const eerConfig = {
    pal: eerRow.pal || {},
    carb_gkg: eerRow.carb_gkg || {},
    protein_gkg: eerRow.protein_gkg,
    fat_gday: eerRow.fat_gday,
  };
  const loads = ["Lower", "Moderate", "High"];
  const byLoad = {};
  let complete = true;
  for (const load of loads) {
    const daily = computeDailyEER(ps, load, eerConfig);
    const key = load.toLowerCase();
    if (!daily) {
      byLoad[key] = null;
      complete = false;
    } else {
      byLoad[key] = {
        energy: `${Number(daily.eerLow).toLocaleString()}–${Number(daily.eerHigh).toLocaleString()} cal`,
        repair: `${daily.protein.low}–${daily.protein.high} g`,
        fuel: `${daily.carb.low}–${daily.carb.high} g`,
        protect: PROTECT_BY_LOAD[load] || "5+ serves",
      };
    }
  }
  const inferred = classifyLoadFromPrescreen(ps);
  const defaultDayType =
    inferred === "High" ? "high" : inferred === "Moderate" ? "moderate" : "lower";
  return {
    lower: byLoad.lower,
    moderate: byLoad.moderate,
    high: byLoad.high,
    complete,
    defaultDayType,
    message: complete
      ? null
      : "Complete your Pre-Screen (date of birth and weight) to see personalised targets.",
  };
}

module.exports = {
  getAthleteMe,
  getAthleteMissions,
  upsertUnlock,
  filterUnlocksForProgression,
  applyUnlockProgression,
  getFoodPrefs,
  upsertFoodPrefs,
  getFoodPrefsCatalog,
  resolveAthleteChatFirstName,
  getPlannerNutritionTargets,
};
