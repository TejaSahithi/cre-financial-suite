-- ============================================================
-- CRE Financial Suite — Pipeline: uploaded_files table
-- Tracks file uploads through the processing pipeline.
-- Status flow: uploaded → parsing → validating → processed → failed
-- ============================================================

CREATE TABLE IF NOT EXISTS public.uploaded_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  module_type     TEXT NOT NULL,       -- leases | expenses | properties | revenue | cam | budgets
  file_name       TEXT NOT NULL,
  file_url        TEXT NOT NULL,
  file_size       INT,
  mime_type       TEXT,
  uploaded_by     TEXT,                -- user email
  status          TEXT NOT NULL DEFAULT 'uploaded',  -- uploaded | parsing | validating | processed | failed
  error_message   TEXT,
  row_count       INT DEFAULT 0,
  valid_count     INT DEFAULT 0,
  error_count     INT DEFAULT 0,
  parsed_data     JSONB DEFAULT '[]',  -- raw parsed rows
  valid_data      JSONB DEFAULT '[]',  -- validated rows ready for storage
  validation_errors JSONB DEFAULT '[]', -- per-row validation errors
  computed_results JSONB DEFAULT '{}', -- output from computation engines
  processing_started_at TIMESTAMPTZ,
  processing_completed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.uploaded_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "uploaded_files_select" ON public.uploaded_files
  FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));
CREATE POLICY "uploaded_files_insert" ON public.uploaded_files
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));
CREATE POLICY "uploaded_files_update" ON public.uploaded_files
  FOR UPDATE USING (public.can_write_org_data(org_id));
CREATE POLICY "uploaded_files_delete" ON public.uploaded_files
  FOR DELETE USING (public.is_org_admin(org_id));

CREATE INDEX IF NOT EXISTS idx_uploaded_files_org ON public.uploaded_files(org_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_module ON public.uploaded_files(module_type);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_status ON public.uploaded_files(status);

-- ============================================================
-- Pipeline computation snapshots — stores deterministic outputs
-- from each engine run, linked to the source data for audit.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.computation_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id     UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  engine_type     TEXT NOT NULL,  -- cam | budget | revenue | lease | reconciliation | expense
  fiscal_year     INT,
  month           INT,
  input_hash      TEXT,           -- SHA of input data for idempotency
  inputs          JSONB NOT NULL DEFAULT '{}',
  outputs         JSONB NOT NULL DEFAULT '{}',
  status          TEXT DEFAULT 'completed',  -- completed | superseded | failed
  computed_at     TIMESTAMPTZ DEFAULT now(),
  computed_by     TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.computation_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "computation_snapshots_select" ON public.computation_snapshots
  FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));
CREATE POLICY "computation_snapshots_insert" ON public.computation_snapshots
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));

CREATE INDEX IF NOT EXISTS idx_snapshots_org ON public.computation_snapshots(org_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_property ON public.computation_snapshots(property_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_engine ON public.computation_snapshots(engine_type, fiscal_year);
