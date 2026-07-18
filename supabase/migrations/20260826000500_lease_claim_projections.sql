-- P2.1 — lease_claim_projection_runs + lease_field_projections.
--
-- A projection run deterministically materializes the current winning
-- claims for a generation into the existing Lease Review compatibility
-- payload shape (P2.6+ builds the actual projector; this migration is
-- schema only). Round-2 correction #9: reproducibility metadata is captured
-- NOW, not deferred to P2.6, so a completed projection run can always answer
-- "which registry/projection code version selected this compatibility
-- field" from the row alone.

CREATE TABLE public.lease_claim_projection_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id  UUID NOT NULL,
  lease_id          UUID,
  generation_id     UUID NOT NULL,
  extraction_run_id UUID NOT NULL,

  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  error_code    TEXT,
  error_message TEXT,

  -- Reproducibility metadata (round-2 correction #9).
  claims_registry_version       TEXT NOT NULL,
  claims_registry_hash          TEXT NOT NULL,
  projection_version            TEXT NOT NULL,
  compatibility_contract_version TEXT NOT NULL,
  ledger_mode                   TEXT NOT NULL CHECK (ledger_mode IN ('off', 'shadow', 'active')),
  input_claim_count             INT NOT NULL DEFAULT 0,
  -- Nullable until P2.6 actually computes them -- columns exist now so the
  -- row shape is stable across the phases that will populate them.
  input_claims_hash  TEXT,
  legacy_payload_hash TEXT,
  claim_payload_hash  TEXT,

  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (id, org_id),
  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  -- Column-scoped SET NULL: a bare SET NULL would null org_id too (NOT
  -- NULL) whenever a linked lease is deleted.
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id)
    REFERENCES public.extraction_runs (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,

  CHECK ((status = 'running' AND completed_at IS NULL) OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)),
  CHECK (status <> 'completed' OR (error_code IS NULL AND error_message IS NULL)),
  CHECK (input_claim_count >= 0),
  CHECK (char_length(claims_registry_version) BETWEEN 1 AND 100),
  CHECK (claims_registry_hash ~ '^[0-9a-f]{64}$'),
  CHECK (char_length(projection_version) BETWEEN 1 AND 100),
  CHECK (char_length(compatibility_contract_version) BETWEEN 1 AND 200)
);

CREATE INDEX idx_lease_claim_projection_runs_file ON public.lease_claim_projection_runs (org_id, uploaded_file_id, created_at DESC);
CREATE INDEX idx_lease_claim_projection_runs_lease ON public.lease_claim_projection_runs (org_id, lease_id) WHERE lease_id IS NOT NULL;

ALTER TABLE public.lease_claim_projection_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_claim_projection_runs_org_select ON public.lease_claim_projection_runs
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_claim_projection_runs FROM authenticated, anon;

-- Terminal immutability: once completed/failed, a projection run is frozen.
-- A future P2.6 RPC settles it via a conditional UPDATE ... WHERE
-- status='running' (the same idempotent-settlement pattern already proven
-- in P1's settle_extraction_stage_run/settle_provider_invocation) -- this
-- trigger is what makes "terminal projection run can't return to running"
-- true regardless of caller.
CREATE OR REPLACE FUNCTION public.enforce_lease_claim_projection_run_terminal_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Single narrow exception, same rationale as lease_claims: leases(id)
  -- ON DELETE SET NULL fires an UPDATE that nulls lease_id alone, and must
  -- be allowed through untouched even on an already-terminal row --
  -- otherwise deleting a lease referenced by a completed/failed projection
  -- run would fail outright, defeating round-2 correction #8.
  IF NEW.lease_id IS NULL AND OLD.lease_id IS NOT NULL
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     AND NEW.uploaded_file_id IS NOT DISTINCT FROM OLD.uploaded_file_id
     AND NEW.generation_id IS NOT DISTINCT FROM OLD.generation_id
     AND NEW.extraction_run_id IS NOT DISTINCT FROM OLD.extraction_run_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.error_code IS NOT DISTINCT FROM OLD.error_code
     AND NEW.error_message IS NOT DISTINCT FROM OLD.error_message
     AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
  THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'lease_claim_projection_runs row % is terminal (%) and cannot be modified', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_claim_projection_run_terminal_guard
  BEFORE UPDATE ON public.lease_claim_projection_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_claim_projection_run_terminal_guard();

-- ---------------------------------------------------------------------------
-- lease_field_projections -- one row per compatibility field key per
-- projection run, each traced to the specific winning claim it came from
-- (never a bare value with no claim lineage -- this is what "no candidate
-- fact silently discarded" means at the projection layer too).
-- ---------------------------------------------------------------------------
CREATE TABLE public.lease_field_projections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  projection_run_id UUID NOT NULL,
  extraction_run_id UUID NOT NULL,

  field_key        TEXT NOT NULL,
  claim_id         UUID NOT NULL,
  assertion_status TEXT NOT NULL,
  value            TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (projection_run_id, field_key),
  FOREIGN KEY (projection_run_id, org_id) REFERENCES public.lease_claim_projection_runs (id, org_id) ON DELETE CASCADE,
  -- Same-run claim linkage, same pattern as lease_claim_evidence_links:
  -- a projected field must trace to a claim from the SAME extraction run as
  -- the projection run itself, not merely the same org.
  FOREIGN KEY (claim_id, extraction_run_id, org_id)
    REFERENCES public.lease_claims (id, extraction_run_id, org_id) ON DELETE RESTRICT,

  CHECK (char_length(field_key) BETWEEN 1 AND 200),
  CHECK (value IS NULL OR char_length(value) <= 10000)
);

CREATE INDEX idx_lease_field_projections_run ON public.lease_field_projections (projection_run_id);
CREATE INDEX idx_lease_field_projections_claim ON public.lease_field_projections (claim_id);

ALTER TABLE public.lease_field_projections ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_field_projections_org_select ON public.lease_field_projections
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_field_projections FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.enforce_lease_field_projections_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lease_field_projections rows are immutable (projection %)', OLD.id;
END;
$$;

CREATE TRIGGER trg_lease_field_projections_immutable
  BEFORE UPDATE ON public.lease_field_projections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_field_projections_immutable();
