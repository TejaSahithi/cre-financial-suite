-- P3.3 — lease_package_membership_decisions: one immutable row per
-- package-membership-resolver invocation. This is deliberately NOT a mutation
-- of lease_package_documents (whose identity is frozen per P3.2) -- a
-- re-extraction (new generation) or a repeated resolver run must be able to
-- produce new decision provenance without rewriting or erasing prior
-- history. package_id/membership_id are nullable: an 'ambiguous',
-- 'requires_related_document' or 'unsupported' decision may never resolve to
-- an actual package/membership row at all.

CREATE TABLE public.lease_package_membership_decisions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id  UUID NOT NULL,
  extraction_run_id UUID NOT NULL,
  generation_id     UUID NOT NULL,

  package_id    UUID,
  membership_id UUID,

  decision TEXT NOT NULL CHECK (decision IN (
    'create_package', 'join_existing_package', 'propose_existing_package',
    'ambiguous', 'requires_related_document', 'unsupported'
  )),
  membership_role   TEXT NOT NULL CHECK (membership_role IN (
    'primary_base_document', 'related_document', 'amendment_document', 'assignment_document',
    'extension_document', 'renewal_document', 'commencement_document', 'guaranty_document',
    'addendum_document', 'exhibit_document', 'unknown_document'
  )),
  membership_status TEXT NOT NULL CHECK (membership_status IN ('proposed', 'confirmed', 'ambiguous', 'rejected')),
  membership_source TEXT NOT NULL CHECK (membership_source IN ('legacy_link', 'deterministic', 'reviewer', 'system')),
  confidence         NUMERIC(5, 4),

  reason_codes         JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_claim_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
  candidate_package_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  related_document_requirement_type   TEXT,
  related_document_requirement_reason TEXT,

  decision_key TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, decision_key),
  UNIQUE (id, org_id),

  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  -- 4-part: catches wrong-file/wrong-generation in one FK (same pattern as lease_claims/lease_document_segments).
  FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id)
    REFERENCES public.extraction_runs (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE SET NULL (package_id),
  -- 3-part: a linked membership row must belong to THIS decision's own package_id, not just the same org.
  FOREIGN KEY (membership_id, package_id, org_id)
    REFERENCES public.lease_package_documents (id, package_id, org_id) ON DELETE SET NULL (membership_id),

  CHECK (char_length(decision_key) BETWEEN 1 AND 600),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (octet_length(reason_codes::text) <= 5000),
  CHECK (octet_length(evidence_claim_ids::text) <= 5000),
  CHECK (octet_length(candidate_package_ids::text) <= 5000),
  -- membership_id can only be set once the decision actually resolved to a
  -- real membership -- 'ambiguous'/'requires_related_document'/'unsupported'
  -- decisions never carry one.
  CHECK (
    (decision IN ('create_package', 'join_existing_package') AND package_id IS NOT NULL)
    OR (decision IN ('propose_existing_package', 'ambiguous', 'requires_related_document', 'unsupported'))
  ),
  -- related_document_requirement_type/_reason are a summary of "this
  -- decision ALSO produced (or would produce) a related-document
  -- requirement" -- they can co-occur with ANY decision type (e.g. an
  -- assignment can join_existing_package as a member AND still need an
  -- open base_lease requirement, per the P3.3 spec's own example), not only
  -- the 'requires_related_document' decision (which is reserved for the
  -- narrower case of a document that cannot resolve to any package/
  -- membership at all). Both columns are simply nullable together.
  CHECK (
    (related_document_requirement_type IS NULL AND related_document_requirement_reason IS NULL)
    OR (related_document_requirement_type IS NOT NULL AND related_document_requirement_reason IS NOT NULL)
  )
);

CREATE INDEX idx_lease_package_membership_decisions_file ON public.lease_package_membership_decisions (org_id, uploaded_file_id);
CREATE INDEX idx_lease_package_membership_decisions_package ON public.lease_package_membership_decisions (org_id, package_id) WHERE package_id IS NOT NULL;

ALTER TABLE public.lease_package_membership_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_package_membership_decisions_org_select ON public.lease_package_membership_decisions
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_package_membership_decisions FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.enforce_lease_package_membership_decisions_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lease_package_membership_decisions rows are immutable (decision %)', OLD.id;
END;
$$;

CREATE TRIGGER trg_lease_package_membership_decisions_immutable
  BEFORE UPDATE ON public.lease_package_membership_decisions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_package_membership_decisions_immutable();

-- Safe projection view (created now for forward-compatibility, grants
-- deferred, same posture as every prior P2.1/P3.1/P3.2 table).
CREATE VIEW public.lease_package_membership_decisions_safe AS
SELECT
  id, org_id, uploaded_file_id, extraction_run_id, generation_id, package_id,
  membership_id, decision, membership_role, membership_status, membership_source,
  confidence, related_document_requirement_type, created_at
FROM public.lease_package_membership_decisions
WHERE public.is_member_of_org(org_id);
-- Excludes decision_key (internal idempotency identifier), reason_codes/
-- evidence_claim_ids/candidate_package_ids (may carry document-adjacent
-- identifiers not meant for broad reading without a real consumer yet).
