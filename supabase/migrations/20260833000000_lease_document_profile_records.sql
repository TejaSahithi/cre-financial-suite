-- P3.1 — lease_document_profile_records: one immutable profile
-- classification candidate per segment. Never updated -- a correction is a
-- new row, exactly like lease_claims (P2.1). No is_current/is_latest
-- boolean anywhere on this table (locked decision #7/#5): effective-profile
-- selection is a P3.4+ concern, built either as a later resolution table or
-- a deterministic view over these immutable candidates -- nothing here may
-- let a future implementation shortcut "latest row wins" into precedence.

CREATE TABLE public.lease_document_profile_records (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id         UUID NOT NULL,
  segment_id               UUID NOT NULL,
  extraction_run_id        UUID NOT NULL,
  extraction_stage_run_id  UUID,
  provider_invocation_id   UUID,
  generation_id            UUID NOT NULL,

  profile_key         TEXT NOT NULL,
  -- Which lease_document_profiles registry_version this profile_key was
  -- validated against -- part of the row's own identity, not bolted on
  -- later, so the insert-time registry-membership trigger below always has
  -- a real value to check against.
  registry_version    TEXT NOT NULL DEFAULT 'lease-document-profiles-v1',
  classification_status TEXT NOT NULL CHECK (classification_status IN (
    'classified', 'ambiguous', 'manual_required', 'unsupported', 'extraction_failed'
  )),
  confidence NUMERIC(5, 4),

  producer_type    TEXT NOT NULL CHECK (producer_type IN ('deterministic_classifier', 'semantic_classifier', 'reviewer')),
  producer_name    TEXT,
  producer_version TEXT,

  classification_key TEXT NOT NULL,
  evidence_summary   JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, classification_key),
  UNIQUE (id, org_id),

  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  -- 4-part: this record's segment must belong to the same uploaded_file_id
  -- AND the same generation_id, not just the same file/org -- catches a
  -- profile record linked to a segment from a stale/different generation.
  FOREIGN KEY (segment_id, uploaded_file_id, generation_id, org_id)
    REFERENCES public.lease_document_segments (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,
  -- 4-part: catches wrong-file/wrong-generation in one FK (same pattern as lease_claims).
  FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id)
    REFERENCES public.extraction_runs (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,
  -- 4-part: identical shape to lease_claims' own provider_invocation_id FK --
  -- catches a provider invocation belonging to a different stage/run.
  FOREIGN KEY (provider_invocation_id, extraction_stage_run_id, extraction_run_id, org_id)
    REFERENCES public.provider_invocations (id, stage_run_id, run_id, org_id) ON DELETE SET NULL (provider_invocation_id),

  -- Producer-conditional stage/invocation requirements (mirrors lease_claims exactly).
  CHECK (
    (producer_type IN ('deterministic_classifier', 'semantic_classifier') AND extraction_stage_run_id IS NOT NULL)
    OR (producer_type = 'reviewer' AND extraction_stage_run_id IS NULL)
  ),
  CHECK (
    (producer_type = 'semantic_classifier' AND provider_invocation_id IS NOT NULL)
    OR (producer_type <> 'semantic_classifier' AND provider_invocation_id IS NULL)
  ),

  CHECK (char_length(profile_key) BETWEEN 1 AND 100),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (char_length(classification_key) BETWEEN 1 AND 600),
  CHECK (octet_length(evidence_summary::text) <= 20000),
  CHECK (octet_length(metadata::text) <= 20000)
);

CREATE INDEX idx_lease_document_profile_records_file ON public.lease_document_profile_records (org_id, uploaded_file_id);
CREATE INDEX idx_lease_document_profile_records_segment ON public.lease_document_profile_records (segment_id);
CREATE INDEX idx_lease_document_profile_records_run ON public.lease_document_profile_records (org_id, extraction_run_id);

ALTER TABLE public.lease_document_profile_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_document_profile_records_org_select ON public.lease_document_profile_records
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_document_profile_records FROM authenticated, anon;

-- Registry membership: profile_key must exist in the generated DB snapshot
-- (lease_document_profiles) for the record's own registry_version --
-- mirrors enforce_lease_claim_concept_registered exactly. Unlike claims,
-- there is no "unregistered/dynamic" namespace for profiles -- every
-- classification must resolve to one of the 13 canonical profiles (a
-- classifier that can't decide uses classification_status='ambiguous' or
-- 'unsupported' with a real profile_key candidate, or 'manual_required'/
-- 'extraction_failed' -- never an unregistered profile_key).
CREATE OR REPLACE FUNCTION public.enforce_lease_document_profile_registered()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lease_document_profiles
     WHERE profile_key = NEW.profile_key
       AND registry_version = NEW.registry_version
  ) THEN
    RAISE EXCEPTION 'profile_key % is not present in lease_document_profiles for registry_version % -- register it in the TS profile registry and regenerate the DB snapshot first', NEW.profile_key, NEW.registry_version;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_document_profile_registered
  BEFORE INSERT ON public.lease_document_profile_records
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_document_profile_registered();

CREATE OR REPLACE FUNCTION public.enforce_lease_document_profile_records_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lease_document_profile_records rows are immutable (record %)', OLD.id;
END;
$$;

CREATE TRIGGER trg_lease_document_profile_records_immutable
  BEFORE UPDATE ON public.lease_document_profile_records
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_document_profile_records_immutable();
