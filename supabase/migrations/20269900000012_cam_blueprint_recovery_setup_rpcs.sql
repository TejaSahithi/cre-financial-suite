-- ===========================================================================
-- Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 2B: recovery
-- setup RPCs.
--
-- Four small, idempotent RPCs: create_recovery_calendar, create_recovery_
-- period, create_recovery_pool (templates and period instances), and
-- assign_cam_input_to_pool. Each one is a thin, safe-to-rerun wrapper
-- around the natural-uniqueness constraints already enforced by the Phase
-- 1 (hardened) schema — "idempotent" here means "find-or-create," not
-- "insert and swallow the conflict error," so a caller always gets back a
-- real row either way.
--
-- assign_cam_input_to_pool never creates a new expense or cam_expense_inputs
-- row — it only ever inserts a cam_input_pool_assignments row pointing at
-- the EXISTING published cam_expense_inputs row, per the blueprint's own
-- "assign finalized CAM-eligible cam_expense_inputs to pools without
-- duplicating the source expense record."
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.create_recovery_calendar(
  p_org_id UUID,
  p_property_id UUID,
  p_name TEXT,
  p_calendar_type TEXT,
  p_fiscal_start_month INT,
  p_actor_user_id UUID,
  p_actor_email TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_calendar public.recovery_calendars%ROWTYPE;
  v_created BOOLEAN := false;
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF NULLIF(trim(COALESCE(p_name, '')), '') IS NULL THEN RAISE EXCEPTION 'name is required'; END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'actor_user_id is required'; END IF;

  IF p_property_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.properties WHERE id = p_property_id AND org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'Property % not found for this organization', p_property_id;
  END IF;

  SELECT * INTO v_calendar FROM public.recovery_calendars
   WHERE org_id = p_org_id AND property_id IS NOT DISTINCT FROM p_property_id AND name = p_name;

  IF NOT FOUND THEN
    INSERT INTO public.recovery_calendars (org_id, property_id, name, calendar_type, fiscal_start_month)
    VALUES (p_org_id, p_property_id, p_name, COALESCE(p_calendar_type, 'calendar_year'), COALESCE(p_fiscal_start_month, 1))
    RETURNING * INTO v_calendar;
    v_created := true;

    INSERT INTO public.audit_logs (org_id, property_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, after, "timestamp")
    VALUES (p_org_id, p_property_id, 'RecoveryCalendar', v_calendar.id::TEXT, 'recovery_calendar_created', p_actor_user_id, p_actor_email, 'info', 'edge_function', to_jsonb(v_calendar), v_now);
  END IF;

  RETURN jsonb_build_object('calendar', to_jsonb(v_calendar), 'created', v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.create_recovery_calendar(UUID, UUID, TEXT, TEXT, INT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_recovery_calendar(UUID, UUID, TEXT, TEXT, INT, UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.create_recovery_period(
  p_org_id UUID,
  p_calendar_id UUID,
  p_start_date DATE,
  p_end_date DATE,
  p_label TEXT,
  p_actor_user_id UUID,
  p_actor_email TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_calendar public.recovery_calendars%ROWTYPE;
  v_period public.recovery_periods%ROWTYPE;
  v_created BOOLEAN := false;
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_calendar_id IS NULL THEN RAISE EXCEPTION 'calendar_id is required'; END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL THEN RAISE EXCEPTION 'start_date and end_date are required'; END IF;
  IF p_end_date < p_start_date THEN RAISE EXCEPTION 'end_date must not precede start_date'; END IF;
  IF NULLIF(trim(COALESCE(p_label, '')), '') IS NULL THEN RAISE EXCEPTION 'label is required'; END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'actor_user_id is required'; END IF;

  SELECT * INTO v_calendar FROM public.recovery_calendars WHERE id = p_calendar_id AND org_id = p_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recovery calendar % not found for this organization', p_calendar_id; END IF;

  SELECT * INTO v_period FROM public.recovery_periods
   WHERE org_id = p_org_id AND calendar_id = p_calendar_id AND start_date = p_start_date AND end_date = p_end_date;

  IF NOT FOUND THEN
    INSERT INTO public.recovery_periods (org_id, calendar_id, start_date, end_date, label)
    VALUES (p_org_id, p_calendar_id, p_start_date, p_end_date, p_label)
    RETURNING * INTO v_period;
    v_created := true;

    INSERT INTO public.audit_logs (org_id, property_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, after, "timestamp")
    VALUES (p_org_id, v_calendar.property_id, 'RecoveryPeriod', v_period.id::TEXT, 'recovery_period_created', p_actor_user_id, p_actor_email, 'info', 'edge_function', to_jsonb(v_period), v_now);
  END IF;

  RETURN jsonb_build_object('period', to_jsonb(v_period), 'created', v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.create_recovery_period(UUID, UUID, DATE, DATE, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_recovery_period(UUID, UUID, DATE, DATE, TEXT, UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.create_recovery_pool(
  p_org_id UUID,
  p_property_id UUID,
  p_name TEXT,
  p_pool_type TEXT,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_is_template BOOLEAN,
  p_period_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_pool public.recovery_pools%ROWTYPE;
  v_created BOOLEAN := false;
  v_is_template BOOLEAN := COALESCE(p_is_template, false);
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_property_id IS NULL THEN RAISE EXCEPTION 'property_id is required'; END IF;
  IF NULLIF(trim(COALESCE(p_name, '')), '') IS NULL THEN RAISE EXCEPTION 'name is required'; END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'actor_user_id is required'; END IF;
  IF NOT v_is_template AND p_period_id IS NULL THEN
    RAISE EXCEPTION 'period_id is required unless is_template is true';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = p_property_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Property % not found for this organization', p_property_id;
  END IF;

  IF p_period_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.recovery_periods WHERE id = p_period_id AND org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'Recovery period % not found for this organization', p_period_id;
  END IF;

  -- Hierarchy validation for the pool's own scope (mirrors
  -- _shared/cam-engine-v2/validation/hierarchy.ts's assertValidPoolScope —
  -- this SQL-side check exists because the RPC is the actual write path;
  -- the TS helper is for callers that need to validate before invoking it,
  -- e.g. a future readiness check).
  IF p_scope_type = 'property' THEN
    IF p_scope_id IS DISTINCT FROM p_property_id THEN
      RAISE EXCEPTION 'scope_id must equal property_id when scope_type is property';
    END IF;
  ELSIF p_scope_type = 'building' THEN
    IF p_scope_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.buildings WHERE id = p_scope_id AND property_id = p_property_id AND org_id = p_org_id
    ) THEN
      RAISE EXCEPTION 'Building % does not belong to property % in organization %', p_scope_id, p_property_id, p_org_id;
    END IF;
  ELSIF p_scope_type = 'custom' THEN
    NULL; -- no single physical node to validate; membership lives in recovery_pool_scope_members
  ELSE
    RAISE EXCEPTION 'Invalid scope_type "%" — must be property, building, or custom', p_scope_type;
  END IF;

  IF v_is_template THEN
    SELECT * INTO v_pool FROM public.recovery_pools WHERE org_id = p_org_id AND property_id = p_property_id AND name = p_name AND is_template;
  ELSE
    SELECT * INTO v_pool FROM public.recovery_pools WHERE org_id = p_org_id AND period_id = p_period_id AND property_id = p_property_id AND name = p_name AND NOT is_template;
  END IF;

  IF NOT FOUND THEN
    INSERT INTO public.recovery_pools (org_id, period_id, is_template, property_id, name, pool_type, scope_type, scope_id)
    VALUES (p_org_id, CASE WHEN v_is_template THEN NULL ELSE p_period_id END, v_is_template, p_property_id, p_name, COALESCE(p_pool_type, 'property'), p_scope_type, p_scope_id)
    RETURNING * INTO v_pool;
    v_created := true;

    INSERT INTO public.audit_logs (org_id, property_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, after, "timestamp")
    VALUES (p_org_id, p_property_id, 'RecoveryPool', v_pool.id::TEXT, 'recovery_pool_created', p_actor_user_id, p_actor_email, 'info', 'edge_function', to_jsonb(v_pool), v_now);
  END IF;

  RETURN jsonb_build_object('pool', to_jsonb(v_pool), 'created', v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.create_recovery_pool(UUID, UUID, TEXT, TEXT, TEXT, UUID, BOOLEAN, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_recovery_pool(UUID, UUID, TEXT, TEXT, TEXT, UUID, BOOLEAN, UUID, UUID, TEXT) TO service_role;

-- Assigns an EXISTING published, CAM-eligible cam_expense_inputs row to a
-- pool. Never creates a new expense or cam_expense_inputs row — only a
-- cam_input_pool_assignments row referencing the existing one.
CREATE OR REPLACE FUNCTION public.assign_cam_input_to_pool(
  p_org_id UUID,
  p_cam_expense_input_id UUID,
  p_recovery_pool_id UUID,
  p_amount NUMERIC,
  p_assignment_method TEXT,
  p_actor_user_id UUID,
  p_actor_email TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_input public.cam_expense_inputs%ROWTYPE;
  v_pool public.recovery_pools%ROWTYPE;
  v_assignment public.cam_input_pool_assignments%ROWTYPE;
  v_created BOOLEAN := false;
  v_amount NUMERIC;
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_cam_expense_input_id IS NULL THEN RAISE EXCEPTION 'cam_expense_input_id is required'; END IF;
  IF p_recovery_pool_id IS NULL THEN RAISE EXCEPTION 'recovery_pool_id is required'; END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'actor_user_id is required'; END IF;

  SELECT * INTO v_input FROM public.cam_expense_inputs WHERE id = p_cam_expense_input_id AND org_id = p_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'cam_expense_input % not found for this organization', p_cam_expense_input_id; END IF;

  -- The CAM publication boundary (hardened earlier this program): only a
  -- currently PUBLISHED input may be assigned to a pool. A withdrawn or
  -- superseded input is exactly what compute-cam already refuses to read;
  -- pool assignment must honor the same boundary, not create a side
  -- channel around it.
  IF v_input.publication_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'cam_expense_input % is not published (publication_status=%) and cannot be assigned to a pool', p_cam_expense_input_id, v_input.publication_status;
  END IF;

  SELECT * INTO v_pool FROM public.recovery_pools WHERE id = p_recovery_pool_id AND org_id = p_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'recovery_pool % not found for this organization', p_recovery_pool_id; END IF;
  IF v_pool.property_id IS DISTINCT FROM v_input.property_id THEN
    RAISE EXCEPTION 'cam_expense_input % (property %) cannot be assigned to pool % (property %) — cross-property assignment is not permitted', p_cam_expense_input_id, v_input.property_id, p_recovery_pool_id, v_pool.property_id;
  END IF;

  v_amount := COALESCE(p_amount, v_input.amount);
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'A positive assignment amount is required';
  END IF;

  SELECT * INTO v_assignment FROM public.cam_input_pool_assignments
   WHERE org_id = p_org_id AND cam_expense_input_id = p_cam_expense_input_id AND recovery_pool_id = p_recovery_pool_id;

  IF NOT FOUND THEN
    INSERT INTO public.cam_input_pool_assignments (org_id, cam_expense_input_id, recovery_pool_id, amount, assignment_method, approved_by)
    VALUES (p_org_id, p_cam_expense_input_id, p_recovery_pool_id, v_amount, COALESCE(p_assignment_method, 'automatic'), p_actor_user_id)
    RETURNING * INTO v_assignment;
    v_created := true;

    INSERT INTO public.audit_logs (org_id, property_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, after, "timestamp")
    VALUES (p_org_id, v_pool.property_id, 'CamInputPoolAssignment', v_assignment.id::TEXT, 'cam_input_assigned_to_pool', p_actor_user_id, p_actor_email, 'info', 'edge_function', to_jsonb(v_assignment), v_now);
  END IF;

  RETURN jsonb_build_object('assignment', to_jsonb(v_assignment), 'created', v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.assign_cam_input_to_pool(UUID, UUID, UUID, NUMERIC, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_cam_input_to_pool(UUID, UUID, UUID, NUMERIC, TEXT, UUID, TEXT) TO service_role;
