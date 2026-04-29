-- =============================================================================
-- ATHLEAT — Kerry Dashboard v4 Migration
-- Adds the 5 new tables required by KerryDashboard_v4:
--   knowledge_entries  — Brain tab (knowledge / corrections / never / files)
--   meals              — meal headers (V3 carousel + Brain → Foods & Meals)
--   meal_foods         — ingredient rows for each meal (with macros + sort)
--   foods              — verified reference food database (~700–1000 items)
--   eer_config         — single-row editable Henry (2005) calculator config
--
-- Run this once in the Supabase SQL editor (or psql against DIRECT_URL).
-- All statements are idempotent.
-- =============================================================================

-- 1) knowledge_entries ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.knowledge_entries (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text        NOT NULL,
  category      text,
  content       text,
  wrong_answer  text,
  right_answer  text,
  file_name     text,
  file_url      text,
  is_active     boolean     DEFAULT true,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  CONSTRAINT knowledge_entries_type_check
    CHECK (type IN ('knowledge', 'correction', 'never', 'file'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_entries_type
  ON public.knowledge_entries (type);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_active
  ON public.knowledge_entries (is_active);

ALTER TABLE public.knowledge_entries ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'knowledge_entries' AND policyname = 'knowledge_admin_all'
  ) THEN
    CREATE POLICY "knowledge_admin_all" ON public.knowledge_entries
      FOR ALL USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'knowledge_entries' AND policyname = 'knowledge_anon_read'
  ) THEN
    CREATE POLICY "knowledge_anon_read" ON public.knowledge_entries
      FOR SELECT USING (is_active = true);
  END IF;
END $$;


-- 2) meals ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.meals (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text          NOT NULL,
  description     text,
  blueprint_note  text,
  instructions    text,
  tags            text[]        DEFAULT '{}'::text[],
  category        text,
  sub_category    text,
  image_url       text,
  image_prompt    text,
  energy_kj       numeric(8,2),
  energy_kcal     numeric(8,2),
  protein_g       numeric(6,2),
  carb_g          numeric(6,2),
  fat_g           numeric(6,2),
  source          text          DEFAULT 'kerry',
  created_by      uuid,
  is_active       boolean       DEFAULT true,
  created_at      timestamptz   DEFAULT now(),
  updated_at      timestamptz   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meals_category ON public.meals (category);
CREATE INDEX IF NOT EXISTS idx_meals_active   ON public.meals (is_active);
CREATE INDEX IF NOT EXISTS idx_meals_title_search
  ON public.meals USING gin (to_tsvector('english', title));

ALTER TABLE public.meals ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'meals' AND policyname = 'meals_dashboard_full'
  ) THEN
    CREATE POLICY "meals_dashboard_full" ON public.meals FOR ALL USING (true);
  END IF;
END $$;


-- 3) meal_foods ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.meal_foods (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_id      uuid          NOT NULL REFERENCES public.meals (id) ON DELETE CASCADE,
  food_id      uuid,
  food_name    text          NOT NULL,
  weight_g     numeric(7,2),
  energy_kj    numeric(8,2),
  protein_g    numeric(6,2),
  carb_g       numeric(6,2),
  fat_g        numeric(6,2),
  sort_order   integer       DEFAULT 0,
  created_at   timestamptz   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meal_foods_meal ON public.meal_foods (meal_id);

ALTER TABLE public.meal_foods ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'meal_foods' AND policyname = 'meal_foods_dashboard_full'
  ) THEN
    CREATE POLICY "meal_foods_dashboard_full" ON public.meal_foods FOR ALL USING (true);
  END IF;
END $$;


-- 4) foods ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.foods (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  food_name      text          NOT NULL,
  serving_label  text,
  weight_g       numeric(7,2),
  energy_kj      numeric(8,2),
  energy_kcal    numeric(8,2),
  protein_g      numeric(6,2),
  carb_g         numeric(6,2),
  fat_g          numeric(6,2),
  fibre_g        numeric(6,2),
  category       text,
  source         text,
  is_active      boolean       DEFAULT true,
  created_at     timestamptz   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_foods_name_search
  ON public.foods USING gin (to_tsvector('english', food_name));
CREATE INDEX IF NOT EXISTS idx_foods_category ON public.foods (category);
CREATE INDEX IF NOT EXISTS idx_foods_active   ON public.foods (is_active);

ALTER TABLE public.foods ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'foods' AND policyname = 'foods_dashboard_full'
  ) THEN
    CREATE POLICY "foods_dashboard_full" ON public.foods FOR ALL USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'foods' AND policyname = 'foods_anon_read'
  ) THEN
    CREATE POLICY "foods_anon_read" ON public.foods FOR SELECT USING (is_active = true);
  END IF;
END $$;


-- 5) eer_config ───────────────────────────────────────────────────────────────
-- Single-row table holding Kerry's editable Henry (2005) settings.
CREATE TABLE IF NOT EXISTS public.eer_config (
  id           integer       PRIMARY KEY DEFAULT 1,
  pal          jsonb         NOT NULL,
  carb_gkg     jsonb         NOT NULL,
  protein_gkg  jsonb         NOT NULL,
  fat_gday     jsonb         NOT NULL,
  updated_at   timestamptz   DEFAULT now(),
  CONSTRAINT eer_config_singleton CHECK (id = 1)
);

ALTER TABLE public.eer_config ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'eer_config' AND policyname = 'eer_config_dashboard_full'
  ) THEN
    CREATE POLICY "eer_config_dashboard_full" ON public.eer_config FOR ALL USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'eer_config' AND policyname = 'eer_config_anon_read'
  ) THEN
    CREATE POLICY "eer_config_anon_read" ON public.eer_config FOR SELECT USING (true);
  END IF;
END $$;

-- Seed default config (only if empty)
INSERT INTO public.eer_config (id, pal, carb_gkg, protein_gkg, fat_gday)
VALUES (
  1,
  '{"Lower":{"low":1.60,"high":1.75},"Moderate":{"low":1.80,"high":2.00},"High":{"low":2.00,"high":2.15}}'::jsonb,
  '{"Lower":{"low":4.5,"high":5.0},"Moderate":{"low":5.0,"high":6.0},"High":{"low":6.5,"high":7.0}}'::jsonb,
  '{"low":1.6,"high":2.2}'::jsonb,
  '{"low":95,"high":115}'::jsonb
)
ON CONFLICT (id) DO NOTHING;
