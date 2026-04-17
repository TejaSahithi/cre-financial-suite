-- Lease review draft metadata from the canonical document review flow.
-- Additive only: keeps raw reviewed extraction data attached to the lease
-- opened by Lease Review without changing the existing lease lifecycle.

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS extraction_data JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS confidence_score NUMERIC,
  ADD COLUMN IF NOT EXISTS low_confidence_fields TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS extracted_fields JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_leases_extraction_source_file
  ON public.leases ((extraction_data->>'source_file_id'))
  WHERE extraction_data ? 'source_file_id';

COMMENT ON COLUMN public.leases.extraction_data IS
  'Document-review metadata: source file, field confidence, custom fields, rejected fields, reviewer audit.';

COMMENT ON COLUMN public.leases.low_confidence_fields IS
  'Fields below the review confidence threshold. Lease Review uses this to alert the team.';
