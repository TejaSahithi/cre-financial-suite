-- Enterprise Document Intelligence v3, Phase 1: durable claim/evidence
-- storage scaffold. Additive only -- no existing table, column, RPC, or RLS
-- policy is altered, renamed, or dropped. Nothing in the runtime pipeline
-- writes to these tables yet (that is explicitly deferred to a later
-- phase); this migration exists so the v3 contract has a real, queryable,
-- versioned home instead of living only inside the transient
-- ui_review_payload JSONB blob, per
-- docs/document-intelligence-v3-baseline.md Section 6 ("Durable claim/
-- evidence ledger is missing") and Section 7 recommendation 2.
--
-- RLS follows the lease_abstract_versions / lease_field_reviews precedent
-- (20260706130000_lease_abstract_versions.sql): SELECT-only for
-- authenticated org members via is_member_of_org(org_id)
-- (20260706125000_add_is_member_of_org_helper.sql), which is
-- local/remote-portable unlike org_id = ANY(get_my_org_ids()) -- see that
-- migration's header comment. No INSERT/UPDATE/DELETE policy is granted to
-- `authenticated`; until a later phase adds a SECURITY DEFINER workflow RPC
-- (per docs/server-owned-workflow-pattern.md) to write these tables, only
-- service_role can write them, matching how lease_abstract_versions starts
-- locked down by construction rather than being retrofitted later.

-- ── 1. document_intelligence_runs ────────────────────────────────────────────
-- One row per v3 contract build attempt for a given uploaded_files row.
-- Analogous in spirit to pipeline_jobs, but scoped to the v3 contract
-- lifecycle rather than the legacy_hybrid/vertex_fact_ledger pipeline
-- stages -- this table does not replace or interact with pipeline_jobs.
CREATE TABLE IF NOT EXISTS public.document_intelligence_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  pipeline_job_id UUID REFERENCES public.pipeline_jobs(id) ON DELETE SET NULL,
  contract_version TEXT NOT NULL DEFAULT 'document_intelligence_v3.phase1',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  version_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
  readiness JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_intelligence_runs_uploaded_file
  ON public.document_intelligence_runs (org_id, uploaded_file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_intelligence_runs_lease
  ON public.document_intelligence_runs (org_id, lease_id, created_at DESC);

ALTER TABLE public.document_intelligence_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_intelligence_runs_select" ON public.document_intelligence_runs;
CREATE POLICY "document_intelligence_runs_select" ON public.document_intelligence_runs
  FOR SELECT USING (public.is_member_of_org(org_id));

DROP TRIGGER IF EXISTS set_document_intelligence_runs_updated_at ON public.document_intelligence_runs;
CREATE TRIGGER set_document_intelligence_runs_updated_at
  BEFORE UPDATE ON public.document_intelligence_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

-- ── 2. document_claims ────────────────────────────────────────────────────────
-- Durable home for the claim ledger the vertex_fact_ledger provider already
-- computes transiently today (supabase/functions/_shared/extraction/
-- vertex-fact-ledger/types.ts's `Fact`, per baseline doc Section 5). This
-- table gives each claim a stable id, org scoping, and a supersession
-- chain -- none of which the transient in-JSONB Fact[] ledger provides.
CREATE TABLE IF NOT EXISTS public.document_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.document_intelligence_runs(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  claim_type TEXT NOT NULL,
  subject JSONB NOT NULL DEFAULT '{}'::jsonb,
  predicate TEXT NOT NULL,
  object JSONB NOT NULL DEFAULT '{}'::jsonb,
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  effective_from DATE,
  effective_to DATE,
  extraction_mode TEXT NOT NULL
    CHECK (extraction_mode IN (
      'explicit', 'normalized', 'inferred', 'calculated',
      'resolved_from_multiple_sources', 'reviewer_entered'
    )),
  confidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  canonical_field_candidates TEXT[] NOT NULL DEFAULT '{}',
  validation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (validation_status IN ('pending', 'passed', 'failed')),
  evidence_sufficiency TEXT NOT NULL DEFAULT 'none'
    CHECK (evidence_sufficiency IN ('strong', 'partial', 'weak', 'none')),
  validation_rules TEXT[] NOT NULL DEFAULT '{}',
  importance NUMERIC,
  supersedes_claim_id UUID REFERENCES public.document_claims(id) ON DELETE SET NULL,
  superseded_by_claim_id UUID REFERENCES public.document_claims(id) ON DELETE SET NULL,
  current_status TEXT NOT NULL DEFAULT 'current'
    CHECK (current_status IN ('current', 'superseded', 'unknown')),
  changed_by_document UUID REFERENCES public.uploaded_files(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_claims_run
  ON public.document_claims (org_id, run_id);
CREATE INDEX IF NOT EXISTS idx_document_claims_uploaded_file
  ON public.document_claims (org_id, uploaded_file_id);
CREATE INDEX IF NOT EXISTS idx_document_claims_lease
  ON public.document_claims (org_id, lease_id);
CREATE INDEX IF NOT EXISTS idx_document_claims_supersedes
  ON public.document_claims (supersedes_claim_id) WHERE supersedes_claim_id IS NOT NULL;

ALTER TABLE public.document_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_claims_select" ON public.document_claims;
CREATE POLICY "document_claims_select" ON public.document_claims
  FOR SELECT USING (public.is_member_of_org(org_id));

DROP TRIGGER IF EXISTS set_document_claims_updated_at ON public.document_claims;
CREATE TRIGGER set_document_claims_updated_at
  BEFORE UPDATE ON public.document_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

-- ── 3. document_claim_evidence ───────────────────────────────────────────────
-- One-to-many evidence rows per claim. `document_id` is a forward reference
-- to the future Document Package Graph node (not yet a real table -- see
-- baseline doc Section 6) and is deliberately left unconstrained;
-- `uploaded_file_id` is the concrete, currently-real source object.
CREATE TABLE IF NOT EXISTS public.document_claim_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.document_claims(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_id UUID,
  uploaded_file_id UUID REFERENCES public.uploaded_files(id) ON DELETE SET NULL,
  page INT,
  source_text TEXT,
  block_ids TEXT[] NOT NULL DEFAULT '{}',
  polygon NUMERIC[] NOT NULL DEFAULT '{}',
  support_type TEXT NOT NULL
    CHECK (support_type IN (
      'direct_quote', 'table_cell', 'visual', 'calculated',
      'cross_reference', 'multi_source'
    )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_claim_evidence_claim
  ON public.document_claim_evidence (org_id, claim_id);

ALTER TABLE public.document_claim_evidence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_claim_evidence_select" ON public.document_claim_evidence;
CREATE POLICY "document_claim_evidence_select" ON public.document_claim_evidence
  FOR SELECT USING (public.is_member_of_org(org_id));

-- ── 4. document_validation_drops ─────────────────────────────────────────────
-- One durable, queryable "why was this value rejected" list, aimed at
-- eventually replacing the three uncoordinated ad hoc noise-suppression
-- mechanisms documented in baseline doc Section 3/4
-- (FALLBACK_VALUE_SENTINELS, LeaseUpload.jsx's noisy-key regex list,
-- ExtractionDebugPanel's missing-trace section) -- not touched by Phase 1.
CREATE TABLE IF NOT EXISTS public.document_validation_drops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.document_intelligence_runs(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  claim_id UUID REFERENCES public.document_claims(id) ON DELETE SET NULL,
  field_key TEXT,
  bad_value JSONB,
  reason TEXT NOT NULL,
  source_text TEXT,
  action TEXT NOT NULL DEFAULT 'dropped'
    CHECK (action IN ('dropped', 'flagged')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_validation_drops_run
  ON public.document_validation_drops (org_id, run_id);
CREATE INDEX IF NOT EXISTS idx_document_validation_drops_uploaded_file
  ON public.document_validation_drops (org_id, uploaded_file_id);

ALTER TABLE public.document_validation_drops ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_validation_drops_select" ON public.document_validation_drops;
CREATE POLICY "document_validation_drops_select" ON public.document_validation_drops
  FOR SELECT USING (public.is_member_of_org(org_id));

-- ── 5. document_canonical_field_projections ─────────────────────────────────
-- A queryable read model of "canonical fields as projections from claims" --
-- the target architecture's core principle (baseline doc Section 6,
-- "ui_review_payload is still the frontend's source of UI truth"). Nothing
-- reads from this table yet; ui_review_payload/normalized_output remain the
-- live UI source of truth, unchanged, per this phase's constraints.
CREATE TABLE IF NOT EXISTS public.document_canonical_field_projections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.document_intelligence_runs(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  field_key TEXT NOT NULL,
  value JSONB,
  normalized_value JSONB,
  status TEXT NOT NULL DEFAULT 'missing'
    CHECK (status IN ('missing', 'auto_populated', 'needs_review', 'reviewer_confirmed', 'reviewer_edited')),
  source_claim_ids UUID[] NOT NULL DEFAULT '{}',
  source_page INT,
  source_text TEXT,
  confidence NUMERIC,
  extraction_mode TEXT
    CHECK (extraction_mode IS NULL OR extraction_mode IN (
      'explicit', 'normalized', 'inferred', 'calculated',
      'resolved_from_multiple_sources', 'reviewer_entered'
    )),
  validation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (validation_status IN ('pending', 'passed', 'failed')),
  canonical_tab TEXT,
  profile_relevance TEXT NOT NULL DEFAULT 'advisory'
    CHECK (profile_relevance IN ('required', 'advisory', 'not_applicable')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_document_canonical_field_projections_uploaded_file
  ON public.document_canonical_field_projections (org_id, uploaded_file_id);
CREATE INDEX IF NOT EXISTS idx_document_canonical_field_projections_lease
  ON public.document_canonical_field_projections (org_id, lease_id);

ALTER TABLE public.document_canonical_field_projections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_canonical_field_projections_select" ON public.document_canonical_field_projections;
CREATE POLICY "document_canonical_field_projections_select" ON public.document_canonical_field_projections
  FOR SELECT USING (public.is_member_of_org(org_id));

DROP TRIGGER IF EXISTS set_document_canonical_field_projections_updated_at ON public.document_canonical_field_projections;
CREATE TRIGGER set_document_canonical_field_projections_updated_at
  BEFORE UPDATE ON public.document_canonical_field_projections
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();
