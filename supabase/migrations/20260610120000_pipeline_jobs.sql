-- Durable background jobs for long-running upload pipeline stages.
-- This is intentionally generic, but the first consumer is lease extraction:
-- upload/ingest creates a job, the worker claims it, and UI polls
-- uploaded_files + pipeline_logs while the job advances.

CREATE TABLE IF NOT EXISTS public.pipeline_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  lease_id UUID NULL REFERENCES public.leases(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  worker_name TEXT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  input JSONB NOT NULL DEFAULT '{}',
  counts JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_jobs_job_type_check
    CHECK (job_type IN ('lease_extraction')),
  CONSTRAINT pipeline_jobs_stage_check
    CHECK (stage IN ('parse', 'normalize', 'review_draft', 'rule_extraction')),
  CONSTRAINT pipeline_jobs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_file
  ON public.pipeline_jobs (uploaded_file_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_queue
  ON public.pipeline_jobs (job_type, status, available_at, created_at);

CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_org
  ON public.pipeline_jobs (org_id, created_at DESC);

ALTER TABLE public.pipeline_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pipeline_jobs_select" ON public.pipeline_jobs
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.org_id = pipeline_jobs.org_id
    )
  );

CREATE POLICY "pipeline_jobs_insert" ON public.pipeline_jobs
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));

CREATE POLICY "pipeline_jobs_update" ON public.pipeline_jobs
  FOR UPDATE USING (public.can_write_org_data(org_id))
  WITH CHECK (public.can_write_org_data(org_id));

COMMENT ON TABLE public.pipeline_jobs IS
  'Durable jobs for long-running upload pipeline stages such as lease parsing and normalization.';
