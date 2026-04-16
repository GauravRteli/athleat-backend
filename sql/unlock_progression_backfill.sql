-- Optional historical backfill for unlock progression.
-- Safe to run multiple times.

-- If prescreen exists, ensure food-preferences unlock.
INSERT INTO public.student_unlocks (student_id, module_key)
SELECT DISTINCT p.student_id, 'food-preferences'
FROM public.prescreen p
ON CONFLICT (student_id, module_key) DO NOTHING;

-- If food preferences exists, ensure mission-1-v1 unlock.
INSERT INTO public.student_unlocks (student_id, module_key)
SELECT DISTINCT fp.student_id, 'mission-1-v1'
FROM public.student_food_preferences fp
ON CONFLICT (student_id, module_key) DO NOTHING;

-- If mission 1 v1 has been submitted, ensure mission-1-v23 unlock.
INSERT INTO public.student_unlocks (student_id, module_key)
SELECT DISTINCT m.student_id, 'mission-1-v23'
FROM public.missions m
WHERE m.mission_id = 'm1'
  AND m.status = 'submitted'
  AND m.v1 IS NOT NULL
ON CONFLICT (student_id, module_key) DO NOTHING;
