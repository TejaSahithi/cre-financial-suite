-- Enterprise hardening Phase 6CAM-1: server-own CAMSetup.jsx's profile
-- edit (saveMutation) and approval (approveMutation) actions.
--
-- Investigation (read directly from src/pages/CAMSetup.jsx, not assumed):
--   * saveMutation calls supabase.from("cam_profiles").update(patch).eq("id", id)
--     directly under the caller's own RLS session. The patch is exactly
--     EditForm's 12 fields: cam_structure, tenant_rsf, building_rsf,
--     tenant_pro_rata_share, admin_fee_percent, gross_up_percent,
--     cam_cap_type, cam_cap_percent, estimate_frequency,
--     reconciliation_frequency, status, notes. No audit of any kind today.
--   * approveMutation re-derives computeEffectiveStatus() client-side
--     (mirrors this migration's v_next_building_rsf/... guard below) and
--     throws before writing if the profile would still be manual_required,
--     then writes status='approved', approved_at=now(), and
--     approved_by: null -- with a code comment reading "populated via DB
--     trigger or auth context in real deployment". Confirmed directly
--     against the live schema (\d cam_profiles) that no such trigger
--     exists: cam_profiles carries exactly one trigger,
--     set_cam_profiles_updated_at, which only bumps updated_at and does
--     not touch approved_by. So today, EVERY CAM profile approval writes
--     approved_by = NULL, permanently, regardless of who clicked Approve --
--     the actor identity is silently lost. This is the exact scenario the
--     task's "Important" instruction anticipated: reporting it here rather
--     than inventing a new trigger or schema. The schema already supports
--     capturing identity -- approved_by is a plain TEXT column (not a UUID
--     FK to auth.users) -- so the smallest fix is for approve_cam_profile
--     below to set approved_by = p_actor_email directly, closing the gap
--     with no schema change at all.
--
-- cam_profiles' existing RLS (cam_profiles_insert/_update/_delete: already
-- is_super_admin() OR can_write_org_data(org_id) -- the canonical
-- non-lockdown shape, no drift found here) is left completely untouched by
-- this migration, per explicit scope ("do not modify RLS, do not lock
-- cam_profiles yet"). These RPCs are additive; the direct-write path this
-- migration replaces in the frontend remains technically permitted by RLS
-- until a future lockdown phase, same as every other module's staged
-- rollout this session.
--
-- Neither mutation ever touches org_id/lease_id/property_id (cam_profiles
-- is 1:1 with leases via a UNIQUE constraint, created once at lease-review
-- time and never re-parented by this page) -- so unlike other RPCs this
-- session, there is no cross-org FK reference to validate beyond the
-- profile row's own org_id ownership check. This is confirmed by reading
-- EditForm's form state and approveMutation's payload directly, not
-- assumed.
--
-- Two separate RPCs (not one combined workflow): save and approve are
-- genuinely different actions -- an arbitrary-subset field edit vs. a
-- fixed status transition with mandatory eligibility re-validation and
-- identity capture -- matching the save/approve split already established
-- for leases (approve_lease_workflow is separate from the various
-- lease-field-edit RPCs) and expenses (persist_expense_classification is
-- separate from review_expense_classification's finalize action).
--
-- No GUC-skip needed: cam_profiles' only trigger
-- (set_cam_profiles_updated_at) does not write audit_logs.

CREATE OR REPLACE FUNCTION public.save_cam_profile(
  p_org_id UUID,
  p_profile_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_patch JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_profile public.cam_profiles%ROWTYPE;
  v_updated public.cam_profiles%ROWTYPE;
  v_key TEXT;
  v_audit_log_id UUID;
  v_allowed_keys TEXT[] := ARRAY[
    'cam_structure', 'tenant_rsf', 'building_rsf', 'tenant_pro_rata_share',
    'admin_fee_percent', 'gross_up_percent', 'cam_cap_type', 'cam_cap_percent',
    'estimate_frequency', 'reconciliation_frequency', 'status', 'notes'
  ];
  v_next_cam_structure TEXT;
  v_next_tenant_rsf NUMERIC;
  v_next_building_rsf NUMERIC;
  v_next_tenant_pro_rata_share NUMERIC;
  v_next_admin_fee_percent NUMERIC;
  v_next_gross_up_percent NUMERIC;
  v_next_cam_cap_type TEXT;
  v_next_cam_cap_percent NUMERIC;
  v_next_estimate_frequency TEXT;
  v_next_reconciliation_frequency TEXT;
  v_next_status TEXT;
  v_next_notes TEXT;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION 'profile_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF jsonb_typeof(COALESCE(p_patch, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'patch must be a JSON object';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT (v_key = ANY(v_allowed_keys)) THEN
      RAISE EXCEPTION 'field % is not permitted', v_key;
    END IF;
  END LOOP;

  SELECT * INTO v_profile
    FROM public.cam_profiles
   WHERE id = p_profile_id AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAM profile not found for this organization';
  END IF;

  -- Sparse-patch-safe resolution: patch value if the key was submitted,
  -- otherwise the profile's current value.
  v_next_cam_structure := CASE WHEN p_patch ? 'cam_structure' THEN NULLIF(p_patch->>'cam_structure', '') ELSE v_profile.cam_structure END;
  v_next_tenant_rsf := CASE WHEN p_patch ? 'tenant_rsf' THEN NULLIF(p_patch->>'tenant_rsf', '')::NUMERIC ELSE v_profile.tenant_rsf END;
  v_next_building_rsf := CASE WHEN p_patch ? 'building_rsf' THEN NULLIF(p_patch->>'building_rsf', '')::NUMERIC ELSE v_profile.building_rsf END;
  v_next_tenant_pro_rata_share := CASE WHEN p_patch ? 'tenant_pro_rata_share' THEN NULLIF(p_patch->>'tenant_pro_rata_share', '')::NUMERIC ELSE v_profile.tenant_pro_rata_share END;
  v_next_admin_fee_percent := CASE WHEN p_patch ? 'admin_fee_percent' THEN NULLIF(p_patch->>'admin_fee_percent', '')::NUMERIC ELSE v_profile.admin_fee_percent END;
  v_next_gross_up_percent := CASE WHEN p_patch ? 'gross_up_percent' THEN NULLIF(p_patch->>'gross_up_percent', '')::NUMERIC ELSE v_profile.gross_up_percent END;
  v_next_cam_cap_type := CASE WHEN p_patch ? 'cam_cap_type' THEN NULLIF(p_patch->>'cam_cap_type', '') ELSE v_profile.cam_cap_type END;
  v_next_cam_cap_percent := CASE WHEN p_patch ? 'cam_cap_percent' THEN NULLIF(p_patch->>'cam_cap_percent', '')::NUMERIC ELSE v_profile.cam_cap_percent END;
  v_next_estimate_frequency := CASE WHEN p_patch ? 'estimate_frequency' THEN NULLIF(p_patch->>'estimate_frequency', '') ELSE v_profile.estimate_frequency END;
  v_next_reconciliation_frequency := CASE WHEN p_patch ? 'reconciliation_frequency' THEN NULLIF(p_patch->>'reconciliation_frequency', '') ELSE v_profile.reconciliation_frequency END;
  v_next_status := CASE WHEN p_patch ? 'status' THEN NULLIF(p_patch->>'status', '') ELSE v_profile.status END;
  v_next_notes := CASE WHEN p_patch ? 'notes' THEN NULLIF(p_patch->>'notes', '') ELSE v_profile.notes END;

  -- Defense-in-depth validation of the same enum options EditForm's own
  -- <Select> components already constrain client-side.
  IF v_next_status IS NOT NULL AND v_next_status NOT IN ('draft', 'pending_review', 'approved') THEN
    RAISE EXCEPTION 'status must be one of draft, pending_review, approved';
  END IF;
  IF v_next_cam_cap_type IS NOT NULL AND v_next_cam_cap_type NOT IN ('none', 'cumulative', 'non_cumulative', 'compounding') THEN
    RAISE EXCEPTION 'cam_cap_type must be one of none, cumulative, non_cumulative, compounding';
  END IF;
  IF v_next_estimate_frequency IS NOT NULL AND v_next_estimate_frequency NOT IN ('monthly', 'quarterly', 'annual') THEN
    RAISE EXCEPTION 'estimate_frequency must be one of monthly, quarterly, annual';
  END IF;
  IF v_next_reconciliation_frequency IS NOT NULL AND v_next_reconciliation_frequency NOT IN ('annual', 'semi_annual', 'never') THEN
    RAISE EXCEPTION 'reconciliation_frequency must be one of annual, semi_annual, never';
  END IF;
  IF v_next_tenant_rsf IS NOT NULL AND v_next_tenant_rsf < 0 THEN
    RAISE EXCEPTION 'tenant_rsf must be a non-negative number';
  END IF;
  IF v_next_building_rsf IS NOT NULL AND v_next_building_rsf < 0 THEN
    RAISE EXCEPTION 'building_rsf must be a non-negative number';
  END IF;
  IF v_next_tenant_pro_rata_share IS NOT NULL AND v_next_tenant_pro_rata_share < 0 THEN
    RAISE EXCEPTION 'tenant_pro_rata_share must be a non-negative number';
  END IF;
  IF v_next_admin_fee_percent IS NOT NULL AND v_next_admin_fee_percent < 0 THEN
    RAISE EXCEPTION 'admin_fee_percent must be a non-negative number';
  END IF;
  IF v_next_gross_up_percent IS NOT NULL AND v_next_gross_up_percent < 0 THEN
    RAISE EXCEPTION 'gross_up_percent must be a non-negative number';
  END IF;
  IF v_next_cam_cap_percent IS NOT NULL AND v_next_cam_cap_percent < 0 THEN
    RAISE EXCEPTION 'cam_cap_percent must be a non-negative number';
  END IF;

  -- Idempotent no-op: nothing would actually change.
  IF v_next_cam_structure IS NOT DISTINCT FROM v_profile.cam_structure
     AND v_next_tenant_rsf IS NOT DISTINCT FROM v_profile.tenant_rsf
     AND v_next_building_rsf IS NOT DISTINCT FROM v_profile.building_rsf
     AND v_next_tenant_pro_rata_share IS NOT DISTINCT FROM v_profile.tenant_pro_rata_share
     AND v_next_admin_fee_percent IS NOT DISTINCT FROM v_profile.admin_fee_percent
     AND v_next_gross_up_percent IS NOT DISTINCT FROM v_profile.gross_up_percent
     AND v_next_cam_cap_type IS NOT DISTINCT FROM v_profile.cam_cap_type
     AND v_next_cam_cap_percent IS NOT DISTINCT FROM v_profile.cam_cap_percent
     AND v_next_estimate_frequency IS NOT DISTINCT FROM v_profile.estimate_frequency
     AND v_next_reconciliation_frequency IS NOT DISTINCT FROM v_profile.reconciliation_frequency
     AND v_next_status IS NOT DISTINCT FROM v_profile.status
     AND v_next_notes IS NOT DISTINCT FROM v_profile.notes
  THEN
    RETURN jsonb_build_object(
      'profile', to_jsonb(v_profile),
      'changed', false
    );
  END IF;

  UPDATE public.cam_profiles SET
    cam_structure = v_next_cam_structure,
    tenant_rsf = v_next_tenant_rsf,
    building_rsf = v_next_building_rsf,
    tenant_pro_rata_share = v_next_tenant_pro_rata_share,
    admin_fee_percent = v_next_admin_fee_percent,
    gross_up_percent = v_next_gross_up_percent,
    cam_cap_type = v_next_cam_cap_type,
    cam_cap_percent = v_next_cam_cap_percent,
    estimate_frequency = v_next_estimate_frequency,
    reconciliation_frequency = v_next_reconciliation_frequency,
    status = v_next_status,
    notes = v_next_notes,
    updated_at = v_now
   WHERE id = p_profile_id AND org_id = p_org_id
  RETURNING * INTO v_updated;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_updated.property_id, 'CamProfile', p_profile_id::TEXT,
    'cam_profile_saved', p_actor_user_id, p_actor_email,
    'info', 'edge_function', to_jsonb(v_profile), to_jsonb(v_updated),
    jsonb_build_object('updated_fields', to_jsonb((SELECT array_agg(k) FROM jsonb_object_keys(p_patch) AS k))),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  RETURN jsonb_build_object(
    'profile', to_jsonb(v_updated),
    'changed', true,
    'audit_log_id', v_audit_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_cam_profile(
  UUID, UUID, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_cam_profile(
  UUID, UUID, UUID, TEXT, JSONB
) TO service_role;

-- ============================================================
-- approve_cam_profile
-- ============================================================
CREATE OR REPLACE FUNCTION public.approve_cam_profile(
  p_org_id UUID,
  p_profile_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_profile public.cam_profiles%ROWTYPE;
  v_updated public.cam_profiles%ROWTYPE;
  v_audit_log_id UUID;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION 'profile_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;

  SELECT * INTO v_profile
    FROM public.cam_profiles
   WHERE id = p_profile_id AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAM profile not found for this organization';
  END IF;

  -- Re-derive CAMSetup.jsx's own computeEffectiveStatus() eligibility gate
  -- server-side, rather than trusting that the client only ever calls this
  -- with an eligible profile -- mirrors persist_expense_classification's
  -- established re-derivation style.
  IF v_profile.building_rsf IS NULL OR v_profile.building_rsf = 0 THEN
    RAISE EXCEPTION 'Cannot approve: Missing building RSF';
  END IF;
  IF v_profile.tenant_pro_rata_share IS NULL
     AND (v_profile.tenant_rsf IS NULL OR v_profile.building_rsf IS NULL)
  THEN
    RAISE EXCEPTION 'Cannot approve: Missing tenant share / RSF';
  END IF;

  -- Idempotent no-op: same actor re-approving an already-approved profile.
  IF v_profile.status IS NOT DISTINCT FROM 'approved'
     AND v_profile.approved_by IS NOT DISTINCT FROM p_actor_email
  THEN
    RETURN jsonb_build_object(
      'profile', to_jsonb(v_profile),
      'changed', false
    );
  END IF;

  UPDATE public.cam_profiles SET
    status = 'approved',
    approved_at = v_now,
    approved_by = p_actor_email,
    updated_at = v_now
   WHERE id = p_profile_id AND org_id = p_org_id
  RETURNING * INTO v_updated;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_updated.property_id, 'CamProfile', p_profile_id::TEXT,
    'cam_profile_approved', p_actor_user_id, p_actor_email,
    'info', 'edge_function', to_jsonb(v_profile), to_jsonb(v_updated),
    jsonb_build_object('approved_by', p_actor_email),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  RETURN jsonb_build_object(
    'profile', to_jsonb(v_updated),
    'changed', true,
    'audit_log_id', v_audit_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.approve_cam_profile(
  UUID, UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.approve_cam_profile(
  UUID, UUID, UUID, TEXT
) TO service_role;
