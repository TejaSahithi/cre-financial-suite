-- ============================================================
-- CRE Financial Suite — Review Pipeline (Phase 0)
-- ============================================================
-- Adds the columns and tables required for the canonical
-- "one standard extraction pipeline" defined in the principal
-- engineer review. This migration is ADDITIVE only — it does not
-- drop, rename, or alter the type of any existing column.
--
-- What this enables:
--   1. Document subtype classification (base_lease, amendment,
--      assignment, consent, extension, addendum, expense_backup,
--      cam_support, budget_support) persisted on upload.
--   2. Normalized extraction output + UI review payload stored
--      directly on uploaded_files so the frontend can render a
--      deterministic review screen.
--   3. Explicit human review gate (review_required / review_status)
--      that blocks store-data for sensitive documents.
--   4. compute_runs audit table so every CAM / Budget / Lease
--      compute can be traced back to its source uploaded_file.
--   5. document_links, lease_amendments, lease_assignments to
--      preserve the parent-child relationships that scanned lease
--      docs depend on.
--
-- Backfill: every existing uploaded_files row is marked
--   review_status='approved' so nothing stalls after deploy.
-- ============================================================

-- ── uploaded_files: extraction + review metadata ─────────────
ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS extraction_method   TEXT,
  ADD COLUMN IF NOT EXISTS document_subtype    TEXT,
  ADD COLUMN IF NOT EXISTS normalized_output   JSONB,
  ADD COLUMN IF NOT EXISTS ui_review_payload   JSONB,
  ADD COLUMN IF NOT EXISTS review_required     BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS review_status       TEXT    DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS approved_by         UUID,
  ADD COLUMN IF NOT EXISTS approved_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by         UUID,
  ADD COLUMN IF NOT EXISTS rejected_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reject_reason       TEXT,
  ADD COLUMN IF NOT EXISTS parent_file_id      UUID REFERENCES public.uploaded_files(id) ON DELETE SET NULL;

-- review_status values accepted by the pipeline
DO $$
BEGIN
  ALTER TABLE public.uploaded_files
    DROP CONSTRAINT IF EXISTS uploaded_files_review_status_check;
  ALTER TABLE public.uploaded_files
    ADD CONSTRAINT uploaded_files_review_status_check
    CHECK (review_status IN (
      'not_required',  -- deterministic module, no human gate
      'pending',       -- waiting on human approval
      'approved',      -- cleared, safe to store + compute
      'rejected'       -- operator blocked, will not be stored
    ));
END $$;

-- document_subtype values accepted by the pipeline
DO $$
BEGIN
  ALTER TABLE public.uploaded_files
    DROP CONSTRAINT IF EXISTS uploaded_files_document_subtype_check;
  ALTER TABLE public.uploaded_files
    ADD CONSTRAINT uploaded_files_document_subtype_check
    CHECK (document_subtype IS NULL OR document_subtype IN (
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
    ));
END $$;

-- Extend pipeline status check to allow review_required / approved
-- (still compatible with legacy 'processed' used by a few back-fills)
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
      'review_required',   -- NEW: waiting on human approval
      'approved',          -- NEW: operator cleared, moving to store
      'storing',
      'stored',
      'computing',
      'completed',
      'processed',         -- legacy alias, kept for back-compat
      'failed'
    ));
END $$;

CREATE INDEX IF NOT EXISTS idx_uploaded_files_review
  ON public.uploaded_files (org_id, review_status)
  WHERE review_required = TRUE;

CREATE INDEX IF NOT EXISTS idx_uploaded_files_subtype
  ON public.uploaded_files (org_id, document_subtype)
  WHERE document_subtype IS NOT NULL;

-- Backfill: pre-existing rows are treated as already reviewed so
-- the new review gate does not block any historical upload.
UPDATE public.uploaded_files
  SET review_status = 'approved'
  WHERE review_status IS NULL
     OR review_status = 'not_required' AND status IN ('completed', 'processed', 'stored');

-- ============================================================
-- compute_runs — audit trail for every compute engine invocation
-- ------------------------------------------------------------
-- Every call to compute-lease / compute-revenue / compute-budget /
-- compute-expense / compute-cam inserts one row here. The
-- input_fingerprint lets us detect when stored results are stale.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.compute_runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id        UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  engine_type        TEXT NOT NULL CHECK (engine_type IN (
    'lease', 'revenue', 'budget', 'expense', 'cam', 'reconciliation'
  )),
  fiscal_year        INT,
  source_file_id     UUID REFERENCES public.uploaded_files(id) ON DELETE SET NULL,
  triggered_by       TEXT,               -- 'upload' | 'manual' | 'scheduled'
  input_fingerprint  TEXT NOT NULL,      -- SHA-256 of sorted inputs
  input_summary      JSONB DEFAULT '{}', -- small human-readable digest
  output_summary     JSONB DEFAULT '{}', -- totals etc. (not full payload)
  status             TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
    'running', 'completed', 'failed', 'superseded'
  )),
  error_message      TEXT,
  started_at         TIMESTAMPTZ DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  duration_ms        INT,
  created_at         TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.compute_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "compute_runs_select" ON public.compute_runs
  FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));
CREATE POLICY "compute_runs_insert" ON public.compute_runs
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));
CREATE POLICY "compute_runs_update" ON public.compute_runs
  FOR UPDATE USING (public.can_write_org_data(org_id));

CREATE INDEX IF NOT EXISTS idx_compute_runs_org_engine
  ON public.compute_runs (org_id, engine_type, fiscal_year, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_compute_runs_property
  ON public.compute_runs (property_id, engine_type, fiscal_year);

CREATE INDEX IF NOT EXISTS idx_compute_runs_fingerprint
  ON public.compute_runs (property_id, engine_type, fiscal_year, input_fingerprint);

CREATE INDEX IF NOT EXISTS idx_compute_runs_source_file
  ON public.compute_runs (source_file_id);

-- ============================================================
-- document_links — generic document → entity linkage
-- ------------------------------------------------------------
-- Any uploaded_files row can reference one or more business
-- entities (lease, property, expense_bucket, budget_line,
-- cam_reconciliation). Supports the "expense backup" and
-- "CAM support" subtypes.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.document_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  file_id         UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL CHECK (entity_type IN (
    'lease', 'property', 'expense_bucket', 'expense_line',
    'budget_line', 'cam_reconciliation', 'revenue_line'
  )),
  entity_id       UUID NOT NULL,
  link_role       TEXT,        -- 'backup' | 'source' | 'amendment' | 'support'
  created_at      TIMESTAMPTZ DEFAULT now(),
  created_by      UUID,
  UNIQUE (file_id, entity_type, entity_id, link_role)
);

ALTER TABLE public.document_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_links_select" ON public.document_links
  FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));
CREATE POLICY "document_links_insert" ON public.document_links
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));
CREATE POLICY "document_links_delete" ON public.document_links
  FOR DELETE USING (public.can_write_org_data(org_id));

CREATE INDEX IF NOT EXISTS idx_document_links_entity
  ON public.document_links (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_document_links_file
  ON public.document_links (file_id);

-- ============================================================
-- lease_amendments — amendment chains to a base lease
-- ------------------------------------------------------------
-- Stores the delta that each amendment / addendum / extension
-- contributes so downstream compute can reconstruct the
-- "effective lease" at any point in time.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.lease_amendments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id           UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  source_file_id     UUID REFERENCES public.uploaded_files(id) ON DELETE SET NULL,
  amendment_number   INT,
  amendment_type     TEXT CHECK (amendment_type IN (
    'amendment', 'addendum', 'extension', 'renewal', 'modification'
  )),
  effective_date     DATE,
  end_date           DATE,
  delta              JSONB NOT NULL DEFAULT '{}',  -- only the changed fields
  notes              TEXT,
  created_at         TIMESTAMPTZ DEFAULT now(),
  created_by         UUID
);

ALTER TABLE public.lease_amendments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lease_amendments_select" ON public.lease_amendments
  FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));
CREATE POLICY "lease_amendments_insert" ON public.lease_amendments
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));
CREATE POLICY "lease_amendments_update" ON public.lease_amendments
  FOR UPDATE USING (public.can_write_org_data(org_id));
CREATE POLICY "lease_amendments_delete" ON public.lease_amendments
  FOR DELETE USING (public.can_write_org_data(org_id));

CREATE INDEX IF NOT EXISTS idx_lease_amendments_lease
  ON public.lease_amendments (lease_id, effective_date);

-- ============================================================
-- lease_assignments — assignment / consent chain
-- ------------------------------------------------------------
-- Tracks tenant substitutions via assignment or consent
-- documents. Preserves the full chain (original tenant →
-- current tenant) even when the base lease row is overwritten.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.lease_assignments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id             UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  source_file_id       UUID REFERENCES public.uploaded_files(id) ON DELETE SET NULL,
  assignment_type      TEXT CHECK (assignment_type IN (
    'assignment', 'consent', 'sublease', 'novation'
  )),
  from_tenant          TEXT,
  to_tenant            TEXT,
  effective_date       DATE,
  consent_required     BOOLEAN DEFAULT TRUE,
  consent_received     BOOLEAN DEFAULT FALSE,
  consent_date         DATE,
  notes                TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  created_by           UUID
);

ALTER TABLE public.lease_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lease_assignments_select" ON public.lease_assignments
  FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));
CREATE POLICY "lease_assignments_insert" ON public.lease_assignments
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));
CREATE POLICY "lease_assignments_update" ON public.lease_assignments
  FOR UPDATE USING (public.can_write_org_data(org_id));
CREATE POLICY "lease_assignments_delete" ON public.lease_assignments
  FOR DELETE USING (public.can_write_org_data(org_id));

CREATE INDEX IF NOT EXISTS idx_lease_assignments_lease
  ON public.lease_assignments (lease_id, effective_date);

-- ============================================================
-- Column comments (documentation for future operators)
-- ============================================================
COMMENT ON COLUMN public.uploaded_files.extraction_method IS
  'Which engine produced normalized_output: docling | gemini_vision | hybrid | csv_parser | xlsx_parser';
COMMENT ON COLUMN public.uploaded_files.document_subtype IS
  'Classified document subtype used to route review + link rules. See uploaded_files_document_subtype_check.';
COMMENT ON COLUMN public.uploaded_files.normalized_output IS
  'Output of runExtractionPipeline(): {rows, method, warnings, validationErrors, metadata}.';
COMMENT ON COLUMN public.uploaded_files.ui_review_payload IS
  'Frozen snapshot rendered by the review UI — field-by-field values, sources, confidence.';
COMMENT ON COLUMN public.uploaded_files.review_required IS
  'TRUE when a human must approve before store-data runs (lease-sensitive subtypes).';
COMMENT ON TABLE  public.compute_runs IS
  'Audit row per compute engine invocation. input_fingerprint is used to detect stale results.';
COMMENT ON TABLE  public.document_links IS
  'Generic many-to-many link between uploaded_files and any business entity.';
COMMENT ON TABLE  public.lease_amendments IS
  'Amendment / addendum / extension deltas layered on top of a base lease.';
COMMENT ON TABLE  public.lease_assignments IS
  'Assignment / consent chain preserving tenant substitution history.';
