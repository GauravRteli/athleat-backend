-- =============================================================================
-- ATHLEAT — Virtual Kez Brain: Knowledge files + folders
-- =============================================================================
-- Adds:
--   • public.knowledge_folders          — named folders for grouping files
--   • public.knowledge_entries.folder_id        (nullable FK)
--   • public.knowledge_entries.file_public_id   (Cloudinary id for cleanup)
--   • public.knowledge_entries.file_size_bytes  (raw byte count)
--   • public.knowledge_entries.file_size        (human readable e.g. "1.2 MB")
--   • public.knowledge_entries.file_type        ("pdf" | "pptx" | "image" | …)
--
-- Idempotent — safe to run multiple times.
-- =============================================================================

-- 1) folders -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.knowledge_folders (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  is_active   boolean     DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_folders_active
  ON public.knowledge_folders (is_active);

ALTER TABLE public.knowledge_folders ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'knowledge_folders' AND policyname = 'knowledge_folders_admin_all'
  ) THEN
    CREATE POLICY "knowledge_folders_admin_all" ON public.knowledge_folders
      FOR ALL USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'knowledge_folders' AND policyname = 'knowledge_folders_anon_read'
  ) THEN
    CREATE POLICY "knowledge_folders_anon_read" ON public.knowledge_folders
      FOR SELECT USING (is_active = true);
  END IF;
END $$;

-- 2) extend knowledge_entries for file metadata + folder link -----------------
ALTER TABLE IF EXISTS public.knowledge_entries
  ADD COLUMN IF NOT EXISTS folder_id        uuid REFERENCES public.knowledge_folders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS file_public_id   text,
  ADD COLUMN IF NOT EXISTS file_size_bytes  bigint,
  ADD COLUMN IF NOT EXISTS file_size        text,
  ADD COLUMN IF NOT EXISTS file_type        text;

CREATE INDEX IF NOT EXISTS idx_knowledge_entries_folder
  ON public.knowledge_entries (folder_id);
