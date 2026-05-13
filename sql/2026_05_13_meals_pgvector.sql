-- =============================================================================
-- ATHLEAT — pgvector on public.meals + match_meals RPC
-- =============================================================================
-- Adds semantic similarity search to the legacy bigserial `public.meals` table
-- so the V3 meal carousel (POST /api/kez/meal-carousel) can do two-layer
-- retrieval (slot category + dislikes hard filter, then ANN by embedding)
-- entirely in Postgres — no LLM round-trip, no 1000-row items catalog.
--
-- Mirrors the pattern established in
-- `sql/2026_05_09_pgvector_knowledge_chunks.sql`, but adapted to the legacy
-- schema where:
--   • `public.meals` (bigserial) has no `tags` array, no `category` column,
--     and no top-level macro columns. Macros come from `public.item_meals`,
--     categories from `meal_category → categories`, tags from `meal_tag → tags`.
--   • There is no `is_active` column on `meals` — every row is treated as live.
--
-- Vector dimension is 1024 to match the existing app-wide embedding config
-- (OPENAI_EMBEDDING_MODEL=text-embedding-3-large, RAG_VECTOR_DIMENSION=1024).
-- This keeps the meals vectors compatible with the same OpenAI call used for
-- `knowledge_chunks` so we share one embedding pipeline across the app.
--
-- Idempotent — safe to run multiple times.
-- =============================================================================

-- 1) extension --------------------------------------------------------------
-- Already enabled by the knowledge_chunks migration, but `IF NOT EXISTS`
-- makes this safe to run standalone too.
CREATE EXTENSION IF NOT EXISTS vector;

-- 2) embedding column on meals ---------------------------------------------
-- 1024 floats × 4 bytes = ~4 KB per meal. With ~100 meals we're nowhere
-- near needing TOAST tuning.
ALTER TABLE public.meals ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- 3) HNSW ANN index --------------------------------------------------------
-- Same defaults as the knowledge_chunks index (m=16, ef_construction=64) —
-- recommended for ≤1M vectors. At query time you can `SET LOCAL
-- hnsw.ef_search = 40` if you need higher recall, but for ~100 meals the
-- defaults are more than enough.
CREATE INDEX IF NOT EXISTS meals_embedding_idx
  ON public.meals
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 4) match_meals RPC -------------------------------------------------------
-- Two-layer retrieval used by `mealCarouselPost`:
--
--   Layer 1 (hard filters, in SQL):
--     • `meal_category` is matched case-insensitively as a SUBSTRING of
--       `public.categories.title` via the `meal_category` join table.
--       Substring is intentional: `slotCategory()` in kezController
--       collapses training-related slots to "Training", which needs to
--       match the live category titles "Pre-Training", "Post-Training",
--       "Training - AM", etc. "Breakfast" still matches only Breakfast,
--       "Lunch" matches "Lunch" and "Lunch - 2nd Break", and so on.
--       Pass NULL or '' to skip the category filter.
--     • `disliked_foods` is a text[]. Any meal whose ingredient titles
--       (`items.title`) contain ANY of these substrings is excluded.
--       Pass `'{}'::text[]` to skip the dislikes filter.
--     • `exclude_meal_ids` is a bigint[]. Meals whose id appears here are
--       skipped — used by the carousel to (a) hide meals the coach has
--       already sent as a V3 pick for this slot, and (b) honour an
--       in-session "Try different" exclusion list. Pass `'{}'::bigint[]`
--       to skip.
--
--   Layer 2 (ANN, uses the HNSW index above):
--     • Order remaining rows by `embedding <=> query_embedding` and keep
--       the top `match_count`.
--
-- Returned columns mirror what the carousel needs:
--   id, title, description, aggregated macros, tag names.
--
-- Macros are aggregated from `public.item_meals` per meal — same source the
-- existing `mealsService.shapeMeal` uses, so the output is in sync with the
-- per-meal totals the carousel cards display.
--
-- `item_meals.energy` is stored as a text string like "550kJ". We strip
-- non-numeric characters and cast to numeric to recover the kJ value.
DROP FUNCTION IF EXISTS public.match_meals(vector, text, text[], int);
DROP FUNCTION IF EXISTS public.match_meals(vector, text, text[], int, bigint[]);
CREATE OR REPLACE FUNCTION public.match_meals(
  query_embedding  vector(1024),
  meal_category    text,
  disliked_foods   text[]  DEFAULT '{}',
  match_count      int     DEFAULT 25,
  exclude_meal_ids bigint[] DEFAULT '{}'
)
RETURNS TABLE (
  id          bigint,
  title       text,
  description text,
  protein_g   numeric,
  carb_g      numeric,
  fat_g       numeric,
  energy_kj   numeric,
  tags        text[]
)
LANGUAGE sql STABLE
AS $$
  -- Top-K candidates after hard filters + ANN ordering.
  WITH base AS (
    SELECT m.id, m.title, m.description
      FROM public.meals m
     WHERE m.embedding IS NOT NULL
       AND (
         meal_category IS NULL
         OR TRIM(meal_category) = ''
         OR EXISTS (
           SELECT 1
             FROM public.meal_category mc
             JOIN public.categories c ON c.id = mc.category_id
            WHERE mc.meal_id = m.id
              AND LOWER(c.title) LIKE '%' || LOWER(TRIM(meal_category)) || '%'
         )
       )
       AND (
         COALESCE(array_length(disliked_foods, 1), 0) = 0
         OR NOT EXISTS (
           SELECT 1
             FROM public.item_meals im
             JOIN public.items i ON i.id = im.item_id
            WHERE im.meal_id = m.id
              AND EXISTS (
                SELECT 1
                  FROM UNNEST(disliked_foods) AS d
                 WHERE TRIM(COALESCE(d, '')) <> ''
                   AND LOWER(i.title) LIKE '%' || LOWER(TRIM(d)) || '%'
              )
         )
       )
       AND (
         COALESCE(array_length(exclude_meal_ids, 1), 0) = 0
         OR NOT (m.id = ANY (exclude_meal_ids))
       )
     ORDER BY m.embedding <=> query_embedding
     LIMIT GREATEST(COALESCE(match_count, 25), 1)
  ),
  macros AS (
    SELECT im.meal_id,
           COALESCE(SUM(im.protein), 0)::numeric AS protein_g,
           COALESCE(SUM(im.carbs),   0)::numeric AS carb_g,
           COALESCE(SUM(im.fat),     0)::numeric AS fat_g,
           COALESCE(SUM(
             NULLIF(regexp_replace(COALESCE(im.energy, ''), '[^0-9.\-]+', '', 'g'), '')::numeric
           ), 0)::numeric AS energy_kj
      FROM public.item_meals im
     WHERE im.meal_id IN (SELECT id FROM base)
     GROUP BY im.meal_id
  ),
  tag_arr AS (
    SELECT mt.meal_id, ARRAY_AGG(t.name ORDER BY t.name) AS tags
      FROM public.meal_tag mt
      JOIN public.tags t ON t.id = mt.tag_id
     WHERE mt.meal_id IN (SELECT id FROM base)
     GROUP BY mt.meal_id
  )
  SELECT b.id,
         b.title,
         b.description,
         COALESCE(mc.protein_g, 0)::numeric AS protein_g,
         COALESCE(mc.carb_g,    0)::numeric AS carb_g,
         COALESCE(mc.fat_g,     0)::numeric AS fat_g,
         COALESCE(mc.energy_kj, 0)::numeric AS energy_kj,
         COALESCE(ta.tags, ARRAY[]::text[]) AS tags
    FROM base b
    LEFT JOIN macros  mc ON mc.meal_id = b.id
    LEFT JOIN tag_arr ta ON ta.meal_id = b.id;
$$;

-- 5) Verification --------------------------------------------------------------
-- After running this migration:
--   1. Run scripts/backfill-meal-embeddings.js to populate
--      `public.meals.embedding` for every existing row (~93 rows).
--   2. Sanity-check with a dummy vector:
--
--   SELECT id, title, protein_g, carb_g, fat_g, energy_kj, tags
--   FROM match_meals(
--     array_fill(0.1, ARRAY[1024])::vector,
--     'Breakfast',
--     ARRAY['peanuts'],
--     5
--   );
--
-- Even with a zero-information dummy vector you should get up to 5 Breakfast
-- meals back (the ANN order will be arbitrary but the filters still apply).
-- Once embeddings are backfilled, the ordering becomes semantically
-- meaningful.
