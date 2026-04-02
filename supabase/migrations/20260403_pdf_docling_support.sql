-- ============================================================
-- CRE Financial Suite — PDF / Docling support
-- Adds docling_raw column to uploaded_files for raw OCR output
-- and extends the status check constraint to include 'pdf_parsed'
-- ============================================================

-- Add column to store raw Docling extraction output (for debugging)
ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS docling_raw JSONB DEFAULT NULL;

-- Extend the status constraint to allow the new 'pdf_parsed' intermediate status.
-- 'pdf_parsed' means: Docling extraction complete, normalisation pending.
-- The existing pipeline statuses are preserved unchanged.
DO $$
BEGIN
  -- Drop the old constraint if it exists (name may vary by migration)
  ALTER TABLE public.uploaded_files
    DROP CONSTRAINT IF EXISTS uploaded_files_status_check;

  -- Re-add with the extended list
  ALTER TABLE public.uploaded_files
    ADD CONSTRAINT uploaded_files_status_check
    CHECK (status IN (
      'uploaded',
      'parsing',
      'parsed',
      'pdf_parsed',   -- NEW: Docling extraction done, normalisation pending
      'validating',
      'validated',
      'storing',
      'stored',
      'processed',
      'failed'
    ));
END $$;

-- Index for querying PDF files by status
CREATE INDEX IF NOT EXISTS idx_uploaded_files_pdf_status
  ON public.uploaded_files (org_id, status)
  WHERE docling_raw IS NOT NULL;

COMMENT ON COLUMN public.uploaded_files.docling_raw IS
  'Raw JSON output from Docling OCR extraction. Stored for debugging. '
  'Not inserted directly into business tables — must pass through normalisation and validation first.';
