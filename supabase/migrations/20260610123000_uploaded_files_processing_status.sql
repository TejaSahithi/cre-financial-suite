-- Add detailed pipeline status storage used by lease async extraction.
-- Coarse lifecycle remains in uploaded_files.status; this column stores the
-- parser/normalizer detail such as lease_extraction_queued or parse_timeout.

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS processing_status TEXT;

COMMENT ON COLUMN public.uploaded_files.processing_status IS
  'Detailed pipeline status for parser/normalizer/review stages. Coarse lifecycle remains in uploaded_files.status.';
