-- A classification marked recoverability_result='conditional' has
-- condition_resolved=false by default (20260624010000_expense_condition_resolution.sql)
-- and the CAM-publish RPC hard-rejects it until condition_resolved=true
-- (20269900000030_publish_cam_expense_input_service_period.sql:200-202).
-- Audit confirmed no reachable code path anywhere -- UI, edge function, or
-- RPC -- ever flips condition_resolved on an existing row: it is written
-- only as a byproduct of the initial/re-classification match logic (which
-- always derives it FROM the current conditional-ness, never resolves it),
-- and manual_override_expense_classification only hardcodes
-- classification_status='finalized' regardless of its own override-value
-- parameters. Net effect: a genuinely conditional expense is permanently
-- stuck and can never reach CAM. This RPC is the missing resolve action,
-- following the same reason/evidence/actor/audit-log pattern as every
-- other controlled override in this codebase (e.g.
-- resolve_cam_input_category, resolve_cam_policy_conflict).

CREATE OR REPLACE FUNCTION public.resolve_expense_classification_condition(
  p_org_id UUID,
  p_classification_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_resolution TEXT,               -- 'recoverable' | 'non_recoverable'
  p_reason TEXT,
  p_evidence JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_classification public.expense_classifications%ROWTYPE;
  v_updated public.expense_classifications%ROWTYPE;
  v_audit_log_id UUID;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_classification_id IS NULL THEN
    RAISE EXCEPTION 'classification_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF p_resolution NOT IN ('recoverable', 'non_recoverable') THEN
    RAISE EXCEPTION 'resolution must be recoverable or non_recoverable';
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'reason is required';
  END IF;

  SELECT * INTO v_classification
    FROM public.expense_classifications
   WHERE id = p_classification_id AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Classification not found for this organization';
  END IF;

  -- Idempotent no-op MUST be checked before the "must currently be
  -- conditional" guard below: resolving sets recoverability_result to the
  -- resolution itself, so a row that was already resolved to this exact
  -- outcome is -- by definition -- no longer literally 'conditional'. A
  -- caller retrying the same resolve call (e.g. after a network timeout,
  -- unsure if the first attempt landed) must get back a clean no-op, not a
  -- confusing "not conditional" exception for the very state it caused.
  IF v_classification.condition_resolved IS TRUE
     AND v_classification.condition_result IS NOT DISTINCT FROM p_resolution
  THEN
    RETURN jsonb_build_object('classification', to_jsonb(v_classification), 'changed', false);
  END IF;

  IF v_classification.recoverability_result IS DISTINCT FROM 'conditional' THEN
    RAISE EXCEPTION 'Classification is not conditional (currently: %)', COALESCE(v_classification.recoverability_result, 'null');
  END IF;

  -- cam_eligible is a separate gate the publish RPC also checks (confirmed:
  -- send_expense_classification_to_cam_workflow rejects unless cam_eligible
  -- = 'yes', independent of recoverability_result/condition_resolved).
  -- Resolving the condition IS the decision that determines eligibility, so
  -- this must set it too -- otherwise a "resolved" row would still silently
  -- fail Send-to-CAM on the very next click, landing right back in a
  -- dead-end that just looks different from the original bug.
  UPDATE public.expense_classifications SET
    recoverability_result = p_resolution,
    recovery_status = p_resolution,
    condition_resolved = true,
    condition_result = p_resolution,
    cam_eligible = CASE WHEN p_resolution = 'recoverable' THEN 'yes' ELSE 'no' END,
    reviewed_by = p_actor_user_id,
    reviewed_at = v_now,
    updated_at = v_now
   WHERE id = p_classification_id AND org_id = p_org_id
  RETURNING * INTO v_updated;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_updated.property_id, 'ExpenseClassification', p_classification_id::TEXT,
    'expense_classification_condition_resolved', p_actor_user_id, p_actor_email,
    'info', 'edge_function', to_jsonb(v_classification), to_jsonb(v_updated),
    jsonb_build_object('resolution', p_resolution, 'reason', p_reason, 'evidence', p_evidence),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  RETURN jsonb_build_object('classification', to_jsonb(v_updated), 'changed', true, 'audit_log_id', v_audit_log_id);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_expense_classification_condition(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.resolve_expense_classification_condition(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB
) TO service_role;
