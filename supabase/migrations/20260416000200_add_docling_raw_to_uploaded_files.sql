-- The PDF/DOCX parser persists raw Docling/OCR output here before
-- normalize-pdf-output builds parsed_data and ui_review_payload.
ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS docling_raw JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_uploaded_files_pdf_status
  ON public.uploaded_files (org_id, status)
  WHERE docling_raw IS NOT NULL;

COMMENT ON COLUMN public.uploaded_files.docling_raw IS
  'Raw JSON output from Docling/OCR extraction. Used by normalize-pdf-output before validation and review.';
