-- Phase 2 diagnostic (Actual Expense -> CAM proof) found the first genuinely
-- broken handoff in the chain: cam_expense_inputs.variability defaults to
-- 'unknown' (migration 20269900000020, ADR-CAM-007) and the CAM V2 engine
-- correctly, intentionally refuses to gross-up or finalize a pool/lease
-- allocation while any assigned input's variability is 'unknown'
-- (VARIABILITY_UNKNOWN, blocking) -- that gate itself is correct and is not
-- touched here.
--
-- recovery_pool_categories.variability_default exists specifically to seed
-- this value (same migration, same ADR) via cam-setup-actions-v2's
-- assign_pool_category action. But nothing in the codebase ever copies it
-- onto the cam_expense_input row it's supposed to classify -- grepped every
-- migration and every edge function for a SET/UPDATE of
-- cam_expense_inputs.variability (not _default) and for any p_variability
-- RPC parameter: zero matches anywhere. So every published CAM input in
-- this application is permanently stuck at 'unknown', and gross-up (and
-- therefore final tenant recovery) can never complete for any property,
-- regardless of how correctly CAM Setup is otherwise configured.
--
-- Root-cause fix, not a workaround: assign_cam_input_to_pool is the one
-- place an input first gains a (pool, category) context to resolve a
-- default from, so it backfills variability from the matching
-- recovery_pool_categories.variability_default -- once, only while the
-- input is still at the column's own 'unknown' default (never overwrites
-- an explicit prior classification, and reruns are idempotent since a
-- resolved value no longer matches 'unknown'). No other behavior of this
-- function changes; no other table, RPC, or the engine itself is touched.
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
  v_variability_default TEXT;
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

  -- Backfill the one field nothing else in the codebase ever populates.
  -- Only touches rows still at the column default; an explicit prior
  -- classification (however it got there) is never overwritten.
  IF v_input.variability = 'unknown' THEN
    SELECT rpc.variability_default INTO v_variability_default
      FROM public.recovery_pool_categories rpc
     WHERE rpc.pool_id = p_recovery_pool_id
       AND rpc.expense_category_id = v_input.expense_category_id;

    IF v_variability_default IS NOT NULL AND v_variability_default <> 'unknown' THEN
      UPDATE public.cam_expense_inputs
         SET variability = v_variability_default, updated_at = v_now
       WHERE id = p_cam_expense_input_id AND variability = 'unknown';
    END IF;
  END IF;

  RETURN jsonb_build_object('assignment', to_jsonb(v_assignment), 'created', v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.assign_cam_input_to_pool(UUID, UUID, UUID, NUMERIC, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_cam_input_to_pool(UUID, UUID, UUID, NUMERIC, TEXT, UUID, TEXT) TO service_role;
