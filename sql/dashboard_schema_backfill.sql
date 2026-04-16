-- Backfill script for dashboard additive schema rollout.
-- Run after dashboard_schema_migration.sql

-- Split full_name into first_name / last_name if empty.
WITH parsed AS (
  SELECT
    id,
    NULLIF(split_part(trim(full_name), ' ', 1), '') AS parsed_first_name,
    NULLIF(
      trim(
        substring(trim(full_name) FROM length(split_part(trim(full_name), ' ', 1)) + 1)
      ),
      ''
    ) AS parsed_last_name
  FROM public.students
)
UPDATE public.students s
SET
  first_name = COALESCE(s.first_name, p.parsed_first_name),
  last_name = COALESCE(s.last_name, p.parsed_last_name),
  updated_at = now()
FROM parsed p
WHERE s.id = p.id
  AND (s.first_name IS NULL OR s.last_name IS NULL);

-- Seed default unlock for existing students.
INSERT INTO public.student_unlocks (student_id, module_key)
SELECT s.id, 'pre-screen'
FROM public.students s
ON CONFLICT (student_id, module_key) DO NOTHING;

-- Existing students without password_hash are intentionally left as NULL.
-- They will need credential provisioning before password login can succeed.

