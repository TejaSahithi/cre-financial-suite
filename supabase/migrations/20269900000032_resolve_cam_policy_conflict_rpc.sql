-- CAM Setup automation pass, item G (rule resolution): evaluate_cam_readiness
-- already reports POLICY_MISSING (no policy for an approved rule -> blocking)
-- and POLICY_CONFLICT (two active policies, same lease+category, overlapping
-- effective windows -> blocking) -- see
-- 20269900000013_cam_blueprint_readiness_engine.sql:80-115. What was missing
-- is any controlled way to actually RESOLVE a POLICY_CONFLICT: Step 4
-- (Policies) is a read-only display, and no RPC existed to supersede one of
-- the two conflicting policies. The instruction is explicit that this must
-- be "a controlled versioned override with evidence," not "unrestricted
-- manual rule selection" -- so this RPC does not let a caller supersede any
-- policy at will. It requires the two policies to actually be in conflict
-- (same lease, overlapping effective window, sharing at least one expense
-- category step) before it will act, and always requires a reason.
CREATE OR REPLACE FUNCTION public.resolve_cam_policy_conflict(
  p_org_id UUID,
  p_policy_id_to_supersede UUID,
  p_reason TEXT,
  p_actor_user_id UUID,
  p_actor_email TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_policy public.lease_recovery_policies%ROWTYPE;
  v_reason TEXT := NULLIF(trim(COALESCE(p_reason, '')), '');
  v_conflicting_policy_id UUID;
  v_now TIMESTAMPTZ := now();
  v_audit_log_id UUID;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_policy_id_to_supersede IS NULL THEN
    RAISE EXCEPTION 'policy_id_to_supersede is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'reason is required to resolve a policy conflict';
  END IF;

  SELECT * INTO v_policy
    FROM public.lease_recovery_policies
   WHERE id = p_policy_id_to_supersede AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Policy not found for this organization';
  END IF;
  IF v_policy.status = 'superseded' THEN
    RAISE EXCEPTION 'Policy is already superseded';
  END IF;

  -- Only act if this policy is genuinely in conflict with another active
  -- policy on the same lease (same category, overlapping effective window)
  -- -- the exact condition evaluate_cam_readiness uses to raise
  -- POLICY_CONFLICT in the first place. This is what keeps the RPC from
  -- being usable as unrestricted manual policy selection.
  SELECT p2.id INTO v_conflicting_policy_id
    FROM public.lease_recovery_policies p2
    JOIN public.lease_recovery_policy_steps s2 ON s2.policy_id = p2.id AND s2.expense_category_id IS NOT NULL
    JOIN public.lease_recovery_policy_steps s1 ON s1.policy_id = v_policy.id AND s1.expense_category_id = s2.expense_category_id
   WHERE p2.org_id = p_org_id
     AND p2.lease_id = v_policy.lease_id
     AND p2.id <> v_policy.id
     AND p2.status <> 'superseded'
     AND daterange(p2.effective_from, p2.effective_to, '[]') && daterange(v_policy.effective_from, v_policy.effective_to, '[]')
   LIMIT 1;

  IF v_conflicting_policy_id IS NULL THEN
    RAISE EXCEPTION 'Policy % is not in conflict with any other active policy on this lease -- nothing to resolve', p_policy_id_to_supersede;
  END IF;

  UPDATE public.lease_recovery_policies
     SET status = 'superseded',
         superseded_by_policy_id = v_conflicting_policy_id,
         notes = COALESCE(notes || E'\n', '') || format('Superseded to resolve POLICY_CONFLICT with policy %s: %s', v_conflicting_policy_id, v_reason),
         updated_at = v_now
   WHERE id = v_policy.id;

  INSERT INTO public.audit_logs (
    org_id, entity_type, entity_id, action, actor_user_id, actor_email,
    severity, source, metadata, "timestamp"
  ) VALUES (
    p_org_id, 'LeaseRecoveryPolicy', p_policy_id_to_supersede::TEXT, 'cam_policy_conflict_resolved',
    p_actor_user_id, p_actor_email, 'info', 'edge_function',
    jsonb_build_object(
      'lease_id', v_policy.lease_id, 'superseded_policy_id', p_policy_id_to_supersede,
      'kept_active_policy_id', v_conflicting_policy_id, 'reason', v_reason
    ),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  RETURN jsonb_build_object(
    'superseded_policy_id', p_policy_id_to_supersede,
    'kept_active_policy_id', v_conflicting_policy_id,
    'audit_log_id', v_audit_log_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_cam_policy_conflict(UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_cam_policy_conflict(UUID, UUID, TEXT, UUID, TEXT) TO service_role;
