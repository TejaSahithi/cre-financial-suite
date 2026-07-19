-- P3.2 — lease_document_relationships: an explicit, evidenced edge between
-- two package documents (or their segments). Identity columns (package,
-- source/target, type, producer, provenance, key) are frozen after insert;
-- only relationship_status, validation_status, resolution_reason and
-- evidence_summary may change, through the controlled transition trigger
-- below. Confirmation requires a real ground -- evidence, a deterministic/
-- semantic detector with a valid classification, or a reviewer decision --
-- never upload order or recency, structurally: nothing on this table reads
-- created_at/updated_at as a signal, and no column here is derived from it.

CREATE TABLE public.lease_document_relationships (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id                UUID NOT NULL,
  source_package_document_id UUID NOT NULL,
  target_package_document_id UUID,
  source_segment_id         UUID,
  target_segment_id         UUID,

  relationship_type   TEXT NOT NULL CHECK (relationship_type IN (
    'base_document', 'amends', 'assigns', 'supersedes', 'extends', 'renews',
    'guarantees', 'resolves_commencement', 'incorporates', 'attachment_to', 'related_unknown'
  )),
  relationship_status  TEXT NOT NULL DEFAULT 'proposed' CHECK (relationship_status IN (
    'proposed', 'confirmed', 'rejected', 'ambiguous', 'requires_related_document', 'superseded'
  )),
  relationship_key     TEXT NOT NULL,
  effective_date       DATE,
  confidence           NUMERIC(5, 4),

  producer_type    TEXT NOT NULL CHECK (producer_type IN (
    'deterministic_relationship_detector', 'semantic_relationship_detector', 'reviewer', 'system'
  )),
  producer_name    TEXT,
  producer_version TEXT,

  extraction_run_id       UUID NOT NULL,
  extraction_stage_run_id UUID,
  provider_invocation_id  UUID,
  generation_id           UUID NOT NULL,

  evidence_claim_id  UUID,
  evidence_summary   JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_status  TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'valid', 'invalid', 'needs_review')),
  resolution_reason  TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, relationship_key),
  UNIQUE (id, org_id),

  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  -- 3-part: source/target package-document must belong to THIS relationship's
  -- own package_id, not just the same org (mirrors extraction_stage_runs'
  -- own run-scoped 3-part FK pattern from P1).
  FOREIGN KEY (source_package_document_id, package_id, org_id)
    REFERENCES public.lease_package_documents (id, package_id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_package_document_id, package_id, org_id)
    REFERENCES public.lease_package_documents (id, package_id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_segment_id, org_id) REFERENCES public.lease_document_segments (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_segment_id, org_id) REFERENCES public.lease_document_segments (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (extraction_run_id, org_id) REFERENCES public.extraction_runs (id, org_id) ON DELETE RESTRICT,
  -- 3-part: this relationship's provider invocation must belong to THIS
  -- relationship's own extraction_stage_run_id (same shape lease_claims/
  -- lease_document_profile_records already use for the identical reason).
  FOREIGN KEY (provider_invocation_id, extraction_stage_run_id, extraction_run_id, org_id)
    REFERENCES public.provider_invocations (id, stage_run_id, run_id, org_id) ON DELETE SET NULL (provider_invocation_id),
  FOREIGN KEY (evidence_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE SET NULL (evidence_claim_id),

  CHECK (target_package_document_id IS NULL OR source_package_document_id <> target_package_document_id),
  CHECK (char_length(relationship_key) BETWEEN 1 AND 600),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (octet_length(evidence_summary::text) <= 20000),

  -- Producer-conditional provenance requirements (mirrors lease_claims exactly).
  CHECK (
    (producer_type IN ('deterministic_relationship_detector', 'semantic_relationship_detector') AND extraction_stage_run_id IS NOT NULL)
    OR (producer_type IN ('reviewer', 'system') AND extraction_stage_run_id IS NULL)
  ),
  CHECK (
    (producer_type = 'semantic_relationship_detector' AND provider_invocation_id IS NOT NULL)
    OR (producer_type <> 'semantic_relationship_detector' AND provider_invocation_id IS NULL)
  ),

  -- A relationship may only be 'confirmed' on a real ground: a valid linked
  -- evidence claim, a deterministic/semantic detector whose own validation
  -- passed, or an explicit reviewer decision. This is the structural
  -- enforcement that upload order (or any other implicit signal) can never
  -- be the sole reason a relationship reaches 'confirmed'.
  CHECK (
    relationship_status <> 'confirmed'
    OR (evidence_claim_id IS NOT NULL AND validation_status = 'valid')
    OR (producer_type IN ('deterministic_relationship_detector', 'semantic_relationship_detector') AND validation_status = 'valid')
    OR producer_type = 'reviewer'
  )
);

CREATE INDEX idx_lease_document_relationships_package ON public.lease_document_relationships (org_id, package_id);
CREATE INDEX idx_lease_document_relationships_source ON public.lease_document_relationships (source_package_document_id);
CREATE INDEX idx_lease_document_relationships_target ON public.lease_document_relationships (target_package_document_id) WHERE target_package_document_id IS NOT NULL;
CREATE INDEX idx_lease_document_relationships_status ON public.lease_document_relationships (org_id, relationship_status);

ALTER TABLE public.lease_document_relationships ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_document_relationships_org_select ON public.lease_document_relationships
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_document_relationships FROM authenticated, anon;

-- Controlled state machine: identity columns (package_id, source/target
-- package-document, source/target segment, type, producer*, provenance,
-- key, generation_id, evidence_claim_id, org_id, created_at) are frozen.
-- Only relationship_status (via the allowed edges below), validation_status,
-- resolution_reason and evidence_summary may change.
CREATE OR REPLACE FUNCTION public.enforce_lease_document_relationship_transitions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.package_id IS DISTINCT FROM OLD.package_id
     OR NEW.source_package_document_id IS DISTINCT FROM OLD.source_package_document_id
     OR NEW.target_package_document_id IS DISTINCT FROM OLD.target_package_document_id
     OR NEW.source_segment_id IS DISTINCT FROM OLD.source_segment_id
     OR NEW.target_segment_id IS DISTINCT FROM OLD.target_segment_id
     OR NEW.relationship_type IS DISTINCT FROM OLD.relationship_type
     OR NEW.relationship_key IS DISTINCT FROM OLD.relationship_key
     OR NEW.producer_type IS DISTINCT FROM OLD.producer_type
     OR NEW.producer_name IS DISTINCT FROM OLD.producer_name
     OR NEW.producer_version IS DISTINCT FROM OLD.producer_version
     OR NEW.extraction_run_id IS DISTINCT FROM OLD.extraction_run_id
     OR NEW.extraction_stage_run_id IS DISTINCT FROM OLD.extraction_stage_run_id
     OR NEW.provider_invocation_id IS DISTINCT FROM OLD.provider_invocation_id
     OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
     OR NEW.evidence_claim_id IS DISTINCT FROM OLD.evidence_claim_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'lease_document_relationships: identity columns are immutable (relationship %)', OLD.id;
  END IF;

  IF NEW.relationship_status IS DISTINCT FROM OLD.relationship_status THEN
    IF OLD.relationship_status IN ('rejected', 'superseded') THEN
      RAISE EXCEPTION 'lease_document_relationships: % is terminal, no further transition allowed (relationship %)', OLD.relationship_status, OLD.id;
    END IF;
    IF NOT (
      (OLD.relationship_status = 'proposed' AND NEW.relationship_status IN ('confirmed', 'rejected', 'ambiguous', 'requires_related_document', 'superseded'))
      OR (OLD.relationship_status = 'ambiguous' AND NEW.relationship_status IN ('confirmed', 'rejected', 'requires_related_document', 'superseded'))
      OR (OLD.relationship_status = 'requires_related_document' AND NEW.relationship_status IN ('confirmed', 'rejected', 'ambiguous', 'superseded'))
      OR (OLD.relationship_status = 'confirmed' AND NEW.relationship_status = 'superseded')
    ) THEN
      RAISE EXCEPTION 'lease_document_relationships: illegal status transition % -> % (relationship %)', OLD.relationship_status, NEW.relationship_status, OLD.id;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_document_relationship_transitions
  BEFORE UPDATE ON public.lease_document_relationships
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_document_relationship_transitions();
