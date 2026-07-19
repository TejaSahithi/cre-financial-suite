-- P3.2 — lease_document_packages: one logical lease-document package. A
-- package groups one or more uploaded documents (via lease_package_documents,
-- next migration) that together represent a single lease's full document
-- set. Package identity/tenant/lease linkage is frozen after insert; only
-- package_status, primary_document_id (once, from NULL), package_version and
-- metadata may change, and only through the controlled transition trigger
-- below -- never an arbitrary UPDATE.
--
-- primary_document_id intentionally has NO FK yet -- lease_package_documents
-- (the table it points into) doesn't exist until the next migration. The
-- composite FK is added via ALTER TABLE once that table exists, same
-- ordering-constraint pattern P1 used for provider_invocations' artifact FKs
-- referencing extraction_artifacts.

CREATE TABLE public.lease_document_packages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Nullable + column-scoped ON DELETE SET NULL, same provenance-survives-
  -- lease-deletion rationale as every P2.1/P3.1 table with a lease_id.
  lease_id              UUID,
  package_key           TEXT NOT NULL,
  package_status        TEXT NOT NULL DEFAULT 'open' CHECK (package_status IN (
    'open', 'complete', 'needs_review', 'superseded', 'archived'
  )),
  primary_document_id   UUID,
  package_version       TEXT NOT NULL DEFAULT 'v1',
  created_by_type       TEXT NOT NULL CHECK (created_by_type IN ('system', 'reviewer')),
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, package_key),
  UNIQUE (id, org_id),

  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),

  CHECK (char_length(package_key) BETWEEN 1 AND 300),
  CHECK (char_length(package_version) BETWEEN 1 AND 50),
  CHECK (octet_length(metadata::text) <= 20000)
);

CREATE INDEX idx_lease_document_packages_lease ON public.lease_document_packages (org_id, lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX idx_lease_document_packages_status ON public.lease_document_packages (org_id, package_status);

ALTER TABLE public.lease_document_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_document_packages_org_select ON public.lease_document_packages
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_document_packages FROM authenticated, anon;

-- Controlled state machine. Identity columns (org_id, lease_id except the
-- one narrow lease-deletion SET NULL cascade, package_key, created_by_type,
-- created_at) are frozen forever. primary_document_id may move from NULL to
-- a value exactly once (one-time linkage, mirrors extraction_runs.lease_id's
-- P1 pattern) and never changes again after that. package_status may only
-- follow the edges below -- archived is fully terminal; superseded may only
-- advance to archived (a superseded package is replaced by a NEW package,
-- never resurrected).
CREATE OR REPLACE FUNCTION public.enforce_lease_document_package_transitions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Narrow exception: leases(id) ON DELETE SET NULL fires an UPDATE that
  -- nulls lease_id alone -- must pass through untouched, same rationale as
  -- every other P2.1/P3.1 table with a nullable lease_id.
  IF NEW.lease_id IS NULL AND OLD.lease_id IS NOT NULL
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     AND NEW.package_key IS NOT DISTINCT FROM OLD.package_key
     AND NEW.package_status IS NOT DISTINCT FROM OLD.package_status
     AND NEW.primary_document_id IS NOT DISTINCT FROM OLD.primary_document_id
     AND NEW.package_version IS NOT DISTINCT FROM OLD.package_version
     AND NEW.created_by_type IS NOT DISTINCT FROM OLD.created_by_type
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
  THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.package_key IS DISTINCT FROM OLD.package_key
     OR NEW.created_by_type IS DISTINCT FROM OLD.created_by_type
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.lease_id IS NOT NULL AND NEW.lease_id IS DISTINCT FROM OLD.lease_id)
  THEN
    RAISE EXCEPTION 'lease_document_packages: identity columns are immutable (package %)', OLD.id;
  END IF;

  IF OLD.primary_document_id IS NOT NULL AND NEW.primary_document_id IS DISTINCT FROM OLD.primary_document_id THEN
    RAISE EXCEPTION 'lease_document_packages: primary_document_id may only be set once, not changed (package %)', OLD.id;
  END IF;

  IF NEW.package_status IS DISTINCT FROM OLD.package_status THEN
    IF OLD.package_status = 'archived' THEN
      RAISE EXCEPTION 'lease_document_packages: archived is terminal, no further transition allowed (package %)', OLD.id;
    END IF;
    IF OLD.package_status = 'superseded' AND NEW.package_status <> 'archived' THEN
      RAISE EXCEPTION 'lease_document_packages: a superseded package may only advance to archived, never back to % (package %)', NEW.package_status, OLD.id;
    END IF;
    IF NOT (
      (OLD.package_status = 'open' AND NEW.package_status IN ('needs_review', 'complete', 'superseded', 'archived'))
      OR (OLD.package_status = 'needs_review' AND NEW.package_status IN ('open', 'complete', 'superseded', 'archived'))
      OR (OLD.package_status = 'complete' AND NEW.package_status IN ('needs_review', 'superseded', 'archived'))
      OR (OLD.package_status = 'superseded' AND NEW.package_status = 'archived')
    ) THEN
      RAISE EXCEPTION 'lease_document_packages: illegal status transition % -> % (package %)', OLD.package_status, NEW.package_status, OLD.id;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_document_package_transitions
  BEFORE UPDATE ON public.lease_document_packages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_document_package_transitions();
