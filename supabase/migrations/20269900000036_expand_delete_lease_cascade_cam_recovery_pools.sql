-- Expand delete_lease_cascade RPC to include CAM Engine v2 multipool tables
-- specifically recovery_pool_lease_participants and all CAM pool / calculation tables.

CREATE OR REPLACE FUNCTION public.delete_lease_cascade(
  target_lease_id UUID,
  p_actor_user_id UUID DEFAULT NULL,
  p_actor_email TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  delete_step RECORD;
  child_table TEXT;
  v_lease public.leases%ROWTYPE;
BEGIN
  IF target_lease_id IS NULL THEN
    RAISE EXCEPTION 'target_lease_id is required';
  END IF;

  SELECT * INTO v_lease
    FROM public.leases
   WHERE id = target_lease_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease not found';
  END IF;

  PERFORM set_config('app.allow_lease_cascade_delete', 'true', true);

  CREATE TEMP TABLE IF NOT EXISTS _lease_delete_file_ids (id UUID PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _lease_delete_extraction_run_ids (id UUID PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _lease_delete_di_run_ids (id UUID PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _lease_delete_package_ids (id UUID PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _lease_delete_family_ids (id UUID PRIMARY KEY) ON COMMIT DROP;

  TRUNCATE _lease_delete_file_ids;
  TRUNCATE _lease_delete_extraction_run_ids;
  TRUNCATE _lease_delete_di_run_ids;
  TRUNCATE _lease_delete_package_ids;
  TRUNCATE _lease_delete_family_ids;

  INSERT INTO _lease_delete_file_ids (id)
  SELECT v_lease.source_file_id
   WHERE v_lease.source_file_id IS NOT NULL
  ON CONFLICT DO NOTHING;

  IF to_regclass('public.uploaded_files') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'uploaded_files'
          AND column_name = 'lease_id'
     ) THEN
    EXECUTE 'INSERT INTO _lease_delete_file_ids (id)
             SELECT id FROM public.uploaded_files WHERE org_id = $1 AND lease_id = $2
             ON CONFLICT DO NOTHING'
    USING v_lease.org_id, target_lease_id;
  END IF;

  IF to_regclass('public.extraction_runs') IS NOT NULL THEN
    INSERT INTO _lease_delete_extraction_run_ids (id)
    SELECT id FROM public.extraction_runs
     WHERE org_id = v_lease.org_id
       AND (lease_id = target_lease_id OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))
    ON CONFLICT DO NOTHING;

    INSERT INTO _lease_delete_file_ids (id)
    SELECT uploaded_file_id FROM public.extraction_runs
     WHERE org_id = v_lease.org_id
       AND lease_id = target_lease_id
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('public.document_intelligence_runs') IS NOT NULL THEN
    INSERT INTO _lease_delete_di_run_ids (id)
    SELECT id FROM public.document_intelligence_runs
     WHERE org_id = v_lease.org_id
       AND (lease_id = target_lease_id OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))
    ON CONFLICT DO NOTHING;

    INSERT INTO _lease_delete_file_ids (id)
    SELECT uploaded_file_id FROM public.document_intelligence_runs
     WHERE org_id = v_lease.org_id
       AND lease_id = target_lease_id
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('public.lease_document_packages') IS NOT NULL THEN
    INSERT INTO _lease_delete_package_ids (id)
    SELECT id FROM public.lease_document_packages
     WHERE org_id = v_lease.org_id AND lease_id = target_lease_id
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('public.lease_package_documents') IS NOT NULL THEN
    INSERT INTO _lease_delete_package_ids (id)
    SELECT package_id FROM public.lease_package_documents
     WHERE org_id = v_lease.org_id
       AND uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)
    ON CONFLICT DO NOTHING;

    INSERT INTO _lease_delete_file_ids (id)
    SELECT uploaded_file_id FROM public.lease_package_documents
     WHERE org_id = v_lease.org_id
       AND package_id IN (SELECT id FROM _lease_delete_package_ids)
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('public.document_family_members') IS NOT NULL THEN
    INSERT INTO _lease_delete_family_ids (id)
    SELECT document_family_id FROM public.document_family_members
     WHERE organization_id = v_lease.org_id
       AND uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('public.portfolio_lease_facts') IS NOT NULL THEN
    INSERT INTO _lease_delete_family_ids (id)
    SELECT document_family_id FROM public.portfolio_lease_facts
     WHERE organization_id = v_lease.org_id
       AND lease_id = target_lease_id
    ON CONFLICT DO NOTHING;
  END IF;

  FOR delete_step IN
    SELECT * FROM (VALUES
      -- Portfolio and document semantics derived from this lease family.
      ('portfolio_finding_actions', 'organization_id = $1 AND portfolio_risk_finding_id IN (SELECT id FROM public.portfolio_risk_findings WHERE organization_id = $1 AND (portfolio_lease_fact_id IN (SELECT id FROM public.portfolio_lease_facts WHERE organization_id = $1 AND (lease_id = $2 OR document_family_id IN (SELECT id FROM _lease_delete_family_ids))) OR document_family_id IN (SELECT id FROM _lease_delete_family_ids) OR $2 = ANY(affected_lease_ids)))'),
      ('portfolio_risk_findings', 'organization_id = $1 AND (portfolio_lease_fact_id IN (SELECT id FROM public.portfolio_lease_facts WHERE organization_id = $1 AND (lease_id = $2 OR document_family_id IN (SELECT id FROM _lease_delete_family_ids))) OR document_family_id IN (SELECT id FROM _lease_delete_family_ids) OR $2 = ANY(affected_lease_ids))'),
      ('portfolio_critical_dates', 'organization_id = $1 AND (lease_id = $2 OR document_family_id IN (SELECT id FROM _lease_delete_family_ids) OR portfolio_lease_fact_id IN (SELECT id FROM public.portfolio_lease_facts WHERE organization_id = $1 AND (lease_id = $2 OR document_family_id IN (SELECT id FROM _lease_delete_family_ids))))'),
      ('portfolio_obligations', 'organization_id = $1 AND (document_family_id IN (SELECT id FROM _lease_delete_family_ids) OR portfolio_lease_fact_id IN (SELECT id FROM public.portfolio_lease_facts WHERE organization_id = $1 AND (lease_id = $2 OR document_family_id IN (SELECT id FROM _lease_delete_family_ids))))'),
      ('portfolio_financial_terms', 'organization_id = $1 AND (document_family_id IN (SELECT id FROM _lease_delete_family_ids) OR portfolio_lease_fact_id IN (SELECT id FROM public.portfolio_lease_facts WHERE organization_id = $1 AND (lease_id = $2 OR document_family_id IN (SELECT id FROM _lease_delete_family_ids))))'),
      ('portfolio_lease_facts', 'organization_id = $1 AND (lease_id = $2 OR document_family_id IN (SELECT id FROM _lease_delete_family_ids))'),
      ('document_semantic_review_resolutions', 'organization_id = $1 AND (uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR document_family_id IN (SELECT id FROM _lease_delete_family_ids))'),
      ('document_semantic_search_records', 'organization_id = $1 AND (uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR document_family_id IN (SELECT id FROM _lease_delete_family_ids))'),
      ('document_amendment_effects', 'organization_id = $1 AND (source_uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR target_uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR document_family_id IN (SELECT id FROM _lease_delete_family_ids))'),
      ('document_family_members', 'organization_id = $1 AND (uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR parent_uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR amends_uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR document_family_id IN (SELECT id FROM _lease_delete_family_ids))'),
      ('document_cross_references', 'organization_id = $1 AND uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)'),
      ('document_definitions', 'organization_id = $1 AND uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)'),

      -- Enterprise review payloads and document intelligence projections.
      ('document_field_review_overrides', 'org_id = $1 AND (uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR run_id IN (SELECT id FROM _lease_delete_di_run_ids))'),
      ('document_enterprise_review_payloads', 'org_id = $1 AND (uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR run_id IN (SELECT id FROM _lease_delete_di_run_ids))'),
      ('document_validation_drops', 'org_id = $1 AND (uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR run_id IN (SELECT id FROM _lease_delete_di_run_ids))'),
      ('document_canonical_field_projections', 'org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR run_id IN (SELECT id FROM _lease_delete_di_run_ids))'),
      ('document_claim_evidence', 'org_id = $1 AND (uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR claim_id IN (SELECT id FROM public.document_claims WHERE org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR run_id IN (SELECT id FROM _lease_delete_di_run_ids))))'),
      ('document_claims', 'org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR run_id IN (SELECT id FROM _lease_delete_di_run_ids))'),
      ('document_intelligence_runs', 'org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR id IN (SELECT id FROM _lease_delete_di_run_ids))'),

      -- Financial runtime, projections, calculations, and candidates.
      ('lease_financial_critical_date_projections', 'org_id = $1 AND lease_id = $2'),
      ('lease_financial_compatibility_writes', 'org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR projection_run_id IN (SELECT id FROM public.lease_financial_projection_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids))))'),
      ('lease_financial_projection_diffs', 'org_id = $1 AND (projection_run_id IN (SELECT id FROM public.lease_financial_projection_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids))) OR calculation_run_id IN (SELECT id FROM public.lease_financial_calculation_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids))))'),
      ('lease_financial_schedule_projections', 'org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR projection_run_id IN (SELECT id FROM public.lease_financial_projection_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids))))'),
      ('lease_financial_field_projections', 'org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR projection_run_id IN (SELECT id FROM public.lease_financial_projection_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids))))'),
      ('lease_financial_projection_runs', 'org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR calculation_run_id IN (SELECT id FROM public.lease_financial_calculation_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids))))'),
      ('lease_financial_calculation_review_decisions', 'org_id = $1 AND calculation_run_id IN (SELECT id FROM public.lease_financial_calculation_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids)))'),
      ('lease_financial_validation_issues', 'org_id = $1 AND calculation_run_id IN (SELECT id FROM public.lease_financial_calculation_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids)))'),
      ('lease_financial_amortization_results', 'org_id = $1 AND calculation_run_id IN (SELECT id FROM public.lease_financial_calculation_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids)))'),
      ('lease_financial_formula_evaluation_results', 'org_id = $1 AND calculation_run_id IN (SELECT id FROM public.lease_financial_calculation_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids)))'),
      ('lease_financial_charge_calculation_results', 'org_id = $1 AND calculation_run_id IN (SELECT id FROM public.lease_financial_calculation_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids)))'),
      ('lease_base_rent_calculated_amounts', 'org_id = $1 AND calculation_run_id IN (SELECT id FROM public.lease_financial_calculation_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids)))'),
      ('lease_base_rent_calculated_periods', 'org_id = $1 AND calculation_run_id IN (SELECT id FROM public.lease_financial_calculation_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids)))'),
      ('lease_base_rent_calculation_results', 'org_id = $1 AND calculation_run_id IN (SELECT id FROM public.lease_financial_calculation_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids)))'),
      ('lease_term_resolution_results', 'org_id = $1 AND calculation_run_id IN (SELECT id FROM public.lease_financial_calculation_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids)))'),
      ('lease_date_resolution_results', 'org_id = $1 AND calculation_run_id IN (SELECT id FROM public.lease_financial_calculation_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids)))'),
      ('lease_financial_calculation_runs', 'org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR extraction_run_id IN (SELECT id FROM _lease_delete_extraction_run_ids))'),
      ('lease_financial_charge_reviewer_decisions', 'org_id = $1 AND (charge_candidate_id IN (SELECT id FROM public.lease_financial_charge_candidates WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))) OR conflict_id IN (SELECT id FROM public.lease_financial_charge_conflicts WHERE org_id = $1 AND uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)))'),
      ('lease_financial_charge_claim_links', 'org_id = $1 AND charge_candidate_id IN (SELECT id FROM public.lease_financial_charge_candidates WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)))'),
      ('lease_financial_deposit_components', 'org_id = $1 AND parent_charge_candidate_id IN (SELECT id FROM public.lease_financial_charge_candidates WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)))'),
      ('lease_financial_amortization_candidates', 'org_id = $1 AND charge_candidate_id IN (SELECT id FROM public.lease_financial_charge_candidates WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)))'),
      ('lease_financial_formula_candidates', 'org_id = $1 AND charge_candidate_id IN (SELECT id FROM public.lease_financial_charge_candidates WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)))'),
      ('lease_financial_charge_amounts', 'org_id = $1 AND charge_candidate_id IN (SELECT id FROM public.lease_financial_charge_candidates WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)))'),
      ('lease_financial_charge_period_candidates', 'org_id = $1 AND charge_candidate_id IN (SELECT id FROM public.lease_financial_charge_candidates WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)))'),
      ('lease_financial_charge_conflicts', 'org_id = $1 AND uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)'),
      ('lease_financial_charge_candidates', 'org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR extraction_run_id IN (SELECT id FROM _lease_delete_extraction_run_ids))'),

      -- Base-rent/date/term source candidates.
      ('lease_base_rent_reviewer_decisions', 'org_id = $1 AND (schedule_candidate_id IN (SELECT id FROM public.lease_base_rent_schedule_candidates WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))) OR conflict_id IN (SELECT id FROM public.lease_base_rent_schedule_conflicts WHERE org_id = $1 AND (uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR package_id IN (SELECT id FROM _lease_delete_package_ids))) OR related_document_requirement_id IN (SELECT id FROM public.lease_related_document_requirements WHERE org_id = $1 AND package_id IN (SELECT id FROM _lease_delete_package_ids)))'),
      ('lease_base_rent_schedule_claim_links', 'org_id = $1 AND (schedule_candidate_id IN (SELECT id FROM public.lease_base_rent_schedule_candidates WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))) OR period_candidate_id IN (SELECT id FROM public.lease_base_rent_period_candidates WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids))))'),
      ('lease_base_rent_period_amounts', 'org_id = $1 AND schedule_candidate_id IN (SELECT id FROM public.lease_base_rent_schedule_candidates WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)))'),
      ('lease_base_rent_escalation_candidates', 'org_id = $1 AND schedule_candidate_id IN (SELECT id FROM public.lease_base_rent_schedule_candidates WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)))'),
      ('lease_base_rent_period_candidates', 'org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR schedule_candidate_id IN (SELECT id FROM public.lease_base_rent_schedule_candidates WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))))'),
      ('lease_base_rent_schedule_conflicts', 'org_id = $1 AND (uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR package_id IN (SELECT id FROM _lease_delete_package_ids))'),
      ('lease_base_rent_schedule_candidates', 'org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR extraction_run_id IN (SELECT id FROM _lease_delete_extraction_run_ids))'),
      ('lease_term_reviewer_decisions', 'org_id = $1 AND (term_candidate_id IN (SELECT id FROM public.lease_term_candidates WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))) OR related_document_requirement_id IN (SELECT id FROM public.lease_related_document_requirements WHERE org_id = $1 AND package_id IN (SELECT id FROM _lease_delete_package_ids)))'),
      ('lease_date_dependency_reviewer_decisions', 'org_id = $1 AND (dependency_id IN (SELECT id FROM public.lease_date_expression_dependencies WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))) OR related_document_requirement_id IN (SELECT id FROM public.lease_related_document_requirements WHERE org_id = $1 AND package_id IN (SELECT id FROM _lease_delete_package_ids)))'),
      ('lease_date_expression_dependencies', 'org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR extraction_run_id IN (SELECT id FROM _lease_delete_extraction_run_ids))'),
      ('lease_date_expression_reviewer_decisions', 'org_id = $1 AND date_expression_id IN (SELECT id FROM public.lease_date_expressions WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)))'),
      ('lease_date_expression_claim_links', 'org_id = $1 AND date_expression_id IN (SELECT id FROM public.lease_date_expressions WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)))'),
      ('lease_term_candidates', 'org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR extraction_run_id IN (SELECT id FROM _lease_delete_extraction_run_ids))'),
      ('lease_date_expressions', 'org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR extraction_run_id IN (SELECT id FROM _lease_delete_extraction_run_ids))'),

      -- Package projection/resolution and graph data.
      ('lease_package_compatibility_writes', 'org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR package_id IN (SELECT id FROM _lease_delete_package_ids))'),
      ('lease_package_projection_diffs', 'org_id = $1 AND package_id IN (SELECT id FROM _lease_delete_package_ids)'),
      ('lease_package_field_projections', 'org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids))'),
      ('lease_package_projection_runs', 'org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids))'),
      ('lease_package_resolution_reviewer_decisions', 'org_id = $1 AND resolution_run_id IN (SELECT id FROM public.lease_package_resolution_runs WHERE org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids)))'),
      ('lease_package_claim_overrides', 'org_id = $1 AND package_id IN (SELECT id FROM _lease_delete_package_ids)'),
      ('lease_package_effective_claims', 'org_id = $1 AND package_id IN (SELECT id FROM _lease_delete_package_ids)'),
      ('lease_package_resolution_conflicts', 'org_id = $1 AND package_id IN (SELECT id FROM _lease_delete_package_ids)'),
      ('lease_package_resolution_runs', 'org_id = $1 AND (lease_id = $2 OR package_id IN (SELECT id FROM _lease_delete_package_ids))'),
      ('lease_date_expression_dependencies', 'org_id = $1 AND related_document_requirement_id IN (SELECT id FROM public.lease_related_document_requirements WHERE org_id = $1 AND package_id IN (SELECT id FROM _lease_delete_package_ids))'),
      ('lease_related_document_requirements', 'org_id = $1 AND package_id IN (SELECT id FROM _lease_delete_package_ids)'),
      ('lease_document_relationship_reviewer_decisions', 'org_id = $1 AND relationship_id IN (SELECT id FROM public.lease_document_relationships WHERE org_id = $1 AND package_id IN (SELECT id FROM _lease_delete_package_ids))'),
      ('lease_document_relationships', 'org_id = $1 AND package_id IN (SELECT id FROM _lease_delete_package_ids)'),
      ('lease_package_membership_decisions', 'org_id = $1 AND (uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR extraction_run_id IN (SELECT id FROM _lease_delete_extraction_run_ids) OR package_id IN (SELECT id FROM _lease_delete_package_ids))'),
      ('lease_package_documents', 'org_id = $1 AND (uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR extraction_run_id IN (SELECT id FROM _lease_delete_extraction_run_ids))'),
      ('lease_document_packages', 'org_id = $1 AND (lease_id = $2 OR id IN (SELECT id FROM _lease_delete_package_ids))'),

      -- Claim ledger, profile, and provenance.
      ('lease_field_projections', 'org_id = $1 AND projection_run_id IN (SELECT id FROM public.lease_claim_projection_runs WHERE org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)))'),
      ('lease_claim_projection_runs', 'org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))'),
      ('lease_claim_review_decisions', 'org_id = $1 AND (claim_id IN (SELECT id FROM public.lease_claims WHERE org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))) OR conflict_group_id IN (SELECT id FROM public.lease_claim_conflict_groups WHERE org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))))'),
      ('lease_claim_conflict_members', 'org_id = $1 AND (claim_id IN (SELECT id FROM public.lease_claims WHERE org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))) OR conflict_group_id IN (SELECT id FROM public.lease_claim_conflict_groups WHERE org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))))'),
      ('lease_claim_conflict_groups', 'org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))'),
      ('lease_claim_evidence_links', 'org_id = $1 AND (claim_id IN (SELECT id FROM public.lease_claims WHERE org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))) OR evidence_id IN (SELECT id FROM public.lease_claim_evidence WHERE org_id = $1 AND uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)))'),
      ('lease_claim_evidence', 'org_id = $1 AND uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)'),
      ('lease_claims', 'org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR extraction_run_id IN (SELECT id FROM _lease_delete_extraction_run_ids))'),
      ('lease_document_profile_records', 'org_id = $1 AND uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)'),
      ('lease_document_segments', 'org_id = $1 AND uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)'),
      ('extraction_artifacts', 'org_id = $1 AND run_id IN (SELECT id FROM _lease_delete_extraction_run_ids)'),
      ('provider_invocations', 'org_id = $1 AND run_id IN (SELECT id FROM _lease_delete_extraction_run_ids)'),
      ('extraction_stage_runs', 'org_id = $1 AND run_id IN (SELECT id FROM _lease_delete_extraction_run_ids)'),
      ('extraction_runs', 'org_id = $1 AND (id IN (SELECT id FROM _lease_delete_extraction_run_ids) OR lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))'),

      -- Pipeline/upload records and legacy review tables.
      ('document_links', 'org_id = $1 AND ((entity_type = ''lease'' AND entity_id = $2) OR file_id IN (SELECT id FROM _lease_delete_file_ids))'),
      ('compute_runs', 'org_id = $1 AND source_file_id IN (SELECT id FROM _lease_delete_file_ids)'),
      ('pipeline_jobs', 'org_id = $1 AND (lease_id = $2 OR uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids))'),
      ('lease_review_finalization_runs', 'org_id = $1 AND uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)'),
      ('lease_document_profile_records', 'org_id = $1 AND uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)'),
      ('lease_document_segments', 'org_id = $1 AND uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)')
    ) AS steps(table_name, predicate)
  LOOP
    IF to_regclass(format('public.%I', delete_step.table_name)) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I WHERE %s', delete_step.table_name, delete_step.predicate)
      USING v_lease.org_id, target_lease_id;
    END IF;
  END LOOP;

  IF to_regclass('public.expense_classification_templates') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'expense_classification_templates'
          AND column_name = 'based_on_lease_id'
     ) THEN
    UPDATE public.expense_classification_templates
       SET based_on_lease_id = NULL
     WHERE based_on_lease_id = target_lease_id;
  END IF;

  FOREACH child_table IN ARRAY ARRAY[
    'recovery_pool_lease_participants',
    'cam_pool_lease_shares',
    'cam_calculation_results',
    'cam_statement_line_items',
    'cam_statements',
    'cam_reconciliations',
    'cam_blueprint_run_ledger',
    'cam_pool_rules',
    'cam_pools',
    'cam_recovery_pools',
    'lease_package_runtime',
    'lease_financial_runtime',
    'budget_line_items',
    'documents',
    'cam_expense_inputs',
    'expense_classifications',
    'expenses',
    'rent_projections',
    'rent_schedules',
    'revenues',
    'lease_critical_dates',
    'lease_clauses',
    'lease_field_reviews',
    'lease_config',
    'cam_profiles',
    'lease_abstract_versions',
    'lease_amendments',
    'lease_assignments',
    'lease_expense_values',
    'lease_expense_rule_clauses',
    'lease_expense_rules',
    'lease_expense_rule_sets'
  ]
  LOOP
    IF to_regclass(format('public.%I', child_table)) IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = child_table
            AND column_name = 'lease_id'
       ) THEN
      EXECUTE format('DELETE FROM public.%I WHERE lease_id = $1', child_table)
      USING target_lease_id;
    END IF;
  END LOOP;

  IF to_regclass('public.leases') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'leases' AND column_name = 'superseded_by_lease_id'
  ) THEN
    UPDATE public.leases SET superseded_by_lease_id = NULL WHERE superseded_by_lease_id = target_lease_id;
  END IF;

  UPDATE public.units SET lease_id = NULL WHERE lease_id = target_lease_id;

  DELETE FROM public.leases WHERE id = target_lease_id;

  DELETE FROM public.uploaded_files
   WHERE org_id = v_lease.org_id
     AND id IN (SELECT id FROM _lease_delete_file_ids);

  INSERT INTO public.audit_logs (
    org_id,
    property_id,
    entity_type,
    entity_id,
    action,
    actor_user_id,
    actor_email,
    severity,
    source,
    before,
    metadata,
    "timestamp"
  )
  VALUES (
    v_lease.org_id,
    v_lease.property_id,
    'Lease',
    target_lease_id::TEXT,
    'delete',
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    to_jsonb(v_lease),
    jsonb_build_object(
      'tenant_name', v_lease.tenant_name,
      'source_file_id', v_lease.source_file_id,
      'cascade_scope', 'lease_source_extraction_review_package_financial_runtime'
    ),
    now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_lease_cascade(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_lease_cascade(UUID, UUID, TEXT) TO service_role;
