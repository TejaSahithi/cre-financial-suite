-- P3.7 - package runtime write-back and finalizer readiness integration.
--
-- Adds the first runtime-owned package compatibility write path and extends the
-- existing finalizer. This migration does not deploy, call providers, change
-- parser routing, write workflow_output, or introduce a second readiness writer.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.lease_package_compatibility_writes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id UUID NOT NULL,
  lease_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  extraction_run_id UUID NOT NULL,
  package_id UUID NOT NULL,
  package_resolution_run_id UUID NOT NULL,
  package_projection_run_id UUID NOT NULL,
  mode TEXT NOT NULL DEFAULT 'active' CHECK (mode = 'active'),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
  idempotency_key TEXT NOT NULL,
  compatibility_hash TEXT NOT NULL,
  package_projection_version TEXT NOT NULL DEFAULT 'lease-package-projection-v1',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, idempotency_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id)
    REFERENCES public.extraction_runs (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (package_resolution_run_id, org_id) REFERENCES public.lease_package_resolution_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (package_projection_run_id, org_id) REFERENCES public.lease_package_projection_runs (id, org_id) ON DELETE RESTRICT,
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 900),
  CHECK (compatibility_hash ~ '^[0-9a-f]{64}$'),
  CHECK (octet_length(metadata::text) <= 20000),
  CHECK (error_message IS NULL OR char_length(error_message) <= 2000)
);

CREATE INDEX IF NOT EXISTS idx_lease_package_compatibility_writes_file
  ON public.lease_package_compatibility_writes (org_id, uploaded_file_id, generation_id);
CREATE INDEX IF NOT EXISTS idx_lease_package_compatibility_writes_projection
  ON public.lease_package_compatibility_writes (org_id, package_projection_run_id);

ALTER TABLE public.lease_package_compatibility_writes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lease_package_compatibility_writes_org_select ON public.lease_package_compatibility_writes;
CREATE POLICY lease_package_compatibility_writes_org_select
  ON public.lease_package_compatibility_writes
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_package_compatibility_writes FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.persist_lease_package_claim_projection(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_lease_id UUID,
  p_generation_id UUID,
  p_extraction_run_id UUID,
  p_package_id UUID,
  p_package_resolution_run_id UUID,
  p_package_projection_run_id UUID,
  p_compatibility_patch JSONB,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_file public.uploaded_files%ROWTYPE;
  v_lease public.leases%ROWTYPE;
  v_projection public.lease_package_projection_runs%ROWTYPE;
  v_existing public.lease_package_compatibility_writes%ROWTYPE;
  v_bad_key TEXT;
  v_hash TEXT;
  v_next_extraction JSONB;
  v_debug JSONB;
  v_audit_log_id UUID;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SERVICE_ROLE_ONLY');
  END IF;
  IF p_org_id IS NULL OR p_uploaded_file_id IS NULL OR p_generation_id IS NULL OR p_extraction_run_id IS NULL
     OR p_package_id IS NULL OR p_package_resolution_run_id IS NULL OR p_package_projection_run_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_RUN_MISMATCH');
  END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_INVALID_PATCH');
  END IF;
  IF jsonb_typeof(COALESCE(p_compatibility_patch, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_INVALID_PATCH');
  END IF;
  IF octet_length(p_compatibility_patch::text) > 2000000 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_TOO_LARGE');
  END IF;

  SELECT key INTO v_bad_key
    FROM jsonb_object_keys(p_compatibility_patch) AS key
   WHERE key NOT IN ('fields', 'field_evidence', 'confidence_scores', 'custom_fields', 'discovered_fields', 'rejected_fields')
   LIMIT 1;
  IF v_bad_key IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_INVALID_PATCH', 'invalid_key', v_bad_key);
  END IF;

  SELECT key INTO v_bad_key
    FROM jsonb_object_keys(p_compatibility_patch) AS key
   WHERE key IN ('raw_claims', 'claims', 'relationships', 'relationship_graph', 'workflow_output', 'expense_rules', 'cam_profile', 'budget_preview', 'provider_metadata', 'artifact_path', 'package_id')
   LIMIT 1;
  IF v_bad_key IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_INVALID_PATCH', 'rejected_key', v_bad_key);
  END IF;

  SELECT * INTO v_file
    FROM public.uploaded_files
   WHERE id = p_uploaded_file_id AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_RUN_MISMATCH');
  END IF;
  IF v_file.active_generation_id IS DISTINCT FROM p_generation_id THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_STALE_GENERATION');
  END IF;

  SELECT * INTO v_lease
    FROM public.leases
   WHERE org_id = p_org_id
     AND (id = p_lease_id OR (p_lease_id IS NULL AND source_file_id = p_uploaded_file_id))
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_RUN_MISMATCH');
  END IF;
  IF COALESCE(v_lease.abstract_status, '') = 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_APPROVED_LEASE');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.extraction_runs
     WHERE id = p_extraction_run_id
       AND org_id = p_org_id
       AND uploaded_file_id = p_uploaded_file_id
       AND generation_id = p_generation_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_RUN_MISMATCH');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.lease_document_packages
     WHERE id = p_package_id AND org_id = p_org_id AND (lease_id = v_lease.id OR lease_id IS NULL)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_RUN_MISMATCH');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.lease_package_resolution_runs
     WHERE id = p_package_resolution_run_id
       AND org_id = p_org_id
       AND package_id = p_package_id
       AND status = 'completed'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_NOT_COMPLETED');
  END IF;

  SELECT * INTO v_projection
    FROM public.lease_package_projection_runs
   WHERE id = p_package_projection_run_id
     AND org_id = p_org_id
     AND package_id = p_package_id
     AND resolution_run_id = p_package_resolution_run_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_RUN_MISMATCH');
  END IF;
  IF v_projection.status <> 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_NOT_COMPLETED');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.lease_package_field_projections fp
      JOIN public.lease_package_documents pd
        ON pd.id = fp.source_package_document_id
       AND pd.package_id = fp.package_id
       AND pd.org_id = fp.org_id
      JOIN public.uploaded_files uf
        ON uf.id = pd.uploaded_file_id
       AND uf.org_id = pd.org_id
     WHERE fp.org_id = p_org_id
       AND fp.projection_run_id = p_package_projection_run_id
       AND pd.generation_id IS DISTINCT FROM uf.active_generation_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_STALE_GENERATION');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.lease_package_resolution_conflicts c
      JOIN public.lease_claim_concepts cc
        ON cc.concept_key = c.concept_key
     WHERE c.org_id = p_org_id
       AND c.resolution_run_id = p_package_resolution_run_id
       AND c.status IN ('open', 'reopened')
       AND cc.evidence_required = true
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_REQUIRED_CONFLICT_OPEN');
  END IF;

  v_hash := encode(digest(p_compatibility_patch::text, 'sha256'), 'hex');
  SELECT * INTO v_existing
    FROM public.lease_package_compatibility_writes
   WHERE org_id = p_org_id AND idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.compatibility_hash = v_hash
       AND v_existing.generation_id = p_generation_id
       AND v_existing.package_id = p_package_id
       AND v_existing.package_resolution_run_id = p_package_resolution_run_id
       AND v_existing.package_projection_run_id = p_package_projection_run_id
    THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotent_replay', true,
        'write_id', v_existing.id,
        'compatibility_hash', v_existing.compatibility_hash
      );
    END IF;
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_WRITE_IDEMPOTENCY_CONFLICT');
  END IF;

  v_next_extraction := COALESCE(v_lease.extraction_data, '{}'::jsonb);
  v_next_extraction := jsonb_set(v_next_extraction, '{fields}', COALESCE(p_compatibility_patch->'fields', '{}'::jsonb), true);
  v_next_extraction := jsonb_set(v_next_extraction, '{field_evidence}', COALESCE(p_compatibility_patch->'field_evidence', '{}'::jsonb), true);
  v_next_extraction := jsonb_set(v_next_extraction, '{confidence_scores}', COALESCE(p_compatibility_patch->'confidence_scores', '{}'::jsonb), true);
  IF p_compatibility_patch ? 'custom_fields' THEN
    v_next_extraction := jsonb_set(v_next_extraction, '{custom_fields}', p_compatibility_patch->'custom_fields', true);
  END IF;
  IF p_compatibility_patch ? 'discovered_fields' THEN
    v_next_extraction := jsonb_set(v_next_extraction, '{discovered_fields}', p_compatibility_patch->'discovered_fields', true);
  END IF;
  IF p_compatibility_patch ? 'rejected_fields' THEN
    v_next_extraction := jsonb_set(v_next_extraction, '{rejected_fields}', p_compatibility_patch->'rejected_fields', true);
  END IF;

  v_debug := COALESCE(v_next_extraction->'extraction_debug', '{}'::jsonb)
    || jsonb_build_object(
      'package_projection', jsonb_build_object(
        'mode', 'active',
        'package_id', p_package_id,
        'package_resolution_run_id', p_package_resolution_run_id,
        'package_projection_run_id', p_package_projection_run_id,
        'package_projection_version', v_projection.package_projection_version,
        'compatibility_hash', v_hash,
        'generation_id', p_generation_id,
        'written_at', v_now
      )
    );
  v_next_extraction := jsonb_set(v_next_extraction, '{extraction_debug}', v_debug, true);

  PERFORM set_config('app.skip_lease_audit_trigger', 'true', true);

  UPDATE public.leases
     SET extraction_data = v_next_extraction,
         updated_at = v_now
   WHERE id = v_lease.id AND org_id = p_org_id;

  INSERT INTO public.lease_package_compatibility_writes (
    org_id, uploaded_file_id, lease_id, generation_id, extraction_run_id,
    package_id, package_resolution_run_id, package_projection_run_id,
    mode, status, idempotency_key, compatibility_hash,
    package_projection_version, metadata
  ) VALUES (
    p_org_id, p_uploaded_file_id, v_lease.id, p_generation_id, p_extraction_run_id,
    p_package_id, p_package_resolution_run_id, p_package_projection_run_id,
    'active', 'completed', p_idempotency_key, v_hash,
    v_projection.package_projection_version,
    jsonb_build_object('p3_7_server_owned_write_back', true)
  )
  RETURNING id INTO v_audit_log_id;

  INSERT INTO public.audit_logs (org_id, property_id, entity_type, entity_id, action, severity, source, after, metadata, "timestamp")
  VALUES (
    p_org_id, v_lease.property_id, 'Lease', v_lease.id::text, 'lease_package_projection_write_back',
    'info', 'edge_function',
    jsonb_build_object('package_projection_run_id', p_package_projection_run_id, 'compatibility_hash', v_hash),
    jsonb_build_object('write_id', v_audit_log_id, 'idempotency_key', p_idempotency_key),
    v_now
  );

  RETURN jsonb_build_object(
    'success', true,
    'write_id', v_audit_log_id,
    'lease_id', v_lease.id,
    'package_projection_run_id', p_package_projection_run_id,
    'compatibility_hash', v_hash
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_package_claim_projection(UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, JSONB, TEXT) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.persist_lease_package_claim_projection(UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, JSONB, TEXT) TO service_role;

-- Replace the P2.7 finalizer signature with one additional defaulted server
-- mode parameter. Drop the exact old signature first so PostgREST cannot keep
-- a stale authoritative overload around.
DROP FUNCTION IF EXISTS public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.finalize_lease_extraction_for_review(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_generation_id UUID DEFAULT NULL,
  p_lease_id UUID DEFAULT NULL,
  p_actor_user_id UUID DEFAULT NULL,
  p_actor_email TEXT DEFAULT NULL,
  p_ledger_mode TEXT DEFAULT 'off',
  p_package_mode TEXT DEFAULT 'off'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_file public.uploaded_files%ROWTYPE;
  v_generation_id UUID;
  v_readiness JSONB;
  v_lease public.leases%ROWTYPE;
  v_coverage JSONB;
  v_extraction_run_status TEXT;
  v_claim_count INT;
  v_projection_run public.lease_claim_projection_runs%ROWTYPE;
  v_missing_evidence_concept TEXT;
  v_open_conflict_concept TEXT;
  v_projected_field_count INT;
  v_profile_count INT;
  v_profile_key_count INT;
  v_package_id UUID;
  v_membership_count INT;
  v_package_document_count INT;
  v_relationship_count INT;
  v_ambiguous_relationship_id UUID;
  v_package_resolution_run public.lease_package_resolution_runs%ROWTYPE;
  v_package_projection_run public.lease_package_projection_runs%ROWTYPE;
  v_open_package_conflict_concept TEXT;
  v_required_related_concept TEXT;
  v_invalid_effective_concept TEXT;
  v_package_field_count INT;
  v_package_write public.lease_package_compatibility_writes%ROWTYPE;
BEGIN
  BEGIN
    IF p_org_id IS NULL THEN
      RAISE EXCEPTION 'org_id is required';
    END IF;
    IF p_uploaded_file_id IS NULL THEN
      RAISE EXCEPTION 'uploaded_file_id is required';
    END IF;
    IF COALESCE(p_ledger_mode, 'off') NOT IN ('off', 'shadow', 'active')
       OR COALESCE(p_package_mode, 'off') NOT IN ('off', 'shadow', 'active') THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_MODE_CONFIGURATION_INVALID');
    END IF;
    IF p_package_mode = 'shadow' AND p_ledger_mode = 'off' THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_MODE_REQUIRES_CLAIMS_LEDGER');
    END IF;
    IF p_package_mode = 'active' AND p_ledger_mode <> 'active' THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_ACTIVE_REQUIRES_CLAIMS_ACTIVE');
    END IF;

    SELECT *
      INTO v_file
      FROM public.uploaded_files
     WHERE id = p_uploaded_file_id
       AND org_id = p_org_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Uploaded file not found for this organization';
    END IF;

    v_generation_id := v_file.active_generation_id;
    IF p_generation_id IS NOT NULL AND p_generation_id IS DISTINCT FROM v_generation_id THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_STALE_GENERATION', 'active_generation_id', v_generation_id);
    END IF;

    v_readiness := public.evaluate_lease_extraction_readiness(p_org_id, p_uploaded_file_id, v_generation_id);

    IF (v_readiness->>'ready')::boolean IS NOT TRUE THEN
      UPDATE public.uploaded_files
         SET review_readiness = v_readiness->>'readiness',
             review_readiness_reasons = COALESCE(v_readiness->'blocking_reasons', '[]'::jsonb),
             review_ready_at = CASE WHEN review_ready_generation_id IS DISTINCT FROM v_generation_id THEN NULL ELSE review_ready_at END,
             review_ready_generation_id = CASE WHEN review_ready_generation_id IS DISTINCT FROM v_generation_id THEN NULL ELSE review_ready_generation_id END,
             updated_at = v_now
       WHERE id = p_uploaded_file_id;

      RETURN jsonb_build_object(
        'success', true,
        'ready', false,
        'readiness', v_readiness->>'readiness',
        'blocking_reasons', v_readiness->'blocking_reasons',
        'active_generation_id', v_generation_id
      );
    END IF;

    IF p_lease_id IS NOT NULL THEN
      SELECT *
        INTO v_lease
        FROM public.leases
       WHERE id = p_lease_id
         AND org_id = p_org_id
         AND source_file_id = p_uploaded_file_id
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Lease % does not belong to this organization/source file', p_lease_id;
      END IF;

      UPDATE public.pipeline_jobs
         SET lease_id = p_lease_id,
             updated_at = v_now
       WHERE uploaded_file_id = p_uploaded_file_id
         AND generation_id = v_generation_id
         AND lease_id IS NULL;
    END IF;

    v_coverage := jsonb_build_object(
      'expense_rule_generation', jsonb_build_object(
        'status', 'completed',
        'rules_generated', jsonb_array_length(
          COALESCE(v_file.ui_review_payload->'records'->0->'workflow_output'->'expense_rules', '[]'::jsonb)
        )
      ),
      'package_projection', jsonb_build_object('mode', p_package_mode, 'status', 'not_required')
    );

    SELECT status INTO v_extraction_run_status
      FROM public.extraction_runs
     WHERE org_id = p_org_id AND generation_id = v_generation_id;

    IF v_extraction_run_status = 'running' THEN
      UPDATE public.extraction_runs
         SET status = 'completed', completed_at = v_now, updated_at = v_now
       WHERE org_id = p_org_id AND generation_id = v_generation_id AND status = 'running';
      v_extraction_run_status := 'completed';
    END IF;

    IF v_extraction_run_status IS NOT NULL AND v_extraction_run_status <> 'completed' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error_code', 'EXTRACTION_RUN_FINALIZATION_MISMATCH',
        'extraction_run_status', v_extraction_run_status
      );
    END IF;

    IF p_ledger_mode = 'active' THEN
      SELECT count(*) INTO v_claim_count
        FROM public.lease_claims
       WHERE org_id = p_org_id AND generation_id = v_generation_id;

      IF v_claim_count = 0 THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'CLAIM_LEDGER_MISSING');
      END IF;

      SELECT lc.concept_key INTO v_missing_evidence_concept
        FROM public.lease_claims lc
        JOIN public.lease_claim_concepts lcc
          ON lcc.concept_key = lc.concept_key AND lcc.registry_version = lc.claims_registry_version
       WHERE lc.org_id = p_org_id AND lc.generation_id = v_generation_id
         AND lcc.evidence_required = true
         AND lc.assertion_status IN ('asserted', 'derived', 'calculated')
         AND NOT EXISTS (SELECT 1 FROM public.lease_claim_evidence_links l WHERE l.claim_id = lc.id)
       LIMIT 1;

      IF v_missing_evidence_concept IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'REQUIRED_CLAIM_EVIDENCE_MISSING', 'concept_key', v_missing_evidence_concept);
      END IF;

      SELECT concept_key INTO v_open_conflict_concept
        FROM public.lease_claim_conflict_groups
       WHERE org_id = p_org_id AND generation_id = v_generation_id AND status IN ('open', 'reopened')
       LIMIT 1;

      IF v_open_conflict_concept IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'REQUIRED_CLAIM_CONFLICT_OPEN', 'concept_key', v_open_conflict_concept);
      END IF;

      SELECT * INTO v_projection_run
        FROM public.lease_claim_projection_runs
       WHERE org_id = p_org_id AND uploaded_file_id = p_uploaded_file_id
       ORDER BY created_at DESC
       LIMIT 1;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'CLAIM_PROJECTION_MISSING');
      END IF;

      IF v_projection_run.generation_id IS DISTINCT FROM v_generation_id THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'CLAIM_PROJECTION_STALE_GENERATION');
      END IF;

      IF v_projection_run.status = 'failed' THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'CLAIM_PROJECTION_FAILED');
      END IF;

      IF v_projection_run.status <> 'completed' THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'CLAIM_PROJECTION_MISSING');
      END IF;

      SELECT count(*) INTO v_projected_field_count
        FROM public.lease_field_projections
       WHERE projection_run_id = v_projection_run.id;

      IF v_projected_field_count = 0 THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'COMPATIBILITY_PROJECTION_INVALID');
      END IF;
    END IF;

    IF p_package_mode = 'active' THEN
      SELECT count(*), count(DISTINCT profile_key)
        INTO v_profile_count, v_profile_key_count
        FROM public.lease_document_profile_records
       WHERE org_id = p_org_id
         AND uploaded_file_id = p_uploaded_file_id
         AND generation_id = v_generation_id
         AND classification_status = 'classified';

      IF v_profile_count = 0 THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROFILE_MISSING');
      END IF;
      IF v_profile_key_count > 1 THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROFILE_AMBIGUOUS');
      END IF;

      SELECT count(*), min(pd.package_id)
        INTO v_membership_count, v_package_id
        FROM public.lease_package_documents pd
        JOIN public.lease_document_packages p ON p.id = pd.package_id AND p.org_id = pd.org_id
       WHERE pd.org_id = p_org_id
         AND pd.uploaded_file_id = p_uploaded_file_id
         AND pd.generation_id = v_generation_id
         AND pd.membership_status = 'confirmed'
         AND p.package_status NOT IN ('superseded', 'archived');

      IF v_membership_count = 0 THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_MEMBERSHIP_MISSING');
      END IF;
      IF v_membership_count > 1 THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_MEMBERSHIP_AMBIGUOUS');
      END IF;

      SELECT count(*) INTO v_package_document_count
        FROM public.lease_package_documents
       WHERE org_id = p_org_id
         AND package_id = v_package_id
         AND membership_status = 'confirmed';

      IF v_package_document_count > 1 THEN
        SELECT count(*) INTO v_relationship_count
          FROM public.lease_document_relationships
         WHERE org_id = p_org_id
           AND package_id = v_package_id
           AND relationship_status = 'confirmed'
           AND validation_status = 'valid';
        IF v_relationship_count = 0 THEN
          RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_RELATIONSHIP_MISSING');
        END IF;
      END IF;

      SELECT id INTO v_ambiguous_relationship_id
        FROM public.lease_document_relationships
       WHERE org_id = p_org_id
         AND package_id = v_package_id
         AND (relationship_status IN ('proposed', 'ambiguous', 'requires_related_document')
              OR validation_status IN ('pending', 'needs_review'))
       LIMIT 1;
      IF v_ambiguous_relationship_id IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_RELATIONSHIP_AMBIGUOUS', 'relationship_id', v_ambiguous_relationship_id);
      END IF;

      SELECT * INTO v_package_resolution_run
        FROM public.lease_package_resolution_runs
       WHERE org_id = p_org_id
         AND package_id = v_package_id
       ORDER BY completed_at DESC NULLS LAST, started_at DESC
       LIMIT 1;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_RESOLUTION_MISSING');
      END IF;
      IF v_package_resolution_run.status = 'failed' THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_RESOLUTION_FAILED');
      END IF;
      IF v_package_resolution_run.status <> 'completed' THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_RESOLUTION_MISSING');
      END IF;

      SELECT c.concept_key INTO v_open_package_conflict_concept
        FROM public.lease_package_resolution_conflicts c
        JOIN public.lease_claim_concepts cc ON cc.concept_key = c.concept_key
       WHERE c.org_id = p_org_id
         AND c.resolution_run_id = v_package_resolution_run.id
         AND c.status IN ('open', 'reopened')
         AND cc.evidence_required = true
       LIMIT 1;
      IF v_open_package_conflict_concept IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_REQUIRED_CONFLICT_OPEN', 'concept_key', v_open_package_conflict_concept);
      END IF;

      SELECT ec.concept_key INTO v_required_related_concept
        FROM public.lease_package_effective_claims ec
        JOIN public.lease_claim_concepts cc ON cc.concept_key = ec.concept_key
       WHERE ec.org_id = p_org_id
         AND ec.resolution_run_id = v_package_resolution_run.id
         AND ec.effective_status = 'requires_related_document'
         AND cc.evidence_required = true
       LIMIT 1;
      IF v_required_related_concept IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_REQUIRED_RELATED_DOCUMENT_MISSING', 'concept_key', v_required_related_concept);
      END IF;

      SELECT concept_key INTO v_invalid_effective_concept
        FROM public.lease_package_effective_claims
       WHERE org_id = p_org_id
         AND resolution_run_id = v_package_resolution_run.id
         AND effective_status IN ('needs_review', 'extraction_failed')
       LIMIT 1;
      IF v_invalid_effective_concept IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_EFFECTIVE_CLAIM_INVALID', 'concept_key', v_invalid_effective_concept);
      END IF;

      SELECT * INTO v_package_projection_run
        FROM public.lease_package_projection_runs
       WHERE org_id = p_org_id
         AND package_id = v_package_id
         AND resolution_run_id = v_package_resolution_run.id
       ORDER BY completed_at DESC NULLS LAST, started_at DESC
       LIMIT 1;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_MISSING');
      END IF;
      IF v_package_projection_run.status = 'failed' THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_FAILED');
      END IF;
      IF v_package_projection_run.status <> 'completed' THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_MISSING');
      END IF;

      IF EXISTS (
        SELECT 1
          FROM public.lease_package_field_projections fp
          JOIN public.lease_package_documents pd
            ON pd.id = fp.source_package_document_id
           AND pd.package_id = fp.package_id
           AND pd.org_id = fp.org_id
          JOIN public.uploaded_files uf
            ON uf.id = pd.uploaded_file_id
           AND uf.org_id = pd.org_id
         WHERE fp.org_id = p_org_id
           AND fp.projection_run_id = v_package_projection_run.id
           AND pd.generation_id IS DISTINCT FROM uf.active_generation_id
      ) THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_STALE_GENERATION');
      END IF;

      SELECT count(*) INTO v_package_field_count
        FROM public.lease_package_field_projections
       WHERE org_id = p_org_id
         AND projection_run_id = v_package_projection_run.id;
      IF v_package_field_count = 0 THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_PROJECTION_FAILED');
      END IF;

      SELECT * INTO v_package_write
        FROM public.lease_package_compatibility_writes
       WHERE org_id = p_org_id
         AND uploaded_file_id = p_uploaded_file_id
         AND generation_id = v_generation_id
         AND package_id = v_package_id
         AND package_resolution_run_id = v_package_resolution_run.id
         AND package_projection_run_id = v_package_projection_run.id
         AND status = 'completed'
       ORDER BY created_at DESC
       LIMIT 1;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_COMPATIBILITY_NOT_PERSISTED');
      END IF;

      v_coverage := jsonb_set(
        v_coverage,
        '{package_projection}',
        jsonb_build_object(
          'mode', 'active',
          'status', 'completed',
          'package_id', v_package_id,
          'resolution_run_id', v_package_resolution_run.id,
          'projection_run_id', v_package_projection_run.id,
          'compatibility_hash', v_package_write.compatibility_hash
        ),
        true
      );
    ELSIF p_package_mode = 'shadow' THEN
      v_coverage := jsonb_set(v_coverage, '{package_projection}', jsonb_build_object('mode', 'shadow', 'status', 'advisory'), true);
    END IF;

    PERFORM set_config('app.allow_review_readiness_ready', 'true', true);

    UPDATE public.uploaded_files
       SET review_readiness = 'ready',
           review_readiness_reasons = '[]'::jsonb,
           review_ready_at = v_now,
           review_ready_generation_id = v_generation_id,
           extraction_finalization_version = 'lease-review-evidence-v3',
           updated_at = v_now
     WHERE id = p_uploaded_file_id;

    RETURN jsonb_build_object(
      'success', true,
      'ready', true,
      'readiness', 'ready',
      'blocking_reasons', '[]'::jsonb,
      'active_generation_id', v_generation_id,
      'coverage', v_coverage
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'FINALIZATION_FAILED',
      'error_message', SQLERRM
    );
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) TO service_role;