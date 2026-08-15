-- ===========================================================================
-- Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-C: the
-- legacy data backfill. Idempotent (every category checks NOT EXISTS
-- before writing, using the same natural keys the underlying tables
-- already enforce), organization+property-scoped, and resumable (a
-- second call only processes whatever the first call didn't finish or
-- what changed since — nothing here depends on run-to-run state other
-- than the database itself).
--
-- Categories actually WRITTEN (real backfill):
--   A. units.square_footage         -> space_area_measurements (scope_type='unit')
--   B. leases (unit/building/sqft)  -> lease_premises + spaces + area_periods
--   C. approved lease_expense_rules -> lease_recovery_policies (via the
--                                      EXISTING materialize_lease_recovery_policy
--                                      RPC — its own hardened effective-date
--                                      and idempotency rules are the
--                                      authority, not reimplemented here)
--   D. units.occupancy_status + an active lease's REAL commencement_date
--                                   -> space_occupancy_periods
--
-- Categories only REPORTED (never auto-written — "do not automatically
-- approve uncertain financial mappings"):
--   E. published cam_expense_inputs with no pool assignment: which POOL an
--      unassigned legacy expense belongs to is a genuine financial
--      judgment call this function must not guess.
--   F. legacy CAM estimate schedules: no source table for pre-existing
--      billed/scheduled tenant estimates was identified in this schema;
--      reported as not-attempted rather than silently skipped without
--      explanation.
--
-- Every WRITTEN row is tagged source_type='legacy_backfill',
-- review_status='needs_review' (a human must confirm it before it's
-- treated as equally authoritative to primary data), and carries a
-- backfill_confidence + backfill_derivation_method explaining exactly
-- what it was inferred from. Dates are NEVER invented — every
-- effective_from used below is a real, already-recorded date/timestamp on
-- an existing row (a lease's own commencement_date, or a unit/lease
-- record's own created_at when no more specific date exists), never a
-- guess like "today" or "start of fiscal year."
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.backfill_cam_engine_v2_legacy_data(
  p_org_id UUID,
  p_property_id UUID,
  p_dry_run BOOLEAN,
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
  v_row RECORD;
  v_report jsonb := '{}'::jsonb;
  -- Per-category counters, reset before each category.
  v_created INT; v_reused INT; v_skipped INT; v_conflicting INT; v_needs_review INT; v_blocked INT;
  v_examples jsonb;
  v_premises_id UUID;
  v_area_sqft NUMERIC;
  v_materialize_result jsonb;
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_property_id IS NULL THEN RAISE EXCEPTION 'property_id is required'; END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'actor_user_id is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = p_property_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Property % not found for organization %', p_property_id, p_org_id;
  END IF;

  -- ===== Category A: units.square_footage -> space_area_measurements =====
  v_created := 0; v_reused := 0; v_skipped := 0; v_conflicting := 0; v_needs_review := 0; v_blocked := 0; v_examples := '[]'::jsonb;
  FOR v_row IN
    SELECT u.id, u.square_footage, u.created_at
      FROM public.units u
     WHERE u.org_id = p_org_id AND u.property_id = p_property_id
  LOOP
    IF v_row.square_footage IS NULL OR v_row.square_footage <= 0 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.space_area_measurements m
       WHERE m.org_id = p_org_id AND m.scope_type = 'unit' AND m.scope_id = v_row.id
         AND m.effective_from = v_row.created_at::date AND m.area_sqft = v_row.square_footage
    ) THEN
      v_reused := v_reused + 1;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.space_area_measurements m
       WHERE m.org_id = p_org_id AND m.scope_type = 'unit' AND m.scope_id = v_row.id
         AND m.effective_from = v_row.created_at::date AND m.area_sqft <> v_row.square_footage
    ) THEN
      v_conflicting := v_conflicting + 1;
      CONTINUE;
    END IF;

    v_created := v_created + 1;
    IF NOT p_dry_run THEN
      INSERT INTO public.space_area_measurements (
        org_id, scope_type, scope_id, area_type, area_sqft, effective_from,
        source_type, backfill_confidence, backfill_derivation_method, review_status
      ) VALUES (
        p_org_id, 'unit', v_row.id, 'rentable', v_row.square_footage, v_row.created_at::date,
        'legacy_backfill', 0.8, 'units.square_footage, effective_from = unit record creation timestamp (no more specific historical date available)', 'needs_review'
      );
    END IF;
  END LOOP;
  v_report := v_report || jsonb_build_object('area_measurements_from_units', jsonb_build_object(
    'created', v_created, 'reused', v_reused, 'skipped', v_skipped, 'conflicting', v_conflicting, 'needs_review', v_needs_review, 'blocked', v_blocked
  ));

  -- ===== Category B: leases -> lease_premises + spaces + area_periods =====
  v_created := 0; v_reused := 0; v_skipped := 0; v_conflicting := 0; v_needs_review := 0; v_blocked := 0;
  FOR v_row IN
    SELECT l.id, l.unit_id, l.building_id, l.property_id, l.square_footage AS lease_sqft,
           COALESCE(l.commencement_date, l.start_date) AS effective_from, u.square_footage AS unit_sqft
      FROM public.leases l
      LEFT JOIN public.units u ON u.id = l.unit_id
     WHERE l.org_id = p_org_id AND l.property_id = p_property_id
       AND NOT EXISTS (SELECT 1 FROM public.lease_premises lp WHERE lp.lease_id = l.id)
  LOOP
    IF v_row.effective_from IS NULL THEN
      v_blocked := v_blocked + 1; -- no real date on record -- never guessed
      CONTINUE;
    END IF;

    v_area_sqft := NULLIF(v_row.lease_sqft, 0);
    IF v_area_sqft IS NULL THEN v_area_sqft := NULLIF(v_row.unit_sqft, 0); END IF;
    IF v_area_sqft IS NULL THEN
      v_needs_review := v_needs_review + 1; -- real date exists, but no area figure anywhere -- flagged, not written
      CONTINUE;
    END IF;

    v_created := v_created + 1;
    IF NOT p_dry_run THEN
      INSERT INTO public.lease_premises (
        org_id, lease_id, premises_type, effective_from, status,
        source_type, backfill_confidence, backfill_derivation_method, review_status
      ) VALUES (
        p_org_id, v_row.id, 'primary', v_row.effective_from, 'draft',
        'legacy_backfill', 0.75, 'leases.commencement_date/start_date and leases.unit_id/building_id/square_footage', 'needs_review'
      )
      RETURNING id INTO v_premises_id;

      INSERT INTO public.lease_premises_spaces (org_id, lease_premises_id, property_id, building_id, unit_id, allocation_weight)
      VALUES (p_org_id, v_premises_id, v_row.property_id, v_row.building_id, v_row.unit_id, 1);

      INSERT INTO public.lease_premises_area_periods (org_id, lease_premises_id, area_basis, contractual_area_sqft, recovery_area_sqft, effective_from)
      VALUES (p_org_id, v_premises_id, 'rentable', v_area_sqft, v_area_sqft, v_row.effective_from);
    END IF;
  END LOOP;
  v_report := v_report || jsonb_build_object('lease_premises_from_leases', jsonb_build_object(
    'created', v_created, 'reused', v_reused, 'skipped', v_skipped, 'conflicting', v_conflicting, 'needs_review', v_needs_review, 'blocked', v_blocked
  ));

  -- ===== Category C: approved lease_expense_rules -> lease_recovery_policies =====
  v_created := 0; v_reused := 0; v_skipped := 0; v_conflicting := 0; v_needs_review := 0; v_blocked := 0; v_examples := '[]'::jsonb;
  -- No NOT-EXISTS pre-filter here, deliberately: materialize_lease_recovery_policy
  -- is already fully idempotent on its own (hash + materializer_version
  -- identity, migration 20269900000017) and correctly reports
  -- already_materialized=true for an unchanged rule. Pre-filtering already-
  -- materialized rules out of this loop would make them permanently
  -- invisible to a rerun instead of correctly counted as "reused."
  FOR v_row IN
    SELECT r.id
      FROM public.lease_expense_rules r
     WHERE r.org_id = p_org_id AND lower(COALESCE(r.approval_status, '')) = 'approved'
       AND lower(COALESCE(r.cam_eligible, '')) = 'yes'
       AND lower(COALESCE(r.recoverable_from_tenant, '')) IN ('yes', 'conditional')
       AND lower(COALESCE(r.payment_treatment, '')) NOT IN ('tenant_direct_contract', 'not_applicable')
       AND r.lease_id IN (SELECT id FROM public.leases WHERE org_id = p_org_id AND property_id = p_property_id)
  LOOP
    IF p_dry_run THEN
      -- Dry-run never calls the mutating RPC, so it approximates via
      -- existence of an approved policy for this rule rather than the
      -- real hash comparison materialize_lease_recovery_policy would do —
      -- close enough for a preview, and apply-mode is the one that
      -- reports the authoritative created/reused/blocked split.
      IF EXISTS (SELECT 1 FROM public.lease_recovery_policies p WHERE p.source_rule_id = v_row.id AND p.status = 'approved') THEN
        v_reused := v_reused + 1;
      ELSE
        v_created := v_created + 1;
      END IF;
      CONTINUE;
    END IF;

    BEGIN
      v_materialize_result := public.materialize_lease_recovery_policy(p_org_id, v_row.id, p_actor_user_id, p_actor_email);
      IF (v_materialize_result ->> 'already_materialized')::boolean THEN
        v_reused := v_reused + 1;
      ELSE
        v_created := v_created + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- A single rule's own reliability rules (e.g. "conflicting amendment
      -- evidence, cannot guess effective_from") failing must not abort
      -- every other rule in this backfill -- caught, counted, and surfaced
      -- with the real reason rather than silently retried or ignored.
      v_blocked := v_blocked + 1;
      v_examples := v_examples || jsonb_build_object('rule_id', v_row.id, 'reason', SQLERRM);
    END;
  END LOOP;
  v_report := v_report || jsonb_build_object('recovery_policies_from_rules', jsonb_build_object(
    'created', v_created, 'reused', v_reused, 'skipped', v_skipped, 'conflicting', v_conflicting, 'needs_review', v_needs_review, 'blocked', v_blocked,
    'blocked_examples', v_examples
  ));

  -- ===== Category D: units.occupancy_status + active lease commencement -> space_occupancy_periods =====
  v_created := 0; v_reused := 0; v_skipped := 0; v_conflicting := 0; v_needs_review := 0; v_blocked := 0;
  FOR v_row IN
    SELECT u.id, u.occupancy_status, l.commencement_date, l.start_date
      FROM public.units u
      LEFT JOIN public.leases l ON l.id = u.lease_id
     WHERE u.org_id = p_org_id AND u.property_id = p_property_id
  LOOP
    IF v_row.occupancy_status = 'occupied' AND COALESCE(v_row.commencement_date, v_row.start_date) IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.space_occupancy_periods sop
         WHERE sop.org_id = p_org_id AND sop.scope_type = 'unit' AND sop.scope_id = v_row.id
           AND sop.effective_from = COALESCE(v_row.commencement_date, v_row.start_date)
      ) THEN
        v_reused := v_reused + 1;
        CONTINUE;
      END IF;
      v_created := v_created + 1;
      IF NOT p_dry_run THEN
        INSERT INTO public.space_occupancy_periods (
          org_id, scope_type, scope_id, occupancy_status, effective_from,
          source_type, backfill_confidence, backfill_derivation_method, review_status
        ) VALUES (
          p_org_id, 'unit', v_row.id, 'occupied', COALESCE(v_row.commencement_date, v_row.start_date),
          'legacy_backfill', 0.7, 'units.occupancy_status=occupied, effective_from = the occupying lease''s own commencement_date/start_date', 'needs_review'
        );
      END IF;
    ELSIF v_row.occupancy_status = 'occupied' THEN
      v_blocked := v_blocked + 1; -- occupied but no lease with a real commencement date to anchor on -- never guessed
    ELSE
      v_needs_review := v_needs_review + 1; -- vacant/unknown status: no reliable vacancy-START date exists in this schema at all
    END IF;
  END LOOP;
  v_report := v_report || jsonb_build_object('occupancy_periods_from_units', jsonb_build_object(
    'created', v_created, 'reused', v_reused, 'skipped', v_skipped, 'conflicting', v_conflicting, 'needs_review', v_needs_review, 'blocked', v_blocked
  ));

  -- ===== Category E (report-only): published expenses with no pool assignment =====
  SELECT count(*) INTO v_needs_review
    FROM public.cam_expense_inputs cei
   WHERE cei.org_id = p_org_id AND cei.property_id = p_property_id AND cei.publication_status = 'published'
     AND NOT EXISTS (SELECT 1 FROM public.cam_input_pool_assignments a WHERE a.cam_expense_input_id = cei.id);
  v_report := v_report || jsonb_build_object('pool_assignments', jsonb_build_object(
    'created', 0, 'reused', 0, 'skipped', 0, 'conflicting', 0, 'needs_review', v_needs_review, 'blocked', 0,
    'note', 'Pool assignment is a financial judgment this function never makes automatically -- every unassigned published expense is reported for manual review, none are auto-assigned.'
  ));

  -- ===== Category F (report-only): legacy CAM estimates =====
  v_report := v_report || jsonb_build_object('estimate_schedules', jsonb_build_object(
    'created', 0, 'reused', 0, 'skipped', 0, 'conflicting', 0, 'needs_review', 0, 'blocked', 0,
    'note', 'No legacy source table for pre-existing billed/scheduled tenant CAM estimates was identified in this schema -- not attempted, not silently skipped.'
  ));

  IF NOT p_dry_run THEN
    INSERT INTO public.audit_logs (org_id, property_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
    VALUES (p_org_id, p_property_id, 'CamEngineV2Backfill', p_property_id::TEXT, 'cam_engine_v2_legacy_backfill_applied', p_actor_user_id, p_actor_email, 'info', 'edge_function', v_report, v_now);
  END IF;

  RETURN jsonb_build_object('org_id', p_org_id, 'property_id', p_property_id, 'dry_run', p_dry_run, 'evaluated_at', v_now, 'report', v_report);
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_cam_engine_v2_legacy_data(UUID, UUID, BOOLEAN, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_cam_engine_v2_legacy_data(UUID, UUID, BOOLEAN, UUID, TEXT) TO service_role;
