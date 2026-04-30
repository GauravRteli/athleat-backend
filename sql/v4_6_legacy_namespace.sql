-- =============================================================================
-- ATHLEAT — Kerry Dashboard v4.6 Legacy Namespace Migration (rename-only)
--
-- The legacy library schema (items, meals (bigserial), item_meals, etc.) is
-- already in place in Supabase and seeded from `Data Upload/*.csv`.
--
-- This migration's only job is to rename the older v4 dashboard tables out of
-- the way IF they happen to still exist alongside the legacy ones, so the
-- dashboard can read/write the legacy `public.meals` (bigserial) without
-- a name collision. We do NOT add any columns to legacy `meals`/`items` —
-- the dashboard adapts to the existing legacy column set:
--
--    blueprint_note  → public.meals.note          (free-text)
--    image_url       → public.meals.image
--    energy/macros   → SUM(item_meals.{energy,protein,carbs,fat})
--    category        → public.meal_category   ↔ public.food_categories
--    sub_category    → public.meal_sub_category ↔ public.sub_categories
--    tags            → public.meal_tag        ↔ public.tags
--
-- Idempotent: safe to run multiple times.
-- =============================================================================

-- ── Rename out-of-the-way only if a v4.0 dashboard `public.meals` (uuid PK)
--    still exists side-by-side with the legacy bigserial one (which it can't
--    if the legacy is already there — but the rename is conditional anyway).
DO $$
DECLARE
  v_pkey_type text;
BEGIN
  SELECT data_type INTO v_pkey_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'meals' AND column_name = 'id';

  -- If `meals.id` is uuid → that's the old v4 dashboard table; rename it.
  IF v_pkey_type = 'uuid' AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'dashboard_meals'
  ) THEN
    EXECUTE 'ALTER TABLE public.meals RENAME TO dashboard_meals';
    RAISE NOTICE 'Renamed v4 dashboard meals (uuid) → dashboard_meals';
  ELSE
    RAISE NOTICE 'No rename needed for public.meals';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'meal_foods'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'dashboard_meal_foods'
  ) THEN
    EXECUTE 'ALTER TABLE public.meal_foods RENAME TO dashboard_meal_foods';
    RAISE NOTICE 'Renamed v4 dashboard meal_foods → dashboard_meal_foods';
  ELSE
    RAISE NOTICE 'No rename needed for public.meal_foods';
  END IF;
END $$;

-- =============================================================================
-- Bump every bigserial sequence to MAX(id) on the corresponding legacy table.
--
-- The CSV seed inserts rows with explicit IDs but does NOT advance the
-- backing sequence, so the next INSERT (e.g. creating a new tag from the
-- Library tab) collides with an existing primary key. Running setval is
-- idempotent and safe to repeat.
-- =============================================================================
DO $$
DECLARE
  pairs text[][] := ARRAY[
    ['public.items',                'items_id_seq'],
    ['public.meals',                'meals_id_seq'],
    ['public.item_meals',           'item_meals_id_seq'],
    ['public.item_tag',             'item_tag_id_seq'],
    ['public.food_categories',      'food_categories_id_seq'],
    ['public.sub_categories',       'sub_categories_id_seq'],
    ['public.subcategory_category', 'subcategory_category_id_seq'],
    ['public.tags',                 'tags_id_seq'],
    ['public.meal_category',        'meal_category_id_seq'],
    ['public.meal_sub_category',    'meal_sub_category_id_seq'],
    ['public.meal_tag',             'meal_tag_id_seq'],
    ['public.goal_histories',       'goal_histories_id_seq']
  ];
  i int;
  tbl text;
  seq text;
BEGIN
  FOR i IN 1..array_length(pairs, 1) LOOP
    tbl := pairs[i][1];
    seq := pairs[i][2];
    BEGIN
      EXECUTE format(
        'SELECT setval(%L, COALESCE((SELECT MAX(id) FROM %s), 1))',
        seq, tbl
      );
    EXCEPTION WHEN undefined_table OR undefined_object THEN
      RAISE NOTICE 'Skip % (table or sequence missing)', tbl;
    END;
  END LOOP;
END $$;
