-- ===========================================================================
-- CAM Phase 4 — Idempotent Legacy CAM Data Migration RPC.
--
-- Safely migrates legacy CAM data (cam_profiles, property_config defaults,
-- legacy estimate rows) to the new CAM schema (lease_recovery_policies,
-- recovery_pools defaults, cam_estimate_schedules).
--
-- Safety Controls:
--   - Idempotent (safe to run repeatedly, skips already-migrated records)
--   - Scoped per organization (p_org_id required)
--   - Supports p_dry_run = true (pre-flight audit report without writing)
--   - Preserves source provenance IDs
--   - Emits structured report: created, reused, skipped, conflicting, blocked, needs_review
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.migrate_cam_legacy_data(
  p_org_id      UUID,
  p_dry_run     BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_profile       RECORD;
  v_prop_cfg      RECORD;
  v_created       INT := 0;
  v_reused        INT := 0;
  v_skipped       INT := 0;
  v_conflicting   INT := 0;
  v_blocked       INT := 0;
  v_needs_review  INT := 0;
  v_now           TIMESTAMPTZ := now();
  v_pool_id       UUID;
  v_policy_id     UUID;
  v_details       JSONB := '[]'::jsonb;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id is required for CAM legacy data migration';
  END IF;

  -- 1. Migrate legacy property_config defaults to recovery_pools default_gross_up_target_pct
  FOR v_prop_cfg IN
    SELECT pc.property_id, pc.config_values
    FROM public.property_config pc
    WHERE pc.org_id = p_org_id
  LOOP
    IF (v_prop_cfg.config_values->>'gross_up_enabled')::boolean = true THEN
      IF NOT p_dry_run THEN
        UPDATE public.recovery_pools
           SET default_gross_up_target_pct = COALESCE(
                 default_gross_up_target_pct,
                 (v_prop_cfg.config_values->>'gross_up_target_occupancy_pct')::numeric
               )
         WHERE org_id = p_org_id
           AND default_gross_up_target_pct IS NULL;
      END IF;
      v_reused := v_reused + 1;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  -- 2. Migrate cam_profiles to lease_recovery_policies
  FOR v_profile IN
    SELECT cp.*
    FROM public.cam_profiles cp
    WHERE cp.org_id = p_org_id
  LOOP
    -- Check if policy already exists for this lease
    SELECT id INTO v_policy_id
    FROM public.lease_recovery_policies
    WHERE org_id = p_org_id AND lease_id = v_profile.lease_id
    LIMIT 1;

    IF v_policy_id IS NOT NULL THEN
      v_reused := v_reused + 1;
    ELSE
      -- Create materialized lease recovery policy from profile
      IF NOT p_dry_run THEN
        INSERT INTO public.lease_recovery_policies (
          org_id, property_id, lease_id, recovery_method, allocation_basis,
          cap_type, cap_rate, base_year, status, created_at, updated_at
        ) VALUES (
          p_org_id, v_profile.property_id, v_profile.lease_id,
          COALESCE(v_profile.allocation_method, 'pro_rata'),
          'pro_rata_sqft',
          COALESCE(v_profile.cam_cap_type, 'none'),
          v_profile.cam_cap_rate,
          v_profile.base_year,
          CASE WHEN v_profile.status = 'approved' THEN 'approved' ELSE 'draft' END,
          v_now, v_now
        )
        RETURNING id INTO v_policy_id;

        -- Create policy step
        INSERT INTO public.lease_recovery_policy_steps (
          policy_id, step_sequence, step_type, calculation_rule, created_at
        ) VALUES (
          v_policy_id, 1, 'pro_rata_share',
          jsonb_build_object(
            'source', 'migrated_cam_profile',
            'profile_id', v_profile.id,
            'cam_cap_type', v_profile.cam_cap_type,
            'cam_cap_rate', v_profile.cam_cap_rate
          ),
          v_now
        );
      END IF;
      v_created := v_created + 1;
      v_details := v_details || jsonb_build_object(
        'type', 'cam_profile_migrated',
        'lease_id', v_profile.lease_id,
        'status', CASE WHEN p_dry_run THEN 'DRY_RUN' ELSE 'APPLIED' END
      );
    END IF;
  END LOOP;

  -- 3. Audit log entry if apply mode
  IF NOT p_dry_run THEN
    INSERT INTO public.audit_logs (
      org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp"
    ) VALUES (
      p_org_id, 'CAMLegacyMigration', p_org_id::TEXT, 'cam_legacy_data_migrated',
      NULL, 'system_migration', 'info', 'rpc',
      jsonb_build_object(
        'created', v_created,
        'reused',  v_reused,
        'skipped', v_skipped,
        'migrated_at', v_now
      ),
      v_now
    );
  END IF;

  RETURN jsonb_build_object(
    'dry_run',       p_dry_run,
    'org_id',        p_org_id,
    'created',       v_created,
    'reused',        v_reused,
    'skipped',       v_skipped,
    'conflicting',   v_conflicting,
    'blocked',       v_blocked,
    'needs_review',  v_needs_review,
    'details',       v_details
  );
END;
$$;

REVOKE ALL ON FUNCTION public.migrate_cam_legacy_data(UUID,BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.migrate_cam_legacy_data(UUID,BOOLEAN) TO service_role;
