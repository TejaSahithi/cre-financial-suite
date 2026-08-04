-- ===========================================================================
-- Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-B: the
-- consistent-read-boundary data gatherer for build-cam-run-input-v2. A
-- single PL/pgSQL function call is one Postgres transaction, so every
-- SELECT below sees the same MVCC snapshot of the database — this is what
-- satisfies requirement 10 ("a consistent database read boundary so inputs
-- cannot change midway through snapshot construction"), not an
-- application-level best-effort. The calling edge function does NOT
-- re-query any of these tables itself; it only shapes this function's
-- output into the CamRunInput contract, computes the hash, and persists
-- the immutable snapshot marker rows.
--
-- Deliberately read-only: this function performs zero writes. It is safe
-- to call repeatedly (e.g. to preview a snapshot before freezing it).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.build_cam_run_input_snapshot_data(
  p_org_id UUID,
  p_property_id UUID,
  p_recovery_period_id UUID,
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_pool_ids UUID[];
  v_lease_ids UUID[];
  v_result jsonb;
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_property_id IS NULL THEN RAISE EXCEPTION 'property_id is required'; END IF;
  IF p_recovery_period_id IS NULL THEN RAISE EXCEPTION 'recovery_period_id is required'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = p_property_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Property % not found for organization %', p_property_id, p_org_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recovery_periods WHERE id = p_recovery_period_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Recovery period % not found for organization %', p_recovery_period_id, p_org_id;
  END IF;

  SELECT array_agg(id) INTO v_pool_ids
    FROM public.recovery_pools
   WHERE org_id = p_org_id AND period_id = p_recovery_period_id AND NOT is_template;

  -- Leases in scope: every lease under this property with at least one
  -- APPROVED recovery policy. A lease with no approved policy contributes
  -- nothing to this run and does not need its premises/area data loaded.
  SELECT array_agg(DISTINCT lease_id) INTO v_lease_ids
    FROM public.lease_recovery_policies
   WHERE org_id = p_org_id AND status = 'approved'
     AND lease_id IN (SELECT id FROM public.leases WHERE org_id = p_org_id AND property_id = p_property_id);

  SELECT jsonb_build_object(
    'pools', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'pool', to_jsonb(rp),
        'categories', COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM public.recovery_pool_categories c WHERE c.pool_id = rp.id), '[]'::jsonb),
        'scope_members', COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM public.recovery_pool_scope_members m WHERE m.pool_id = rp.id), '[]'::jsonb)
      ))
      FROM public.recovery_pools rp WHERE rp.id = ANY(COALESCE(v_pool_ids, ARRAY[]::UUID[]))
    ), '[]'::jsonb),

    'policies', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'policy', to_jsonb(p),
        'steps', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.sequence) FROM public.lease_recovery_policy_steps s WHERE s.policy_id = p.id), '[]'::jsonb)
      ))
      FROM public.lease_recovery_policies p
     WHERE p.org_id = p_org_id AND p.status = 'approved' AND p.lease_id = ANY(COALESCE(v_lease_ids, ARRAY[]::UUID[]))
    ), '[]'::jsonb),

    'leases', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'lease', to_jsonb(l),
        'premises', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'premises', to_jsonb(lp),
            'spaces', COALESCE((SELECT jsonb_agg(to_jsonb(sp)) FROM public.lease_premises_spaces sp WHERE sp.lease_premises_id = lp.id), '[]'::jsonb),
            'area_periods', COALESCE((SELECT jsonb_agg(to_jsonb(ap)) FROM public.lease_premises_area_periods ap WHERE ap.lease_premises_id = lp.id), '[]'::jsonb)
          ))
          FROM public.lease_premises lp WHERE lp.lease_id = l.id AND lp.status <> 'draft'
        ), '[]'::jsonb)
      ))
      FROM public.leases l WHERE l.id = ANY(COALESCE(v_lease_ids, ARRAY[]::UUID[]))
    ), '[]'::jsonb),

    'area_measurements', COALESCE((
      SELECT jsonb_agg(to_jsonb(am)) FROM public.space_area_measurements am
       WHERE am.org_id = p_org_id
         AND (am.scope_id = p_property_id
           OR am.scope_id IN (SELECT id FROM public.buildings WHERE property_id = p_property_id)
           OR am.scope_id IN (SELECT id FROM public.units WHERE property_id = p_property_id))
    ), '[]'::jsonb),

    'occupancy_periods', COALESCE((
      SELECT jsonb_agg(to_jsonb(op)) FROM public.space_occupancy_periods op
       WHERE op.org_id = p_org_id
         AND (op.scope_id = p_property_id
           OR op.scope_id IN (SELECT id FROM public.buildings WHERE property_id = p_property_id)
           OR op.scope_id IN (SELECT id FROM public.units WHERE property_id = p_property_id))
    ), '[]'::jsonb),

    'published_expense_inputs', COALESCE((
      SELECT jsonb_agg(to_jsonb(ei)) FROM public.cam_expense_inputs ei
       WHERE ei.org_id = p_org_id AND ei.property_id = p_property_id AND ei.publication_status = 'published'
    ), '[]'::jsonb),

    'pool_assignments', COALESCE((
      SELECT jsonb_agg(to_jsonb(a)) FROM public.cam_input_pool_assignments a
       WHERE a.org_id = p_org_id AND a.recovery_pool_id = ANY(COALESCE(v_pool_ids, ARRAY[]::UUID[]))
    ), '[]'::jsonb),

    'pool_lease_participants', COALESCE((
      SELECT jsonb_agg(to_jsonb(pp)) FROM public.recovery_pool_lease_participants pp
       WHERE pp.org_id = p_org_id AND pp.pool_id = ANY(COALESCE(v_pool_ids, ARRAY[]::UUID[])) AND pp.status = 'active'
    ), '[]'::jsonb),

    'estimate_schedules', COALESCE((
      SELECT jsonb_agg(to_jsonb(es)) FROM public.cam_estimate_schedules es
       WHERE es.org_id = p_org_id AND es.recovery_period_id = p_recovery_period_id
         AND es.lease_id = ANY(COALESCE(v_lease_ids, ARRAY[]::UUID[])) AND es.status <> 'void'
    ), '[]'::jsonb),

    'prior_period_adjustments', COALESCE((
      SELECT jsonb_agg(to_jsonb(pa)) FROM public.cam_prior_period_adjustments pa
       WHERE pa.org_id = p_org_id AND pa.recovery_period_id = p_recovery_period_id
         AND pa.lease_id = ANY(COALESCE(v_lease_ids, ARRAY[]::UUID[]))
    ), '[]'::jsonb),

    -- No persisted source exists yet for prior-year cap history or
    -- normalized base-year pool snapshots (both are genuine, documented
    -- gaps — see the Phase 3B report). Returned empty rather than
    -- fabricated; the engine's own CAP_HISTORY_MISSING/BASE_YEAR_MISSING
    -- handling already degrades safely (warn-and-pass-through for caps,
    -- blocking for base year unless a policy carries an explicit
    -- base_year_amount fallback).
    'prior_cam_history', '[]'::jsonb,
    'base_year_snapshots', '[]'::jsonb,

    'snapshot_taken_at', now()
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.build_cam_run_input_snapshot_data(UUID, UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.build_cam_run_input_snapshot_data(UUID, UUID, UUID, TEXT, UUID) TO service_role;
