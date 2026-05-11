-- =============================================================================
-- ATHLEAT — V3 carousel polish
-- Idempotent. Safe to re-run. Adds the two columns the new save-suggestion
-- endpoint writes to and ensures `carousel_settings` has a sensible default.
-- =============================================================================

-- 1. `meal_carousel_draft` columns used by the new V3 pipeline.
--    `image_prompt` is the text the V3 carousel builds for OpenAI Images so
--    Kerry's Brain drafts can re-generate the same image later if needed.
--    `meal_id` mirrors the older `created_meal_id` column — having both
--    keeps both old (drafts → meals) and new (save-suggestion) flows happy.
ALTER TABLE public.meal_carousel_draft
  ADD COLUMN IF NOT EXISTS image_prompt text,
  ADD COLUMN IF NOT EXISTS meal_id      bigint;

-- Keep `meal_id` and `created_meal_id` in sync when either is set.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'meal_carousel_draft'
      AND c.column_name = 'created_meal_id'
  ) THEN
    UPDATE public.meal_carousel_draft
       SET meal_id = COALESCE(meal_id, created_meal_id)
     WHERE meal_id IS NULL
       AND created_meal_id IS NOT NULL;
  END IF;
END $$;

-- Foreign-key the new `meal_id` to `meals.id` when types align.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'meals'
      AND c.column_name = 'id'
      AND c.data_type = 'bigint'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'meal_carousel_draft'
      AND tc.constraint_name = 'meal_carousel_draft_meal_id_fkey'
  ) THEN
    ALTER TABLE public.meal_carousel_draft
      ADD CONSTRAINT meal_carousel_draft_meal_id_fkey
      FOREIGN KEY (meal_id) REFERENCES public.meals(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 2. `carousel_settings` default — make sure a backfill row exists with
--    `suggestion_count: 3` so the Brain UI and /api/eer-config respond with
--    sensible numbers from day one. Kerry can still raise this in the Brain
--    tab if she wants more cards per slot.
UPDATE public.eer_config
   SET carousel_settings = COALESCE(carousel_settings, '{"suggestion_count": 3}'::jsonb)
 WHERE id = 1;

-- Insert a default eer_config row if one doesn't exist yet.
INSERT INTO public.eer_config (id, pal, carb_gkg, protein_gkg, fat_gday, carousel_settings)
SELECT 1,
       '{"Lower":{"low":1.6,"high":1.75},"Moderate":{"low":1.8,"high":2.0},"High":{"low":2.0,"high":2.15}}'::jsonb,
       '{"Lower":{"low":4.5,"high":5.0},"Moderate":{"low":5.0,"high":6.0},"High":{"low":6.5,"high":7.0}}'::jsonb,
       '{"low":1.6,"high":2.2}'::jsonb,
       '{"low":95,"high":115}'::jsonb,
       '{"suggestion_count": 3}'::jsonb
 WHERE NOT EXISTS (SELECT 1 FROM public.eer_config WHERE id = 1);
