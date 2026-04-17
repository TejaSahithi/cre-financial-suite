-- Store human-reviewed document output without replacing the raw extraction.
-- This keeps the pipeline auditable: raw extraction, UI review payload,
-- reviewer decisions, and final approved rows are all distinct artifacts.

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS reviewed_output JSONB,
  ADD COLUMN IF NOT EXISTS review_audit JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uploaded_files_review_status_check'
      AND conrelid = 'public.uploaded_files'::regclass
  ) THEN
    ALTER TABLE public.uploaded_files
      DROP CONSTRAINT uploaded_files_review_status_check;
  END IF;

  ALTER TABLE public.uploaded_files
    ADD CONSTRAINT uploaded_files_review_status_check
    CHECK (
      review_status IS NULL
      OR review_status IN ('not_required', 'pending', 'saved', 'approved', 'rejected')
    );
END $$;

COMMENT ON COLUMN public.uploaded_files.reviewed_output IS
  'Final reviewer-controlled document output, including accepted standard fields, custom fields, rejected fields, and flat rows used for storage.';

COMMENT ON COLUMN public.uploaded_files.review_audit IS
  'Append-only JSON audit events for save/approve/reject decisions made during document review.';
