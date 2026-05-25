/**
 * Cascading unlock filter — strips orphan `student_unlocks` rows that skip the
 * linear chain (prescreen → food-prefs → m1 → m2 → … → tools).
 */
const {
  DEV_UNLOCK_ALL_MISSIONS,
  allAthleteModuleKeys,
} = require("../config/devFlags");
const MISSION_IDS = ["m1", "m2", "m3", "m4", "m5"];

const TOOL_DEPS = {
  "training-planner": ["mission-4-v1", "mission-4-v23"],
  "game-day-planner": ["mission-5-v1"],
  "shopping-list": ["mission-4-v23"],
  "view-plan": ["mission-4-v23"],
};

function missionModuleKeys(index) {
  const n = index + 1;
  return { v1: `mission-${n}-v1`, v23: `mission-${n}-v23` };
}

/**
 * @param {string[]} rawUnlocks - keys from DB (+ synthetic pre-screen)
 * @param {Record<string, { v2SubmittedAt?: string|null }>} missionsById
 * @param {{ prescreenDone?: boolean, foodPrefsDone?: boolean }} gates
 */
function filterUnlocksForProgression(rawUnlocks, missionsById = {}, gates = {}) {
  const raw = Array.isArray(rawUnlocks) ? rawUnlocks : [];
  if (DEV_UNLOCK_ALL_MISSIONS) {
    return [...new Set([...allAthleteModuleKeys(), ...raw])];
  }
  const out = new Set(["pre-screen"]);

  const prescreenOk =
    gates.prescreenDone === true ||
    raw.includes("food-preferences") ||
    raw.some((k) => k.startsWith("mission-"));

  if (!prescreenOk) return [...out];

  const foodOk =
    gates.foodPrefsDone === true || raw.includes("food-preferences");
  if (foodOk) out.add("food-preferences");
  if (!out.has("food-preferences")) return [...out];

  for (let i = 0; i < MISSION_IDS.length; i++) {
    if (i > 0) {
      const prev = missionsById[MISSION_IDS[i - 1]];
      const prevKeys = missionModuleKeys(i - 1);
      if (!prev?.v2SubmittedAt) break;
      // Do not grant m{n+1} keys unless m{n} keys are already in the chain
      // (prevents Lunch open while Breakfast nav is still locked).
      if (!out.has(prevKeys.v1) && !out.has(prevKeys.v23)) break;
    }
    const m = missionsById[MISSION_IDS[i]];
    const { v1, v23 } = missionModuleKeys(i);
    if (m?.submittedAt) out.add(v1);
    if (m?.v2SubmittedAt) out.add(v23);
    if (raw.includes(v1)) out.add(v1);
    if (raw.includes(v23)) out.add(v23);
  }

  for (const [toolKey, deps] of Object.entries(TOOL_DEPS)) {
    if (deps.some((d) => out.has(d)) && raw.includes(toolKey)) {
      out.add(toolKey);
    }
  }

  return [...out];
}

/** Whether a Thinkific/manual unlock POST is allowed right now. */
function isModuleUnlockAllowed(moduleKey, rawUnlocks, missionsById = {}, gates = {}) {
  if (DEV_UNLOCK_ALL_MISSIONS) return true;
  const filtered = new Set(
    filterUnlocksForProgression(rawUnlocks, missionsById, gates),
  );
  if (moduleKey === "pre-screen") return true;
  if (filtered.has(moduleKey)) return true;

  const next = filterUnlocksForProgression(
    [...rawUnlocks, moduleKey],
    missionsById,
    gates,
  );
  return next.includes(moduleKey);
}

/** Mission index 0..4 (m1..m5) reachable in the athlete nav. */
function isMissionGroupAccessible(missionIndex, missionsById, effectiveUnlocks, def) {
  if (DEV_UNLOCK_ALL_MISSIONS) return true;
  if (!effectiveUnlocks.includes("food-preferences")) return false;

  for (let j = 0; j < missionIndex; j++) {
    const prevKeys = missionModuleKeys(j);
    const prevHasKey =
      effectiveUnlocks.includes(prevKeys.v1) ||
      effectiveUnlocks.includes(prevKeys.v23);
    if (!prevHasKey) return false;
    const prev = missionsById[MISSION_IDS[j]];
    if (!prev?.v2SubmittedAt) return false;
  }

  if (missionIndex > 0) {
    const prev = missionsById[MISSION_IDS[missionIndex - 1]];
    if (!prev?.v2SubmittedAt) return false;
  }

  return (
    effectiveUnlocks.includes(def.v1Key) ||
    effectiveUnlocks.includes(def.v23Key)
  );
}

module.exports = {
  MISSION_IDS,
  missionModuleKeys,
  filterUnlocksForProgression,
  isModuleUnlockAllowed,
  isMissionGroupAccessible,
};
