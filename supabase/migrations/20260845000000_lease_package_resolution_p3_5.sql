-- P3.5 - deterministic package-effective claim resolution.
--
-- Adds authoritative package-resolution storage and controlled RPCs. This
-- migration does not modify P2 source claims, compatibility projections,
-- extraction_data, workflow_output, runtime pipeline wiring, provider routing,
-- or diagnostic v3 package-resolution tables.

CREATE TABLE public.lease_package_resolution_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id UUID NOT NULL,
  lease_id UUID,
  resolution_version TEXT NOT NULL,
  claims_registry_version TEXT NOT NULL,
  claims_registry_hash TEXT NOT NULL,
  profile_registry_version TEXT NOT NULL,
  profile_registry_hash TEXT NOT NULL,
  relationship_contract_version TEXT NOT NULL,
  package_mode TEXT NOT NULL CHECK (package_mode IN ('off', 'shadow', 'active')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'superseded')),
  input_package_documents_hash TEXT NOT NULL,
  input_relationships_hash TEXT NOT NULL,
  input_claims_hash TEXT NOT NULL,
  source_claim_count INT NOT NULL DEFAULT 0,
  effective_claim_count INT NOT NULL DEFAULT 0,
  override_count INT NOT NULL DEFAULT 0,
  inherited_claim_count INT NOT NULL DEFAULT 0,
  conflict_count INT NOT NULL DEFAULT 0,
  related_document_requirement_count INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (id, org_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  CHECK (char_length(resolution_version) BETWEEN 1 AND 200),
  CHECK (char_length(claims_registry_hash) BETWEEN 1 AND 200),
  CHECK (char_length(profile_registry_hash) BETWEEN 1 AND 200),
  CHECK (char_length(relationship_contract_version) BETWEEN 1 AND 200),
  CHECK (char_length(input_package_documents_hash) BETWEEN 1 AND 200),
  CHECK (char_length(input_relationships_hash) BETWEEN 1 AND 200),
  CHECK (char_length(input_claims_hash) BETWEEN 1 AND 200),
  CHECK (source_claim_count >= 0 AND effective_claim_count >= 0 AND override_count >= 0),
  CHECK (inherited_claim_count >= 0 AND conflict_count >= 0 AND related_document_requirement_count >= 0),
  CHECK ((status IN ('completed', 'failed', 'superseded') AND completed_at IS NOT NULL) OR status = 'running'),
  CHECK (error_message IS NULL OR char_length(error_message) <= 2000),
  CHECK (octet_length(metadata::text) <= 20000)
);

CREATE UNIQUE INDEX idx_lease_package_resolution_one_running
  ON public.lease_package_resolution_runs (
    org_id, package_id, resolution_version,
    input_package_documents_hash, input_relationships_hash, input_claims_hash
  )
  WHERE status = 'running';
CREATE INDEX idx_lease_package_resolution_runs_package ON public.lease_package_resolution_runs (org_id, package_id);
CREATE INDEX idx_lease_package_resolution_runs_status ON public.lease_package_resolution_runs (org_id, status);

ALTER TABLE public.lease_package_resolution_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_package_resolution_runs_org_select
  ON public.lease_package_resolution_runs
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_package_resolution_runs FROM authenticated, anon;

CREATE TABLE public.lease_package_resolution_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id UUID NOT NULL,
  resolution_run_id UUID NOT NULL,
  concept_key TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'lease',
  instance_key TEXT NOT NULL DEFAULT 'default',
  conflict_type TEXT NOT NULL CHECK (conflict_type IN (
    'multiple_explicit_overrides', 'relationship_ambiguous', 'amendment_order_ambiguous',
    'competing_assignments', 'competing_commencement_certificates', 'supersession_ambiguous',
    'incompatible_package_documents', 'stale_generation_candidate', 'missing_related_document',
    'domain_scope_conflict'
  )),
  conflict_key TEXT NOT NULL,
  candidate_claim_ids UUID[] NOT NULL DEFAULT '{}',
  candidate_relationship_ids UUID[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'rejected', 'waived', 'reopened')),
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution_claim_id UUID,
  reviewer_decision_id UUID,

  UNIQUE (org_id, conflict_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolution_run_id, org_id) REFERENCES public.lease_package_resolution_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolution_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE SET NULL (resolution_claim_id),
  CHECK (char_length(concept_key) BETWEEN 1 AND 200),
  CHECK (char_length(scope_key) BETWEEN 1 AND 200),
  CHECK (char_length(instance_key) BETWEEN 1 AND 200),
  CHECK (char_length(conflict_key) BETWEEN 1 AND 1000),
  CHECK (array_length(candidate_claim_ids, 1) IS NULL OR array_length(candidate_claim_ids, 1) <= 100),
  CHECK (array_length(candidate_relationship_ids, 1) IS NULL OR array_length(candidate_relationship_ids, 1) <= 100),
  CHECK (array_length(reason_codes, 1) IS NULL OR array_length(reason_codes, 1) <= 50),
  CHECK ((status IN ('resolved', 'rejected', 'waived') AND resolved_at IS NOT NULL) OR status IN ('open', 'reopened'))
);

CREATE INDEX idx_lease_package_resolution_conflicts_run ON public.lease_package_resolution_conflicts (org_id, resolution_run_id);
CREATE INDEX idx_lease_package_resolution_conflicts_status ON public.lease_package_resolution_conflicts (org_id, status);

ALTER TABLE public.lease_package_resolution_conflicts ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_package_resolution_conflicts_org_select
  ON public.lease_package_resolution_conflicts
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_package_resolution_conflicts FROM authenticated, anon;

CREATE TABLE public.lease_package_effective_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id UUID NOT NULL,
  resolution_run_id UUID NOT NULL,
  concept_key TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'lease',
  instance_key TEXT NOT NULL DEFAULT 'default',
  effective_status TEXT NOT NULL CHECK (effective_status IN (
    'effective', 'inherited', 'overridden', 'needs_review', 'requires_related_document',
    'not_present', 'not_applicable', 'unreadable', 'extraction_failed'
  )),
  selected_source_claim_id UUID,
  base_source_claim_id UUID,
  overriding_source_claim_id UUID,
  selected_package_document_id UUID,
  source_relationship_id UUID,
  relationship_path JSONB NOT NULL DEFAULT '[]'::jsonb,
  precedence_rule TEXT NOT NULL,
  resolution_reason TEXT,
  confidence NUMERIC(5, 4),
  conflict_group_id UUID,
  related_document_requirement_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (resolution_run_id, concept_key, scope_key, instance_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolution_run_id, org_id) REFERENCES public.lease_package_resolution_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (selected_source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE SET NULL (selected_source_claim_id),
  FOREIGN KEY (base_source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE SET NULL (base_source_claim_id),
  FOREIGN KEY (overriding_source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE SET NULL (overriding_source_claim_id),
  FOREIGN KEY (selected_package_document_id, package_id, org_id)
    REFERENCES public.lease_package_documents (id, package_id, org_id) ON DELETE SET NULL (selected_package_document_id),
  FOREIGN KEY (source_relationship_id, org_id) REFERENCES public.lease_document_relationships (id, org_id) ON DELETE SET NULL (source_relationship_id),
  FOREIGN KEY (conflict_group_id, org_id) REFERENCES public.lease_package_resolution_conflicts (id, org_id) ON DELETE SET NULL (conflict_group_id),
  FOREIGN KEY (related_document_requirement_id, org_id) REFERENCES public.lease_related_document_requirements (id, org_id) ON DELETE SET NULL (related_document_requirement_id),
  CHECK (char_length(concept_key) BETWEEN 1 AND 200),
  CHECK (char_length(scope_key) BETWEEN 1 AND 200),
  CHECK (char_length(instance_key) BETWEEN 1 AND 200),
  CHECK (char_length(precedence_rule) BETWEEN 1 AND 200),
  CHECK (octet_length(relationship_path::text) <= 5000),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (
    (effective_status IN ('effective', 'inherited', 'overridden') AND selected_source_claim_id IS NOT NULL)
    OR effective_status IN ('needs_review', 'requires_related_document', 'not_present', 'not_applicable', 'unreadable', 'extraction_failed')
  )
);

CREATE INDEX idx_lease_package_effective_claims_run ON public.lease_package_effective_claims (org_id, resolution_run_id);
CREATE INDEX idx_lease_package_effective_claims_package ON public.lease_package_effective_claims (org_id, package_id);
CREATE INDEX idx_lease_package_effective_claims_concept ON public.lease_package_effective_claims (org_id, concept_key);

ALTER TABLE public.lease_package_effective_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_package_effective_claims_org_select
  ON public.lease_package_effective_claims
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_package_effective_claims FROM authenticated, anon;

CREATE TABLE public.lease_package_claim_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id UUID NOT NULL,
  resolution_run_id UUID NOT NULL,
  base_claim_id UUID,
  overriding_claim_id UUID NOT NULL,
  relationship_id UUID NOT NULL,
  concept_key TEXT NOT NULL,
  override_type TEXT NOT NULL CHECK (override_type IN (
    'explicit_amendment', 'assignment_party_change', 'extension_term_change',
    'renewal_term_change', 'commencement_resolution', 'explicit_supersession',
    'domain_addendum', 'reviewer_override', 'guaranty_party_addition',
    'work_letter', 'explicit_attachment'
  )),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid', 'invalid', 'needs_review')),
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (id, org_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolution_run_id, org_id) REFERENCES public.lease_package_resolution_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (base_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE SET NULL (base_claim_id),
  FOREIGN KEY (overriding_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (relationship_id, org_id) REFERENCES public.lease_document_relationships (id, org_id) ON DELETE RESTRICT,
  CHECK (char_length(concept_key) BETWEEN 1 AND 200),
  CHECK (array_length(reason_codes, 1) IS NULL OR array_length(reason_codes, 1) <= 50)
);

CREATE INDEX idx_lease_package_claim_overrides_run ON public.lease_package_claim_overrides (org_id, resolution_run_id);
CREATE INDEX idx_lease_package_claim_overrides_package ON public.lease_package_claim_overrides (org_id, package_id);

ALTER TABLE public.lease_package_claim_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_package_claim_overrides_org_select
  ON public.lease_package_claim_overrides
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_package_claim_overrides FROM authenticated, anon;

CREATE TABLE public.lease_package_resolution_reviewer_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  conflict_id UUID NOT NULL,
  resolution_run_id UUID NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'choose_claim', 'reject_override', 'confirm_relationship_order',
    'waive_related_document_requirement', 'reopen'
  )),
  selected_claim_id UUID,
  idempotency_key TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  actor_email TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, idempotency_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (conflict_id, org_id) REFERENCES public.lease_package_resolution_conflicts (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolution_run_id, org_id) REFERENCES public.lease_package_resolution_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (selected_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE SET NULL (selected_claim_id),
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 600),
  CHECK (reason IS NULL OR char_length(reason) <= 2000)
);

CREATE INDEX idx_lease_package_resolution_reviewer_decisions_conflict
  ON public.lease_package_resolution_reviewer_decisions (org_id, conflict_id);

ALTER TABLE public.lease_package_resolution_reviewer_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_package_resolution_reviewer_decisions_org_select
  ON public.lease_package_resolution_reviewer_decisions
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_package_resolution_reviewer_decisions FROM authenticated, anon;

ALTER TABLE public.lease_package_resolution_conflicts
  ADD CONSTRAINT lease_package_resolution_conflicts_reviewer_decision_fk
  FOREIGN KEY (reviewer_decision_id, org_id)
  REFERENCES public.lease_package_resolution_reviewer_decisions (id, org_id) ON DELETE SET NULL (reviewer_decision_id);

CREATE OR REPLACE FUNCTION public.enforce_lease_package_resolution_run_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed', 'superseded') THEN
    RAISE EXCEPTION 'lease_package_resolution_runs: % is terminal, no further transition allowed (run %)', OLD.status, OLD.id;
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.package_id IS DISTINCT FROM OLD.package_id
     OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
     OR NEW.resolution_version IS DISTINCT FROM OLD.resolution_version
     OR NEW.claims_registry_version IS DISTINCT FROM OLD.claims_registry_version
     OR NEW.claims_registry_hash IS DISTINCT FROM OLD.claims_registry_hash
     OR NEW.profile_registry_version IS DISTINCT FROM OLD.profile_registry_version
     OR NEW.profile_registry_hash IS DISTINCT FROM OLD.profile_registry_hash
     OR NEW.relationship_contract_version IS DISTINCT FROM OLD.relationship_contract_version
     OR NEW.package_mode IS DISTINCT FROM OLD.package_mode
     OR NEW.input_package_documents_hash IS DISTINCT FROM OLD.input_package_documents_hash
     OR NEW.input_relationships_hash IS DISTINCT FROM OLD.input_relationships_hash
     OR NEW.input_claims_hash IS DISTINCT FROM OLD.input_claims_hash
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
  THEN
    RAISE EXCEPTION 'lease_package_resolution_runs: identity columns are immutable (run %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_package_resolution_run_immutability
  BEFORE UPDATE ON public.lease_package_resolution_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_package_resolution_run_immutability();

CREATE OR REPLACE FUNCTION public.enforce_lease_package_resolution_claim_generation()
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
      RAISE EXCEPTION 'lease_package_effective_claims: selected/base/override claim % is not active in package %', v_claim_id, NEW.package_id;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_lease_package_resolution_claim_generation
  BEFORE INSERT ON public.lease_package_effective_claims
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_package_resolution_claim_generation();

CREATE OR REPLACE FUNCTION public.persist_lease_package_resolution(
  p_org_id UUID,
  p_package_id UUID,
  p_resolution_run JSONB,
  p_effective_claims JSONB,
  p_overrides JSONB,
  p_conflicts JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run_id UUID;
  v_item JSONB;
  v_conflict_id UUID;
  v_conflicts_inserted INT := 0;
  v_effective_inserted INT := 0;
  v_overrides_inserted INT := 0;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SERVICE_ROLE_ONLY');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lease_document_packages WHERE id = p_package_id AND org_id = p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_NOT_FOUND_IN_ORG');
  END IF;
  IF jsonb_typeof(COALESCE(p_effective_claims, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_overrides, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_conflicts, '[]'::jsonb)) <> 'array'
  THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'RESOLUTION_PAYLOADS_MUST_BE_ARRAYS');
  END IF;

  UPDATE public.lease_package_resolution_runs
     SET status = 'superseded', completed_at = now(), metadata = metadata || jsonb_build_object('superseded_by_new_input', true)
   WHERE org_id = p_org_id
     AND package_id = p_package_id
     AND status = 'running';

  INSERT INTO public.lease_package_resolution_runs (
    org_id, package_id, lease_id, resolution_version, claims_registry_version,
    claims_registry_hash, profile_registry_version, profile_registry_hash,
    relationship_contract_version, package_mode, status,
    input_package_documents_hash, input_relationships_hash, input_claims_hash,
    source_claim_count, effective_claim_count, override_count, inherited_claim_count,
    conflict_count, related_document_requirement_count, completed_at, metadata
  ) VALUES (
    p_org_id,
    p_package_id,
    NULLIF(p_resolution_run->>'lease_id', '')::uuid,
    COALESCE(NULLIF(p_resolution_run->>'resolution_version', ''), 'lease-package-resolution-v1'),
    COALESCE(NULLIF(p_resolution_run->>'claims_registry_version', ''), 'lease-claims-v1'),
    COALESCE(NULLIF(p_resolution_run->>'claims_registry_hash', ''), 'unknown'),
    COALESCE(NULLIF(p_resolution_run->>'profile_registry_version', ''), 'lease-document-profiles-v1'),
    COALESCE(NULLIF(p_resolution_run->>'profile_registry_hash', ''), 'unknown'),
    COALESCE(NULLIF(p_resolution_run->>'relationship_contract_version', ''), 'lease-document-relationships-v1'),
    COALESCE(NULLIF(p_resolution_run->>'package_mode', ''), 'shadow'),
    'completed',
    COALESCE(NULLIF(p_resolution_run->>'input_package_documents_hash', ''), 'unknown'),
    COALESCE(NULLIF(p_resolution_run->>'input_relationships_hash', ''), 'unknown'),
    COALESCE(NULLIF(p_resolution_run->>'input_claims_hash', ''), 'unknown'),
    COALESCE((p_resolution_run->>'source_claim_count')::int, 0),
    COALESCE((p_resolution_run->>'effective_claim_count')::int, 0),
    COALESCE((p_resolution_run->>'override_count')::int, 0),
    COALESCE((p_resolution_run->>'inherited_claim_count')::int, 0),
    COALESCE((p_resolution_run->>'conflict_count')::int, 0),
    COALESCE((p_resolution_run->>'related_document_requirement_count')::int, 0),
    now(),
    jsonb_build_object('p3_5_no_compatibility_projection', true)
  )
  RETURNING id INTO v_run_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_conflicts, '[]'::jsonb))
  LOOP
    INSERT INTO public.lease_package_resolution_conflicts (
      org_id, package_id, resolution_run_id, concept_key, scope_key, instance_key,
      conflict_type, conflict_key, candidate_claim_ids, candidate_relationship_ids,
      reason_codes
    ) VALUES (
      p_org_id, p_package_id, v_run_id,
      v_item->>'conceptKey',
      COALESCE(NULLIF(v_item->>'scopeKey', ''), 'lease'),
      COALESCE(NULLIF(v_item->>'instanceKey', ''), 'default'),
      v_item->>'conflictType',
      COALESCE(NULLIF(v_item->>'conflictKey', ''), 'conflict:' || v_run_id::text || ':' || v_conflicts_inserted::text),
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_item->'candidateClaimIds', '[]'::jsonb))::uuid),
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_item->'candidateRelationshipIds', '[]'::jsonb))::uuid),
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_item->'reasonCodes', '[]'::jsonb)))
    )
    ON CONFLICT (org_id, conflict_key) DO NOTHING
    RETURNING id INTO v_conflict_id;
    v_conflicts_inserted := v_conflicts_inserted + 1;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_effective_claims, '[]'::jsonb))
  LOOP
    INSERT INTO public.lease_package_effective_claims (
      org_id, package_id, resolution_run_id, concept_key, scope_key, instance_key,
      effective_status, selected_source_claim_id, base_source_claim_id,
      overriding_source_claim_id, selected_package_document_id, source_relationship_id,
      relationship_path, precedence_rule, resolution_reason,
      related_document_requirement_id
    ) VALUES (
      p_org_id, p_package_id, v_run_id,
      v_item->>'conceptKey',
      COALESCE(NULLIF(v_item->>'scopeKey', ''), 'lease'),
      COALESCE(NULLIF(v_item->>'instanceKey', ''), 'default'),
      v_item->>'status',
      NULLIF(v_item->>'selectedClaimId', '')::uuid,
      NULLIF(v_item->>'baseClaimId', '')::uuid,
      NULLIF(v_item->>'overridingClaimId', '')::uuid,
      NULLIF(v_item->>'sourcePackageDocumentId', '')::uuid,
      NULLIF(v_item->>'sourceRelationshipId', '')::uuid,
      COALESCE(v_item->'relationshipPath', '[]'::jsonb),
      COALESCE(NULLIF(v_item->>'precedenceRule', ''), 'unspecified'),
      array_to_string(ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_item->'reasonCodes', '[]'::jsonb))), ','),
      NULLIF(v_item->>'relatedDocumentRequirementId', '')::uuid
    );
    v_effective_inserted := v_effective_inserted + 1;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_overrides, '[]'::jsonb))
  LOOP
    INSERT INTO public.lease_package_claim_overrides (
      org_id, package_id, resolution_run_id, base_claim_id, overriding_claim_id,
      relationship_id, concept_key, override_type, validation_status, reason_codes
    ) VALUES (
      p_org_id, p_package_id, v_run_id,
      NULLIF(v_item->>'baseClaimId', '')::uuid,
      NULLIF(v_item->>'overridingClaimId', '')::uuid,
      NULLIF(v_item->>'relationshipId', '')::uuid,
      v_item->>'conceptKey',
      v_item->>'overrideType',
      COALESCE(NULLIF(v_item->>'validationStatus', ''), 'valid'),
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_item->'reasonCodes', '[]'::jsonb)))
    );
    v_overrides_inserted := v_overrides_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'resolution_run_id', v_run_id,
    'effective_claims_inserted', v_effective_inserted,
    'overrides_inserted', v_overrides_inserted,
    'conflicts_inserted', v_conflicts_inserted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_package_resolution(UUID, UUID, JSONB, JSONB, JSONB, JSONB) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.persist_lease_package_resolution(UUID, UUID, JSONB, JSONB, JSONB, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_lease_package_claim_conflict(
  p_org_id UUID,
  p_operation TEXT,
  p_idempotency_key TEXT,
  p_conflict_id UUID,
  p_selected_claim_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_actor_email TEXT;
  v_existing_decision RECORD;
  v_conflict RECORD;
  v_decision_id UUID;
BEGIN
  IF v_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_AUTHENTICATED');
  END IF;
  IF NOT public.is_member_of_org(p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
  END IF;
  IF p_operation NOT IN ('choose_claim', 'reject_override', 'confirm_relationship_order', 'waive_related_document_requirement', 'reopen') THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_OPERATION');
  END IF;

  SELECT * INTO v_existing_decision
    FROM public.lease_package_resolution_reviewer_decisions
   WHERE org_id = p_org_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent_replay', true,
      'decision_id', v_existing_decision.id,
      'conflict_id', v_existing_decision.conflict_id,
      'operation', v_existing_decision.operation,
      'selected_claim_id', v_existing_decision.selected_claim_id
    );
  END IF;

  SELECT * INTO v_conflict
    FROM public.lease_package_resolution_conflicts
   WHERE id = p_conflict_id AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'CONFLICT_NOT_FOUND');
  END IF;

  IF p_operation = 'choose_claim' THEN
    IF p_selected_claim_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'SELECTED_CLAIM_REQUIRED');
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
       WHERE c.id = p_selected_claim_id
         AND c.org_id = p_org_id
         AND c.concept_key = v_conflict.concept_key
         AND c.scope_key = v_conflict.scope_key
         AND c.instance_key = v_conflict.instance_key
         AND lpd.package_id = v_conflict.package_id
         AND lpd.membership_status = 'confirmed'
         AND c.generation_id = uf.active_generation_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'SELECTED_CLAIM_NOT_ACTIVE_IN_PACKAGE');
    END IF;
  END IF;

  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;

  INSERT INTO public.lease_package_resolution_reviewer_decisions (
    org_id, conflict_id, resolution_run_id, operation, selected_claim_id,
    idempotency_key, actor_user_id, actor_email, reason
  ) VALUES (
    p_org_id, p_conflict_id, v_conflict.resolution_run_id, p_operation, p_selected_claim_id,
    p_idempotency_key, v_actor_user_id, v_actor_email, p_reason
  )
  RETURNING id INTO v_decision_id;

  UPDATE public.lease_package_resolution_conflicts
     SET status = CASE
           WHEN p_operation = 'reopen' THEN 'reopened'
           WHEN p_operation = 'waive_related_document_requirement' THEN 'waived'
           WHEN p_operation = 'reject_override' THEN 'rejected'
           ELSE 'resolved'
         END,
         resolved_at = CASE WHEN p_operation = 'reopen' THEN NULL ELSE now() END,
         resolution_claim_id = CASE WHEN p_operation = 'choose_claim' THEN p_selected_claim_id ELSE resolution_claim_id END,
         reviewer_decision_id = v_decision_id
   WHERE id = p_conflict_id;

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, actor_role, severity, source, after, metadata)
  VALUES (
    p_org_id, 'lease_package_resolution_conflicts', p_conflict_id::text, 'update',
    v_actor_user_id, v_actor_email, 'reviewer', 'info', 'edge_function',
    jsonb_build_object('operation', p_operation, 'selected_claim_id', p_selected_claim_id),
    jsonb_build_object('idempotency_key', p_idempotency_key, 'reason', p_reason)
  );

  RETURN jsonb_build_object(
    'success', true,
    'decision_id', v_decision_id,
    'conflict_id', p_conflict_id,
    'operation', p_operation,
    'selected_claim_id', p_selected_claim_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_lease_package_claim_conflict(UUID, TEXT, TEXT, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_lease_package_claim_conflict(UUID, TEXT, TEXT, UUID, UUID, TEXT) TO authenticated, service_role;
