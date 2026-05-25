-- ─────────────────────────────────────────────────────────────────────────────
-- ATHLEAT — Per-athlete EER overrides (Kerry Dashboard v5.2)
-- Migration: 2026-05-25
--
-- Backs GET/PATCH /api/students/:studentId/eer-overrides
-- (studentService.getEerOverrides / saveEerOverrides).
--
-- One row per (athlete_id, load_day) where load_day is Lower | Moderate | High.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.athlete_eer_overrides (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  load_day    text NOT NULL,
  overrides   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT athlete_eer_overrides_load_day_check
    CHECK (load_day IN ('Lower', 'Moderate', 'High')),
  CONSTRAINT athlete_eer_overrides_athlete_load_unique
    UNIQUE (athlete_id, load_day)
);

CREATE INDEX IF NOT EXISTS idx_athlete_eer_overrides_athlete
  ON public.athlete_eer_overrides (athlete_id);

ALTER TABLE public.athlete_eer_overrides ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'athlete_eer_overrides'
      AND policyname = 'athlete_eer_overrides_dashboard_full'
  ) THEN
    CREATE POLICY "athlete_eer_overrides_dashboard_full"
      ON public.athlete_eer_overrides FOR ALL USING (true);
  END IF;
END $$;
