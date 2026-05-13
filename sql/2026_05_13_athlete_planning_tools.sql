-- ─────────────────────────────────────────────────────────────────────────────
-- ATHLEAT — Athlete Planning Tools tables
-- Migration: 2026-05-13
--
-- Backs the v4 Athlete Dashboard "Planning Tools" (Training Day Planner,
-- Game Day Planner, Shopping List). Each athlete owns a single row per tool
-- that is upserted on save. The Athlete Dashboard reads/writes these via
-- /api/athlete/training-plan, /game-day-plan and /shopping-list.
--
-- Conceptual schema from spec (renamed to match this codebase, where the
-- canonical athlete table is `public.students`, not `athlete_profiles`):
--
--   training_plans   — Training Day Planner (Build Your Plan + meal times)
--   game_day_plans   — Game Day Planner (AM/PM toggle + slot selections)
--   shopping_lists   — Shopping List (meal selection + generated list)
--
-- All `*_data` columns are JSONB so the dashboard can evolve without
-- additional migrations. `serves` is exposed as a real column on
-- `shopping_lists` so Kerry can sort / report on it cheaply.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Training Day Plans ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.training_plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  plan_data      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- full plan + meal times
  submitted_at   timestamptz,                          -- set on first/explicit submit
  kerry_notes    text,                                 -- nullable — set by Kerry Dashboard
  reviewed_at    timestamptz,                          -- nullable — set when Kerry reviews
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT training_plans_student_unique UNIQUE (student_id)
);

CREATE INDEX IF NOT EXISTS idx_training_plans_student
  ON public.training_plans (student_id);

-- ── 2. Game Day Plans ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.game_day_plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  plan_data      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { gameTime: 'am'|'pm', slots: [...] }
  submitted_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_day_plans_student_unique UNIQUE (student_id)
);

CREATE INDEX IF NOT EXISTS idx_game_day_plans_student
  ON public.game_day_plans (student_id);

-- ── 3. Shopping Lists ────────────────────────────────────────────────────────
-- An athlete can generate a list more than once (different week, different
-- serves), so this table is NOT uniquely keyed on student_id. The dashboard
-- reads the most recent row via ORDER BY created_at DESC LIMIT 1, but the
-- history is preserved for Kerry's review.
CREATE TABLE IF NOT EXISTS public.shopping_lists (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  list_data      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { selectedMeals: [...], items: {protein:[...], carbs:[...], ...} }
  serves         int  NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shopping_lists_student_created
  ON public.shopping_lists (student_id, created_at DESC);

-- ── 4. Updated-at triggers (Postgres pattern used elsewhere in this schema) ──
-- Note: We avoid `DROP TRIGGER` here so Supabase / other SQL UIs do not flag this
-- migration as a "destructive" script. Triggers are created only if missing.
CREATE OR REPLACE FUNCTION public.set_updated_at_timestamp()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $migrate$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND t.tgname = 'trg_training_plans_updated_at'
      AND n.nspname = 'public'
      AND c.relname = 'training_plans'
  ) THEN
    CREATE TRIGGER trg_training_plans_updated_at
      BEFORE UPDATE ON public.training_plans
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND t.tgname = 'trg_game_day_plans_updated_at'
      AND n.nspname = 'public'
      AND c.relname = 'game_day_plans'
  ) THEN
    CREATE TRIGGER trg_game_day_plans_updated_at
      BEFORE UPDATE ON public.game_day_plans
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END
$migrate$;
