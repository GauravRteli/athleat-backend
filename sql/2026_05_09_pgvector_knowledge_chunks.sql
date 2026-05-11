-- =============================================================================
-- ATHLEAT — Virtual Kez Brain: pgvector chunk store (replaces Pinecone)
-- =============================================================================
-- Moves the RAG vector store from Pinecone into Supabase Postgres + pgvector.
--
-- What this migration does:
--   1. Enables the `vector` extension (required for the `vector` column type
--      and the `<=>` cosine-distance operator).
--   2. Creates `public.knowledge_chunks` — one row per chunk per entry, with
--      the embedding stored as `vector(1024)`.  Cascades on entry delete so
--      removing a knowledge_entry automatically wipes its chunks.
--   3. Adds a HNSW ANN index on the embedding using cosine ops.
--   4. Defines `match_knowledge_chunks(query_embedding, match_count)` — the
--      similarity-search RPC the chat pipeline calls.  Returns rows + cosine
--      score (1 - distance) shaped to mirror Pinecone's previous response so
--      the chat formatter doesn't have to change.
--   5. Resets every active knowledge_entries row to `embedding_status='pending'`
--      so the existing startup backfill repopulates the new chunk table on
--      the next backend restart — no manual reindex required.
--
-- Idempotent — safe to run multiple times.
--
-- IMPORTANT: vector dimension is hard-coded to 1024 to match the existing
-- env config (RAG_VECTOR_DIMENSION=1024 / OpenAI text-embedding-3-large with
-- the `dimensions: 1024` parameter).  If you change the embedding dimension
-- you must drop & recreate the table — pgvector cannot ALTER an indexed
-- vector column to a new dimension in place.
-- =============================================================================

-- 1) extension --------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- 2) chunk table ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id     uuid          NOT NULL REFERENCES public.knowledge_entries(id) ON DELETE CASCADE,
  chunk_index  integer       NOT NULL,
  chunk_total  integer       NOT NULL,
  content      text          NOT NULL,
  metadata     jsonb         NOT NULL DEFAULT '{}'::jsonb,
  embedding    vector(1024)  NOT NULL,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_chunks_entry_chunk_unique UNIQUE (entry_id, chunk_index)
);

-- 3) indexes ----------------------------------------------------------------
-- HNSW for fast cosine ANN search.  m=16 / ef_construction=64 are pgvector's
-- recommended defaults for ≤1M vectors.  At query time set ef_search via
-- `SET LOCAL hnsw.ef_search = 40;` if you need higher recall.
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_hnsw
  ON public.knowledge_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Cheap b-tree on entry_id so deleteByEntry / per-entry counts stay O(log n).
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_entry_id
  ON public.knowledge_chunks (entry_id);

-- 4) similarity-search RPC --------------------------------------------------
-- Returns the top `match_count` chunks ordered by cosine similarity.
-- `score` is `1 - cosine_distance`, so 1.0 = identical, 0.0 = orthogonal —
-- matches the convention chat.js expects from Pinecone.
DROP FUNCTION IF EXISTS public.match_knowledge_chunks(vector, integer);
CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
  query_embedding vector(1024),
  match_count     integer DEFAULT 6
)
RETURNS TABLE (
  id           uuid,
  entry_id     uuid,
  chunk_index  integer,
  chunk_total  integer,
  content      text,
  metadata     jsonb,
  score        double precision
)
LANGUAGE sql STABLE
AS $$
  SELECT
    kc.id,
    kc.entry_id,
    kc.chunk_index,
    kc.chunk_total,
    kc.content,
    kc.metadata,
    (1 - (kc.embedding <=> query_embedding))::double precision AS score
  FROM public.knowledge_chunks kc
  ORDER BY kc.embedding <=> query_embedding
  LIMIT GREATEST(match_count, 1)
$$;

-- 5) RLS --------------------------------------------------------------------
-- Lock the table down — only service role / admin paths should ever touch it.
-- The backend uses the service role / direct DB connection, so this is just
-- belt-and-braces against accidental anon access via the JS client.
ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'knowledge_chunks'
      AND policyname = 'knowledge_chunks_admin_all'
  ) THEN
    CREATE POLICY "knowledge_chunks_admin_all" ON public.knowledge_chunks
      FOR ALL USING (true);
  END IF;
END $$;

-- 6) one-time cutover -------------------------------------------------------
-- Flip every active row from 'ready' (= "lives in Pinecone") back to
-- 'pending' so the startup backfill rebuilds them in pgvector.
-- 'failed' rows are already retried by the backfill, so we leave them.
UPDATE public.knowledge_entries
   SET embedding_status = 'pending',
       embedding_error  = NULL,
       embedded_at      = NULL,
       updated_at       = now()
 WHERE is_active = true
   AND embedding_status = 'ready';
