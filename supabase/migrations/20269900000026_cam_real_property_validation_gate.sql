-- ===========================================================================
-- CAM Phase 4B — Step 3: Real Property Validation Gate RPC.
--
-- Adds the submit_real_property_variance_report RPC for when a real
-- anonymized property becomes available. The gate status starts BLOCKED
-- in the cam_real_property_validations table (created in migration 025).
--
-- This RPC does NOT enable production posting — it updates the gate row
-- to IN_PROGRESS and records the variance report. Only a manual review
-- by a human reviewer can move the gate to VERIFIED or FAILED.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.submit_real_property_variance_report(
  p_org_id              UUID,
  p_property_id         UUID,
  p_cam_run_id          UUID,
  p_variance_report     JSONB,
  p_actor_user_id       UUID,
  p_actor_email         TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_rows  INTEGER;
  v_now   TIMESTAMPTZ := now();
BEGIN
  -- Only allowed on real property cam runs (not synthetic test data).
  -- The caller must have a real property_id with actual leases.
  IF p_cam_run_id IS NULL THEN
    RAISE EXCEPTION 'A real posted cam_run_id is required for variance report submission';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cam_runs WHERE id = p_cam_run_id AND org_id = p_org_id AND status = 'posted') THEN
    RAISE EXCEPTION 'Variance report requires a posted CAM run — run % is not posted or not found', p_cam_run_id;
  END IF;
  IF p_variance_report IS NULL OR jsonb_array_length(p_variance_report->'rows') = 0 THEN
    RAISE EXCEPTION 'variance_report must include at least one row in .rows';
  END IF;

  -- Upsert the gate row to IN_PROGRESS.
  INSERT INTO public.cam_real_property_validations (
    org_id, property_id, cam_run_id, status, block_reason, variance_report, manual_reviewer
  ) VALUES (
    p_org_id, p_property_id, p_cam_run_id,
    'IN_PROGRESS',
    'Variance report submitted — awaiting manual review and classification of all variance rows before VERIFIED.',
    p_variance_report,
    p_actor_user_id
  )
  ON CONFLICT (org_id, property_id) DO UPDATE
    SET cam_run_id       = EXCLUDED.cam_run_id,
        status           = 'IN_PROGRESS',
        block_reason     = EXCLUDED.block_reason,
        variance_report  = EXCLUDED.variance_report,
        manual_reviewer  = EXCLUDED.manual_reviewer,
        updated_at       = v_now;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
  VALUES (p_org_id, 'CamRealPropertyValidation', p_property_id::TEXT, 'real_property_variance_report_submitted',
    p_actor_user_id, p_actor_email, 'info', 'rpc',
    jsonb_build_object('cam_run_id', p_cam_run_id, 'row_count', jsonb_array_length(p_variance_report->'rows')), v_now);

  RETURN jsonb_build_object(
    'status', 'IN_PROGRESS',
    'message', 'Variance report recorded. A human reviewer must classify all rows and set status=VERIFIED before FEATURE_CAM_POSTING_ENABLED can be enabled in production.',
    'property_id', p_property_id,
    'cam_run_id', p_cam_run_id
  );
END;
$$;
REVOKE ALL ON FUNCTION public.submit_real_property_variance_report(UUID,UUID,UUID,JSONB,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.submit_real_property_variance_report(UUID,UUID,UUID,JSONB,UUID,TEXT) TO service_role;

-- Unique gate per org+property (only one active gate at a time)
CREATE UNIQUE INDEX IF NOT EXISTS uq_cam_real_property_validations_org_property
  ON public.cam_real_property_validations (org_id, property_id);
