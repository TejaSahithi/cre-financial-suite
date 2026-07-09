-- Enterprise hardening Phase 3 (part 1): server-side validation + audit
-- logging for property_config / lease_config writes.
--
-- These are NOT run-tracked "workflow" actions in the sense of
-- docs/server-owned-workflow-pattern.md (approve/send-to-cam/publish) — a
-- config save has no duplicate-side-effect risk from a retry (it's an
-- idempotent upsert of current settings, not a one-time state transition),
-- so there is no idempotency-run table here. What Phase 3 adds is what was
-- actually missing: server-side range validation of the config_values JSONB
-- payload (the existing CHECK constraints only cover the three top-level
-- columns, not the percentages/rates inside config_values), and an
-- audit_logs row on every write, in the same transaction as the upsert.
--
-- RLS on both tables is left exactly as-is (still permits direct
-- can_write_org_data(org_id) writes) — locking that down is Phase 6's job,
-- done only after callers have moved onto these RPCs.

CREATE OR REPLACE FUNCTION public.save_property_cam_config(
  p_org_id UUID,
  p_property_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_cam_calculation_method TEXT,
  p_expense_recovery_method TEXT,
  p_fiscal_year_start INT,
  p_config_values JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_before public.property_config%ROWTYPE;
  v_after public.property_config%ROWTYPE;
  v_admin_fee_pct NUMERIC;
  v_management_fee_pct NUMERIC;
  v_gross_up_target_occupancy_pct NUMERIC;
  v_cam_cap_rate NUMERIC;
  v_audit_log_id UUID;
  v_response JSONB;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_property_id IS NULL THEN
    RAISE EXCEPTION 'property_id is required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = p_property_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Property not found for this organization';
  END IF;

  IF p_cam_calculation_method NOT IN ('pro_rata', 'fixed', 'capped') THEN
    RAISE EXCEPTION 'cam_calculation_method must be one of pro_rata, fixed, capped';
  END IF;
  IF p_expense_recovery_method NOT IN ('base_year', 'full', 'none') THEN
    RAISE EXCEPTION 'expense_recovery_method must be one of base_year, full, none';
  END IF;
  IF p_fiscal_year_start IS NULL OR p_fiscal_year_start < 1 OR p_fiscal_year_start > 12 THEN
    RAISE EXCEPTION 'fiscal_year_start must be between 1 and 12';
  END IF;

  v_admin_fee_pct := (p_config_values->>'admin_fee_pct')::NUMERIC;
  v_management_fee_pct := (p_config_values->>'management_fee_pct')::NUMERIC;
  v_gross_up_target_occupancy_pct := (p_config_values->>'gross_up_target_occupancy_pct')::NUMERIC;
  v_cam_cap_rate := (p_config_values->>'cam_cap_rate')::NUMERIC;

  IF v_admin_fee_pct IS NOT NULL AND (v_admin_fee_pct < 0 OR v_admin_fee_pct > 100) THEN
    RAISE EXCEPTION 'admin_fee_pct must be between 0 and 100';
  END IF;
  IF v_management_fee_pct IS NOT NULL AND (v_management_fee_pct < 0 OR v_management_fee_pct > 100) THEN
    RAISE EXCEPTION 'management_fee_pct must be between 0 and 100';
  END IF;
  IF v_gross_up_target_occupancy_pct IS NOT NULL AND (v_gross_up_target_occupancy_pct < 0 OR v_gross_up_target_occupancy_pct > 100) THEN
    RAISE EXCEPTION 'gross_up_target_occupancy_pct must be between 0 and 100';
  END IF;
  IF v_cam_cap_rate IS NOT NULL AND v_cam_cap_rate < 0 THEN
    RAISE EXCEPTION 'cam_cap_rate must not be negative';
  END IF;

  SELECT * INTO v_before
    FROM public.property_config
   WHERE org_id = p_org_id AND property_id = p_property_id;

  INSERT INTO public.property_config (
    org_id, property_id, cam_calculation_method, expense_recovery_method,
    fiscal_year_start, config_values, updated_at
  )
  VALUES (
    p_org_id, p_property_id, p_cam_calculation_method, p_expense_recovery_method,
    p_fiscal_year_start, COALESCE(p_config_values, '{}'::jsonb), v_now
  )
  ON CONFLICT (org_id, property_id) DO UPDATE SET
    cam_calculation_method = EXCLUDED.cam_calculation_method,
    expense_recovery_method = EXCLUDED.expense_recovery_method,
    fiscal_year_start = EXCLUDED.fiscal_year_start,
    config_values = EXCLUDED.config_values,
    updated_at = EXCLUDED.updated_at
  RETURNING * INTO v_after;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, p_property_id, 'PropertyConfig', p_property_id::TEXT, 'property_cam_config_saved',
    p_actor_user_id, p_actor_email, 'info', 'edge_function',
    to_jsonb(v_before), to_jsonb(v_after),
    jsonb_build_object('property_id', p_property_id),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object('row', to_jsonb(v_after), 'audit_log_id', v_audit_log_id);
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.save_property_cam_config(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, INT, JSONB
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.save_property_cam_config(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, INT, JSONB
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.save_lease_config(
  p_org_id UUID,
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_base_year INT,
  p_excluded_expenses TEXT[],
  p_config_values JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_lease public.leases%ROWTYPE;
  v_before public.lease_config%ROWTYPE;
  v_after public.lease_config%ROWTYPE;
  v_cam_cap_rate NUMERIC;
  v_cam_cap NUMERIC;
  v_base_year_amount NUMERIC;
  v_expense_stop_amount NUMERIC;
  v_weight_factor NUMERIC;
  v_management_fee_pct NUMERIC;
  v_controllable_cap_rate NUMERIC;
  v_audit_log_id UUID;
  v_response JSONB;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_lease_id IS NULL THEN
    RAISE EXCEPTION 'lease_id is required';
  END IF;

  SELECT * INTO v_lease FROM public.leases WHERE id = p_lease_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;

  IF p_base_year IS NOT NULL AND (p_base_year < 1900 OR p_base_year > 2200) THEN
    RAISE EXCEPTION 'base_year is out of range';
  END IF;

  v_cam_cap_rate := (p_config_values->>'cam_cap_rate')::NUMERIC;
  v_cam_cap := (p_config_values->>'cam_cap')::NUMERIC;
  v_base_year_amount := (p_config_values->>'base_year_amount')::NUMERIC;
  v_expense_stop_amount := (p_config_values->>'expense_stop_amount')::NUMERIC;
  v_weight_factor := (p_config_values->>'weight_factor')::NUMERIC;
  v_management_fee_pct := (p_config_values->>'management_fee_pct')::NUMERIC;
  v_controllable_cap_rate := (p_config_values->>'controllable_cap_rate')::NUMERIC;

  IF v_cam_cap_rate IS NOT NULL AND v_cam_cap_rate < 0 THEN
    RAISE EXCEPTION 'cam_cap_rate must not be negative';
  END IF;
  IF v_cam_cap IS NOT NULL AND v_cam_cap < 0 THEN
    RAISE EXCEPTION 'cam_cap must not be negative';
  END IF;
  IF v_base_year_amount IS NOT NULL AND v_base_year_amount < 0 THEN
    RAISE EXCEPTION 'base_year_amount must not be negative';
  END IF;
  IF v_expense_stop_amount IS NOT NULL AND v_expense_stop_amount < 0 THEN
    RAISE EXCEPTION 'expense_stop_amount must not be negative';
  END IF;
  IF v_weight_factor IS NOT NULL AND (v_weight_factor < 0 OR v_weight_factor > 1) THEN
    RAISE EXCEPTION 'weight_factor must be between 0 and 1';
  END IF;
  IF v_management_fee_pct IS NOT NULL AND (v_management_fee_pct < 0 OR v_management_fee_pct > 100) THEN
    RAISE EXCEPTION 'management_fee_pct must be between 0 and 100';
  END IF;
  IF v_controllable_cap_rate IS NOT NULL AND v_controllable_cap_rate < 0 THEN
    RAISE EXCEPTION 'controllable_cap_rate must not be negative';
  END IF;

  SELECT * INTO v_before
    FROM public.lease_config
   WHERE org_id = p_org_id AND lease_id = p_lease_id;

  INSERT INTO public.lease_config (
    org_id, lease_id, base_year, excluded_expenses, config_values, updated_at
  )
  VALUES (
    p_org_id, p_lease_id, p_base_year, COALESCE(p_excluded_expenses, ARRAY[]::TEXT[]),
    COALESCE(p_config_values, '{}'::jsonb), v_now
  )
  ON CONFLICT (org_id, lease_id) DO UPDATE SET
    base_year = EXCLUDED.base_year,
    excluded_expenses = EXCLUDED.excluded_expenses,
    config_values = EXCLUDED.config_values,
    updated_at = EXCLUDED.updated_at
  RETURNING * INTO v_after;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_lease.property_id, 'LeaseConfig', p_lease_id::TEXT, 'lease_cam_config_saved',
    p_actor_user_id, p_actor_email, 'info', 'edge_function',
    to_jsonb(v_before), to_jsonb(v_after),
    jsonb_build_object('lease_id', p_lease_id),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object('row', to_jsonb(v_after), 'audit_log_id', v_audit_log_id);
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.save_lease_config(
  UUID, UUID, UUID, TEXT, INT, TEXT[], JSONB
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.save_lease_config(
  UUID, UUID, UUID, TEXT, INT, TEXT[], JSONB
) TO authenticated, service_role;
