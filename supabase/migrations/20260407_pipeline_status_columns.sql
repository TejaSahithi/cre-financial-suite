-- ============================================================
-- Pipeline status lifecycle improvements
-- Adds progress_percentage and failed_step columns to
-- uploaded_files so the frontend can show a progress bar
-- and operators can see exactly where a file failed.
-- ============================================================

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS progress_percentage INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_step TEXT;

-- Back-fill progress for existing rows based on current status
UPDATE public.uploaded_files SET progress_percentage =
  CASE status
    WHEN 'uploaded'   THEN 5
    WHEN 'parsing'    THEN 15
    WHEN 'parsed'     THEN 30
    WHEN 'pdf_parsed' THEN 35
    WHEN 'validating' THEN 45
    WHEN 'validated'  THEN 60
    WHEN 'storing'    THEN 70
    WHEN 'stored'     THEN 80
    WHEN 'computing'  THEN 90
    WHEN 'completed'  THEN 100
    WHEN 'processed'  THEN 100   -- legacy alias
    ELSE 0
  END
WHERE progress_percentage = 0 OR progress_percentage IS NULL;

-- Normalise legacy 'processed' status to 'completed'
UPDATE public.uploaded_files
  SET status = 'completed'
  WHERE status = 'processed';

-- Index for fast status-based queries (e.g. "show all failed files")
CREATE INDEX IF NOT EXISTS idx_uploaded_files_status_org
  ON public.uploaded_files (org_id, status, created_at DESC);
