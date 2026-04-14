-- ============================================================================
-- ATHLEAT — Full Schema for Supabase PostgreSQL
-- Run this in the Supabase SQL Editor (or via psql against DIRECT_URL).
-- ============================================================================

-- 1. students
CREATE TABLE IF NOT EXISTS public.students (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  thinkific_user_id    text        UNIQUE NOT NULL,
  full_name            text        NOT NULL,
  email                text,
  created_at           timestamptz DEFAULT now(),
  quest_xp             integer     DEFAULT 0,
  best_streak          integer     DEFAULT 0,
  badges_earned        text[]      DEFAULT '{}',
  feedback_status      text        DEFAULT 'none',
  kerry_feedback       text,
  feedback_approved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_students_thinkific ON public.students (thinkific_user_id);
CREATE INDEX IF NOT EXISTS idx_students_feedback  ON public.students (feedback_status);

-- 2. prescreen
CREATE TABLE IF NOT EXISTS public.prescreen (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       uuid        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  dob              date,
  school_year      text,
  referral         text,
  ethnicity        text,
  blood_test       text,
  medical          text[],
  medical_dates    jsonb,
  supplements      text,
  sex              text,
  menstrual        text,
  height_cm        integer,
  weight_kg        numeric(5,1),
  weight_trend     text,
  living_with      text[],
  cooking          text,
  cooking_skills   text,
  fav_foods        text,
  dislike_foods    text,
  dietary_reqs     text[],
  eating_style     text[],
  takeaway_frequency text,
  takeaway_foods   text,
  goals            text[],
  biggest_challenges text[],
  meal_priority    text,
  help_areas       text[],
  top_questions    text,
  info_sources     text[],
  activity_type    text[],
  days_low         integer,
  days_med         integer,
  days_high        integer,
  session_length   text,
  hunger_grid      jsonb,
  completed_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_prescreen_student ON public.prescreen (student_id);

-- 3. blueprint_answers
CREATE TABLE IF NOT EXISTS public.blueprint_answers (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   uuid        NOT NULL UNIQUE REFERENCES public.students(id) ON DELETE CASCADE,
  answers      jsonb       NOT NULL,
  xp_earned    integer     DEFAULT 0,
  badges       text[]      DEFAULT '{}',
  completed_at timestamptz,
  updated_at   timestamptz DEFAULT now()
);

-- 4. missions
CREATE TABLE IF NOT EXISTS public.missions (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id           uuid        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  mission_id           text        NOT NULL,
  status               text        DEFAULT 'not_started',
  v1                   jsonb,
  v2                   jsonb,
  v3                   jsonb,
  submitted_at         timestamptz,
  v2_submitted_at      timestamptz,
  kerry_feedback       text,
  feedback_status      text        DEFAULT 'none',
  feedback_approved_at timestamptz,
  UNIQUE (student_id, mission_id)
);

CREATE INDEX IF NOT EXISTS idx_missions_student  ON public.missions (student_id);
CREATE INDEX IF NOT EXISTS idx_missions_status   ON public.missions (feedback_status);

-- 5. questions
CREATE TABLE IF NOT EXISTS public.questions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  uuid        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  text        text        NOT NULL,
  asked_at    timestamptz DEFAULT now(),
  status      text        DEFAULT 'pending',
  reply       text,
  replied_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_questions_student ON public.questions (student_id);
CREATE INDEX IF NOT EXISTS idx_questions_status  ON public.questions (status);

-- 6. mission_config
CREATE TABLE IF NOT EXISTS public.mission_config (
  id         text        PRIMARY KEY,
  name       text        NOT NULL,
  icon       text,
  module     text,
  "desc"     text,
  next_step  text,
  slots      jsonb       NOT NULL,
  updated_at timestamptz DEFAULT now()
);

-- Seed mission_config with the 5 default mission definitions
INSERT INTO public.mission_config (id, name, icon, module, "desc", next_step, slots) VALUES
  ('m1', 'Mission 1 — Breakfast Pics', '🌅', 'After completing your Blueprint',
   'Upload 3 pics of your breakfast on 3 different training days.',
   'Head back to Thinkific to complete the breakfast modules.',
   '[{"id":"b1","label":"Breakfast 1","hint":"e.g. 2 Weet-Bix + 200ml full cream milk + 1 banana"},{"id":"b2","label":"Breakfast 2","hint":"e.g. 2 eggs scrambled + 2 slices wholegrain toast + 250ml OJ"},{"id":"b3","label":"Breakfast 3","hint":"e.g. 3/4 cup Chobani Greek yoghurt + berries + granola"}]'),
  ('m2', 'Mission 2 — Lunch Pics', '☀️', 'After Module 2: Carbohydrates and Fuel',
   'Upload 3 pics of your lunch on 3 different training days.',
   'Head back to complete the carbohydrates module.',
   '[{"id":"l1","label":"Lunch 1","hint":"e.g. 2 wholegrain rolls + shaved chicken + salad + water"},{"id":"l2","label":"Lunch 2","hint":"e.g. 1 cup pasta + tuna + corn + capsicum + light mayo"},{"id":"l3","label":"Lunch 3","hint":"e.g. 2 slices Burgen bread + avocado + 2 poached eggs + spinach"}]'),
  ('m3', 'Mission 3 — Dinner Pics', '🌙', 'After Module 3: Protein and Recovery',
   'Upload 3 pics of your dinner on 3 different evenings.',
   'Head back to complete the protein and recovery modules.',
   '[{"id":"d1","label":"Dinner 1","hint":"e.g. 150g grilled chicken + rice + 2 fists roasted veg"},{"id":"d2","label":"Dinner 2","hint":"e.g. 150g beef mince bolognese + 1.5 cups penne + side salad"},{"id":"d3","label":"Dinner 3","hint":"e.g. 2 basa fillets (baked) + sweet potato + steamed broccoli"}]'),
  ('m4', 'Mission 4 — Training Meals', '⚡', 'After Module 4: Training Nutrition',
   'Upload your pre-training snack, post-training recovery and a daytime snack.',
   'Head back to complete the training nutrition modules.',
   '[{"id":"pre","label":"Pre-Training Snack","hint":"e.g. banana + toast with peanut butter — 90 min before training"},{"id":"post","label":"Post-Training Recovery","hint":"e.g. 300ml chocolate milk + yoghurt — within 20 min of finishing"},{"id":"snk","label":"Daytime Snack","hint":"e.g. Greek yoghurt + blueberries + nuts — at 3pm"}]'),
  ('m5', 'Mission 5 — Game Day Pics', '🏉', 'After Module 5: Game Day Nutrition',
   'Upload your full game day nutrition — pre-game, half-time and post-game.',
   'Head back to complete the game day module.',
   '[{"id":"pre","label":"Pre-Game Meal","hint":"e.g. pasta + chicken + salad — 3 hours before kick-off"},{"id":"half","label":"Half-Time Snack","hint":"e.g. orange quarters + Gatorade + muesli bar"},{"id":"post","label":"Post-Game Recovery Meal","hint":"e.g. chicken burger + banana + chocolate milk — 45 min after full-time"}]')
ON CONFLICT (id) DO NOTHING;
