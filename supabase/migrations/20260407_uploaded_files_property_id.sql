-- ============================================================
-- Add property_id to uploaded_files
--
-- Allows the upload UI to tag a file with a specific property
-- at upload time. The compute orchestrator uses this as the
-- primary source for property_id, avoiding the need to scan
-- every row in valid_data.
-- ============================================================

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL;

-- Index for fast "all files for a property" queries
CREATE INDEX IF NOT EXISTS idx_uploaded_files_property
  ON public.uploaded_files (org_id, property_id)
  WHERE property_id IS NOT NULL;
