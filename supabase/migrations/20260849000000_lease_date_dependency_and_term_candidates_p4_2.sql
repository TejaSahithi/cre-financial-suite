-- P4.2 - immutable date-expression dependency graph and lease-term candidates.
--
-- This migration stops before deterministic date resolution. It does not
-- calculate commencement or expiration dates, expand recurring deadlines,
-- create rent schedules, generate critical dates, write extraction_data or
-- workflow_output, modify parser/model/provider routing, or change finalizer
-- and readiness behavior. LEASE_FINANCIAL_SCHEDULE_MODE remains the only
-- financial schedule feature flag and defaults off in runtime code.

CREATE TABLE public.lease_date_expression_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID,
  package_id UUID,
  uploaded_file_id UUID NOT NULL,
  extraction_run_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  source_expression_id UUID NOT NULL,
  target_expression_id UUID,
  dependency_type TEXT NOT NULL CHECK (dependency_type IN (
    'anchor', 'offset_anchor', 'event_anchor', 'alternative', 'condition',
    'minimum_operand', 'maximum_operand', 'earlier_of_operand', 'later_of_operand',
    'recurrence_anchor', 'notice_anchor', 'term_start', 'term_end', 'resolves',
    'supersedes_expression', 'contextual'
  )),
  dependency_status TEXT NOT NULL CHECK (dependency_status IN (
    'proposed', 'valid', 'ambiguous', 'needs_review',
    'requires_related_document', 'invalid', 'superseded'
  )),
  dependency_key TEXT NOT NULL,
  operand_role TEXT,
  operand_order INT CHECK (operand_order IS NULL OR operand_order >= 1),
  condition_key TEXT,
  source_claim_id UUID,
  source_package_effective_claim_id UUID,
  related_document_requirement_id UUID,
  producer_type TEXT NOT NULL CHECK (producer_type IN (
    'deterministic_mapper', 'semantic_extractor', 'validation_engine',
    'legacy_adapter', 'reviewer', 'system_projection'
  )),
  producer_name TEXT NOT NULL,
  producer_version TEXT,
  dependency_contract_version TEXT NOT NULL DEFAULT 'lease-date-dependencies-v1',
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'valid', 'invalid', 'needs_review')),
  validation_errors TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, dependency_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id)
    REFERENCES public.extraction_runs (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id)
    REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (related_document_requirement_id, org_id)
    REFERENCES public.lease_related_document_requirements (id, org_id) ON DELETE RESTRICT,

  CHECK (source_expression_id IS DISTINCT FROM target_expression_id),
  CHECK (char_length(dependency_key) BETWEEN 1 AND 600),
  CHECK (char_length(producer_name) BETWEEN 1 AND 200),
  CHECK (producer_version IS NULL OR char_length(producer_version) <= 200),
  CHECK (dependency_contract_version = 'lease-date-dependencies-v1'),
  CHECK (array_length(validation_errors, 1) IS NULL OR array_length(validation_errors, 1) <= 50),
  CHECK (octet_length(metadata::text) <= 20000),
  CHECK (target_expression_id IS NOT NULL OR dependency_status = 'requires_related_document'),
  CHECK (dependency_status <> 'valid' OR target_expression_id IS NOT NULL),
  CHECK (dependency_status <> 'requires_related_document' OR related_document_requirement_id IS NOT NULL),
  CHECK (dependency_type NOT IN ('minimum_operand', 'maximum_operand', 'earlier_of_operand', 'later_of_operand', 'alternative') OR operand_order IS NOT NULL)
);

CREATE INDEX idx_lease_date_expression_dependencies_org_file
  ON public.lease_date_expression_dependencies (org_id, uploaded_file_id);
CREATE INDEX idx_lease_date_expression_dependencies_source
  ON public.lease_date_expression_dependencies (org_id, source_expression_id);
CREATE INDEX idx_lease_date_expression_dependencies_target
  ON public.lease_date_expression_dependencies (org_id, target_expression_id) WHERE target_expression_id IS NOT NULL;
CREATE INDEX idx_lease_date_expression_dependencies_package
  ON public.lease_date_expression_dependencies (org_id, package_id) WHERE package_id IS NOT NULL;

ALTER TABLE public.lease_date_expression_dependencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_date_expression_dependencies_org_select
  ON public.lease_date_expression_dependencies
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_date_expression_dependencies FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.validate_lease_date_expression_dependency_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source public.lease_date_expressions%ROWTYPE;
  v_target public.lease_date_expressions%ROWTYPE;
BEGIN
  SELECT * INTO v_source FROM public.lease_date_expressions
   WHERE id = NEW.source_expression_id AND org_id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DATE_DEPENDENCY_SOURCE_EXPRESSION_MISSING';
  END IF;
  IF v_source.uploaded_file_id IS DISTINCT FROM NEW.uploaded_file_id
     OR v_source.extraction_run_id IS DISTINCT FROM NEW.extraction_run_id
     OR v_source.generation_id IS DISTINCT FROM NEW.generation_id
     OR v_source.package_id IS DISTINCT FROM NEW.package_id
     OR v_source.lease_id IS DISTINCT FROM NEW.lease_id THEN
    RAISE EXCEPTION 'DATE_DEPENDENCY_CONTEXT_MISMATCH';
  END IF;

  IF NEW.target_expression_id IS NOT NULL THEN
    SELECT * INTO v_target FROM public.lease_date_expressions
     WHERE id = NEW.target_expression_id AND org_id = NEW.org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'DATE_DEPENDENCY_TARGET_EXPRESSION_MISSING';
    END IF;
    IF v_target.uploaded_file_id IS DISTINCT FROM NEW.uploaded_file_id
       OR v_target.extraction_run_id IS DISTINCT FROM NEW.extraction_run_id
       OR v_target.generation_id IS DISTINCT FROM NEW.generation_id
       OR v_target.package_id IS DISTINCT FROM NEW.package_id
       OR v_target.lease_id IS DISTINCT FROM NEW.lease_id THEN
      RAISE EXCEPTION 'DATE_DEPENDENCY_CONTEXT_MISMATCH';
    END IF;
    IF v_target.expression_status IN ('not_present', 'not_applicable', 'unreadable', 'extraction_failed') THEN
      RAISE EXCEPTION 'DATE_DEPENDENCY_STALE_TARGET';
    END IF;
    IF EXISTS (
      WITH RECURSIVE dependency_path AS (
        SELECT d.source_expression_id, d.target_expression_id
          FROM public.lease_date_expression_dependencies d
         WHERE d.org_id = NEW.org_id
           AND d.source_expression_id = NEW.target_expression_id
           AND d.target_expression_id IS NOT NULL
           AND d.dependency_status NOT IN ('invalid', 'superseded')
        UNION
        SELECT d.source_expression_id, d.target_expression_id
          FROM public.lease_date_expression_dependencies d
          JOIN dependency_path p
            ON d.source_expression_id = p.target_expression_id
         WHERE d.org_id = NEW.org_id
           AND d.target_expression_id IS NOT NULL
           AND d.dependency_status NOT IN ('invalid', 'superseded')
      )
      SELECT 1 FROM dependency_path WHERE target_expression_id = NEW.source_expression_id
    ) THEN
      RAISE EXCEPTION 'DATE_DEPENDENCY_CYCLE';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_lease_date_expression_dependency_insert
  BEFORE INSERT ON public.lease_date_expression_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.validate_lease_date_expression_dependency_insert();

CREATE OR REPLACE FUNCTION public.enforce_lease_date_expression_dependency_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lease_date_expression_dependencies rows are immutable';
  END IF;
  IF NEW.lease_id IS NULL AND OLD.lease_id IS NOT NULL
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     AND NEW.package_id IS NOT DISTINCT FROM OLD.package_id
     AND NEW.uploaded_file_id IS NOT DISTINCT FROM OLD.uploaded_file_id
     AND NEW.extraction_run_id IS NOT DISTINCT FROM OLD.extraction_run_id
     AND NEW.generation_id IS NOT DISTINCT FROM OLD.generation_id
     AND NEW.source_expression_id IS NOT DISTINCT FROM OLD.source_expression_id
     AND NEW.target_expression_id IS NOT DISTINCT FROM OLD.target_expression_id
     AND NEW.dependency_key IS NOT DISTINCT FROM OLD.dependency_key
     AND NEW.dependency_type IS NOT DISTINCT FROM OLD.dependency_type THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'lease_date_expression_dependencies rows are immutable; create a new dependency or reviewer decision instead (dependency %)', OLD.id;
END;
$$;

CREATE TRIGGER trg_enforce_lease_date_expression_dependency_immutability
  BEFORE UPDATE OR DELETE ON public.lease_date_expression_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_date_expression_dependency_immutability();

CREATE TABLE public.lease_date_dependency_reviewer_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  dependency_id UUID NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'accept', 'reject', 'replace', 'select_ambiguous_anchor',
    'mark_requires_related_document', 'reopen'
  )),
  replacement_dependency JSONB,
  selected_target_expression_id UUID,
  related_document_requirement_id UUID,
  idempotency_key TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  actor_email TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (dependency_id, org_id) REFERENCES public.lease_date_expression_dependencies (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (selected_target_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (related_document_requirement_id, org_id)
    REFERENCES public.lease_related_document_requirements (id, org_id) ON DELETE RESTRICT,
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 600),
  CHECK (reason IS NULL OR char_length(reason) <= 2000),
  CHECK (replacement_dependency IS NULL OR octet_length(replacement_dependency::text) <= 20000),
  CHECK (operation <> 'replace' OR replacement_dependency IS NOT NULL),
  CHECK (operation <> 'select_ambiguous_anchor' OR selected_target_expression_id IS NOT NULL),
  CHECK (operation <> 'mark_requires_related_document' OR related_document_requirement_id IS NOT NULL)
);

CREATE INDEX idx_lease_date_dependency_reviewer_decisions_dependency
  ON public.lease_date_dependency_reviewer_decisions (org_id, dependency_id);

ALTER TABLE public.lease_date_dependency_reviewer_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_date_dependency_reviewer_decisions_org_select
  ON public.lease_date_dependency_reviewer_decisions
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_date_dependency_reviewer_decisions FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.reject_lease_date_dependency_review_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lease_date_dependency_reviewer_decisions rows are append-only';
END;
$$;

CREATE TRIGGER trg_reject_lease_date_dependency_review_update
  BEFORE UPDATE OR DELETE ON public.lease_date_dependency_reviewer_decisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_lease_date_dependency_review_update();

CREATE TABLE public.lease_term_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID,
  package_id UUID,
  uploaded_file_id UUID NOT NULL,
  extraction_run_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  source_package_document_id UUID,
  source_package_effective_claim_id UUID,
  start_expression_id UUID,
  end_expression_id UUID,
  related_document_requirement_id UUID,
  term_type TEXT NOT NULL CHECK (term_type IN (
    'initial_term', 'extension_term', 'renewal_term', 'option_term',
    'holdover_term', 'construction_period', 'rent_free_period',
    'partial_term', 'unknown_term'
  )),
  term_status TEXT NOT NULL CHECK (term_status IN (
    'proposed', 'valid', 'ambiguous', 'needs_review',
    'requires_related_document', 'invalid', 'superseded'
  )),
  origin_type TEXT NOT NULL CHECK (origin_type IN (
    'extracted', 'reviewer', 'derived', 'calculated', 'legacy_adapter',
    'system_projection'
  )),
  term_key TEXT NOT NULL,
  instance_key TEXT NOT NULL DEFAULT 'default',
  duration_value NUMERIC CHECK (duration_value IS NULL OR duration_value >= 0),
  duration_unit TEXT CHECK (duration_unit IS NULL OR duration_unit IN ('day', 'business_day', 'week', 'month', 'year')),
  duration_inclusive_rule TEXT CHECK (duration_inclusive_rule IS NULL OR duration_inclusive_rule IN ('exclusive_end', 'inclusive_end', 'source_defined', 'unknown')),
  sequence_number INT CHECK (sequence_number IS NULL OR sequence_number >= 1),
  parent_term_id UUID,
  option_exercise_required BOOLEAN,
  automatic_renewal BOOLEAN,
  confidence NUMERIC(5,4),
  producer_type TEXT NOT NULL CHECK (producer_type IN (
    'deterministic_mapper', 'semantic_extractor', 'validation_engine',
    'legacy_adapter', 'reviewer', 'system_projection'
  )),
  producer_name TEXT NOT NULL,
  producer_version TEXT,
  term_contract_version TEXT NOT NULL DEFAULT 'lease-term-candidates-v1',
  date_expression_registry_version TEXT NOT NULL DEFAULT 'lease-date-expressions-v1',
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'valid', 'invalid', 'needs_review')),
  validation_errors TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, term_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id)
    REFERENCES public.extraction_runs (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_document_id, package_id, org_id)
    REFERENCES public.lease_package_documents (id, package_id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id)
    REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (start_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (end_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (related_document_requirement_id, org_id)
    REFERENCES public.lease_related_document_requirements (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_term_id, org_id) REFERENCES public.lease_term_candidates (id, org_id) ON DELETE RESTRICT,

  CHECK (char_length(term_key) BETWEEN 1 AND 600),
  CHECK (char_length(instance_key) BETWEEN 1 AND 200),
  CHECK (char_length(producer_name) BETWEEN 1 AND 200),
  CHECK (producer_version IS NULL OR char_length(producer_version) <= 200),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (term_contract_version = 'lease-term-candidates-v1'),
  CHECK (date_expression_registry_version = 'lease-date-expressions-v1'),
  CHECK (array_length(validation_errors, 1) IS NULL OR array_length(validation_errors, 1) <= 50),
  CHECK (octet_length(metadata::text) <= 20000),
  CHECK ((duration_value IS NULL AND duration_unit IS NULL) OR (duration_value IS NOT NULL AND duration_unit IS NOT NULL)),
  CHECK (term_status <> 'requires_related_document' OR related_document_requirement_id IS NOT NULL),
  CHECK (NOT (metadata ? 'resolved_date')),
  CHECK (NOT (metadata ? 'calculated_date')),
  CHECK (NOT (metadata ? 'rent_schedule')),
  CHECK (NOT (metadata ? 'critical_dates'))
);

CREATE INDEX idx_lease_term_candidates_org_file ON public.lease_term_candidates (org_id, uploaded_file_id);
CREATE INDEX idx_lease_term_candidates_package ON public.lease_term_candidates (org_id, package_id) WHERE package_id IS NOT NULL;
CREATE INDEX idx_lease_term_candidates_start_expression ON public.lease_term_candidates (org_id, start_expression_id) WHERE start_expression_id IS NOT NULL;
CREATE INDEX idx_lease_term_candidates_end_expression ON public.lease_term_candidates (org_id, end_expression_id) WHERE end_expression_id IS NOT NULL;

ALTER TABLE public.lease_term_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_term_candidates_org_select
  ON public.lease_term_candidates
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_term_candidates FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.validate_lease_term_candidate_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expression public.lease_date_expressions%ROWTYPE;
BEGIN
  FOR v_expression IN
    SELECT * FROM public.lease_date_expressions
     WHERE org_id = NEW.org_id
       AND id IN (NEW.start_expression_id, NEW.end_expression_id)
  LOOP
    IF v_expression.uploaded_file_id IS DISTINCT FROM NEW.uploaded_file_id
       OR v_expression.extraction_run_id IS DISTINCT FROM NEW.extraction_run_id
       OR v_expression.generation_id IS DISTINCT FROM NEW.generation_id
       OR v_expression.package_id IS DISTINCT FROM NEW.package_id
       OR v_expression.lease_id IS DISTINCT FROM NEW.lease_id THEN
      RAISE EXCEPTION 'LEASE_TERM_EXPRESSION_CONTEXT_MISMATCH';
    END IF;
  END LOOP;
  IF NEW.start_expression_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.lease_date_expressions WHERE id = NEW.start_expression_id AND org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'LEASE_TERM_START_EXPRESSION_MISSING';
  END IF;
  IF NEW.end_expression_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.lease_date_expressions WHERE id = NEW.end_expression_id AND org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'LEASE_TERM_END_EXPRESSION_MISSING';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_lease_term_candidate_insert
  BEFORE INSERT ON public.lease_term_candidates
  FOR EACH ROW EXECUTE FUNCTION public.validate_lease_term_candidate_insert();

CREATE OR REPLACE FUNCTION public.enforce_lease_term_candidate_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lease_term_candidates rows are immutable';
  END IF;
  IF NEW.lease_id IS NULL AND OLD.lease_id IS NOT NULL
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     AND NEW.package_id IS NOT DISTINCT FROM OLD.package_id
     AND NEW.uploaded_file_id IS NOT DISTINCT FROM OLD.uploaded_file_id
     AND NEW.extraction_run_id IS NOT DISTINCT FROM OLD.extraction_run_id
     AND NEW.generation_id IS NOT DISTINCT FROM OLD.generation_id
     AND NEW.term_key IS NOT DISTINCT FROM OLD.term_key
     AND NEW.term_type IS NOT DISTINCT FROM OLD.term_type THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'lease_term_candidates rows are immutable; create a new candidate or reviewer decision instead (term %)', OLD.id;
END;
$$;

CREATE TRIGGER trg_enforce_lease_term_candidate_immutability
  BEFORE UPDATE OR DELETE ON public.lease_term_candidates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_term_candidate_immutability();

CREATE TABLE public.lease_term_reviewer_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  term_candidate_id UUID NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'accept', 'reject', 'replace', 'mark_requires_related_document', 'reopen'
  )),
  replacement_term JSONB,
  related_document_requirement_id UUID,
  idempotency_key TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  actor_email TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (term_candidate_id, org_id) REFERENCES public.lease_term_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (related_document_requirement_id, org_id)
    REFERENCES public.lease_related_document_requirements (id, org_id) ON DELETE RESTRICT,
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 600),
  CHECK (reason IS NULL OR char_length(reason) <= 2000),
  CHECK (replacement_term IS NULL OR octet_length(replacement_term::text) <= 20000),
  CHECK (operation <> 'replace' OR replacement_term IS NOT NULL),
  CHECK (operation <> 'mark_requires_related_document' OR related_document_requirement_id IS NOT NULL)
);

CREATE INDEX idx_lease_term_reviewer_decisions_term
  ON public.lease_term_reviewer_decisions (org_id, term_candidate_id);

ALTER TABLE public.lease_term_reviewer_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_term_reviewer_decisions_org_select
  ON public.lease_term_reviewer_decisions
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_term_reviewer_decisions FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.reject_lease_term_review_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lease_term_reviewer_decisions rows are append-only';
END;
$$;

CREATE TRIGGER trg_reject_lease_term_review_update
  BEFORE UPDATE OR DELETE ON public.lease_term_reviewer_decisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_lease_term_review_update();

CREATE OR REPLACE FUNCTION public.persist_lease_date_expression_dependencies(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_lease_id UUID,
  p_package_id UUID,
  p_extraction_run_id UUID,
  p_generation_id UUID,
  p_dependencies JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active_generation_id UUID;
  v_dependency JSONB;
  v_count INT;
  v_dependency_id UUID;
  v_dependency_key TEXT;
  v_inserted INT := 0;
  v_already_existed INT := 0;
  v_result_map JSONB := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SERVICE_ROLE_ONLY');
  END IF;
  IF jsonb_typeof(COALESCE(p_dependencies, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'DEPENDENCIES_MUST_BE_ARRAY');
  END IF;
  v_count := jsonb_array_length(COALESCE(p_dependencies, '[]'::jsonb));
  IF v_count > 100 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'BATCH_TOO_LARGE');
  END IF;
  SELECT active_generation_id INTO v_active_generation_id
    FROM public.uploaded_files WHERE id = p_uploaded_file_id AND org_id = p_org_id;
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

  FOR v_dependency IN SELECT * FROM jsonb_array_elements(COALESCE(p_dependencies, '[]'::jsonb))
  LOOP
    v_dependency_id := NULL;
    v_dependency_key := v_dependency->>'dependency_key';
    BEGIN
      INSERT INTO public.lease_date_expression_dependencies (
        org_id, lease_id, package_id, uploaded_file_id, extraction_run_id,
        generation_id, source_expression_id, target_expression_id, dependency_type,
        dependency_status, dependency_key, operand_role, operand_order, condition_key,
        source_claim_id, source_package_effective_claim_id, related_document_requirement_id,
        producer_type, producer_name, producer_version, dependency_contract_version,
        validation_status, validation_errors, metadata
      ) VALUES (
        p_org_id, p_lease_id, p_package_id, p_uploaded_file_id, p_extraction_run_id,
        p_generation_id, (v_dependency->>'source_expression_id')::uuid,
        NULLIF(v_dependency->>'target_expression_id', '')::uuid,
        v_dependency->>'dependency_type',
        v_dependency->>'dependency_status',
        v_dependency_key,
        NULLIF(v_dependency->>'operand_role', ''),
        NULLIF(v_dependency->>'operand_order', '')::int,
        NULLIF(v_dependency->>'condition_key', ''),
        NULLIF(v_dependency->>'source_claim_id', '')::uuid,
        NULLIF(v_dependency->>'source_package_effective_claim_id', '')::uuid,
        NULLIF(v_dependency->>'related_document_requirement_id', '')::uuid,
        v_dependency->>'producer_type',
        COALESCE(NULLIF(v_dependency->>'producer_name', ''), 'p4.2_date_dependency_graph'),
        NULLIF(v_dependency->>'producer_version', ''),
        COALESCE(NULLIF(v_dependency->>'dependency_contract_version', ''), 'lease-date-dependencies-v1'),
        COALESCE(NULLIF(v_dependency->>'validation_status', ''), 'pending'),
        CASE WHEN v_dependency ? 'validation_errors' AND jsonb_typeof(v_dependency->'validation_errors') = 'array'
             THEN ARRAY(SELECT jsonb_array_elements_text(v_dependency->'validation_errors'))
             ELSE '{}'::text[] END,
        COALESCE(v_dependency->'metadata', '{}'::jsonb)
      )
      ON CONFLICT (org_id, dependency_key) DO NOTHING
      RETURNING id INTO v_dependency_id;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error_code', SQLERRM);
    END;

    IF v_dependency_id IS NULL THEN
      SELECT id INTO v_dependency_id
        FROM public.lease_date_expression_dependencies
       WHERE org_id = p_org_id AND dependency_key = v_dependency_key;
      v_already_existed := v_already_existed + 1;
    ELSE
      v_inserted := v_inserted + 1;
    END IF;
    v_result_map := v_result_map || jsonb_build_object(v_dependency_key, v_dependency_id::text);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'dependencies_inserted', v_inserted,
    'dependencies_already_existed', v_already_existed,
    'dependency_id_map', v_result_map
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_date_expression_dependencies(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.persist_lease_date_expression_dependencies(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.persist_lease_term_candidates(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_lease_id UUID,
  p_package_id UUID,
  p_extraction_run_id UUID,
  p_generation_id UUID,
  p_terms JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active_generation_id UUID;
  v_term JSONB;
  v_count INT;
  v_term_id UUID;
  v_term_key TEXT;
  v_inserted INT := 0;
  v_already_existed INT := 0;
  v_result_map JSONB := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SERVICE_ROLE_ONLY');
  END IF;
  IF jsonb_typeof(COALESCE(p_terms, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'TERMS_MUST_BE_ARRAY');
  END IF;
  v_count := jsonb_array_length(COALESCE(p_terms, '[]'::jsonb));
  IF v_count > 100 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'BATCH_TOO_LARGE');
  END IF;
  SELECT active_generation_id INTO v_active_generation_id
    FROM public.uploaded_files WHERE id = p_uploaded_file_id AND org_id = p_org_id;
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

  FOR v_term IN SELECT * FROM jsonb_array_elements(COALESCE(p_terms, '[]'::jsonb))
  LOOP
    v_term_id := NULL;
    v_term_key := v_term->>'term_key';
    BEGIN
      INSERT INTO public.lease_term_candidates (
        org_id, lease_id, package_id, uploaded_file_id, extraction_run_id,
        generation_id, source_package_document_id, source_package_effective_claim_id,
        start_expression_id, end_expression_id, related_document_requirement_id,
        term_type, term_status, origin_type, term_key, instance_key,
        duration_value, duration_unit, duration_inclusive_rule, sequence_number,
        parent_term_id, option_exercise_required, automatic_renewal, confidence,
        producer_type, producer_name, producer_version, term_contract_version,
        date_expression_registry_version, validation_status, validation_errors, metadata
      ) VALUES (
        p_org_id, p_lease_id, p_package_id, p_uploaded_file_id, p_extraction_run_id,
        p_generation_id, NULLIF(v_term->>'source_package_document_id', '')::uuid,
        NULLIF(v_term->>'source_package_effective_claim_id', '')::uuid,
        NULLIF(v_term->>'start_expression_id', '')::uuid,
        NULLIF(v_term->>'end_expression_id', '')::uuid,
        NULLIF(v_term->>'related_document_requirement_id', '')::uuid,
        v_term->>'term_type',
        v_term->>'term_status',
        v_term->>'origin_type',
        v_term_key,
        COALESCE(NULLIF(v_term->>'instance_key', ''), 'default'),
        NULLIF(v_term->>'duration_value', '')::numeric,
        NULLIF(v_term->>'duration_unit', ''),
        NULLIF(v_term->>'duration_inclusive_rule', ''),
        NULLIF(v_term->>'sequence_number', '')::int,
        NULLIF(v_term->>'parent_term_id', '')::uuid,
        NULLIF(v_term->>'option_exercise_required', '')::boolean,
        NULLIF(v_term->>'automatic_renewal', '')::boolean,
        NULLIF(v_term->>'confidence', '')::numeric,
        v_term->>'producer_type',
        COALESCE(NULLIF(v_term->>'producer_name', ''), 'p4.2_lease_term_candidates'),
        NULLIF(v_term->>'producer_version', ''),
        COALESCE(NULLIF(v_term->>'term_contract_version', ''), 'lease-term-candidates-v1'),
        COALESCE(NULLIF(v_term->>'date_expression_registry_version', ''), 'lease-date-expressions-v1'),
        COALESCE(NULLIF(v_term->>'validation_status', ''), 'pending'),
        CASE WHEN v_term ? 'validation_errors' AND jsonb_typeof(v_term->'validation_errors') = 'array'
             THEN ARRAY(SELECT jsonb_array_elements_text(v_term->'validation_errors'))
             ELSE '{}'::text[] END,
        COALESCE(v_term->'metadata', '{}'::jsonb)
      )
      ON CONFLICT (org_id, term_key) DO NOTHING
      RETURNING id INTO v_term_id;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error_code', SQLERRM);
    END;

    IF v_term_id IS NULL THEN
      SELECT id INTO v_term_id
        FROM public.lease_term_candidates
       WHERE org_id = p_org_id AND term_key = v_term_key;
      v_already_existed := v_already_existed + 1;
    ELSE
      v_inserted := v_inserted + 1;
    END IF;
    v_result_map := v_result_map || jsonb_build_object(v_term_key, v_term_id::text);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'terms_inserted', v_inserted,
    'terms_already_existed', v_already_existed,
    'term_id_map', v_result_map
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_term_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.persist_lease_term_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.record_lease_date_dependency_review_decision(
  p_org_id UUID,
  p_dependency_id UUID,
  p_operation TEXT,
  p_replacement_dependency JSONB DEFAULT NULL,
  p_selected_target_expression_id UUID DEFAULT NULL,
  p_related_document_requirement_id UUID DEFAULT NULL,
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
  v_dependency RECORD;
  v_decision_id UUID;
  v_key TEXT := COALESCE(NULLIF(p_idempotency_key, ''), gen_random_uuid()::text);
BEGIN
  IF v_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_AUTHENTICATED');
  END IF;
  IF NOT public.is_member_of_org(p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
  END IF;
  IF p_operation NOT IN ('accept', 'reject', 'replace', 'select_ambiguous_anchor', 'mark_requires_related_document', 'reopen') THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_OPERATION');
  END IF;
  SELECT * INTO v_dependency FROM public.lease_date_expression_dependencies
   WHERE id = p_dependency_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'DATE_DEPENDENCY_NOT_FOUND');
  END IF;
  IF v_dependency.generation_id IS DISTINCT FROM (
    SELECT active_generation_id FROM public.uploaded_files
     WHERE id = v_dependency.uploaded_file_id AND org_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'STALE_GENERATION');
  END IF;
  IF p_operation = 'replace' AND p_replacement_dependency IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'REPLACEMENT_DEPENDENCY_REQUIRED');
  END IF;
  IF p_operation = 'select_ambiguous_anchor' AND p_selected_target_expression_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SELECTED_TARGET_REQUIRED');
  END IF;
  IF p_operation = 'mark_requires_related_document' AND p_related_document_requirement_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'RELATED_DOCUMENT_REQUIREMENT_REQUIRED');
  END IF;

  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;
  INSERT INTO public.lease_date_dependency_reviewer_decisions (
    org_id, dependency_id, operation, replacement_dependency,
    selected_target_expression_id, related_document_requirement_id,
    idempotency_key, actor_user_id, actor_email, reason
  ) VALUES (
    p_org_id, p_dependency_id, p_operation, p_replacement_dependency,
    p_selected_target_expression_id, p_related_document_requirement_id,
    v_key, v_actor_user_id, v_actor_email, p_reason
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_decision_id;

  IF v_decision_id IS NULL THEN
    SELECT id INTO v_decision_id
      FROM public.lease_date_dependency_reviewer_decisions
     WHERE org_id = p_org_id AND idempotency_key = v_key;
  END IF;

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, actor_role, severity, source, after, metadata)
  VALUES (
    p_org_id, 'lease_date_expression_dependencies', p_dependency_id::text, 'review',
    v_actor_user_id, v_actor_email, 'reviewer', 'info', 'edge_function',
    jsonb_build_object('operation', p_operation, 'review_decision_id', v_decision_id),
    jsonb_build_object('idempotency_key', v_key, 'reason', p_reason)
  );

  RETURN jsonb_build_object('success', true, 'review_decision_id', v_decision_id);
END;
$$;

REVOKE ALL ON FUNCTION public.record_lease_date_dependency_review_decision(UUID, UUID, TEXT, JSONB, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_lease_date_dependency_review_decision(UUID, UUID, TEXT, JSONB, UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_lease_term_review_decision(
  p_org_id UUID,
  p_term_candidate_id UUID,
  p_operation TEXT,
  p_replacement_term JSONB DEFAULT NULL,
  p_related_document_requirement_id UUID DEFAULT NULL,
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
  v_term RECORD;
  v_decision_id UUID;
  v_key TEXT := COALESCE(NULLIF(p_idempotency_key, ''), gen_random_uuid()::text);
BEGIN
  IF v_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_AUTHENTICATED');
  END IF;
  IF NOT public.is_member_of_org(p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
  END IF;
  IF p_operation NOT IN ('accept', 'reject', 'replace', 'mark_requires_related_document', 'reopen') THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_OPERATION');
  END IF;
  SELECT * INTO v_term FROM public.lease_term_candidates
   WHERE id = p_term_candidate_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'LEASE_TERM_NOT_FOUND');
  END IF;
  IF v_term.generation_id IS DISTINCT FROM (
    SELECT active_generation_id FROM public.uploaded_files
     WHERE id = v_term.uploaded_file_id AND org_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'STALE_GENERATION');
  END IF;
  IF p_operation = 'replace' AND p_replacement_term IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'REPLACEMENT_TERM_REQUIRED');
  END IF;
  IF p_operation = 'mark_requires_related_document' AND p_related_document_requirement_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'RELATED_DOCUMENT_REQUIREMENT_REQUIRED');
  END IF;

  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;
  INSERT INTO public.lease_term_reviewer_decisions (
    org_id, term_candidate_id, operation, replacement_term,
    related_document_requirement_id, idempotency_key, actor_user_id,
    actor_email, reason
  ) VALUES (
    p_org_id, p_term_candidate_id, p_operation, p_replacement_term,
    p_related_document_requirement_id, v_key, v_actor_user_id,
    v_actor_email, p_reason
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_decision_id;

  IF v_decision_id IS NULL THEN
    SELECT id INTO v_decision_id
      FROM public.lease_term_reviewer_decisions
     WHERE org_id = p_org_id AND idempotency_key = v_key;
  END IF;

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, actor_role, severity, source, after, metadata)
  VALUES (
    p_org_id, 'lease_term_candidates', p_term_candidate_id::text, 'review',
    v_actor_user_id, v_actor_email, 'reviewer', 'info', 'edge_function',
    jsonb_build_object('operation', p_operation, 'review_decision_id', v_decision_id),
    jsonb_build_object('idempotency_key', v_key, 'reason', p_reason)
  );

  RETURN jsonb_build_object('success', true, 'review_decision_id', v_decision_id);
END;
$$;

REVOKE ALL ON FUNCTION public.record_lease_term_review_decision(UUID, UUID, TEXT, JSONB, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_lease_term_review_decision(UUID, UUID, TEXT, JSONB, UUID, TEXT, TEXT) TO authenticated, service_role;
