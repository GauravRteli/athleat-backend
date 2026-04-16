-- Optional historical backfill for mission unlock progression.
-- Safe to run multiple times.

-- Mission N V1 complete -> unlock mission-N-v23
INSERT INTO public.student_unlocks (student_id, module_key)
SELECT DISTINCT m.student_id, CONCAT('mission-', REPLACE(m.mission_id, 'm', ''), '-v23')
FROM public.missions m
WHERE m.status = 'submitted'
  AND m.v1 IS NOT NULL
ON CONFLICT (student_id, module_key) DO NOTHING;

-- Mission N V2 complete -> unlock mission-(N+1)-v1
INSERT INTO public.student_unlocks (student_id, module_key)
SELECT DISTINCT
  m.student_id,
  CONCAT('mission-', (CAST(REPLACE(m.mission_id, 'm', '') AS integer) + 1)::text, '-v1')
FROM public.missions m
WHERE m.status = 'submitted'
  AND m.v2 IS NOT NULL
  AND m.mission_id IN ('m1', 'm2', 'm3', 'm4')
ON CONFLICT (student_id, module_key) DO NOTHING;
