-- Phase 1 baseline: reconcile the effective observability contract used by the
-- current app and edge functions.
--
-- This migration is additive/idempotent. It does not replace the historical
-- migrations; it codifies the uploaded_files / pipeline_logs / audit_logs
-- contract that later code paths already rely on.

-- ── uploaded_files: effective observability + review contract ──────────────
ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS progress_percentage INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_step TEXT,
  ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS docling_raw JSONB,
  ADD COLUMN IF NOT EXISTS extraction_method TEXT,
  ADD COLUMN IF NOT EXISTS document_subtype TEXT,
  ADD COLUMN IF NOT EXISTS normalized_output JSONB,
  ADD COLUMN IF NOT EXISTS ui_review_payload JSONB,
  ADD COLUMN IF NOT EXISTS reviewed_output JSONB,
  ADD COLUMN IF NOT EXISTS review_audit JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS review_required BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS approved_by UUID,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by UUID,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reject_reason TEXT,
  ADD COLUMN IF NOT EXISTS parent_file_id UUID REFERENCES public.uploaded_files(id) ON DELETE SET NULL;

UPDATE public.uploaded_files
SET status = 'completed'
WHERE status = 'processed';

UPDATE public.uploaded_files
SET progress_percentage =
  CASE status
    WHEN 'uploaded' THEN 5
    WHEN 'parsing' THEN 15
    WHEN 'parsed' THEN 30
    WHEN 'pdf_parsed' THEN 35
    WHEN 'validating' THEN 45
    WHEN 'validated' THEN 55
    WHEN 'review_required' THEN 60
    WHEN 'approved' THEN 65
    WHEN 'storing' THEN 70
    WHEN 'stored' THEN 80
    WHEN 'computing' THEN 90
    WHEN 'completed' THEN 100
    ELSE COALESCE(progress_percentage, 0)
  END
WHERE progress_percentage IS NULL OR progress_percentage = 0;

UPDATE public.uploaded_files
SET review_status = 'approved'
WHERE review_status IS NULL
  OR (
    review_status = 'not_required'
    AND status IN ('stored', 'completed')
  );

UPDATE public.uploaded_files
SET review_audit = '[]'::jsonb
WHERE review_audit IS NULL;

ALTER TABLE public.uploaded_files
  ALTER COLUMN review_audit SET DEFAULT '[]'::jsonb;

ALTER TABLE public.uploaded_files
  ALTER COLUMN review_audit SET NOT NULL;

DO $$
BEGIN
  ALTER TABLE public.uploaded_files
    DROP CONSTRAINT IF EXISTS uploaded_files_status_check;
  ALTER TABLE public.uploaded_files
    ADD CONSTRAINT uploaded_files_status_check
    CHECK (status IN (
      'uploaded',
      'parsing',
      'parsed',
      'pdf_parsed',
      'validating',
      'validated',
      'review_required',
      'approved',
      'storing',
      'stored',
      'computing',
      'completed',
      'failed'
    ));
END $$;

DO $$
BEGIN
  ALTER TABLE public.uploaded_files
    DROP CONSTRAINT IF EXISTS uploaded_files_review_status_check;
  ALTER TABLE public.uploaded_files
    ADD CONSTRAINT uploaded_files_review_status_check
    CHECK (
      review_status IS NULL
      OR review_status IN ('not_required', 'pending', 'saved', 'approved', 'rejected')
    );
END $$;

DO $$
BEGIN
  ALTER TABLE public.uploaded_files
    DROP CONSTRAINT IF EXISTS uploaded_files_document_subtype_check;
  ALTER TABLE public.uploaded_files
    ADD CONSTRAINT uploaded_files_document_subtype_check
    CHECK (
      document_subtype IS NULL
      OR document_subtype IN (
        'base_lease',
        'amendment',
        'assignment',
        'consent',
        'extension',
        'addendum',
        'expense_backup',
        'cam_support',
        'budget_support',
        'rent_roll',
        'generic'
      )
    );
END $$;

CREATE INDEX IF NOT EXISTS idx_uploaded_files_status_org
  ON public.uploaded_files (org_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_uploaded_files_property
  ON public.uploaded_files (org_id, property_id)
  WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_uploaded_files_building_scope
  ON public.uploaded_files (org_id, building_id)
  WHERE building_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_uploaded_files_unit_scope
  ON public.uploaded_files (org_id, unit_id)
  WHERE unit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_uploaded_files_review
  ON public.uploaded_files (org_id, review_status)
  WHERE review_required = TRUE;

CREATE INDEX IF NOT EXISTS idx_uploaded_files_subtype
  ON public.uploaded_files (org_id, document_subtype)
  WHERE document_subtype IS NOT NULL;

COMMENT ON TABLE public.uploaded_files IS
  'Canonical file-ingestion state machine used by upload-handler, ingestion, validation, review, storage, and compute orchestration.';
COMMENT ON COLUMN public.uploaded_files.progress_percentage IS
  'Operator-facing progress indicator derived from the uploaded_files status lifecycle.';
COMMENT ON COLUMN public.uploaded_files.failed_step IS
  'Last pipeline step that failed; used for diagnostics and retry decisions.';
COMMENT ON COLUMN public.uploaded_files.review_audit IS
  'Append-only review event history for save/approve/reject actions.';

-- ── pipeline_logs: ensure consistent structured logging contract ───────────
CREATE TABLE IF NOT EXISTS public.pipeline_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.pipeline_logs ENABLE ROW LEVEL SECURITY;

UPDATE public.pipeline_logs
SET metadata = '{}'::jsonb
WHERE metadata IS NULL;

ALTER TABLE public.pipeline_logs
  ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;

ALTER TABLE public.pipeline_logs
  ALTER COLUMN metadata SET NOT NULL;

DO $$
BEGIN
  ALTER TABLE public.pipeline_logs
    DROP CONSTRAINT IF EXISTS pipeline_logs_level_check;
  ALTER TABLE public.pipeline_logs
    ADD CONSTRAINT pipeline_logs_level_check
    CHECK (level IN ('info', 'warn', 'error'));
END $$;

DROP POLICY IF EXISTS "pipeline_logs_select" ON public.pipeline_logs;
DROP POLICY IF EXISTS "pipeline_logs_insert" ON public.pipeline_logs;

CREATE POLICY "pipeline_logs_select" ON public.pipeline_logs
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.org_id = pipeline_logs.org_id
    )
  );

CREATE POLICY "pipeline_logs_insert" ON public.pipeline_logs
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));

CREATE INDEX IF NOT EXISTS idx_pipeline_logs_file
  ON public.pipeline_logs (file_id, timestamp ASC);

CREATE INDEX IF NOT EXISTS idx_pipeline_logs_org
  ON public.pipeline_logs (org_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_logs_level
  ON public.pipeline_logs (org_id, level)
  WHERE level IN ('warn', 'error');

COMMENT ON TABLE public.pipeline_logs IS
  'Per-step structured activity log written by edge functions for each uploaded file.';

-- ── audit_logs: keep client-side audit writes visible under current app use ─
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_logs_select_admin" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_select" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_insert" ON public.audit_logs;

CREATE POLICY "audit_logs_select" ON public.audit_logs
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.org_id = audit_logs.org_id
    )
  );

CREATE POLICY "audit_logs_insert" ON public.audit_logs
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_timestamp
  ON public.audit_logs (org_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
  ON public.audit_logs (entity_type, entity_id, timestamp DESC);

COMMENT ON TABLE public.audit_logs IS
  'User-visible audit trail for entity lifecycle, membership, and admin actions.';
