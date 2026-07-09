-- Enterprise hardening Phase 6R-13: server-own the post-approval lease
-- building/unit auto-link.
--
-- LeaseReview.jsx's post-approval flow currently does two separate things
-- after approve_lease_workflow succeeds: (1) client-side text matching
-- (matchBuildingAndUnit, in buildingUnitMatcher.js) to guess which
-- building/unit the lease's extracted text refers to, then (2) a direct
-- `supabase.from("leases").update({building_id, unit_id})` write using the
-- caller's own RLS session. Step 1 is pure UI-derived intent (string
-- matching against candidate rows already fetched for display) and stays
-- entirely client-side, unchanged. This migration replaces only step 2's
-- mechanical persistence with a narrow RPC.
--
-- Not folded into update_lease_extraction_field: that RPC explicitly
-- rejects any write once abstract_status = 'approved' (confirmed at
-- 20260714000000_update_lease_extraction_field.sql:91) -- and this
-- workflow runs immediately AFTER approval succeeds, when abstract_status
-- is already 'approved'. Reusing it would always fail here. A narrow
-- sibling RPC avoids that guard conflict without weakening it for the
-- field-edit RPC's own (still-valid) use case.
--
-- Validation: building_id (if provided) must belong to the same org as
-- the lease and, if the lease has a property_id, to that same property.
-- unit_id (if provided) must likewise belong to the same org/property, and
-- to the resolved building_id if one is set/being set. Cross-org and
-- cross-property links are rejected outright. Idempotent: if the resolved
-- building_id/unit_id are identical to the lease's current values, this is
-- a no-op -- no write, no audit row, `changed: false` in the response.
--
-- Reuses the same app.skip_lease_audit_trigger GUC pattern as every other
-- leases-mutating RPC this epic has added, so fn_on_lease_changed doesn't
-- write a duplicate audit row for this UPDATE.

CREATE OR REPLACE FUNCTION public.link_lease_space_assignment(
  p_org_id UUID,
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_building_id UUID DEFAULT NULL,
  p_unit_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_lease public.leases%ROWTYPE;
  v_updated public.leases%ROWTYPE;
  v_building public.buildings%ROWTYPE;
  v_unit public.units%ROWTYPE;
  v_next_building_id UUID;
  v_next_unit_id UUID;
  v_audit_log_id UUID;
  v_response JSONB;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_lease_id IS NULL THEN
    RAISE EXCEPTION 'lease_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF p_building_id IS NULL AND p_unit_id IS NULL THEN
    RAISE EXCEPTION 'at least one of building_id or unit_id is required';
  END IF;

  SELECT * INTO v_lease
    FROM public.leases
   WHERE id = p_lease_id AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;

  v_next_building_id := v_lease.building_id;
  v_next_unit_id := v_lease.unit_id;

  IF p_building_id IS NOT NULL THEN
    SELECT * INTO v_building FROM public.buildings WHERE id = p_building_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Building not found';
    END IF;
    IF v_building.org_id IS DISTINCT FROM p_org_id THEN
      RAISE EXCEPTION 'Building does not belong to this organization';
    END IF;
    IF v_lease.property_id IS NOT NULL AND v_building.property_id IS DISTINCT FROM v_lease.property_id THEN
      RAISE EXCEPTION 'Building does not belong to the lease''s property';
    END IF;
    v_next_building_id := p_building_id;
  END IF;

  IF p_unit_id IS NOT NULL THEN
    SELECT * INTO v_unit FROM public.units WHERE id = p_unit_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unit not found';
    END IF;
    IF v_unit.org_id IS DISTINCT FROM p_org_id THEN
      RAISE EXCEPTION 'Unit does not belong to this organization';
    END IF;
    IF v_lease.property_id IS NOT NULL AND v_unit.property_id IS DISTINCT FROM v_lease.property_id THEN
      RAISE EXCEPTION 'Unit does not belong to the lease''s property';
    END IF;
    IF v_next_building_id IS NOT NULL AND v_unit.building_id IS DISTINCT FROM v_next_building_id THEN
      RAISE EXCEPTION 'Unit does not belong to the resolved building';
    END IF;
    v_next_unit_id := p_unit_id;
    IF v_next_building_id IS NULL AND v_unit.building_id IS NOT NULL THEN
      v_next_building_id := v_unit.building_id;
    END IF;
  END IF;

  -- Idempotent no-op: nothing would actually change.
  IF v_next_building_id IS NOT DISTINCT FROM v_lease.building_id
     AND v_next_unit_id IS NOT DISTINCT FROM v_lease.unit_id THEN
    RETURN jsonb_build_object(
      'lease_id', v_lease.id,
      'building_id', v_lease.building_id,
      'unit_id', v_lease.unit_id,
      'changed', false
    );
  END IF;

  PERFORM set_config('app.skip_lease_audit_trigger', 'true', true);

  UPDATE public.leases
     SET building_id = v_next_building_id,
         unit_id = v_next_unit_id,
         updated_at = v_now
   WHERE id = p_lease_id AND org_id = p_org_id
  RETURNING * INTO v_updated;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_updated.property_id, 'Lease', p_lease_id::TEXT,
    'lease_space_assignment_linked', p_actor_user_id, p_actor_email,
    'info', 'edge_function', to_jsonb(v_lease), to_jsonb(v_updated),
    jsonb_build_object('building_id', v_next_building_id, 'unit_id', v_next_unit_id),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object(
    'lease_id', v_updated.id,
    'building_id', v_updated.building_id,
    'unit_id', v_updated.unit_id,
    'changed', true,
    'audit_log_id', v_audit_log_id
  );
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.link_lease_space_assignment(
  UUID, UUID, UUID, TEXT, UUID, UUID
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.link_lease_space_assignment(
  UUID, UUID, UUID, TEXT, UUID, UUID
) TO service_role;
