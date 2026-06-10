-- Compatibility columns used by the lease upload/review pipeline.
-- The browser now reads rich status through the pipeline-status Edge Function,
-- but these idempotent columns keep hosted environments and PostgREST schema
-- cache aligned with the async extraction worker.

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS processing_status TEXT,
  ADD COLUMN IF NOT EXISTS failed_step TEXT,
  ADD COLUMN IF NOT EXISTS progress_percentage INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_required BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS review_status TEXT,
  ADD COLUMN IF NOT EXISTS document_subtype TEXT,
  ADD COLUMN IF NOT EXISTS extraction_method TEXT,
  ADD COLUMN IF NOT EXISTS ui_review_payload JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS reviewed_output JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS normalized_output JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS docling_raw JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.uploaded_files.processing_status IS
  'Detailed pipeline status for parser/normalizer/review stages. Coarse lifecycle remains in uploaded_files.status.';

SELECT pg_notify('pgrst', 'reload schema');
