-- Expand review_status check constraint to include values used by the edge function pipeline.
-- REVIEW_STATUSES in pipeline-contract.ts emits 'blocked_pipeline_failure', 'review_ready',
-- and 'manual_review_required' but the constraint only knew about the original UI-facing values.
DO $$
BEGIN
  ALTER TABLE public.uploaded_files
    DROP CONSTRAINT IF EXISTS uploaded_files_review_status_check;

  ALTER TABLE public.uploaded_files
    ADD CONSTRAINT uploaded_files_review_status_check
    CHECK (
      review_status IS NULL
      OR review_status IN (
        'not_required',
        'pending',
        'saved',
        'approved',
        'rejected',
        'blocked_pipeline_failure',
        'review_ready',
        'manual_review_required'
      )
    );
END $$;
