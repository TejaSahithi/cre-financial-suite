-- Additive migration: introduces azure_raw_response as the new canonical
-- column name for uploaded_files' parsed-document JSON (Azure Document
-- Intelligence layout output). docling_raw is NOT dropped here -- it is
-- dual-written by parse-document-azure/lease-extraction-worker and read as
-- a compatibility fallback throughout the pipeline during this window.
-- A separate, later migration will drop docling_raw once production usage
-- of azure_raw_response has been verified.
ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS azure_raw_response JSONB DEFAULT NULL;

COMMENT ON COLUMN public.uploaded_files.azure_raw_response IS
  'Azure Document Intelligence layout output (canonical name). Dual-written alongside the legacy docling_raw column during the compatibility window; docling_raw is scheduled for removal in a later migration once verified unused.';

-- Backfill existing rows so already-parsed files are immediately readable
-- under the new column name without waiting for a re-parse.
UPDATE public.uploaded_files
SET azure_raw_response = docling_raw
WHERE azure_raw_response IS NULL
  AND docling_raw IS NOT NULL;
