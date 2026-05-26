-- ============================================================================
-- ATHLEAT — gate Kez analysis with explicit "send to athlete" + athlete submit
-- ============================================================================
-- Why
--   Until now, every meal_analysis row was implicitly visible to the athlete
--   as soon as Kerry ran Kez. We now want:
--     1. Kerry presses "Send to {firstName}" on a specific analysis before the
--        athlete sees the Kez result, tags, or coach analysis.
--     2. The athlete presses "Submit" on the sent analysis to acknowledge it.
--        That state survives reloads. If Kerry re-runs the analysis (which
--        INSERTs a fresh row) both flags reset naturally on the new row.
--
-- Idempotent.
-- ============================================================================

ALTER TABLE public.meal_analysis
  ADD COLUMN IF NOT EXISTS sent_to_athlete_at  timestamptz,
  ADD COLUMN IF NOT EXISTS athlete_submitted_at timestamptz;

-- Helpful index for the athlete read path (latest sent analysis per slot/version).
CREATE INDEX IF NOT EXISTS idx_meal_analysis_sent_to_athlete
  ON public.meal_analysis (student_id, mission_id, slot_id, version, sent_to_athlete_at);
