-- P2.1 — lease_claims: the atomic, immutable claim ledger core table.
--
-- Every candidate fact the extraction pipeline discovers becomes exactly one
-- row here (never silently discarded) -- an asserted/derived/calculated
-- value, or an explicit not_present/not_applicable/unreadable/
-- requires_related_document/extraction_failed observation. Corrections are
-- a NEW row with supersedes_claim_id set, never an UPDATE -- this table is
-- fully immutable after insert (see the trigger below). "Ambiguous" facts
-- are represented as multiple separate 'asserted' claims linked into one
-- open lease_claim_conflict_groups row (next migration), not a bounded
-- multi-value object or an 'ambiguous' status on a single claim.

CREATE TABLE public.lease_claims (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id         UUID NOT NULL,
  -- Nullable and ON DELETE SET NULL (round-2 correction #8): the immutable
  -- document/run/file provenance chain must survive even if a lease
  -- business record is later deliberately removed.
  lease_id                 UUID,
  -- Same UUID as extraction_runs.generation_id / pipeline_jobs.generation_id
  -- (P0/P1 precedent) -- not itself an FK, generation_id is not a primary
  -- key anywhere; the real tenant/run-scoping guarantee comes from the
  -- composite extraction_run_id FK below.
  generation_id            UUID NOT NULL,
  extraction_run_id        UUID NOT NULL,
  -- Nullable (round-2 correction #2): a reviewer/system_projection claim
  -- isn't produced by a parse/normalize/enrich stage.
  extraction_stage_run_id  UUID,
  -- Nullable (round-2 correction #2): only semantic_extractor claims
  -- require a specific provider invocation.
  provider_invocation_id   UUID,

  producer_type TEXT NOT NULL CHECK (producer_type IN (
    'deterministic_mapper', 'semantic_extractor', 'validation_engine',
    'legacy_adapter', 'reviewer', 'system_projection'
  )),

  -- concept_key is either a registered lease_claim_concepts.concept_key
  -- (registry_status='registered') or a normalizeDynamicKey()-produced
  -- 'dynamic.<key>' namespace key for an unmapped/discovered finding
  -- (registry_status='unregistered') -- see the trigger below for the
  -- cross-table membership check a bare CHECK constraint cannot express.
  concept_key             TEXT NOT NULL,
  registry_status         TEXT NOT NULL CHECK (registry_status IN ('registered', 'unregistered')),
  claims_registry_version TEXT NOT NULL,

  -- scope_key: which real-world subject this claim is about ('lease' for an
  -- ordinary lease-level fact; a sub-entity scope like 'unit:suite_3' or
  -- 'party:guarantor_1' otherwise). instance_key: which instance of a
  -- multiple-cardinality concept this is (see ClaimInstanceStrategy,
  -- concept-types.ts) -- 'default' for every current singleton concept.
  scope_key         TEXT NOT NULL DEFAULT 'lease',
  instance_key      TEXT NOT NULL DEFAULT 'default',
  -- Distinguishes genuinely separate candidate assertions for the same
  -- concept/scope/instance (e.g. two conflicting values found in one
  -- document) from "one more piece of evidence for the same assertion" --
  -- claim identity intentionally does NOT include an evidence fingerprint
  -- (round-2 correction #4).
  candidate_ordinal INT NOT NULL DEFAULT 0,

  assertion_status TEXT NOT NULL CHECK (assertion_status IN (
    'asserted', 'derived', 'calculated',
    'not_present', 'not_applicable', 'unreadable',
    'requires_related_document', 'extraction_failed'
  )),

  normalized_value TEXT,
  raw_value_text   TEXT,
  -- Free-form structured detail on how a derived/calculated value was
  -- produced (e.g. which other claims/fields it was computed from). Never
  -- raw document text or secrets.
  derivation JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC(5, 4),

  -- Producer+concept+scope+instance+normalized_value+candidate_ordinal,
  -- scoped to the generation/stage-attempt that produced it -- computed by
  -- the P2.4 adapter, not by the database. UNIQUE(org_id, claim_key) is the
  -- idempotency authority: a retried adapter call with the identical
  -- inputs produces the identical claim_key and is a safe no-op-on-conflict
  -- insert, never a duplicate row.
  claim_key TEXT NOT NULL,

  -- A correction is a new row superseding an old one -- never an UPDATE.
  supersedes_claim_id UUID,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, claim_key),
  UNIQUE (id, org_id),
  -- Lets lease_claim_evidence_links (next migration) FK against
  -- (claim_id, extraction_run_id, org_id) -- structurally prevents linking a
  -- claim from one run to evidence from a different run, not just same-org.
  UNIQUE (id, extraction_run_id, org_id),

  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  -- Column-scoped SET NULL (Postgres 15+): a bare `ON DELETE SET NULL` on a
  -- multi-column FK nulls EVERY referencing column, not just the intended
  -- one -- which would null org_id too (NOT NULL) whenever a linked lease
  -- is deleted, breaking the delete outright. Same fix applied to
  -- extraction_runs.lease_id in P1 after this was discovered.
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  -- 4-part composite (round-2 correction #3): catches a claim referencing
  -- the right run but the wrong file or wrong generation in one FK.
  FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id)
    REFERENCES public.extraction_runs (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,
  -- 4-part composite (round-2 correction #3): catches a claim referencing a
  -- provider invocation belonging to a different stage/run. Column-scoped
  -- SET NULL for the same reason as lease_id above.
  FOREIGN KEY (provider_invocation_id, extraction_stage_run_id, extraction_run_id, org_id)
    REFERENCES public.provider_invocations (id, stage_run_id, run_id, org_id) ON DELETE SET NULL (provider_invocation_id),
  FOREIGN KEY (supersedes_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE SET NULL (supersedes_claim_id),

  -- Producer-conditional stage/invocation requirements (round-2 correction #2).
  CHECK (
    (producer_type IN ('deterministic_mapper', 'semantic_extractor', 'validation_engine', 'legacy_adapter') AND extraction_stage_run_id IS NOT NULL)
    OR (producer_type IN ('reviewer', 'system_projection') AND extraction_stage_run_id IS NULL)
  ),
  CHECK (
    (producer_type = 'semantic_extractor' AND provider_invocation_id IS NOT NULL)
    OR (producer_type <> 'semantic_extractor' AND provider_invocation_id IS NULL)
  ),

  -- Registry-namespace consistency (round-2 correction #5): a registered
  -- concept must never accidentally use the dynamic namespace or vice versa.
  CHECK (
    (registry_status = 'registered' AND concept_key NOT LIKE 'dynamic.%')
    OR (registry_status = 'unregistered' AND concept_key LIKE 'dynamic.%')
  ),

  -- Assertion/value consistency (round-2 correction #5).
  CHECK (
    (assertion_status IN ('asserted', 'derived', 'calculated') AND normalized_value IS NOT NULL)
    OR (assertion_status IN ('not_present', 'not_applicable', 'unreadable', 'requires_related_document', 'extraction_failed') AND normalized_value IS NULL)
  ),

  -- Explicit size/length CHECKs (round-2 correction #5).
  CHECK (char_length(concept_key) BETWEEN 1 AND 200),
  CHECK (char_length(scope_key) BETWEEN 1 AND 200),
  CHECK (char_length(instance_key) BETWEEN 1 AND 200),
  CHECK (candidate_ordinal >= 0),
  CHECK (normalized_value IS NULL OR char_length(normalized_value) <= 10000),
  CHECK (raw_value_text IS NULL OR char_length(raw_value_text) <= 20000),
  CHECK (octet_length(derivation::text) <= 20000),
  CHECK (octet_length(metadata::text) <= 20000),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (char_length(claim_key) BETWEEN 1 AND 600)
);

CREATE INDEX idx_lease_claims_org_lease ON public.lease_claims (org_id, lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX idx_lease_claims_org_file ON public.lease_claims (org_id, uploaded_file_id);
CREATE INDEX idx_lease_claims_run ON public.lease_claims (org_id, extraction_run_id);
CREATE INDEX idx_lease_claims_concept ON public.lease_claims (org_id, concept_key);
CREATE INDEX idx_lease_claims_supersedes ON public.lease_claims (supersedes_claim_id) WHERE supersedes_claim_id IS NOT NULL;

ALTER TABLE public.lease_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_claims_org_select ON public.lease_claims
  FOR SELECT USING (public.is_member_of_org(org_id));
-- No grant to authenticated/anon yet (see the security migration) -- this
-- policy exists for forward-compatibility only and is currently unreachable
-- because SELECT itself is revoked below.
REVOKE ALL ON public.lease_claims FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- Registry membership: a bare CHECK constraint cannot reference another
-- table, so registered-concept validity against the generated DB snapshot
-- (lease_claim_concepts) is enforced here, at insert time.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_lease_claim_concept_registered()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.registry_status = 'registered' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.lease_claim_concepts
       WHERE concept_key = NEW.concept_key
         AND registry_version = NEW.claims_registry_version
    ) THEN
      RAISE EXCEPTION 'concept_key % is not present in lease_claim_concepts for registry_version % -- register it in the TS concept registry and regenerate the DB snapshot first', NEW.concept_key, NEW.claims_registry_version;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_claim_concept_registered
  BEFORE INSERT ON public.lease_claims
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_claim_concept_registered();

-- ---------------------------------------------------------------------------
-- Supersession compatibility: a correction must reference a claim for the
-- SAME real-world fact slot (concept_key/scope_key/instance_key), never an
-- arbitrary other claim. Cross-org supersession is already impossible (the
-- (supersedes_claim_id, org_id) composite FK guarantees it), so this trigger
-- only needs to check the fact-slot match.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_lease_claim_supersession_compatibility()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target RECORD;
BEGIN
  IF NEW.supersedes_claim_id IS NOT NULL THEN
    SELECT concept_key, scope_key, instance_key INTO v_target
      FROM public.lease_claims WHERE id = NEW.supersedes_claim_id;
    IF v_target.concept_key IS DISTINCT FROM NEW.concept_key
       OR v_target.scope_key IS DISTINCT FROM NEW.scope_key
       OR v_target.instance_key IS DISTINCT FROM NEW.instance_key THEN
      RAISE EXCEPTION 'supersedes_claim_id % is not compatible: superseding claim must share concept_key/scope_key/instance_key with the claim it corrects', NEW.supersedes_claim_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_claim_supersession_compatibility
  BEFORE INSERT ON public.lease_claims
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_claim_supersession_compatibility();

-- ---------------------------------------------------------------------------
-- Immutability: lease_claims rows are never updated after insert. A
-- correction is always a new row with supersedes_claim_id set.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_lease_claims_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Single narrow exception: leases(id) ON DELETE SET NULL fires an UPDATE
  -- that nulls lease_id alone. Round-2 correction #8's whole point was that
  -- the immutable document/run/file provenance chain must survive a
  -- deliberate lease deletion via exactly this cascade -- a blanket
  -- rejection here would silently break that cascade and make deleting any
  -- lease with claims fail outright. Mirrors extraction_runs' already-proven
  -- lease_id one-time-move exception from P1, just in the opposite
  -- direction (non-null -> NULL instead of NULL -> non-null).
  IF NEW.lease_id IS NULL AND OLD.lease_id IS NOT NULL
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     AND NEW.uploaded_file_id IS NOT DISTINCT FROM OLD.uploaded_file_id
     AND NEW.generation_id IS NOT DISTINCT FROM OLD.generation_id
     AND NEW.extraction_run_id IS NOT DISTINCT FROM OLD.extraction_run_id
     AND NEW.extraction_stage_run_id IS NOT DISTINCT FROM OLD.extraction_stage_run_id
     AND NEW.provider_invocation_id IS NOT DISTINCT FROM OLD.provider_invocation_id
     AND NEW.producer_type IS NOT DISTINCT FROM OLD.producer_type
     AND NEW.concept_key IS NOT DISTINCT FROM OLD.concept_key
     AND NEW.registry_status IS NOT DISTINCT FROM OLD.registry_status
     AND NEW.claims_registry_version IS NOT DISTINCT FROM OLD.claims_registry_version
     AND NEW.scope_key IS NOT DISTINCT FROM OLD.scope_key
     AND NEW.instance_key IS NOT DISTINCT FROM OLD.instance_key
     AND NEW.candidate_ordinal IS NOT DISTINCT FROM OLD.candidate_ordinal
     AND NEW.assertion_status IS NOT DISTINCT FROM OLD.assertion_status
     AND NEW.normalized_value IS NOT DISTINCT FROM OLD.normalized_value
     AND NEW.raw_value_text IS NOT DISTINCT FROM OLD.raw_value_text
     AND NEW.derivation IS NOT DISTINCT FROM OLD.derivation
     AND NEW.confidence IS NOT DISTINCT FROM OLD.confidence
     AND NEW.claim_key IS NOT DISTINCT FROM OLD.claim_key
     AND NEW.supersedes_claim_id IS NOT DISTINCT FROM OLD.supersedes_claim_id
     AND NEW.metadata IS NOT DISTINCT FROM OLD.metadata
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'lease_claims rows are immutable -- corrections must be a new row with supersedes_claim_id set, never an UPDATE (claim %)', OLD.id;
END;
$$;

CREATE TRIGGER trg_lease_claims_immutable
  BEFORE UPDATE ON public.lease_claims
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_claims_immutable();
