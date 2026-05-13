/**
 * planningService — CRUD for the Athlete Dashboard "Planning Tools".
 *
 * Backs three tables:
 *   public.training_plans  (one row per student, upserted)
 *   public.game_day_plans  (one row per student, upserted)
 *   public.shopping_lists  (history — most recent row returned to athlete)
 *
 * All routes that call into here are gated by `requireAthleteAuth`, which
 * sets `req.auth.studentId`. Never accept athlete IDs from request bodies.
 */
const { query } = require("../config/postgres");

// ── Training Day Plan ────────────────────────────────────────────────────────
async function getTrainingPlan(studentId) {
  const res = await query(
    `SELECT plan_data, submitted_at, kerry_notes, reviewed_at, updated_at
       FROM public.training_plans
      WHERE student_id = $1
      LIMIT 1`,
    [studentId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    planData: row.plan_data || {},
    submittedAt: row.submitted_at,
    kerryNotes: row.kerry_notes || "",
    reviewedAt: row.reviewed_at,
    updatedAt: row.updated_at,
  };
}

async function upsertTrainingPlan(studentId, planData, { submit = false } = {}) {
  const submittedAtClause = submit ? "now()" : "training_plans.submitted_at";
  const res = await query(
    `INSERT INTO public.training_plans (student_id, plan_data, submitted_at, updated_at)
     VALUES ($1, $2, ${submit ? "now()" : "NULL"}, now())
     ON CONFLICT (student_id) DO UPDATE
       SET plan_data    = EXCLUDED.plan_data,
           submitted_at = ${submittedAtClause},
           updated_at   = now()
     RETURNING plan_data, submitted_at, kerry_notes, reviewed_at, updated_at`,
    [studentId, JSON.stringify(planData || {})],
  );
  const row = res.rows[0];
  return {
    planData: row.plan_data || {},
    submittedAt: row.submitted_at,
    kerryNotes: row.kerry_notes || "",
    reviewedAt: row.reviewed_at,
    updatedAt: row.updated_at,
  };
}

// ── Game Day Plan ────────────────────────────────────────────────────────────
async function getGameDayPlan(studentId) {
  const res = await query(
    `SELECT plan_data, submitted_at, updated_at
       FROM public.game_day_plans
      WHERE student_id = $1
      LIMIT 1`,
    [studentId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    planData: row.plan_data || {},
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

async function upsertGameDayPlan(studentId, planData, { submit = true } = {}) {
  const submittedAtClause = submit ? "now()" : "game_day_plans.submitted_at";
  const res = await query(
    `INSERT INTO public.game_day_plans (student_id, plan_data, submitted_at, updated_at)
     VALUES ($1, $2, ${submit ? "now()" : "NULL"}, now())
     ON CONFLICT (student_id) DO UPDATE
       SET plan_data    = EXCLUDED.plan_data,
           submitted_at = ${submittedAtClause},
           updated_at   = now()
     RETURNING plan_data, submitted_at, updated_at`,
    [studentId, JSON.stringify(planData || {})],
  );
  const row = res.rows[0];
  return {
    planData: row.plan_data || {},
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

// ── Shopping List ────────────────────────────────────────────────────────────
async function getLatestShoppingList(studentId) {
  const res = await query(
    `SELECT id, list_data, serves, created_at
       FROM public.shopping_lists
      WHERE student_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [studentId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    listData: row.list_data || {},
    serves: row.serves,
    createdAt: row.created_at,
  };
}

async function insertShoppingList(studentId, listData, serves) {
  const safeServes = Number.isFinite(Number(serves)) ? Math.max(1, Math.round(Number(serves))) : 1;
  const res = await query(
    `INSERT INTO public.shopping_lists (student_id, list_data, serves)
     VALUES ($1, $2, $3)
     RETURNING id, list_data, serves, created_at`,
    [studentId, JSON.stringify(listData || {}), safeServes],
  );
  const row = res.rows[0];
  return {
    id: row.id,
    listData: row.list_data || {},
    serves: row.serves,
    createdAt: row.created_at,
  };
}

module.exports = {
  getTrainingPlan,
  upsertTrainingPlan,
  getGameDayPlan,
  upsertGameDayPlan,
  getLatestShoppingList,
  insertShoppingList,
};
