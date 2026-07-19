-- P3.2 — lease_package_documents: membership of one uploaded document
-- (specifically, one uploaded_file/extraction_run/generation) inside a
-- lease_document_package. Identity columns (which package, which file/run/
-- generation, which segment/profile-record, membership_role, source, key)
-- are frozen after insert -- a corrected role/source is a NEW row
-- (membership_status='superseded' on the old one), never an in-place edit.
-- Only membership_status, confidence and metadata may change, through the
-- controlled transition trigger below.

CREATE TABLE public.lease_package_documents (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id                  UUID NOT NULL,
  uploaded_file_id            UUID NOT NULL,
  extraction_run_id           UUID NOT NULL,
  generation_id               UUID NOT NULL,
  full_file_segment_id        UUID,
  canonical_profile_record_id UUID,

  membership_role   TEXT NOT NULL CHECK (membership_role IN (
    'primary_base_document', 'related_document', 'amendment_document', 'assignment_document',
    'extension_document', 'renewal_document', 'commencement_document', 'guaranty_document',
    'addendum_document', 'exhibit_document', 'unknown_document'
  )),
  membership_status TEXT NOT NULL DEFAULT 'proposed' CHECK (membership_status IN (
    'proposed', 'confirmed', 'rejected', 'ambiguous', 'superseded'
  )),
  membership_source TEXT NOT NULL CHECK (membership_source IN (
    'deterministic', 'semantic', 'reviewer', 'system', 'legacy_link'
  )),
  membership_key    TEXT NOT NULL,
  confidence        NUMERIC(5, 4),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,

  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, membership_key),
  UNIQUE (id, org_id),
  -- 3-part: lets lease_document_packages.primary_document_id and
  -- lease_document_relationships' source/target FKs confirm "this membership
  -- row belongs to THIS specific package", not just the same org.
  UNIQUE (id, package_id, org_id),

  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  -- 4-part: catches wrong-file/wrong-generation in one FK (same pattern as lease_claims/lease_document_segments).
  FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id)
    REFERENCES public.extraction_runs (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,
  -- 4-part: a supplied segment must belong to the SAME file/generation, not just the same org.
  FOREIGN KEY (full_file_segment_id, uploaded_file_id, generation_id, org_id)
    REFERENCES public.lease_document_segments (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,
  -- 4-part: a supplied profile record must belong to the SAME file/generation too (P3.2 migration 1's new constraint).
  FOREIGN KEY (canonical_profile_record_id, uploaded_file_id, generation_id, org_id)
    REFERENCES public.lease_document_profile_records (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,

  CHECK (char_length(membership_key) BETWEEN 1 AND 600),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (octet_length(metadata::text) <= 20000)
);

CREATE INDEX idx_lease_package_documents_package ON public.lease_package_documents (org_id, package_id);
CREATE INDEX idx_lease_package_documents_file ON public.lease_package_documents (org_id, uploaded_file_id);
-- Only one CONFIRMED primary base document per package -- a partial unique
-- index, not an EXCLUDE constraint, so this schema doesn't need the
-- btree_gist extension (same reasoning P3.1 already applied to segment
-- overlap rejection).
CREATE UNIQUE INDEX idx_lease_package_documents_one_confirmed_primary
  ON public.lease_package_documents (package_id)
  WHERE membership_role = 'primary_base_document' AND membership_status = 'confirmed';

ALTER TABLE public.lease_package_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_package_documents_org_select ON public.lease_package_documents
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_package_documents FROM authenticated, anon;

-- Now that lease_package_documents exists, add the deferred composite FK from
-- lease_document_packages.primary_document_id (ordering constraint, same
-- pattern P1 used for provider_invocations' artifact FKs).
-- Self-referencing composite: (primary_document_id, id, org_id) matches
-- lease_package_documents(id, package_id, org_id) -- i.e. the linked
-- membership row's own package_id must equal THIS package's id, not just
-- belong to the same org.
ALTER TABLE public.lease_document_packages
  ADD CONSTRAINT lease_document_packages_primary_document_fk
  FOREIGN KEY (primary_document_id, id, org_id)
  REFERENCES public.lease_package_documents (id, package_id, org_id) ON DELETE SET NULL (primary_document_id);

-- Stale-generation guard: a membership row can never be inserted, nor
-- transitioned via UPDATE, INTO 'confirmed' if its generation is no longer
-- the file's active_generation_id -- a stale generation cannot become
-- confirmed membership, whatever the caller believes. Fires on both INSERT
-- (a caller could insert directly as 'confirmed') and UPDATE (the normal
-- proposed -> confirmed transition path).
CREATE OR REPLACE FUNCTION public.enforce_lease_package_document_generation_fencing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active_generation_id UUID;
BEGIN
  IF NEW.membership_status = 'confirmed'
     AND (TG_OP = 'INSERT' OR NEW.membership_status IS DISTINCT FROM OLD.membership_status)
  THEN
    SELECT active_generation_id INTO v_active_generation_id
      FROM public.uploaded_files
     WHERE id = NEW.uploaded_file_id AND org_id = NEW.org_id;

    IF v_active_generation_id IS DISTINCT FROM NEW.generation_id THEN
      RAISE EXCEPTION 'lease_package_documents: generation % is not the active generation for uploaded_file % -- a stale generation cannot become confirmed membership', NEW.generation_id, NEW.uploaded_file_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_package_document_generation_fencing
  BEFORE INSERT OR UPDATE ON public.lease_package_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_package_document_generation_fencing();

-- One uploaded document may not be CONFIRMED in two active (non-superseded/
-- non-archived) packages for the same lease, unless the second confirmation
-- is an explicit reviewer decision (membership_source='reviewer') -- an
-- automated (deterministic/semantic/system) producer can never silently
-- double-confirm the same document into two packages for the same lease.
CREATE OR REPLACE FUNCTION public.enforce_lease_package_document_single_confirmed_lease_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lease_id UUID;
  v_conflict_count INT;
BEGIN
  IF NEW.membership_status <> 'confirmed' OR NEW.membership_source = 'reviewer' THEN
    RETURN NEW;
  END IF;

  SELECT lease_id INTO v_lease_id FROM public.lease_document_packages WHERE id = NEW.package_id;
  IF v_lease_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_conflict_count
    FROM public.lease_package_documents pd
    JOIN public.lease_document_packages p ON p.id = pd.package_id
   WHERE pd.org_id = NEW.org_id
     AND pd.uploaded_file_id = NEW.uploaded_file_id
     AND pd.generation_id = NEW.generation_id
     AND pd.membership_status = 'confirmed'
     AND pd.package_id <> NEW.package_id
     AND p.lease_id = v_lease_id
     AND p.package_status NOT IN ('superseded', 'archived');

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'lease_package_documents: uploaded_file % generation % is already confirmed in another active package for lease % -- requires an explicit reviewer decision (membership_source=reviewer)', NEW.uploaded_file_id, NEW.generation_id, v_lease_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_package_document_single_confirmed_lease_link
  BEFORE INSERT OR UPDATE ON public.lease_package_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_package_document_single_confirmed_lease_link();

-- Controlled state machine: identity columns (package_id, uploaded_file_id,
-- extraction_run_id, generation_id, full_file_segment_id,
-- canonical_profile_record_id, membership_role, membership_source,
-- membership_key, org_id, added_at) are frozen. Only membership_status
-- (via the allowed edges below), confidence and metadata may change.
CREATE OR REPLACE FUNCTION public.enforce_lease_package_document_transitions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.package_id IS DISTINCT FROM OLD.package_id
     OR NEW.uploaded_file_id IS DISTINCT FROM OLD.uploaded_file_id
     OR NEW.extraction_run_id IS DISTINCT FROM OLD.extraction_run_id
     OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
     OR NEW.full_file_segment_id IS DISTINCT FROM OLD.full_file_segment_id
     OR NEW.canonical_profile_record_id IS DISTINCT FROM OLD.canonical_profile_record_id
     OR NEW.membership_role IS DISTINCT FROM OLD.membership_role
     OR NEW.membership_source IS DISTINCT FROM OLD.membership_source
     OR NEW.membership_key IS DISTINCT FROM OLD.membership_key
     OR NEW.added_at IS DISTINCT FROM OLD.added_at
  THEN
    RAISE EXCEPTION 'lease_package_documents: identity columns are immutable (membership %)', OLD.id;
  END IF;

  IF NEW.membership_status IS DISTINCT FROM OLD.membership_status THEN
    IF OLD.membership_status IN ('rejected', 'superseded') THEN
      RAISE EXCEPTION 'lease_package_documents: % is terminal, no further transition allowed (membership %)', OLD.membership_status, OLD.id;
    END IF;
    IF NOT (
      (OLD.membership_status = 'proposed' AND NEW.membership_status IN ('confirmed', 'rejected', 'ambiguous', 'superseded'))
      OR (OLD.membership_status = 'ambiguous' AND NEW.membership_status IN ('confirmed', 'rejected', 'superseded'))
      OR (OLD.membership_status = 'confirmed' AND NEW.membership_status = 'superseded')
    ) THEN
      RAISE EXCEPTION 'lease_package_documents: illegal status transition % -> % (membership %)', OLD.membership_status, NEW.membership_status, OLD.id;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_package_document_transitions
  BEFORE UPDATE ON public.lease_package_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_package_document_transitions();
