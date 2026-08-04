-- ===========================================================================
-- Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-D step 2:
-- create or load a draft cam_run. Relies on migration 20269900000010's own
-- uniqueness index (idx_cam_runs_one_active_per_series) as the concurrency
-- guard — a unique-violation on concurrent INSERTs is caught and resolved
-- by re-selecting the row the other transaction just created, so two
-- simultaneous "start a run" calls converge on the same draft row instead
-- of erroring.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.get_or_create_draft_cam_run(
  p_org_id UUID,
  p_recovery_period_id UUID,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_run_type TEXT,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_adjustment_of_run_id UUID DEFAULT NULL,
  p_restatement_of_run_id UUID DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_run public.cam_runs%ROWTYPE;
  v_existing public.cam_runs%ROWTYPE;
  v_next_run_number INT;
  v_created BOOLEAN := false;
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_recovery_period_id IS NULL THEN RAISE EXCEPTION 'recovery_period_id is required'; END IF;
  IF p_run_type NOT IN ('standard', 'adjustment', 'restatement', 'preview') THEN
    RAISE EXCEPTION 'Invalid run_type "%"', p_run_type;
  END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'actor_user_id is required'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.recovery_periods WHERE id = p_recovery_period_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Recovery period % not found for this organization', p_recovery_period_id;
  END IF;
  IF p_run_type = 'adjustment' AND p_adjustment_of_run_id IS NULL THEN
    RAISE EXCEPTION 'adjustment_of_run_id is required when run_type is adjustment (ADR-CAM-005: corrections reference exactly which run they correct)';
  END IF;
  IF p_run_type = 'restatement' AND p_restatement_of_run_id IS NULL THEN
    RAISE EXCEPTION 'restatement_of_run_id is required when run_type is restatement';
  END IF;

  -- 'preview' runs are explicitly excluded from the one-active-per-series
  -- uniqueness index (migration 20269900000010) -- always create a new one.
  IF p_run_type <> 'preview' THEN
    SELECT * INTO v_existing FROM public.cam_runs
     WHERE org_id = p_org_id AND recovery_period_id = p_recovery_period_id
       AND scope_type = p_scope_type AND scope_id IS NOT DISTINCT FROM p_scope_id AND run_type = p_run_type
       AND status NOT IN ('voided', 'superseded')
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('run', to_jsonb(v_existing), 'created', false);
    END IF;
  END IF;

  SELECT COALESCE(MAX(run_number), 0) + 1 INTO v_next_run_number
    FROM public.cam_runs
   WHERE org_id = p_org_id AND recovery_period_id = p_recovery_period_id
     AND scope_type = p_scope_type AND scope_id IS NOT DISTINCT FROM p_scope_id;

  BEGIN
    INSERT INTO public.cam_runs (
      org_id, recovery_period_id, scope_type, scope_id, run_number, run_type, status, created_by
    ) VALUES (
      p_org_id, p_recovery_period_id, p_scope_type, p_scope_id, v_next_run_number, p_run_type, 'draft', p_actor_user_id
    )
    RETURNING * INTO v_run;
    v_created := true;
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent caller won the race; converge on their row instead of failing.
    SELECT * INTO v_run FROM public.cam_runs
     WHERE org_id = p_org_id AND recovery_period_id = p_recovery_period_id
       AND scope_type = p_scope_type AND scope_id IS NOT DISTINCT FROM p_scope_id AND run_type = p_run_type
       AND status NOT IN ('voided', 'superseded')
     LIMIT 1;
    IF NOT FOUND THEN RAISE; END IF;
  END;

  IF v_created THEN
    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, after, "timestamp")
    VALUES (p_org_id, 'CamRun', v_run.id::TEXT, 'cam_run_draft_created', p_actor_user_id, p_actor_email, 'info', 'edge_function', to_jsonb(v_run), v_now);
  END IF;

  RETURN jsonb_build_object('run', to_jsonb(v_run), 'created', v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_draft_cam_run(UUID, UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_create_draft_cam_run(UUID, UUID, TEXT, UUID, TEXT, UUID, TEXT, UUID, UUID) TO service_role;
