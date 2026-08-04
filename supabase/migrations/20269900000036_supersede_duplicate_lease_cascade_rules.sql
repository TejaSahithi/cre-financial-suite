-- Root cause found immediately after using supersede_duplicate_lease for
-- real (Hudson & Pine, property A1): marking the duplicate LEASE as
-- superseded left its lease_expense_rules rows at approval_status=
-- 'approved', because evaluate_cam_readiness's POLICY_MISSING check reads
-- lease_expense_rules.approval_status directly and does not join through
-- to the parent lease's status. Result: readiness still reported 13
-- blocking "approved rule has not been materialized" issues for rules
-- belonging to a lease that's no longer active -- correct data, wrong
-- conclusion, because materialize_lease_recovery_policy correctly still
-- refuses to materialize a policy for a superseded lease's dateless rules.
--
-- Fix: cascade the supersession to the duplicate lease's own approved
-- rules, same 'superseded' value already used for leases.status,
-- lease_recovery_policies.status, and cam_expense_inputs.publication_status
-- -- one consistent lifecycle value across the whole CAM data model,
-- rather than teaching every consumer query (readiness, CAM Setup,
-- policies list, etc.) to separately join through to lease status. Only
-- rules currently 'approved' are touched -- draft/rejected/other states on
-- the duplicate lease are left as their own historical record.
CREATE OR REPLACE FUNCTION public.supersede_duplicate_lease(
  p_org_id UUID,
  p_duplicate_lease_id UUID,
  p_canonical_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_duplicate public.leases%ROWTYPE;
  v_canonical public.leases%ROWTYPE;
  v_updated public.leases%ROWTYPE;
  v_before JSONB;
  v_after JSONB;
  v_audit_log_id UUID;
  v_next_extraction JSONB;
  v_rules_superseded INT := 0;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_duplicate_lease_id IS NULL THEN
    RAISE EXCEPTION 'duplicate_lease_id is required';
  END IF;
  IF p_canonical_lease_id IS NULL THEN
    RAISE EXCEPTION 'canonical_lease_id is required';
  END IF;
  IF p_duplicate_lease_id = p_canonical_lease_id THEN
    RAISE EXCEPTION 'duplicate_lease_id and canonical_lease_id must be different leases';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'reason is required';
  END IF;

  SELECT * INTO v_duplicate FROM public.leases WHERE id = p_duplicate_lease_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Duplicate lease not found for this organization';
  END IF;

  SELECT * INTO v_canonical FROM public.leases WHERE id = p_canonical_lease_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Canonical lease not found for this organization';
  END IF;

  IF COALESCE(v_canonical.status, '') = 'superseded' THEN
    RAISE EXCEPTION 'Canonical lease % is itself superseded -- point to its own canonical lease instead', p_canonical_lease_id;
  END IF;

  IF v_duplicate.status = 'superseded' AND v_duplicate.superseded_by_lease_id = p_canonical_lease_id THEN
    RETURN jsonb_build_object(
      'lease_id', v_duplicate.id, 'status', v_duplicate.status,
      'superseded_by_lease_id', v_duplicate.superseded_by_lease_id, 'already_superseded', true
    );
  END IF;
  IF v_duplicate.status = 'superseded' AND v_duplicate.superseded_by_lease_id IS DISTINCT FROM p_canonical_lease_id THEN
    RAISE EXCEPTION 'Lease % is already superseded by a different lease (%) -- resolve that conflict explicitly before repointing it', p_duplicate_lease_id, v_duplicate.superseded_by_lease_id;
  END IF;

  v_before := jsonb_build_object('status', v_duplicate.status, 'abstract_status', v_duplicate.abstract_status, 'superseded_by_lease_id', v_duplicate.superseded_by_lease_id);

  v_next_extraction := jsonb_set(
    COALESCE(v_duplicate.extraction_data, '{}'::jsonb),
    ARRAY['superseded'],
    jsonb_build_object('reason', p_reason, 'superseded_at', v_now, 'superseded_by_lease_id', p_canonical_lease_id, 'actor_user_id', p_actor_user_id, 'actor_email', p_actor_email),
    true
  );

  PERFORM set_config('app.skip_lease_audit_trigger', 'true', true);

  UPDATE public.leases
     SET status = 'superseded',
         abstract_status = 'superseded',
         superseded_by_lease_id = p_canonical_lease_id,
         extraction_data = v_next_extraction,
         updated_at = v_now
   WHERE id = p_duplicate_lease_id AND org_id = p_org_id
  RETURNING * INTO v_updated;

  -- Cascade: the duplicate's own approved rules no longer belong to an
  -- active lease and must stop appearing as materialization-pending
  -- readiness blockers or publish-to-CAM candidates.
  UPDATE public.lease_expense_rules
     SET approval_status = 'superseded', updated_at = v_now
   WHERE lease_id = p_duplicate_lease_id
     AND approval_status = 'approved';
  GET DIAGNOSTICS v_rules_superseded = ROW_COUNT;

  v_after := jsonb_build_object('status', v_updated.status, 'abstract_status', v_updated.abstract_status, 'superseded_by_lease_id', v_updated.superseded_by_lease_id);

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_updated.property_id, 'Lease', p_duplicate_lease_id::TEXT, 'lease_superseded_as_duplicate',
    p_actor_user_id, p_actor_email, 'info', 'edge_function', v_before, v_after,
    jsonb_build_object('reason', p_reason, 'canonical_lease_id', p_canonical_lease_id, 'tenant_name', v_duplicate.tenant_name, 'rules_superseded', v_rules_superseded),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  RETURN jsonb_build_object(
    'lease_id', v_updated.id, 'status', v_updated.status, 'abstract_status', v_updated.abstract_status,
    'superseded_by_lease_id', v_updated.superseded_by_lease_id, 'already_superseded', false,
    'rules_superseded', v_rules_superseded, 'audit_log_id', v_audit_log_id
  );
END;
$$;
