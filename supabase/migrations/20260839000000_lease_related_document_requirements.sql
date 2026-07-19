-- P3.2 — lease_related_document_requirements: a required but missing or
-- unresolved related document (e.g. an assignment uploaded without its base
-- lease). Identity columns are frozen after insert; only requirement_status,
-- resolved_at, resolved_by_package_document_id and metadata may change,
-- through the controlled transition trigger below. This is the P3-side,
-- document-level counterpart of the P2.1 claim-level assertion_status
-- 'requires_related_document' (lease_claims already supports that value) --
-- consistent vocabulary, not a competing concept.

CREATE TABLE public.lease_related_document_requirements (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                         UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id                     UUID NOT NULL,
  requesting_package_document_id UUID NOT NULL,

  requirement_type        TEXT NOT NULL CHECK (requirement_type IN (
    'base_lease', 'prior_amendment', 'original_assignment', 'commencement_certificate',
    'guaranty', 'referenced_addendum', 'exhibit', 'other_related_document'
  )),
  required_profile_key    TEXT,
  referenced_document_date DATE,
  referenced_party_names  JSONB NOT NULL DEFAULT '[]'::jsonb,
  referenced_identifier   TEXT,

  requirement_status TEXT NOT NULL DEFAULT 'open' CHECK (requirement_status IN (
    'open', 'resolved', 'waived', 'rejected', 'ambiguous'
  )),
  reason_code        TEXT NOT NULL,
  evidence_claim_id   UUID,
  requirement_key     TEXT NOT NULL,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by_package_document_id UUID,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (org_id, requirement_key),
  UNIQUE (id, org_id),

  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (requesting_package_document_id, package_id, org_id)
    REFERENCES public.lease_package_documents (id, package_id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolved_by_package_document_id, package_id, org_id)
    REFERENCES public.lease_package_documents (id, package_id, org_id) ON DELETE SET NULL (resolved_by_package_document_id),
  FOREIGN KEY (evidence_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE SET NULL (evidence_claim_id),

  CHECK (char_length(requirement_key) BETWEEN 1 AND 600),
  CHECK (char_length(reason_code) BETWEEN 1 AND 200),
  CHECK (required_profile_key IS NULL OR char_length(required_profile_key) BETWEEN 1 AND 100),
  CHECK (octet_length(referenced_party_names::text) <= 5000),
  CHECK (octet_length(metadata::text) <= 20000),

  -- Resolution must reference an actual package document, OR be an explicit
  -- reviewer waiver (reason_code carries the waiver justification) -- never
  -- a bare status flip with nothing behind it.
  CHECK (
    (requirement_status = 'resolved' AND resolved_by_package_document_id IS NOT NULL AND resolved_at IS NOT NULL)
    OR (requirement_status = 'waived' AND resolved_at IS NOT NULL)
    OR (requirement_status IN ('open', 'rejected', 'ambiguous') AND resolved_at IS NULL AND resolved_by_package_document_id IS NULL)
  )
);

CREATE INDEX idx_lease_related_document_requirements_package ON public.lease_related_document_requirements (org_id, package_id);
CREATE INDEX idx_lease_related_document_requirements_status ON public.lease_related_document_requirements (org_id, requirement_status);

ALTER TABLE public.lease_related_document_requirements ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_related_document_requirements_org_select ON public.lease_related_document_requirements
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_related_document_requirements FROM authenticated, anon;

-- Controlled state machine: identity columns (package_id, requesting
-- document, type, required_profile_key, referenced_*, evidence_claim_id,
-- requirement_key, org_id, created_at) are frozen. Only requirement_status
-- (via the allowed edges below), resolved_at, resolved_by_package_document_id
-- and metadata may change.
CREATE OR REPLACE FUNCTION public.enforce_lease_related_document_requirement_transitions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.package_id IS DISTINCT FROM OLD.package_id
     OR NEW.requesting_package_document_id IS DISTINCT FROM OLD.requesting_package_document_id
     OR NEW.requirement_type IS DISTINCT FROM OLD.requirement_type
     OR NEW.required_profile_key IS DISTINCT FROM OLD.required_profile_key
     OR NEW.referenced_document_date IS DISTINCT FROM OLD.referenced_document_date
     OR NEW.referenced_identifier IS DISTINCT FROM OLD.referenced_identifier
     OR NEW.evidence_claim_id IS DISTINCT FROM OLD.evidence_claim_id
     OR NEW.requirement_key IS DISTINCT FROM OLD.requirement_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'lease_related_document_requirements: identity columns are immutable (requirement %)', OLD.id;
  END IF;

  IF NEW.requirement_status IS DISTINCT FROM OLD.requirement_status THEN
    IF OLD.requirement_status IN ('resolved', 'waived', 'rejected') THEN
      RAISE EXCEPTION 'lease_related_document_requirements: % is terminal, no further transition allowed (requirement %)', OLD.requirement_status, OLD.id;
    END IF;
    IF NOT (
      (OLD.requirement_status = 'open' AND NEW.requirement_status IN ('resolved', 'waived', 'rejected', 'ambiguous'))
      OR (OLD.requirement_status = 'ambiguous' AND NEW.requirement_status IN ('resolved', 'waived', 'rejected'))
    ) THEN
      RAISE EXCEPTION 'lease_related_document_requirements: illegal status transition % -> % (requirement %)', OLD.requirement_status, NEW.requirement_status, OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_related_document_requirement_transitions
  BEFORE UPDATE ON public.lease_related_document_requirements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_related_document_requirement_transitions();
