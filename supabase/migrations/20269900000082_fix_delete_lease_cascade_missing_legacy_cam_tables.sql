-- Repair lease deletion after the hierarchical cascade migration reintroduced
-- a legacy CAM table reference that is not present in current environments.
-- Keep the function schema-tolerant: tables and lease_id columns can vary by
-- deployment, but a missing retired table must never block lease deletion.

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
  child_table TEXT;
  delete_step RECORD;
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
    RETURN;
  END IF;

  PERFORM set_config('app.allow_lease_cascade_delete', 'true', true);
  PERFORM set_config('app.allow_cascade_delete', 'true', true);

  CREATE TEMP TABLE IF NOT EXISTS _lease_delete_file_ids (id UUID PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _lease_delete_extraction_run_ids (id UUID PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _lease_delete_di_run_ids (id UUID PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _lease_delete_package_ids (id UUID PRIMARY KEY) ON COMMIT DROP;

  TRUNCATE _lease_delete_file_ids;
  TRUNCATE _lease_delete_extraction_run_ids;
  TRUNCATE _lease_delete_di_run_ids;
  TRUNCATE _lease_delete_package_ids;

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
       AND uploaded_file_id IS NOT NULL
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
       AND uploaded_file_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('public.lease_document_packages') IS NOT NULL THEN
    INSERT INTO _lease_delete_package_ids (id)
    SELECT id FROM public.lease_document_packages
     WHERE org_id = v_lease.org_id
       AND lease_id = target_lease_id
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('public.lease_package_documents') IS NOT NULL THEN
    INSERT INTO _lease_delete_package_ids (id)
    SELECT package_id FROM public.lease_package_documents
     WHERE org_id = v_lease.org_id
       AND uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids)
       AND package_id IS NOT NULL
    ON CONFLICT DO NOTHING;

    INSERT INTO _lease_delete_file_ids (id)
    SELECT uploaded_file_id FROM public.lease_package_documents
     WHERE org_id = v_lease.org_id
       AND package_id IN (SELECT id FROM _lease_delete_package_ids)
       AND uploaded_file_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;

  FOR delete_step IN
    SELECT * FROM (VALUES
      ('cam_run_calculation_lines', 'org_id = $1 AND lease_result_id IN (SELECT id FROM public.cam_run_lease_results WHERE org_id = $1 AND lease_id = $2)'),
      ('cam_run_exceptions', 'org_id = $1 AND entity_type = ''lease'' AND entity_id = $2'),
      ('document_links', 'org_id = $1 AND ((entity_type = ''lease'' AND entity_id = $2) OR file_id IN (SELECT id FROM _lease_delete_file_ids))'),
      ('compute_runs', 'org_id = $1 AND source_file_id IN (SELECT id FROM _lease_delete_file_ids)'),
      ('extraction_artifacts', 'org_id = $1 AND run_id IN (SELECT id FROM _lease_delete_extraction_run_ids)'),
      ('provider_invocations', 'org_id = $1 AND run_id IN (SELECT id FROM _lease_delete_extraction_run_ids)'),
      ('extraction_stage_runs', 'org_id = $1 AND run_id IN (SELECT id FROM _lease_delete_extraction_run_ids)'),
      ('lease_package_documents', 'org_id = $1 AND (uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR extraction_run_id IN (SELECT id FROM _lease_delete_extraction_run_ids))'),
      ('lease_package_membership_decisions', 'org_id = $1 AND (uploaded_file_id IN (SELECT id FROM _lease_delete_file_ids) OR package_id IN (SELECT id FROM _lease_delete_package_ids) OR extraction_run_id IN (SELECT id FROM _lease_delete_extraction_run_ids))'),
      ('lease_document_packages', 'org_id = $1 AND (lease_id = $2 OR id IN (SELECT id FROM _lease_delete_package_ids))')
    ) AS steps(table_name, predicate)
  LOOP
    IF to_regclass(format('public.%I', delete_step.table_name)) IS NOT NULL THEN
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE %s', delete_step.table_name, delete_step.predicate)
        USING v_lease.org_id, target_lease_id;
      EXCEPTION WHEN undefined_table OR undefined_column THEN
        NULL;
      END;
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
    'lease_financial_critical_date_projections',
    'lease_financial_compatibility_writes',
    'lease_financial_projection_diffs',
    'lease_financial_schedule_projections',
    'lease_financial_field_projections',
    'lease_financial_projection_runs',
    'lease_financial_calculation_review_decisions',
    'lease_financial_validation_issues',
    'lease_financial_amortization_results',
    'lease_financial_formula_evaluation_results',
    'lease_financial_charge_calculation_results',
    'lease_base_rent_calculated_amounts',
    'lease_base_rent_calculated_periods',
    'lease_base_rent_calculation_results',
    'lease_term_resolution_results',
    'lease_date_resolution_results',
    'lease_financial_calculation_runs',
    'lease_financial_charge_candidates',
    'lease_base_rent_schedule_candidates',
    'lease_base_rent_period_candidates',
    'lease_term_candidates',
    'lease_date_expressions',
    'lease_date_expression_dependencies',
    'lease_claim_projection_runs',
    'lease_claim_conflict_groups',
    'lease_claims',
    'document_canonical_field_projections',
    'document_claims',
    'document_intelligence_runs',
    'extraction_runs',
    'recovery_pool_lease_participants',
    'cam_pool_lease_shares',
    'cam_run_lease_results',
    'cam_run_statements',
    'cam_statements',
    'cam_charge_exports',
    'cam_estimate_schedules',
    'cam_prior_period_adjustments',
    'cam_calculation_results',
    'cam_statement_line_items',
    'cam_reconciliations',
    'cam_blueprint_run_ledger',
    'cam_expense_inputs',
    'tenant_reconciliation_lines',
    'tenant_reconciliations',
    'cpi_rent_adjustment_proposals',
    'percentage_rent_calculations',
    'tenant_sales_reports',
    'lease_percentage_rent_terms',
    'lease_charge_calculations',
    'lease_insurance_compliance_results',
    'coi_documents',
    'reference_series_selections',
    'cam_tenant_caps',
    'cam_tenant_admin_fees',
    'cam_pool_exclusions',
    'cam_recovery_profile_exclusions',
    'budget_line_items',
    'documents',
    'expense_classifications',
    'expenses',
    'rent_projections',
    'rent_schedules',
    'revenues',
    'lease_critical_dates',
    'lease_clauses',
    'lease_field_reviews',
    'lease_config',
    'lease_abstract_versions',
    'lease_amendments',
    'lease_assignments',
    'lease_expense_values',
    'lease_expense_rule_clauses',
    'lease_expense_rules',
    'lease_expense_rule_sets',
    'pipeline_jobs',
    'uploaded_files'
  ]
  LOOP
    IF to_regclass(format('public.%I', child_table)) IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = child_table
            AND column_name = 'lease_id'
       ) THEN
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE lease_id = $1', child_table)
        USING target_lease_id;
      EXCEPTION WHEN undefined_table OR undefined_column THEN
        NULL;
      END;
    END IF;
  END LOOP;

  IF to_regclass('public.leases') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'leases'
       AND column_name = 'superseded_by_lease_id'
  ) THEN
    UPDATE public.leases
       SET superseded_by_lease_id = NULL
     WHERE superseded_by_lease_id = target_lease_id;
  END IF;

  IF to_regclass('public.units') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'units'
          AND column_name = 'lease_id'
     ) THEN
    UPDATE public.units SET lease_id = NULL WHERE lease_id = target_lease_id;
  END IF;

  DELETE FROM public.leases WHERE id = target_lease_id;

  IF to_regclass('public.uploaded_files') IS NOT NULL THEN
    DELETE FROM public.uploaded_files
     WHERE org_id = v_lease.org_id
       AND id IN (SELECT id FROM _lease_delete_file_ids);
  END IF;

  IF to_regclass('public.audit_logs') IS NOT NULL THEN
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
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_lease_cascade(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_lease_cascade(UUID, UUID, TEXT) TO service_role;
