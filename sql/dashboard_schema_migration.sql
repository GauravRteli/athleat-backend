-- Additive schema changes for athlete dashboard integration.

-- 1) Extend students for first/last name compatibility.
ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS last_login timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 2) Unlock tracking table.
CREATE TABLE IF NOT EXISTS public.student_unlocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  module_key text NOT NULL,
  unlocked_at timestamptz DEFAULT now(),
  UNIQUE (student_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_student_unlocks_student_id
  ON public.student_unlocks (student_id);

CREATE INDEX IF NOT EXISTS idx_student_unlocks_module_key
  ON public.student_unlocks (module_key);

-- 3) Food preferences table.
CREATE TABLE IF NOT EXISTS public.student_food_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL UNIQUE REFERENCES public.students(id) ON DELETE CASCADE,
  selections jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  updated_at timestamptz DEFAULT now()
);

-- 4) Compatibility view for JSX naming.
CREATE OR REPLACE VIEW public.athlete_profiles_v AS
SELECT
  s.id,
  s.email,
  s.first_name,
  s.last_name,
  s.created_at
FROM public.students s;

