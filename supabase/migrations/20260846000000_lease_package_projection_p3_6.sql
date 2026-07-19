-- P3.6 - package-aware compatibility projection.
--
-- Adds isolated package projection storage and a service-role persistence RPC.
-- This migration does not write leases.extraction_data, workflow_output,
-- runtime pipeline wiring, finalizer/readiness state, providers, or diagnostic
-- v3 projection tables.

CREATE TABLE public.lease_package_projection_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id UUID NOT NULL,
  lease_id UUID,
  resolution_run_id UUID NOT NULL,
  package_projection_version TEXT NOT NULL,
  p2_projection_version TEXT NOT NULL,
  claims_registry_version TEXT NOT NULL,
  claims_registry_hash TEXT NOT NULL,
  profile_registry_version TEXT NOT NULL,
  profile_registry_hash TEXT NOT NULL,
  compatibility_contract_version TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('off', 'shadow', 'active')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'superseded')),
  input_effective_claim_count INT NOT NULL DEFAULT 0,
  input_effective_claims_hash TEXT NOT NULL,
  output_field_count INT NOT NULL DEFAULT 0,
  inherited_field_count INT NOT NULL DEFAULT 0,
  overridden_field_count INT NOT NULL DEFAULT 0,
  needs_review_field_count INT NOT NULL DEFAULT 0,
  requires_related_document_count INT NOT NULL DEFAULT 0,
  dynamic_field_count INT NOT NULL DEFAULT 0,
  conflict_count INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (id, org_id),
  UNIQUE (org_id, resolution_run_id, package_projection_version, input_effective_claims_hash),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (resolution_run_id, org_id) REFERENCES public.lease_package_resolution_runs (id, org_id) ON DELETE RESTRICT,
  CHECK (char_length(package_projection_version) BETWEEN 1 AND 200),
  CHECK (char_length(p2_projection_version) BETWEEN 1 AND 200),
  CHECK (char_length(claims_registry_hash) BETWEEN 1 AND 200),
  CHECK (char_length(profile_registry_hash) BETWEEN 1 AND 200),
  CHECK (char_length(compatibility_contract_version) BETWEEN 1 AND 200),
  CHECK (char_length(input_effective_claims_hash) BETWEEN 1 AND 200),
  CHECK (input_effective_claim_count >= 0 AND output_field_count >= 0),
  CHECK (inherited_field_count >= 0 AND overridden_field_count >= 0),
  CHECK (needs_review_field_count >= 0 AND requires_related_document_count >= 0),
  CHECK (dynamic_field_count >= 0 AND conflict_count >= 0),
  CHECK ((status IN ('completed', 'failed', 'superseded') AND completed_at IS NOT NULL) OR status = 'running'),
  CHECK (error_message IS NULL OR char_length(error_message) <= 2000),
  CHECK (octet_length(metadata::text) <= 20000)
);

CREATE INDEX idx_lease_package_projection_runs_package ON public.lease_package_projection_runs (org_id, package_id);
CREATE INDEX idx_lease_package_projection_runs_resolution ON public.lease_package_projection_runs (org_id, resolution_run_id);
CREATE INDEX idx_lease_package_projection_runs_status ON public.lease_package_projection_runs (org_id, status);

ALTER TABLE public.lease_package_projection_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_package_projection_runs_org_select
  ON public.lease_package_projection_runs
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_package_projection_runs FROM authenticated, anon;

CREATE TABLE public.lease_package_field_projections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id UUID NOT NULL,
  projection_run_id UUID NOT NULL,
  resolution_run_id UUID NOT NULL,
  lease_id UUID,
  field_key TEXT NOT NULL,
  instance_key TEXT NOT NULL DEFAULT 'default',
  concept_key TEXT NOT NULL,
  package_effective_claim_id UUID,
  selected_source_claim_id UUID,
  base_source_claim_id UUID,
  overriding_source_claim_id UUID,
  source_package_document_id UUID,
  source_relationship_id UUID,
  normalized_value JSONB,
  display_value TEXT,
  extraction_status TEXT,
  confidence NUMERIC(6, 2),
  evidence_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  package_status TEXT NOT NULL CHECK (package_status IN (
    'base', 'inherited', 'overridden', 'party_role_changed',
    'resolved_by_certificate', 'addendum_override', 'reviewer_resolved',
    'needs_review', 'requires_related_document', 'unavailable'
  )),
  precedence_rule TEXT NOT NULL,
  projection_reason TEXT,
  relationship_path JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflict_id UUID,
  related_document_requirement_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (projection_run_id, field_key, instance_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (projection_run_id, org_id) REFERENCES public.lease_package_projection_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolution_run_id, org_id) REFERENCES public.lease_package_resolution_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (package_effective_claim_id, org_id) REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE SET NULL (package_effective_claim_id),
  FOREIGN KEY (selected_source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE SET NULL (selected_source_claim_id),
  FOREIGN KEY (base_source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE SET NULL (base_source_claim_id),
  FOREIGN KEY (overriding_source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE SET NULL (overriding_source_claim_id),
  FOREIGN KEY (source_package_document_id, package_id, org_id)
    REFERENCES public.lease_package_documents (id, package_id, org_id) ON DELETE SET NULL (source_package_document_id),
  FOREIGN KEY (source_relationship_id, org_id) REFERENCES public.lease_document_relationships (id, org_id) ON DELETE SET NULL (source_relationship_id),
  FOREIGN KEY (conflict_id, org_id) REFERENCES public.lease_package_resolution_conflicts (id, org_id) ON DELETE SET NULL (conflict_id),
  FOREIGN KEY (related_document_requirement_id, org_id) REFERENCES public.lease_related_document_requirements (id, org_id) ON DELETE SET NULL (related_document_requirement_id),
  CHECK (char_length(field_key) BETWEEN 1 AND 200),
  CHECK (char_length(instance_key) BETWEEN 1 AND 200),
  CHECK (char_length(concept_key) BETWEEN 1 AND 200),
  CHECK (char_length(precedence_rule) BETWEEN 1 AND 200),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100)),
  CHECK (octet_length(evidence_summary::text) <= 10000),
  CHECK (octet_length(relationship_path::text) <= 5000),
  CHECK (
    (package_status = 'needs_review' AND selected_source_claim_id IS NULL)
    OR package_status <> 'needs_review'
  ),
  CHECK (
    (package_status = 'requires_related_document' AND related_document_requirement_id IS NOT NULL)
    OR package_status <> 'requires_related_document'
  )
);

CREATE INDEX idx_lease_package_field_projections_run ON public.lease_package_field_projections (org_id, projection_run_id);
CREATE INDEX idx_lease_package_field_projections_resolution ON public.lease_package_field_projections (org_id, resolution_run_id);
CREATE INDEX idx_lease_package_field_projections_field ON public.lease_package_field_projections (org_id, field_key);

ALTER TABLE public.lease_package_field_projections ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_package_field_projections_org_select
  ON public.lease_package_field_projections
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_package_field_projections FROM authenticated, anon;

CREATE TABLE public.lease_package_projection_diffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id UUID NOT NULL,
  projection_run_id UUID NOT NULL,
  single_document_projection_run_id UUID,
  diff_status TEXT NOT NULL CHECK (diff_status IN ('equal', 'differences_found', 'comparison_unavailable', 'failed')),
  difference_count INT NOT NULL DEFAULT 0,
  equal_count INT NOT NULL DEFAULT 0,
  explicit_override_count INT NOT NULL DEFAULT 0,
  inherited_count INT NOT NULL DEFAULT 0,
  party_role_change_count INT NOT NULL DEFAULT 0,
  related_document_count INT NOT NULL DEFAULT 0,
  conflict_count INT NOT NULL DEFAULT 0,
  representation_only_count INT NOT NULL DEFAULT 0,
  bounded_diff_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  detailed_diff_artifact_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (projection_run_id),
  UNIQUE (id, org_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (projection_run_id, org_id) REFERENCES public.lease_package_projection_runs (id, org_id) ON DELETE RESTRICT,
  CHECK (difference_count >= 0 AND equal_count >= 0 AND explicit_override_count >= 0),
  CHECK (inherited_count >= 0 AND party_role_change_count >= 0),
  CHECK (related_document_count >= 0 AND conflict_count >= 0 AND representation_only_count >= 0),
  CHECK (octet_length(bounded_diff_summary::text) <= 20000)
);

CREATE INDEX idx_lease_package_projection_diffs_package ON public.lease_package_projection_diffs (org_id, package_id);

ALTER TABLE public.lease_package_projection_diffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_package_projection_diffs_org_select
  ON public.lease_package_projection_diffs
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_package_projection_diffs FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.enforce_lease_package_projection_run_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed', 'superseded') THEN
    RAISE EXCEPTION 'lease_package_projection_runs: % is terminal, no further transition allowed (run %)', OLD.status, OLD.id;
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.package_id IS DISTINCT FROM OLD.package_id
     OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
     OR NEW.resolution_run_id IS DISTINCT FROM OLD.resolution_run_id
     OR NEW.package_projection_version IS DISTINCT FROM OLD.package_projection_version
     OR NEW.p2_projection_version IS DISTINCT FROM OLD.p2_projection_version
     OR NEW.claims_registry_version IS DISTINCT FROM OLD.claims_registry_version
     OR NEW.claims_registry_hash IS DISTINCT FROM OLD.claims_registry_hash
     OR NEW.profile_registry_version IS DISTINCT FROM OLD.profile_registry_version
     OR NEW.profile_registry_hash IS DISTINCT FROM OLD.profile_registry_hash
     OR NEW.compatibility_contract_version IS DISTINCT FROM OLD.compatibility_contract_version
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.input_effective_claims_hash IS DISTINCT FROM OLD.input_effective_claims_hash
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
  THEN
    RAISE EXCEPTION 'lease_package_projection_runs: identity columns are immutable (run %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_package_projection_run_immutability
  BEFORE UPDATE ON public.lease_package_projection_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_package_projection_run_immutability();

CREATE OR REPLACE FUNCTION public.enforce_lease_package_field_projection_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lease_package_field_projections rows are immutable';
END;
$$;

CREATE TRIGGER trg_enforce_lease_package_field_projection_immutability
  BEFORE UPDATE OR DELETE ON public.lease_package_field_projections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_package_field_projection_immutability();

CREATE OR REPLACE FUNCTION public.enforce_lease_package_projection_claim_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_claim_id UUID;
BEGIN
  FOREACH v_claim_id IN ARRAY ARRAY[
    NEW.selected_source_claim_id,
    NEW.base_source_claim_id,
    NEW.overriding_source_claim_id
  ]
  LOOP
    IF v_claim_id IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.lease_claims c
        JOIN public.lease_package_documents lpd
          ON lpd.uploaded_file_id = c.uploaded_file_id
         AND lpd.extraction_run_id = c.extraction_run_id
         AND lpd.generation_id = c.generation_id
         AND lpd.org_id = c.org_id
        JOIN public.uploaded_files uf
          ON uf.id = c.uploaded_file_id
         AND uf.org_id = c.org_id
       WHERE c.id = v_claim_id
         AND c.org_id = NEW.org_id
         AND lpd.package_id = NEW.package_id
         AND lpd.membership_status = 'confirmed'
         AND c.generation_id = uf.active_generation_id
    ) THEN
      RAISE EXCEPTION 'lease_package_field_projections: source claim % is not active in package %', v_claim_id, NEW.package_id;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_package_projection_claim_generation
  BEFORE INSERT ON public.lease_package_field_projections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_package_projection_claim_generation();

CREATE OR REPLACE FUNCTION public.persist_lease_package_projection(
  p_org_id UUID,
  p_package_id UUID,
  p_resolution_run_id UUID,
  p_projection_run JSONB,
  p_field_projections JSONB,
  p_projection_diff JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_projection_run_id UUID;
  v_existing_run RECORD;
  v_item JSONB;
  v_inserted_fields INT := 0;
  v_difference_count INT := 0;
  v_equal_count INT := 0;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SERVICE_ROLE_ONLY');
  END IF;
  IF jsonb_typeof(COALESCE(p_field_projections, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_FIELD_PROJECTIONS_MUST_BE_ARRAY');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.lease_package_resolution_runs r
     WHERE r.id = p_resolution_run_id
       AND r.org_id = p_org_id
       AND r.package_id = p_package_id
       AND r.status = 'completed'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_RESOLUTION_NOT_COMPLETED');
  END IF;

  SELECT * INTO v_existing_run
    FROM public.lease_package_projection_runs
   WHERE org_id = p_org_id
     AND resolution_run_id = p_resolution_run_id
     AND package_projection_version = COALESCE(NULLIF(p_projection_run->>'package_projection_version', ''), 'lease-package-projection-v1')
     AND input_effective_claims_hash = COALESCE(NULLIF(p_projection_run->>'input_effective_claims_hash', ''), 'unknown');
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent_replay', true,
      'projection_run_id', v_existing_run.id
    );
  END IF;

  INSERT INTO public.lease_package_projection_runs (
    org_id, package_id, lease_id, resolution_run_id, package_projection_version,
    p2_projection_version, claims_registry_version, claims_registry_hash,
    profile_registry_version, profile_registry_hash, compatibility_contract_version,
    mode, status, input_effective_claim_count, input_effective_claims_hash,
    output_field_count, inherited_field_count, overridden_field_count,
    needs_review_field_count, requires_related_document_count, dynamic_field_count,
    conflict_count, completed_at, metadata
  ) VALUES (
    p_org_id,
    p_package_id,
    NULLIF(p_projection_run->>'lease_id', '')::uuid,
    p_resolution_run_id,
    COALESCE(NULLIF(p_projection_run->>'package_projection_version', ''), 'lease-package-projection-v1'),
    COALESCE(NULLIF(p_projection_run->>'p2_projection_version', ''), 'projection-v1'),
    COALESCE(NULLIF(p_projection_run->>'claims_registry_version', ''), 'lease-claims-v1'),
    COALESCE(NULLIF(p_projection_run->>'claims_registry_hash', ''), 'unknown'),
    COALESCE(NULLIF(p_projection_run->>'profile_registry_version', ''), 'lease-document-profiles-v1'),
    COALESCE(NULLIF(p_projection_run->>'profile_registry_hash', ''), 'unknown'),
    COALESCE(NULLIF(p_projection_run->>'compatibility_contract_version', ''), 'lease-claims-v1'),
    COALESCE(NULLIF(p_projection_run->>'mode', ''), 'shadow'),
    'completed',
    COALESCE((p_projection_run->>'input_effective_claim_count')::int, jsonb_array_length(COALESCE(p_field_projections, '[]'::jsonb))),
    COALESCE(NULLIF(p_projection_run->>'input_effective_claims_hash', ''), 'unknown'),
    COALESCE((p_projection_run->>'output_field_count')::int, 0),
    COALESCE((p_projection_run->>'inherited_field_count')::int, 0),
    COALESCE((p_projection_run->>'overridden_field_count')::int, 0),
    COALESCE((p_projection_run->>'needs_review_field_count')::int, 0),
    COALESCE((p_projection_run->>'requires_related_document_count')::int, 0),
    COALESCE((p_projection_run->>'dynamic_field_count')::int, 0),
    COALESCE((p_projection_run->>'conflict_count')::int, 0),
    now(),
    jsonb_build_object('p3_6_no_runtime_writeback', true)
  )
  RETURNING id INTO v_projection_run_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_field_projections, '[]'::jsonb))
  LOOP
    INSERT INTO public.lease_package_field_projections (
      org_id, package_id, projection_run_id, resolution_run_id, lease_id,
      field_key, instance_key, concept_key, package_effective_claim_id,
      selected_source_claim_id, base_source_claim_id, overriding_source_claim_id,
      source_package_document_id, source_relationship_id, normalized_value,
      display_value, extraction_status, confidence, evidence_summary,
      package_status, precedence_rule, projection_reason, relationship_path,
      conflict_id, related_document_requirement_id
    ) VALUES (
      p_org_id, p_package_id, v_projection_run_id, p_resolution_run_id,
      NULLIF(p_projection_run->>'lease_id', '')::uuid,
      v_item->>'fieldKey',
      COALESCE(NULLIF(v_item->>'instanceKey', ''), 'default'),
      v_item->>'conceptKey',
      (
        SELECT ec.id
          FROM public.lease_package_effective_claims ec
         WHERE ec.org_id = p_org_id
           AND ec.resolution_run_id = p_resolution_run_id
           AND ec.concept_key = v_item->>'conceptKey'
           AND ec.scope_key = COALESCE(NULLIF(v_item->>'scopeKey', ''), 'lease')
           AND ec.instance_key = COALESCE(NULLIF(v_item->>'instanceKey', ''), 'default')
         LIMIT 1
      ),
      NULLIF(v_item->>'selectedSourceClaimId', '')::uuid,
      NULLIF(v_item->>'baseSourceClaimId', '')::uuid,
      NULLIF(v_item->>'overridingSourceClaimId', '')::uuid,
      NULLIF(v_item->>'sourcePackageDocumentId', '')::uuid,
      NULLIF(v_item->>'sourceRelationshipId', '')::uuid,
      CASE WHEN v_item ? 'normalizedValue' THEN to_jsonb(v_item->>'normalizedValue') ELSE NULL END,
      v_item->>'displayValue',
      v_item->>'extractionStatus',
      NULLIF(v_item->>'confidence', '')::numeric,
      COALESCE(v_item->'evidenceSummary', '{}'::jsonb),
      v_item->>'packageStatus',
      COALESCE(NULLIF(v_item->>'precedenceRule', ''), 'unspecified'),
      v_item->>'projectionReason',
      COALESCE(v_item->'relationshipPath', '[]'::jsonb),
      NULLIF(v_item->>'conflictId', '')::uuid,
      NULLIF(v_item->>'relatedDocumentRequirementId', '')::uuid
    );
    v_inserted_fields := v_inserted_fields + 1;
  END LOOP;

  v_difference_count := COALESCE((
    SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(p_projection_diff->'differences', '[]'::jsonb)) AS d(item)
     WHERE d.item->>'classification' <> 'equal'
  ), 0);
  v_equal_count := COALESCE((
    SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(p_projection_diff->'differences', '[]'::jsonb)) AS d(item)
     WHERE d.item->>'classification' = 'equal'
  ), 0);

  INSERT INTO public.lease_package_projection_diffs (
    org_id, package_id, projection_run_id, diff_status, difference_count,
    equal_count, explicit_override_count, inherited_count, party_role_change_count,
    related_document_count, conflict_count, representation_only_count, bounded_diff_summary
  ) VALUES (
    p_org_id, p_package_id, v_projection_run_id,
    CASE
      WHEN jsonb_typeof(COALESCE(p_projection_diff->'differences', '[]'::jsonb)) <> 'array' THEN 'comparison_unavailable'
      WHEN v_difference_count = 0 THEN 'equal'
      ELSE 'differences_found'
    END,
    v_difference_count,
    v_equal_count,
    COALESCE((p_projection_diff->'summary'->>'explicit_amendment_override')::int, 0),
    COALESCE((p_projection_diff->'summary'->>'inherited_from_base')::int, 0),
    COALESCE((p_projection_diff->'summary'->>'assignment_party_change')::int, 0),
    COALESCE((p_projection_diff->'summary'->>'requires_related_document')::int, 0),
    COALESCE((p_projection_diff->'summary'->>'package_conflict')::int, 0),
    COALESCE((p_projection_diff->'summary'->>'representation_only')::int, 0),
    jsonb_build_object('summary', COALESCE(p_projection_diff->'summary', '{}'::jsonb))
  );

  RETURN jsonb_build_object(
    'success', true,
    'projection_run_id', v_projection_run_id,
    'field_projections_inserted', v_inserted_fields
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_package_projection(UUID, UUID, UUID, JSONB, JSONB, JSONB) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.persist_lease_package_projection(UUID, UUID, UUID, JSONB, JSONB, JSONB) TO service_role;
