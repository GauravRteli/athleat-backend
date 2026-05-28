-- =============================================================================
-- ATHLEAT — expose cosine distance from match_meals
-- =============================================================================
-- Why:
-- The V3 reranker previously inferred semantic relevance from rank index only.
-- Returning the real `(embedding <=> query_embedding)` distance allows a more
-- stable score and better ingredient-continuity balancing.
--
-- Safe to run multiple times.
-- =============================================================================

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
  tags        text[],
  distance    numeric
)
LANGUAGE sql STABLE
AS $$
  WITH base AS (
    SELECT m.id,
           m.title,
           m.description,
           (m.embedding <=> query_embedding)::numeric AS distance
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
         COALESCE(ta.tags, ARRAY[]::text[]) AS tags,
         b.distance
    FROM base b
    LEFT JOIN macros  mc ON mc.meal_id = b.id
    LEFT JOIN tag_arr ta ON ta.meal_id = b.id
   ORDER BY b.distance ASC;
$$;

