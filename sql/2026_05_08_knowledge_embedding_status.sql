-- =============================================================================
-- ATHLEAT — Virtual Kez Brain: per-entry embedding status (Pinecone RAG)
-- =============================================================================
-- Adds bookkeeping columns so the frontend can show "Indexing… / Indexed /
-- Failed" badges and so the indexer worker can resume safely after a crash.
--
--   • embedding_status   — 'pending' | 'processing' | 'ready' | 'failed'
--   • embedding_error    — last failure message (nullable)
--   • embedded_at        — last successful upsert timestamp (nullable)
--
-- Idempotent — safe to run multiple times.
-- =============================================================================

ALTER TABLE IF EXISTS public.knowledge_entries
  ADD COLUMN IF NOT EXISTS embedding_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS embedding_error  text,
  ADD COLUMN IF NOT EXISTS embedded_at      timestamptz;

CREATE INDEX IF NOT EXISTS idx_knowledge_entries_embedding_status
  ON public.knowledge_entries (embedding_status);
