-- ============================================================
-- pipeline_logs — per-step structured log for every file run
--
-- Every pipeline step (upload, parse, validate, store, compute)
-- writes a row here. The frontend can poll this to show a live
-- activity feed for a file.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.pipeline_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  step        TEXT NOT NULL,   -- upload | parse | validate | store | compute | compute-lease | etc.
  level       TEXT NOT NULL DEFAULT 'info',  -- info | warn | error
  message     TEXT NOT NULL,
  metadata    JSONB DEFAULT '{}',            -- optional structured data (row counts, error details, etc.)
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.pipeline_logs ENABLE ROW LEVEL SECURITY;

-- Org members can read their own logs
CREATE POLICY "pipeline_logs_select" ON public.pipeline_logs
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid() AND m.org_id = pipeline_logs.org_id
    )
  );

-- Only service role / edge functions insert logs (via can_write_org_data)
CREATE POLICY "pipeline_logs_insert" ON public.pipeline_logs
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));

-- Fast lookup: all logs for a file in order
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_file
  ON public.pipeline_logs (file_id, timestamp ASC);

CREATE INDEX IF NOT EXISTS idx_pipeline_logs_org
  ON public.pipeline_logs (org_id, timestamp DESC);
