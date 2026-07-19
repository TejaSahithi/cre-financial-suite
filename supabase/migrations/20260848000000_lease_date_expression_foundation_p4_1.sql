-- P4.1 - canonical date-expression registry and immutable expression candidates.
--
-- This migration implements only the P4.1 foundation. It does not calculate
-- dates, build term graphs, create rent schedules, generate critical dates,
-- write extraction_data/workflow_output, modify finalizer/readiness behavior,
-- or change P2/P3 source claims/package-effective claims.

CREATE TABLE public.lease_date_expression_registry_versions (
  registry_version TEXT PRIMARY KEY,
  registry_hash TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (registry_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE public.lease_date_expression_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registry_version TEXT NOT NULL REFERENCES public.lease_date_expression_registry_versions(registry_version) ON DELETE RESTRICT,
  expression_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  required_components TEXT[] NOT NULL DEFAULT '{}',
  allowed_anchor_types TEXT[] NOT NULL DEFAULT '{}',
  operands_permitted BOOLEAN NOT NULL DEFAULT false,
  offsets_permitted BOOLEAN NOT NULL DEFAULT false,
  recurrence_permitted BOOLEAN NOT NULL DEFAULT false,
  requires_dependency_processing BOOLEAN NOT NULL DEFAULT false,
  fixed_resolved_date_permitted BOOLEAN NOT NULL DEFAULT false,
  validation_rules TEXT[] NOT NULL DEFAULT '{}',
  introduced_in TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (registry_version, expression_type),
  CHECK (expression_type IN (
    'fixed_date', 'event_date', 'relative_to_date', 'relative_to_event',
    'earlier_of', 'later_of', 'minimum_of', 'maximum_of',
    'dependent_date', 'recurring_deadline', 'notice_window',
    'unresolved_expression'
  )),
  CHECK (char_length(display_name) BETWEEN 1 AND 200),
  CHECK (char_length(description) BETWEEN 1 AND 2000),
  CHECK (array_length(required_components, 1) IS NULL OR array_length(required_components, 1) <= 20),
  CHECK (array_length(allowed_anchor_types, 1) IS NULL OR array_length(allowed_anchor_types, 1) <= 20),
  CHECK (array_length(validation_rules, 1) IS NULL OR array_length(validation_rules, 1) <= 50)
);

REVOKE ALL ON public.lease_date_expression_registry_versions FROM authenticated, anon;
REVOKE ALL ON public.lease_date_expression_types FROM authenticated, anon;

INSERT INTO public.lease_date_expression_registry_versions (registry_version, registry_hash) VALUES
  ('lease-date-expressions-v1', '4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8');

INSERT INTO public.lease_date_expression_types
  (registry_version, expression_type, display_name, description, required_components, allowed_anchor_types, operands_permitted, offsets_permitted, recurrence_permitted, requires_dependency_processing, fixed_resolved_date_permitted, validation_rules, introduced_in)
VALUES
  ('lease-date-expressions-v1', 'fixed_date', 'Fixed Date', 'A specific date explicitly stated in an authoritative source or supplied by a reviewer.', '{"explicit_date"}', '{}', false, false, false, false, true, '{"explicit_date_required","no_event_anchor_or_offset"}', 'lease-date-expressions-v1'),
  ('lease-date-expressions-v1', 'event_date', 'Event Date', 'A date tied to an event, such as certificate of occupancy or delivery of possession.', '{"event_key"}', '{"event"}', false, false, false, true, true, '{"event_key_required","unresolved_until_authoritative_event"}', 'lease-date-expressions-v1'),
  ('lease-date-expressions-v1', 'relative_to_date', 'Relative To Date', 'A date offset before or after another fixed date or date expression.', '{"anchor","offset_value","offset_unit","offset_direction"}', '{"date","expression","concept"}', false, true, false, true, false, '{"anchor_required","offset_required","no_p4_1_resolution"}', 'lease-date-expressions-v1'),
  ('lease-date-expressions-v1', 'relative_to_event', 'Relative To Event', 'A date offset before or after an event anchor.', '{"event_key","offset_value","offset_unit","offset_direction"}', '{"event"}', false, true, false, true, false, '{"event_key_required","offset_required","no_p4_1_resolution"}', 'lease-date-expressions-v1'),
  ('lease-date-expressions-v1', 'earlier_of', 'Earlier Of', 'The earlier date among multiple candidate operands.', '{"operands"}', '{"expression","concept","event"}', true, false, false, true, false, '{"multiple_operands_required","no_p4_1_resolution"}', 'lease-date-expressions-v1'),
  ('lease-date-expressions-v1', 'later_of', 'Later Of', 'The later date among multiple candidate operands.', '{"operands"}', '{"expression","concept","event"}', true, false, false, true, false, '{"multiple_operands_required","no_p4_1_resolution"}', 'lease-date-expressions-v1'),
  ('lease-date-expressions-v1', 'minimum_of', 'Minimum Of', 'The minimum date or deadline from an operand set under a legal condition.', '{"operands"}', '{"expression","concept","event"}', true, false, false, true, false, '{"multiple_operands_required","no_p4_1_resolution"}', 'lease-date-expressions-v1'),
  ('lease-date-expressions-v1', 'maximum_of', 'Maximum Of', 'The maximum date or deadline from an operand set under a legal condition.', '{"operands"}', '{"expression","concept","event"}', true, false, false, true, false, '{"multiple_operands_required","no_p4_1_resolution"}', 'lease-date-expressions-v1'),
  ('lease-date-expressions-v1', 'dependent_date', 'Dependent Date', 'A date that depends on another unresolved expression, concept, or event.', '{"anchor"}', '{"expression","concept","event"}', false, false, false, true, false, '{"dependency_required","no_p4_1_resolution"}', 'lease-date-expressions-v1'),
  ('lease-date-expressions-v1', 'recurring_deadline', 'Recurring Deadline', 'A repeating date obligation, such as a yearly statement due date.', '{"recurrence_definition"}', '{"date","expression","concept","event"}', false, true, true, true, false, '{"bounded_recurrence_required","no_occurrence_expansion_in_p4_1"}', 'lease-date-expressions-v1'),
  ('lease-date-expressions-v1', 'notice_window', 'Notice Window', 'A notice period anchored to another date expression or concept.', '{"anchor","offset_value","offset_unit","offset_direction"}', '{"date","expression","concept","event"}', false, true, false, true, false, '{"anchor_required","window_required","no_deadline_calculation_in_p4_1"}', 'lease-date-expressions-v1'),
  ('lease-date-expressions-v1', 'unresolved_expression', 'Unresolved Expression', 'A safely preserved date expression that lacks enough validated structure for resolution.', '{}', '{"date","expression","concept","event","unknown"}', true, true, true, true, false, '{"preserve_without_fabrication","status_unresolved_or_needs_review"}', 'lease-date-expressions-v1');

CREATE TABLE public.lease_date_expressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID,
  package_id UUID,
  uploaded_file_id UUID NOT NULL,
  extraction_run_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  source_package_document_id UUID,
  source_package_effective_claim_id UUID,
  source_claim_id UUID,
  concept_key TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'lease',
  instance_key TEXT NOT NULL DEFAULT 'default',
  expression_type TEXT NOT NULL,
  expression_status TEXT NOT NULL CHECK (expression_status IN (
    'extracted', 'unresolved', 'ambiguous', 'needs_review', 'manual_required',
    'requires_related_document', 'not_present', 'not_applicable', 'unreadable',
    'extraction_failed'
  )),
  origin_type TEXT NOT NULL CHECK (origin_type IN (
    'extracted', 'reviewer', 'derived', 'calculated', 'legacy_adapter',
    'system_projection'
  )),
  expression_key TEXT NOT NULL,
  explicit_date DATE,
  event_key TEXT,
  anchor_concept_key TEXT,
  anchor_expression_id UUID,
  offset_value NUMERIC,
  offset_unit TEXT CHECK (offset_unit IS NULL OR offset_unit IN ('day', 'business_day', 'week', 'month', 'year')),
  offset_direction TEXT CHECK (offset_direction IS NULL OR offset_direction IN ('before', 'after')),
  business_day_rule TEXT CHECK (business_day_rule IS NULL OR business_day_rule IN ('none', 'next_business_day', 'previous_business_day', 'nearest_business_day')),
  operands JSONB,
  recurrence_definition JSONB,
  condition_definition JSONB,
  normalized_expression JSONB NOT NULL DEFAULT '{}'::jsonb,
  derivation_definition JSONB,
  calculation_formula_key TEXT,
  calculation_version TEXT,
  confidence NUMERIC(5,4),
  producer_type TEXT NOT NULL CHECK (producer_type IN (
    'deterministic_mapper', 'semantic_extractor', 'validation_engine',
    'legacy_adapter', 'reviewer', 'system_projection'
  )),
  producer_name TEXT NOT NULL,
  producer_version TEXT,
  extraction_stage_run_id UUID,
  provider_invocation_id UUID,
  registry_version TEXT NOT NULL DEFAULT 'lease-date-expressions-v1',
  registry_hash TEXT NOT NULL DEFAULT '4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8',
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'valid', 'invalid', 'needs_review')),
  validation_errors TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, expression_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id)
    REFERENCES public.extraction_runs (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (extraction_stage_run_id, extraction_run_id, org_id)
    REFERENCES public.extraction_stage_runs (id, run_id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_invocation_id, extraction_stage_run_id, extraction_run_id, org_id)
    REFERENCES public.provider_invocations (id, stage_run_id, run_id, org_id) ON DELETE SET NULL (provider_invocation_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_document_id, package_id, org_id)
    REFERENCES public.lease_package_documents (id, package_id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id)
    REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (anchor_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE SET NULL (anchor_expression_id),
  FOREIGN KEY (registry_version, expression_type)
    REFERENCES public.lease_date_expression_types (registry_version, expression_type) ON DELETE RESTRICT,

  CHECK (char_length(concept_key) BETWEEN 1 AND 200),
  CHECK (char_length(scope_key) BETWEEN 1 AND 200),
  CHECK (char_length(instance_key) BETWEEN 1 AND 200),
  CHECK (char_length(expression_key) BETWEEN 1 AND 600),
  CHECK (char_length(producer_name) BETWEEN 1 AND 200),
  CHECK (producer_version IS NULL OR char_length(producer_version) <= 200),
  CHECK (registry_hash ~ '^[0-9a-f]{64}$'),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (offset_value IS NULL OR offset_value >= 0),
  CHECK (array_length(validation_errors, 1) IS NULL OR array_length(validation_errors, 1) <= 50),
  CHECK (octet_length(normalized_expression::text) <= 20000),
  CHECK (operands IS NULL OR octet_length(operands::text) <= 20000),
  CHECK (recurrence_definition IS NULL OR octet_length(recurrence_definition::text) <= 10000),
  CHECK (condition_definition IS NULL OR octet_length(condition_definition::text) <= 10000),
  CHECK (derivation_definition IS NULL OR octet_length(derivation_definition::text) <= 10000),
  CHECK (
    (expression_type = 'fixed_date' AND explicit_date IS NOT NULL AND event_key IS NULL AND anchor_concept_key IS NULL AND anchor_expression_id IS NULL AND offset_value IS NULL AND offset_unit IS NULL AND offset_direction IS NULL)
    OR expression_type <> 'fixed_date'
  ),
  CHECK (expression_type <> 'event_date' OR event_key IS NOT NULL),
  CHECK (expression_type <> 'relative_to_date' OR ((anchor_concept_key IS NOT NULL OR anchor_expression_id IS NOT NULL) AND offset_value IS NOT NULL AND offset_unit IS NOT NULL AND offset_direction IS NOT NULL)),
  CHECK (expression_type <> 'relative_to_event' OR (event_key IS NOT NULL AND offset_value IS NOT NULL AND offset_unit IS NOT NULL AND offset_direction IS NOT NULL)),
  CHECK (expression_type <> 'notice_window' OR ((anchor_concept_key IS NOT NULL OR anchor_expression_id IS NOT NULL OR event_key IS NOT NULL) AND offset_value IS NOT NULL AND offset_unit IS NOT NULL AND offset_direction IS NOT NULL)),
  CHECK (expression_type NOT IN ('earlier_of', 'later_of', 'minimum_of', 'maximum_of') OR (operands IS NOT NULL AND jsonb_typeof(operands) = 'array' AND jsonb_array_length(operands) >= 2)),
  CHECK (expression_type <> 'dependent_date' OR (anchor_concept_key IS NOT NULL OR anchor_expression_id IS NOT NULL OR event_key IS NOT NULL)),
  CHECK (expression_type <> 'recurring_deadline' OR (recurrence_definition IS NOT NULL AND jsonb_typeof(recurrence_definition) = 'object')),
  CHECK (expression_status <> 'ambiguous' OR explicit_date IS NULL),
  CHECK (expression_type IN ('fixed_date', 'event_date') OR explicit_date IS NULL),
  CHECK (
    origin_type NOT IN ('derived', 'calculated')
    OR (calculation_formula_key IS NOT NULL AND calculation_version IS NOT NULL)
  ),
  CHECK (
    (producer_type = 'semantic_extractor' AND provider_invocation_id IS NOT NULL)
    OR (producer_type <> 'semantic_extractor' AND provider_invocation_id IS NULL)
  ),
  CHECK (
    (origin_type = 'reviewer' AND extraction_stage_run_id IS NULL AND provider_invocation_id IS NULL AND producer_type = 'reviewer')
    OR origin_type <> 'reviewer'
  )
);

CREATE INDEX idx_lease_date_expressions_org_file ON public.lease_date_expressions (org_id, uploaded_file_id);
CREATE INDEX idx_lease_date_expressions_run ON public.lease_date_expressions (org_id, extraction_run_id);
CREATE INDEX idx_lease_date_expressions_lease ON public.lease_date_expressions (org_id, lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX idx_lease_date_expressions_package ON public.lease_date_expressions (org_id, package_id) WHERE package_id IS NOT NULL;
CREATE INDEX idx_lease_date_expressions_concept ON public.lease_date_expressions (org_id, concept_key);

ALTER TABLE public.lease_date_expressions ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_date_expressions_org_select
  ON public.lease_date_expressions
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_date_expressions FROM authenticated, anon;

CREATE TABLE public.lease_date_expression_claim_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  date_expression_id UUID NOT NULL,
  source_claim_id UUID NOT NULL,
  source_package_effective_claim_id UUID,
  link_role TEXT NOT NULL CHECK (link_role IN (
    'primary_source', 'anchor_source', 'offset_source', 'condition_source',
    'corroborating_source', 'contradictory_source', 'contextual_source'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (date_expression_id, source_claim_id, link_role),
  UNIQUE (id, org_id),
  FOREIGN KEY (date_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id)
    REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT
);

CREATE INDEX idx_lease_date_expression_claim_links_expr
  ON public.lease_date_expression_claim_links (org_id, date_expression_id);
CREATE INDEX idx_lease_date_expression_claim_links_claim
  ON public.lease_date_expression_claim_links (org_id, source_claim_id);

ALTER TABLE public.lease_date_expression_claim_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_date_expression_claim_links_org_select
  ON public.lease_date_expression_claim_links
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_date_expression_claim_links FROM authenticated, anon;

CREATE TABLE public.lease_date_expression_reviewer_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  date_expression_id UUID NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'accept_expression', 'reject_expression', 'replace_expression',
    'mark_unresolved', 'mark_manual_required',
    'mark_requires_related_document', 'reopen'
  )),
  replacement_expression JSONB,
  idempotency_key TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  actor_email TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (date_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 600),
  CHECK (reason IS NULL OR char_length(reason) <= 2000),
  CHECK (replacement_expression IS NULL OR octet_length(replacement_expression::text) <= 20000),
  CHECK (operation <> 'replace_expression' OR replacement_expression IS NOT NULL)
);

CREATE INDEX idx_lease_date_expression_reviewer_decisions_expr
  ON public.lease_date_expression_reviewer_decisions (org_id, date_expression_id);

ALTER TABLE public.lease_date_expression_reviewer_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_date_expression_reviewer_decisions_org_select
  ON public.lease_date_expression_reviewer_decisions
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_date_expression_reviewer_decisions FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.enforce_lease_date_expression_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.lease_id IS NULL AND OLD.lease_id IS NOT NULL
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     AND NEW.package_id IS NOT DISTINCT FROM OLD.package_id
     AND NEW.uploaded_file_id IS NOT DISTINCT FROM OLD.uploaded_file_id
     AND NEW.extraction_run_id IS NOT DISTINCT FROM OLD.extraction_run_id
     AND NEW.generation_id IS NOT DISTINCT FROM OLD.generation_id
     AND NEW.expression_key IS NOT DISTINCT FROM OLD.expression_key
     AND NEW.expression_type IS NOT DISTINCT FROM OLD.expression_type
     AND NEW.origin_type IS NOT DISTINCT FROM OLD.origin_type
     AND NEW.normalized_expression IS NOT DISTINCT FROM OLD.normalized_expression
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'lease_date_expressions rows are immutable; create a new candidate or reviewer decision instead (expression %)', OLD.id;
END;
$$;

CREATE TRIGGER trg_enforce_lease_date_expression_immutability
  BEFORE UPDATE ON public.lease_date_expressions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_date_expression_immutability();

CREATE OR REPLACE FUNCTION public.reject_lease_date_expression_link_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lease_date_expression_claim_links rows are immutable';
END;
$$;

CREATE TRIGGER trg_reject_lease_date_expression_link_update
  BEFORE UPDATE OR DELETE ON public.lease_date_expression_claim_links
  FOR EACH ROW EXECUTE FUNCTION public.reject_lease_date_expression_link_update();

CREATE OR REPLACE FUNCTION public.reject_lease_date_expression_review_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lease_date_expression_reviewer_decisions rows are append-only';
END;
$$;

CREATE TRIGGER trg_reject_lease_date_expression_review_update
  BEFORE UPDATE OR DELETE ON public.lease_date_expression_reviewer_decisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_lease_date_expression_review_update();

CREATE OR REPLACE FUNCTION public.persist_lease_date_expression_candidates(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_lease_id UUID,
  p_package_id UUID,
  p_extraction_run_id UUID,
  p_generation_id UUID,
  p_candidates JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active_generation_id UUID;
  v_candidate JSONB;
  v_link JSONB;
  v_candidate_count INT;
  v_expression_id UUID;
  v_expression_key TEXT;
  v_source_claim_id UUID;
  v_source_claim RECORD;
  v_source_package_effective_claim_id UUID;
  v_inserted INT := 0;
  v_already_existed INT := 0;
  v_links_inserted INT := 0;
  v_result_map JSONB := '{}'::jsonb;
  v_registry_hash TEXT;
  v_explicit_date DATE;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SERVICE_ROLE_ONLY');
  END IF;

  IF jsonb_typeof(COALESCE(p_candidates, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'CANDIDATES_MUST_BE_ARRAY');
  END IF;
  v_candidate_count := jsonb_array_length(COALESCE(p_candidates, '[]'::jsonb));
  IF v_candidate_count > 100 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'BATCH_TOO_LARGE');
  END IF;

  SELECT active_generation_id INTO v_active_generation_id
    FROM public.uploaded_files
   WHERE id = p_uploaded_file_id AND org_id = p_org_id;
  IF v_active_generation_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FILE_NOT_FOUND_IN_ORG');
  END IF;
  IF v_active_generation_id IS DISTINCT FROM p_generation_id THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'STALE_GENERATION');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.extraction_runs
     WHERE id = p_extraction_run_id
       AND uploaded_file_id = p_uploaded_file_id
       AND generation_id = p_generation_id
       AND org_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'EXTRACTION_RUN_NOT_FOUND');
  END IF;

  IF p_package_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.lease_document_packages
     WHERE id = p_package_id AND org_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_NOT_FOUND_IN_ORG');
  END IF;

  FOR v_candidate IN SELECT * FROM jsonb_array_elements(COALESCE(p_candidates, '[]'::jsonb))
  LOOP
    v_expression_id := NULL;
    v_expression_key := v_candidate->>'expression_key';
    v_source_claim_id := NULLIF(v_candidate->>'source_claim_id', '')::uuid;
    v_source_package_effective_claim_id := NULLIF(v_candidate->>'source_package_effective_claim_id', '')::uuid;

    SELECT registry_hash INTO v_registry_hash
      FROM public.lease_date_expression_registry_versions
     WHERE registry_version = v_candidate->>'registry_version';
    IF v_registry_hash IS NULL OR v_registry_hash IS DISTINCT FROM v_candidate->>'registry_hash' THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'DATE_EXPRESSION_REGISTRY_MISMATCH');
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.lease_date_expression_types
       WHERE registry_version = v_candidate->>'registry_version'
         AND expression_type = v_candidate->>'expression_type'
    ) THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'DATE_EXPRESSION_TYPE_INVALID');
    END IF;

    IF v_candidate->>'origin_type' = 'extracted'
       AND v_source_claim_id IS NULL
       AND NOT (v_candidate ? 'source_claim_links' AND jsonb_typeof(v_candidate->'source_claim_links') = 'array' AND jsonb_array_length(v_candidate->'source_claim_links') > 0)
    THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'DATE_EXPRESSION_SOURCE_CLAIM_MISSING');
    END IF;

    IF v_source_claim_id IS NOT NULL THEN
      SELECT * INTO v_source_claim FROM public.lease_claims WHERE id = v_source_claim_id AND org_id = p_org_id;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'DATE_EXPRESSION_SOURCE_CLAIM_MISSING');
      END IF;
      IF p_package_id IS NULL AND (
        v_source_claim.uploaded_file_id IS DISTINCT FROM p_uploaded_file_id
        OR v_source_claim.extraction_run_id IS DISTINCT FROM p_extraction_run_id
        OR v_source_claim.generation_id IS DISTINCT FROM p_generation_id
      ) THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'DATE_EXPRESSION_SOURCE_MISMATCH');
      END IF;
      IF p_package_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.lease_package_documents
         WHERE org_id = p_org_id
           AND package_id = p_package_id
           AND uploaded_file_id = v_source_claim.uploaded_file_id
           AND extraction_run_id = v_source_claim.extraction_run_id
           AND generation_id = v_source_claim.generation_id
           AND membership_status = 'confirmed'
      ) THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'DATE_EXPRESSION_SOURCE_MISMATCH');
      END IF;
    END IF;

    IF v_source_package_effective_claim_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.lease_package_effective_claims
       WHERE id = v_source_package_effective_claim_id
         AND org_id = p_org_id
         AND (p_package_id IS NULL OR package_id = p_package_id)
    ) THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'DATE_EXPRESSION_SOURCE_MISMATCH');
    END IF;

    v_explicit_date := NULLIF(v_candidate->>'explicit_date', '')::date;

    INSERT INTO public.lease_date_expressions (
      org_id, lease_id, package_id, uploaded_file_id, extraction_run_id,
      generation_id, source_package_document_id, source_package_effective_claim_id,
      source_claim_id, concept_key, scope_key, instance_key, expression_type,
      expression_status, origin_type, expression_key, explicit_date, event_key,
      anchor_concept_key, anchor_expression_id, offset_value, offset_unit,
      offset_direction, business_day_rule, operands, recurrence_definition,
      condition_definition, normalized_expression, derivation_definition,
      calculation_formula_key, calculation_version, confidence, producer_type,
      producer_name, producer_version, extraction_stage_run_id,
      provider_invocation_id, registry_version, registry_hash,
      validation_status, validation_errors
    ) VALUES (
      p_org_id, p_lease_id, p_package_id, p_uploaded_file_id, p_extraction_run_id,
      p_generation_id, NULLIF(v_candidate->>'source_package_document_id', '')::uuid,
      v_source_package_effective_claim_id, v_source_claim_id,
      v_candidate->>'concept_key',
      COALESCE(v_candidate->>'scope_key', 'lease'),
      COALESCE(v_candidate->>'instance_key', 'default'),
      v_candidate->>'expression_type',
      v_candidate->>'expression_status',
      v_candidate->>'origin_type',
      v_expression_key,
      v_explicit_date,
      NULLIF(v_candidate->>'event_key', ''),
      NULLIF(v_candidate->>'anchor_concept_key', ''),
      NULLIF(v_candidate->>'anchor_expression_id', '')::uuid,
      NULLIF(v_candidate->>'offset_value', '')::numeric,
      NULLIF(v_candidate->>'offset_unit', ''),
      NULLIF(v_candidate->>'offset_direction', ''),
      NULLIF(v_candidate->>'business_day_rule', ''),
      v_candidate->'operands',
      v_candidate->'recurrence_definition',
      v_candidate->'condition_definition',
      COALESCE(v_candidate->'normalized_expression', '{}'::jsonb),
      v_candidate->'derivation_definition',
      NULLIF(v_candidate->>'calculation_formula_key', ''),
      NULLIF(v_candidate->>'calculation_version', ''),
      NULLIF(v_candidate->>'confidence', '')::numeric,
      v_candidate->>'producer_type',
      COALESCE(NULLIF(v_candidate->>'producer_name', ''), 'p4.1_date_expression_foundation'),
      NULLIF(v_candidate->>'producer_version', ''),
      NULLIF(v_candidate->>'extraction_stage_run_id', '')::uuid,
      NULLIF(v_candidate->>'provider_invocation_id', '')::uuid,
      v_candidate->>'registry_version',
      v_candidate->>'registry_hash',
      COALESCE(NULLIF(v_candidate->>'validation_status', ''), 'pending'),
      CASE WHEN v_candidate ? 'validation_errors' AND jsonb_typeof(v_candidate->'validation_errors') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(v_candidate->'validation_errors'))
           ELSE '{}'::text[] END
    )
    ON CONFLICT (org_id, expression_key) DO NOTHING
    RETURNING id INTO v_expression_id;

    IF v_expression_id IS NULL THEN
      SELECT id INTO v_expression_id
        FROM public.lease_date_expressions
       WHERE org_id = p_org_id AND expression_key = v_expression_key;
      v_already_existed := v_already_existed + 1;
    ELSE
      v_inserted := v_inserted + 1;
    END IF;

    IF v_source_claim_id IS NOT NULL THEN
      INSERT INTO public.lease_date_expression_claim_links (
        org_id, date_expression_id, source_claim_id,
        source_package_effective_claim_id, link_role
      ) VALUES (
        p_org_id, v_expression_id, v_source_claim_id,
        v_source_package_effective_claim_id, 'primary_source'
      )
      ON CONFLICT (date_expression_id, source_claim_id, link_role) DO NOTHING;
      v_links_inserted := v_links_inserted + 1;
    END IF;

    IF v_candidate ? 'source_claim_links' AND jsonb_typeof(v_candidate->'source_claim_links') = 'array' THEN
      FOR v_link IN SELECT * FROM jsonb_array_elements(v_candidate->'source_claim_links')
      LOOP
        v_source_claim_id := NULLIF(v_link->>'source_claim_id', '')::uuid;
        v_source_package_effective_claim_id := NULLIF(v_link->>'source_package_effective_claim_id', '')::uuid;
        IF v_source_claim_id IS NULL THEN
          RETURN jsonb_build_object('success', false, 'error_code', 'DATE_EXPRESSION_SOURCE_CLAIM_MISSING');
        END IF;
        SELECT * INTO v_source_claim FROM public.lease_claims WHERE id = v_source_claim_id AND org_id = p_org_id;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('success', false, 'error_code', 'DATE_EXPRESSION_SOURCE_CLAIM_MISSING');
        END IF;
        IF p_package_id IS NULL AND (
          v_source_claim.uploaded_file_id IS DISTINCT FROM p_uploaded_file_id
          OR v_source_claim.extraction_run_id IS DISTINCT FROM p_extraction_run_id
          OR v_source_claim.generation_id IS DISTINCT FROM p_generation_id
        ) THEN
          RETURN jsonb_build_object('success', false, 'error_code', 'DATE_EXPRESSION_SOURCE_MISMATCH');
        END IF;
        INSERT INTO public.lease_date_expression_claim_links (
          org_id, date_expression_id, source_claim_id,
          source_package_effective_claim_id, link_role
        ) VALUES (
          p_org_id, v_expression_id, v_source_claim_id,
          v_source_package_effective_claim_id,
          COALESCE(NULLIF(v_link->>'link_role', ''), 'primary_source')
        )
        ON CONFLICT (date_expression_id, source_claim_id, link_role) DO NOTHING;
        v_links_inserted := v_links_inserted + 1;
      END LOOP;
    END IF;

    v_result_map := v_result_map || jsonb_build_object(v_expression_key, v_expression_id::text);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'expressions_inserted', v_inserted,
    'expressions_already_existed', v_already_existed,
    'links_processed', v_links_inserted,
    'expression_id_map', v_result_map
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_date_expression_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.persist_lease_date_expression_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.record_lease_date_expression_review_decision(
  p_org_id UUID,
  p_date_expression_id UUID,
  p_operation TEXT,
  p_replacement_expression JSONB DEFAULT NULL,
  p_reason TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_actor_email TEXT;
  v_decision_id UUID;
  v_key TEXT := COALESCE(NULLIF(p_idempotency_key, ''), gen_random_uuid()::text);
BEGIN
  IF v_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_AUTHENTICATED');
  END IF;
  IF NOT public.is_member_of_org(p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.lease_date_expressions
     WHERE id = p_date_expression_id AND org_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'DATE_EXPRESSION_NOT_FOUND');
  END IF;
  IF p_operation = 'replace_expression' AND p_replacement_expression IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'REPLACEMENT_EXPRESSION_REQUIRED');
  END IF;

  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;

  INSERT INTO public.lease_date_expression_reviewer_decisions (
    org_id, date_expression_id, operation, replacement_expression,
    idempotency_key, actor_user_id, actor_email, reason
  ) VALUES (
    p_org_id, p_date_expression_id, p_operation, p_replacement_expression,
    v_key, v_actor_user_id, v_actor_email, p_reason
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_decision_id;

  IF v_decision_id IS NULL THEN
    SELECT id INTO v_decision_id
      FROM public.lease_date_expression_reviewer_decisions
     WHERE org_id = p_org_id AND idempotency_key = v_key;
  END IF;

  RETURN jsonb_build_object('success', true, 'review_decision_id', v_decision_id);
END;
$$;

REVOKE ALL ON FUNCTION public.record_lease_date_expression_review_decision(UUID, UUID, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_lease_date_expression_review_decision(UUID, UUID, TEXT, JSONB, TEXT, TEXT) TO authenticated, service_role;
