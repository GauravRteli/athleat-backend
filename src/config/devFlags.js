/**
 * TEMP development flags — flip before production.
 *
 * DEV_UNLOCK_ALL_MISSIONS:
 *   - Skips prescreen → food-prefs → breakfast → lunch … chain on submit
 *   - Returns all missions as unlocked in GET /api/athlete/missions
 *   - Does not filter orphan student_unlocks keys on GET /api/athlete/me
 *
 * Set env DEV_UNLOCK_ALL_MISSIONS=false to disable without editing code.
 */
const DEV_UNLOCK_ALL_MISSIONS =
  process.env.DEV_UNLOCK_ALL_MISSIONS !== "false" &&
  process.env.DEV_UNLOCK_ALL_MISSIONS !== "0";

/** All sidebar / submit module_key values used by the athlete dashboard. */
function allAthleteModuleKeys() {
  const keys = ["pre-screen", "food-preferences"];
  for (let i = 1; i <= 5; i++) {
    keys.push(`mission-${i}-v1`, `mission-${i}-v23`);
  }
  keys.push(
    "training-planner",
    "game-day-planner",
    "shopping-list",
    "view-plan",
  );
  return keys;
}

module.exports = { DEV_UNLOCK_ALL_MISSIONS, allAthleteModuleKeys };
