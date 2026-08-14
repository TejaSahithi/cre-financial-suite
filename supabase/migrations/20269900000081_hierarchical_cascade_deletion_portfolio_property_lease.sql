-- Migration: Hierarchical cascade deletion for Portfolio, Property, and Lease
-- Enables clean deletion of Portfolios, Properties, and Leases without foreign key restriction errors.

-- 1. Drop restrictive foreign keys and recreate them with ON DELETE CASCADE.
DO $$
DECLARE
  r RECORD;
BEGIN
  -- Drop foreign keys that block deletion
  FOR r IN (
    SELECT tc.table_schema, tc.table_name, tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND (
        (tc.table_name = 'properties' AND kcu.column_name = 'portfolio_id') OR
        (tc.table_name = 'recovery_pools' AND kcu.column_name = 'period_id') OR
        (tc.table_name = 'cam_runs' AND kcu.column_name = 'recovery_period_id') OR
        (tc.table_name = 'cam_prior_period_adjustments' AND kcu.column_name IN ('recovery_period_id', 'lease_id')) OR
        (tc.table_name = 'cam_audit_trail' AND kcu.column_name IN ('recovery_period_id', 'cam_run_id')) OR
        (tc.table_name = 'cam_tenant_shares' AND kcu.column_name IN ('cam_run_id', 'lease_id')) OR
        (tc.table_name = 'cam_pool_calculations' AND kcu.column_name = 'cam_run_id') OR
        (tc.table_name = 'cam_expense_pool_allocations' AND kcu.column_name = 'cam_run_id') OR
        (tc.table_name = 'cam_tenant_caps' AND kcu.column_name IN ('cam_run_id', 'lease_id')) OR
        (tc.table_name = 'cam_tenant_admin_fees' AND kcu.column_name IN ('cam_run_id', 'lease_id')) OR
        (tc.table_name = 'cam_variance_analyses' AND kcu.column_name = 'cam_run_id') OR
        (tc.table_name = 'cam_reconciliations' AND kcu.column_name = 'cam_run_id') OR
        (tc.table_name = 'cam_postings' AND kcu.column_name = 'cam_run_id') OR
        (tc.table_name = 'cam_posting_journal_entries' AND kcu.column_name = 'cam_run_id') OR
        (tc.table_name = 'cam_run_reconciliation_links' AND kcu.column_name IN ('original_run_id', 'adjustment_run_id')) OR
        (tc.table_name = 'cam_run_superseded_links' AND kcu.column_name IN ('superseded_run_id', 'restatement_run_id')) OR
        (tc.table_name = 'cam_run_evidence_attachments' AND kcu.column_name = 'cam_run_id') OR
        (tc.table_name = 'tenant_reconciliations' AND kcu.column_name = 'lease_id') OR
        (tc.table_name = 'tenant_reconciliation_lines' AND kcu.column_name = 'lease_id') OR
        (tc.table_name = 'cam_pool_exclusions' AND kcu.column_name = 'lease_id') OR
        (tc.table_name = 'cam_recovery_profile_exclusions' AND kcu.column_name = 'lease_id') OR
        (tc.table_name = 'expenses' AND kcu.column_name IN ('property_id', 'lease_id', 'portfolio_id')) OR
        (tc.table_name = 'budgets' AND kcu.column_name IN ('property_id', 'portfolio_id')) OR
        (tc.table_name = 'financial_control_findings' AND kcu.column_name = 'property_id') OR
        (tc.table_name = 'financial_control_policies' AND kcu.column_name = 'property_id')
      )
  ) LOOP
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I', r.table_schema, r.table_name, r.constraint_name);
  END LOOP;
END $$;

-- 2. Re-add foreign key constraints with ON DELETE CASCADE where appropriate
DO $$
BEGIN
  IF to_regclass('public.properties') IS NOT NULL AND to_regclass('public.portfolios') IS NOT NULL THEN
    ALTER TABLE public.properties
      ADD CONSTRAINT properties_portfolio_id_fkey
      FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.recovery_pools') IS NOT NULL AND to_regclass('public.recovery_periods') IS NOT NULL THEN
    ALTER TABLE public.recovery_pools
      ADD CONSTRAINT recovery_pools_period_id_fkey
      FOREIGN KEY (period_id) REFERENCES public.recovery_periods(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_runs') IS NOT NULL AND to_regclass('public.recovery_periods') IS NOT NULL THEN
    ALTER TABLE public.cam_runs
      ADD CONSTRAINT cam_runs_recovery_period_id_fkey
      FOREIGN KEY (recovery_period_id) REFERENCES public.recovery_periods(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_prior_period_adjustments') IS NOT NULL THEN
    ALTER TABLE public.cam_prior_period_adjustments
      ADD CONSTRAINT cam_prior_period_adjustments_recovery_period_id_fkey
      FOREIGN KEY (recovery_period_id) REFERENCES public.recovery_periods(id) ON DELETE CASCADE,
      ADD CONSTRAINT cam_prior_period_adjustments_lease_id_fkey
      FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_audit_trail') IS NOT NULL THEN
    ALTER TABLE public.cam_audit_trail
      ADD CONSTRAINT cam_audit_trail_recovery_period_id_fkey
      FOREIGN KEY (recovery_period_id) REFERENCES public.recovery_periods(id) ON DELETE CASCADE,
      ADD CONSTRAINT cam_audit_trail_cam_run_id_fkey
      FOREIGN KEY (cam_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_tenant_shares') IS NOT NULL THEN
    ALTER TABLE public.cam_tenant_shares
      ADD CONSTRAINT cam_tenant_shares_cam_run_id_fkey
      FOREIGN KEY (cam_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE,
      ADD CONSTRAINT cam_tenant_shares_lease_id_fkey
      FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_pool_calculations') IS NOT NULL THEN
    ALTER TABLE public.cam_pool_calculations
      ADD CONSTRAINT cam_pool_calculations_cam_run_id_fkey
      FOREIGN KEY (cam_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_expense_pool_allocations') IS NOT NULL THEN
    ALTER TABLE public.cam_expense_pool_allocations
      ADD CONSTRAINT cam_expense_pool_allocations_cam_run_id_fkey
      FOREIGN KEY (cam_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_tenant_caps') IS NOT NULL THEN
    ALTER TABLE public.cam_tenant_caps
      ADD CONSTRAINT cam_tenant_caps_cam_run_id_fkey
      FOREIGN KEY (cam_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE,
      ADD CONSTRAINT cam_tenant_caps_lease_id_fkey
      FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_tenant_admin_fees') IS NOT NULL THEN
    ALTER TABLE public.cam_tenant_admin_fees
      ADD CONSTRAINT cam_tenant_admin_fees_cam_run_id_fkey
      FOREIGN KEY (cam_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE,
      ADD CONSTRAINT cam_tenant_admin_fees_lease_id_fkey
      FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_variance_analyses') IS NOT NULL THEN
    ALTER TABLE public.cam_variance_analyses
      ADD CONSTRAINT cam_variance_analyses_cam_run_id_fkey
      FOREIGN KEY (cam_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_reconciliations') IS NOT NULL THEN
    ALTER TABLE public.cam_reconciliations
      ADD CONSTRAINT cam_reconciliations_cam_run_id_fkey
      FOREIGN KEY (cam_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_postings') IS NOT NULL THEN
    ALTER TABLE public.cam_postings
      ADD CONSTRAINT cam_postings_cam_run_id_fkey
      FOREIGN KEY (cam_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_posting_journal_entries') IS NOT NULL THEN
    ALTER TABLE public.cam_posting_journal_entries
      ADD CONSTRAINT cam_posting_journal_entries_cam_run_id_fkey
      FOREIGN KEY (cam_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_run_reconciliation_links') IS NOT NULL THEN
    ALTER TABLE public.cam_run_reconciliation_links
      ADD CONSTRAINT cam_run_reconciliation_links_original_run_id_fkey
      FOREIGN KEY (original_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE,
      ADD CONSTRAINT cam_run_reconciliation_links_adjustment_run_id_fkey
      FOREIGN KEY (adjustment_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_run_superseded_links') IS NOT NULL THEN
    ALTER TABLE public.cam_run_superseded_links
      ADD CONSTRAINT cam_run_superseded_links_superseded_run_id_fkey
      FOREIGN KEY (superseded_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE,
      ADD CONSTRAINT cam_run_superseded_links_restatement_run_id_fkey
      FOREIGN KEY (restatement_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_run_evidence_attachments') IS NOT NULL THEN
    ALTER TABLE public.cam_run_evidence_attachments
      ADD CONSTRAINT cam_run_evidence_attachments_cam_run_id_fkey
      FOREIGN KEY (cam_run_id) REFERENCES public.cam_runs(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.tenant_reconciliations') IS NOT NULL THEN
    ALTER TABLE public.tenant_reconciliations
      ADD CONSTRAINT tenant_reconciliations_lease_id_fkey
      FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.tenant_reconciliation_lines') IS NOT NULL THEN
    ALTER TABLE public.tenant_reconciliation_lines
      ADD CONSTRAINT tenant_reconciliation_lines_lease_id_fkey
      FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_pool_exclusions') IS NOT NULL THEN
    ALTER TABLE public.cam_pool_exclusions
      ADD CONSTRAINT cam_pool_exclusions_lease_id_fkey
      FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.cam_recovery_profile_exclusions') IS NOT NULL THEN
    ALTER TABLE public.cam_recovery_profile_exclusions
      ADD CONSTRAINT cam_recovery_profile_exclusions_lease_id_fkey
      FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.expenses') IS NOT NULL THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_property_id_fkey
      FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE,
      ADD CONSTRAINT expenses_portfolio_id_fkey
      FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(id) ON DELETE CASCADE,
      ADD CONSTRAINT expenses_lease_id_fkey
      FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.budgets') IS NOT NULL THEN
    ALTER TABLE public.budgets
      ADD CONSTRAINT budgets_property_id_fkey
      FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE,
      ADD CONSTRAINT budgets_portfolio_id_fkey
      FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.financial_control_findings') IS NOT NULL THEN
    ALTER TABLE public.financial_control_findings
      ADD CONSTRAINT financial_control_findings_property_id_fkey
      FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.financial_control_policies') IS NOT NULL THEN
    ALTER TABLE public.financial_control_policies
      ADD CONSTRAINT financial_control_policies_property_id_fkey
      FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 3. Update Immutability Triggers to permit deletion during cascade / administrative delete
CREATE OR REPLACE FUNCTION public.enforce_cam_run_ledger_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_run_status TEXT;
  v_run_id UUID := COALESCE(NEW.cam_run_id, OLD.cam_run_id);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  SELECT status INTO v_run_status FROM public.cam_runs WHERE id = v_run_id;
  IF v_run_status IN ('posted', 'superseded', 'voided') THEN
    RAISE EXCEPTION 'Cannot modify %: parent CAM run % is in immutable status %', TG_TABLE_NAME, v_run_id, v_run_status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_cam_run_immutability_and_transitions()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF OLD.status IN ('superseded', 'voided') THEN
    RAISE EXCEPTION 'CAM run % is in terminal status % and cannot be modified', OLD.id, OLD.status;
  END IF;

  IF OLD.status = 'posted' THEN
    IF NEW.status IS DISTINCT FROM 'superseded' THEN
      RAISE EXCEPTION 'Posted CAM run % is immutable; only a transition to superseded is permitted (attempted status: %)', OLD.id, NEW.status;
    END IF;
    IF NEW.recovery_period_id IS DISTINCT FROM OLD.recovery_period_id
      OR NEW.scope_type IS DISTINCT FROM OLD.scope_type
      OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
      OR NEW.run_number IS DISTINCT FROM OLD.run_number
      OR NEW.run_type IS DISTINCT FROM OLD.run_type
      OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
      OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
      OR NEW.rounding_policy IS DISTINCT FROM OLD.rounding_policy
      OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
      OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
    THEN
      RAISE EXCEPTION 'Posted CAM run % is immutable; only status may change (to superseded)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'draft' AND NEW.status IN ('readiness_failed', 'ready', 'voided')) OR
      (OLD.status = 'readiness_failed' AND NEW.status IN ('ready', 'draft', 'voided')) OR
      (OLD.status = 'ready' AND NEW.status IN ('calculating', 'readiness_failed', 'voided')) OR
      (OLD.status = 'calculating' AND NEW.status IN ('calculated', 'readiness_failed')) OR
      (OLD.status = 'calculated' AND NEW.status IN ('under_review', 'calculating', 'voided')) OR
      (OLD.status = 'under_review' AND NEW.status IN ('submitted', 'calculated', 'voided')) OR
      (OLD.status = 'submitted' AND NEW.status IN ('approved', 'under_review', 'voided')) OR
      (OLD.status = 'approved' AND NEW.status IN ('posted', 'under_review', 'voided'))
    ) THEN
      RAISE EXCEPTION 'Invalid CAM run status transition % -> % for run %', OLD.status, NEW.status, OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 4. Expanded Authoritative delete_lease_cascade RPC
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

  -- Downstream financial domain tables
  DELETE FROM public.tenant_reconciliation_lines WHERE lease_id = target_lease_id;
  DELETE FROM public.tenant_reconciliations WHERE lease_id = target_lease_id;
  DELETE FROM public.cpi_rent_adjustment_proposals WHERE lease_id = target_lease_id;
  DELETE FROM public.lease_obligation_occurrences WHERE org_id = v_lease.org_id AND obligation_id IN (SELECT id FROM public.lease_obligations WHERE lease_id = target_lease_id);
  DELETE FROM public.lease_obligations WHERE lease_id = target_lease_id;
  DELETE FROM public.percentage_rent_calculations WHERE lease_id = target_lease_id;
  DELETE FROM public.tenant_sales_reports WHERE lease_id = target_lease_id;
  DELETE FROM public.lease_percentage_rent_terms WHERE lease_id = target_lease_id;
  DELETE FROM public.lease_charge_calculations WHERE lease_id = target_lease_id;
  DELETE FROM public.lease_insurance_compliance_results WHERE lease_id = target_lease_id;
  DELETE FROM public.coi_documents WHERE lease_id = target_lease_id;
  DELETE FROM public.reference_series_selections WHERE lease_id = target_lease_id;

  -- CAM V2 downstream records
  DELETE FROM public.cam_tenant_shares WHERE lease_id = target_lease_id;
  DELETE FROM public.cam_tenant_caps WHERE lease_id = target_lease_id;
  DELETE FROM public.cam_tenant_admin_fees WHERE lease_id = target_lease_id;
  DELETE FROM public.cam_prior_period_adjustments WHERE lease_id = target_lease_id;
  DELETE FROM public.cam_pool_exclusions WHERE lease_id = target_lease_id;
  IF to_regclass('public.cam_recovery_profile_exclusions') IS NOT NULL THEN
    DELETE FROM public.cam_recovery_profile_exclusions WHERE lease_id = target_lease_id;
  END IF;

  -- Lease expense rules
  DELETE FROM public.lease_expense_rules WHERE lease_id = target_lease_id;
  DELETE FROM public.lease_expense_rule_sets WHERE lease_id = target_lease_id;

  -- Actual expenses associated with this lease
  DELETE FROM public.expenses WHERE lease_id = target_lease_id;

  -- Rent schedules and critical dates
  DELETE FROM public.rent_schedules WHERE lease_id = target_lease_id;
  DELETE FROM public.lease_critical_dates WHERE lease_id = target_lease_id;

  -- Document intelligence and extraction runs
  IF to_regclass('public.document_intelligence_runs') IS NOT NULL THEN
    DELETE FROM public.document_intelligence_runs WHERE lease_id = target_lease_id;
  END IF;
  IF to_regclass('public.extraction_runs') IS NOT NULL THEN
    DELETE FROM public.extraction_runs WHERE lease_id = target_lease_id;
  END IF;
  IF to_regclass('public.lease_document_packages') IS NOT NULL THEN
    DELETE FROM public.lease_document_packages WHERE lease_id = target_lease_id;
  END IF;

  -- Finally delete the lease itself
  DELETE FROM public.leases WHERE id = target_lease_id;
END;
$$;

-- 5. Cascade Delete RPC for Property
CREATE OR REPLACE FUNCTION public.delete_property_cascade(
  target_property_id UUID,
  p_actor_user_id UUID DEFAULT NULL,
  p_actor_email TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lease_id UUID;
BEGIN
  IF target_property_id IS NULL THEN
    RAISE EXCEPTION 'target_property_id is required';
  END IF;

  PERFORM set_config('app.allow_lease_cascade_delete', 'true', true);
  PERFORM set_config('app.allow_cascade_delete', 'true', true);

  -- Delete all child leases cleanly via lease cascade
  FOR v_lease_id IN (SELECT id FROM public.leases WHERE property_id = target_property_id)
  LOOP
    PERFORM public.delete_lease_cascade(v_lease_id, p_actor_user_id, p_actor_email);
  END LOOP;

  -- Delete CAM structure and runs tied to this property
  DELETE FROM public.cam_runs WHERE scope_type = 'property' AND scope_id = target_property_id;
  DELETE FROM public.recovery_pools WHERE property_id = target_property_id;
  DELETE FROM public.recovery_calendars WHERE property_id = target_property_id;

  -- Delete expenses and budgets tied to this property
  DELETE FROM public.expenses WHERE property_id = target_property_id;
  DELETE FROM public.budgets WHERE property_id = target_property_id;
  DELETE FROM public.financial_control_findings WHERE property_id = target_property_id;
  DELETE FROM public.financial_control_policies WHERE property_id = target_property_id;

  -- Delete buildings & units
  DELETE FROM public.units WHERE property_id = target_property_id;
  DELETE FROM public.buildings WHERE property_id = target_property_id;

  -- Delete property
  DELETE FROM public.properties WHERE id = target_property_id;
END;
$$;

-- 6. Cascade Delete RPC for Portfolio
CREATE OR REPLACE FUNCTION public.delete_portfolio_cascade(
  target_portfolio_id UUID,
  p_actor_user_id UUID DEFAULT NULL,
  p_actor_email TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_property_id UUID;
BEGIN
  IF target_portfolio_id IS NULL THEN
    RAISE EXCEPTION 'target_portfolio_id is required';
  END IF;

  PERFORM set_config('app.allow_lease_cascade_delete', 'true', true);
  PERFORM set_config('app.allow_cascade_delete', 'true', true);

  -- Delete each child property via property cascade
  FOR v_property_id IN (SELECT id FROM public.properties WHERE portfolio_id = target_portfolio_id)
  LOOP
    PERFORM public.delete_property_cascade(v_property_id, p_actor_user_id, p_actor_email);
  END LOOP;

  -- Delete unassigned portfolio-level expenses and budgets if any
  DELETE FROM public.expenses WHERE portfolio_id = target_portfolio_id;
  DELETE FROM public.budgets WHERE portfolio_id = target_portfolio_id;

  -- Finally delete the portfolio
  DELETE FROM public.portfolios WHERE id = target_portfolio_id;
END;
$$;
