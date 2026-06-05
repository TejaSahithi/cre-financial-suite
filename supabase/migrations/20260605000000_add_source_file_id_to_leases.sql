-- Add source_file_id to leases table.
-- The review-approve function writes this column and leaseService.js reads it,
-- but no prior migration added it to public.leases. The missing column causes
-- Supabase PostgREST to return 400/500 errors on every lease read and write
-- that goes through the document-review pipeline.

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS source_file_id UUID
    REFERENCES public.uploaded_files(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leases_source_file_id
  ON public.leases (source_file_id)
  WHERE source_file_id IS NOT NULL;

COMMENT ON COLUMN public.leases.source_file_id IS
  'The uploaded_files row that produced this lease via document review.';
