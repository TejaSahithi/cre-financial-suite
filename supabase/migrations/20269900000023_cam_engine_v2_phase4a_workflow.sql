-- ===========================================================================
-- Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 4A:
-- operational workflow commands (submit for review, return to draft,
-- approve, reject) on top of the ALREADY-ENFORCED cam_runs status graph
-- from migration 20269900000010 (Phase 1 hardening). Per the Phase 4
-- instructions, this is additive wiring on top of the frozen CAM
-- architecture, not a redesign: the status graph and its trigger
-- (enforce_cam_run_immutability_and_transitions) are untouched.
--
-- "create CAM run" / "calculate draft run" / "atomically recalculate draft
-- run" already exist and are NOT duplicated here:
--   - create: get_or_create_draft_cam_run (20269900000019)
--   - calculate / recalculate: run-cam-calculation-v2 edge function, which
--     already handles both a first calculation (draft/readiness_failed ->
--     ready -> calculating -> calculated) and a later recalculation
--     (calculated -> calculating -> calculated) atomically via
--     persist_cam_run_results' own delete-then-insert transaction.
--
-- New in this migration:
--   1. cam_runs.run_mode: the ephemeral request-time run_mode passed to
--      run-cam-calculation-v2 (preview vs posting_eligible) was previously
--      never persisted, which meant a 'calculated' run's own row couldn't
--      later prove whether UNKNOWN prior-period adjustments (and other
--      posting_eligible-only blocking checks) had actually been evaluated
--      as blocking rather than merely warned about. Every Phase 4A
--      submission gate below depends on knowing this, so it must be a real
--      column, not re-derived by guesswork.
--   2. cam_runs.submitted_at / approved_at: read-model timestamps for the
--      CAM Run and Approval UI pages (approved_by/posted_at already
--      existed; submitted_at/approved_at did not).
--   3. Five workflow RPCs mapping the user-facing 4 actions (submit for
--      review; return to draft with reason; approve; reject with reason)
--      onto the existing 2-hop under_review/submitted graph, plus a 5th
--      RPC (resolve_cam_run_exception) wiring up the cam_run_exceptions
--      resolution_status/resolved_by/resolution_note columns that already
--      existed in the Phase 1 schema but had no RPC to actually use them:
--        submit_cam_run_for_review: calculated -> under_review -> submitted
--          (one atomic call; requires run_mode='posting_eligible', since a
--          preview-mode calculation may be hiding a would-be-blocking
--          UNKNOWN prior-adjustment issue that never got the chance to
--          block).
--        return_cam_run_to_draft(reason): {under_review or submitted} ->
--          calculated. The larger pushback -- needs rework/recalculation.
--        reject_cam_run(reason): submitted -> under_review. The lighter
--          pushback -- stays in the review queue, doesn't require a fresh
--          calculation.
--        approve_cam_run: submitted -> approved. Fails closed if any
--          cam_run_exceptions row is still severity='blocking' AND
--          resolution_status='open' ("unexplained exceptions prohibited").
--        resolve_cam_run_exception: records a resolution
--          (resolved/waived) with a mandatory note and the acting user --
--          this IS the "responsible user, resolution action, evidence"
--          mechanism the Exception Review page needs; it does not delete
--          or hide the exception row, only marks it resolved/waived.
-- ===========================================================================

ALTER TABLE public.cam_runs
  ADD COLUMN IF NOT EXISTS run_mode TEXT NOT NULL DEFAULT 'preview' CHECK (run_mode IN ('preview', 'posting_eligible')),
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- ---- persist_cam_run_results now also records the run_mode the caller
-- actually calculated with, so later workflow RPCs can verify it. A
-- changed parameter list is a NEW overload to Postgres, not a replacement
-- of the old one -- the prior 11-arg signature must be dropped explicitly,
-- or PostgREST will find two ambiguous candidates for any call whose named
-- arguments happen to match both. ----
DROP FUNCTION IF EXISTS public.persist_cam_run_results(UUID, UUID, UUID, TEXT, TEXT, TEXT, BOOLEAN, JSONB, JSONB, JSONB, JSONB);

CREATE OR REPLACE FUNCTION public.persist_cam_run_results(
  p_org_id UUID,
  p_cam_run_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_input_hash TEXT,
  p_engine_version TEXT,
  p_ready_to_post BOOLEAN,
  p_pool_results JSONB,
  p_lease_results JSONB,
  p_calculation_lines JSONB,
  p_exceptions JSONB,
  p_run_mode TEXT DEFAULT 'preview'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_run RECORD;
  v_now TIMESTAMPTZ := now();
  v_already_persisted BOOLEAN := false;
  v_pool_result_count INT := 0;
  v_lease_result_count INT := 0;
  v_calculation_line_count INT := 0;
  v_exception_count INT := 0;
  v_target_status TEXT;
BEGIN
  IF p_org_id IS NULL OR p_cam_run_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id and p_cam_run_id are required';
  END IF;

  SELECT * INTO v_run FROM public.cam_runs WHERE id = p_cam_run_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAM run % was not found in organization %', p_cam_run_id, p_org_id;
  END IF;

  IF v_run.status IN ('posted', 'superseded', 'voided') THEN
    RAISE EXCEPTION 'CAM run % is in terminal/immutable status % and cannot accept new results — corrections require a new adjustment/restatement run (ADR-CAM-005)', p_cam_run_id, v_run.status;
  END IF;

  IF v_run.status NOT IN ('ready', 'calculating', 'calculated') THEN
    RAISE EXCEPTION 'CAM run % is in status % — results may only be persisted after readiness has passed (status ready/calculating/calculated)', p_cam_run_id, v_run.status;
  END IF;

  IF v_run.status = 'calculated' AND v_run.input_hash IS NOT NULL AND v_run.input_hash = p_input_hash AND v_run.run_mode = COALESCE(p_run_mode, 'preview') THEN
    v_already_persisted := true;
  END IF;

  IF NOT v_already_persisted THEN
    IF v_run.status <> 'calculating' THEN
      UPDATE public.cam_runs SET status = 'calculating', updated_at = v_now WHERE id = p_cam_run_id;
    END IF;

    DELETE FROM public.cam_run_calculation_lines WHERE cam_run_id = p_cam_run_id;
    DELETE FROM public.cam_run_exceptions WHERE cam_run_id = p_cam_run_id;
    DELETE FROM public.cam_run_lease_results WHERE cam_run_id = p_cam_run_id;
    DELETE FROM public.cam_run_pool_results WHERE cam_run_id = p_cam_run_id;

    CREATE TEMP TABLE IF NOT EXISTS tmp_pool_result_map (pool_id UUID PRIMARY KEY, pool_result_id UUID) ON COMMIT DROP;
    CREATE TEMP TABLE IF NOT EXISTS tmp_lease_result_map (lease_id UUID PRIMARY KEY, lease_result_id UUID) ON COMMIT DROP;
    DELETE FROM tmp_pool_result_map WHERE true;
    DELETE FROM tmp_lease_result_map WHERE true;

    INSERT INTO tmp_pool_result_map (pool_id, pool_result_id)
    SELECT (elem->>'pool_id')::UUID, gen_random_uuid()
    FROM jsonb_array_elements(COALESCE(p_pool_results, '[]'::jsonb)) elem;

    INSERT INTO public.cam_run_pool_results (
      id, org_id, cam_run_id, pool_id, actual_amount, excluded_amount, gross_up_adjustment, amortization, adjusted_pool, denominator_metrics
    )
    SELECT
      m.pool_result_id, p_org_id, p_cam_run_id, (elem->>'pool_id')::UUID,
      COALESCE((elem->>'actual_amount')::NUMERIC, 0), COALESCE((elem->>'excluded_amount')::NUMERIC, 0),
      COALESCE((elem->>'gross_up_adjustment')::NUMERIC, 0), COALESCE((elem->>'amortization')::NUMERIC, 0),
      COALESCE((elem->>'adjusted_pool')::NUMERIC, 0), COALESCE(elem->'denominator_metrics', '{}'::jsonb)
    FROM jsonb_array_elements(COALESCE(p_pool_results, '[]'::jsonb)) elem
    JOIN tmp_pool_result_map m ON m.pool_id = (elem->>'pool_id')::UUID;
    GET DIAGNOSTICS v_pool_result_count = ROW_COUNT;

    INSERT INTO tmp_lease_result_map (lease_id, lease_result_id)
    SELECT (elem->>'lease_id')::UUID, gen_random_uuid()
    FROM jsonb_array_elements(COALESCE(p_lease_results, '[]'::jsonb)) elem;

    INSERT INTO public.cam_run_lease_results (
      id, org_id, cam_run_id, lease_id, final_recovery, estimates_billed, amount_due_credit, status
    )
    SELECT
      m.lease_result_id, p_org_id, p_cam_run_id, (elem->>'lease_id')::UUID,
      COALESCE((elem->>'final_recovery')::NUMERIC, 0), COALESCE((elem->>'estimates_billed')::NUMERIC, 0),
      COALESCE((elem->>'amount_due_credit')::NUMERIC, 0), 'calculated'
    FROM jsonb_array_elements(COALESCE(p_lease_results, '[]'::jsonb)) elem
    JOIN tmp_lease_result_map m ON m.lease_id = (elem->>'lease_id')::UUID;
    GET DIAGNOSTICS v_lease_result_count = ROW_COUNT;

    INSERT INTO public.cam_run_calculation_lines (
      org_id, cam_run_id, lease_result_id, pool_result_id, sequence, line_type, category, formula_code,
      input_amount, output_amount, adjustment, policy_step_id, explanation
    )
    SELECT
      p_org_id, p_cam_run_id, lm.lease_result_id, pm.pool_result_id,
      COALESCE((elem->>'sequence')::INT, 0), elem->>'line_type', elem->>'category', elem->>'formula_code',
      NULLIF(elem->>'input_amount', 'null')::NUMERIC, NULLIF(elem->>'output_amount', 'null')::NUMERIC,
      NULLIF(elem->>'adjustment', 'null')::NUMERIC,
      NULLIF(elem->>'policy_step_id', 'null')::UUID, elem->>'explanation'
    FROM jsonb_array_elements(COALESCE(p_calculation_lines, '[]'::jsonb)) elem
    LEFT JOIN tmp_lease_result_map lm ON lm.lease_id = NULLIF(elem->>'lease_id', 'null')::UUID
    LEFT JOIN tmp_pool_result_map pm ON pm.pool_id = NULLIF(elem->>'pool_id', 'null')::UUID;
    GET DIAGNOSTICS v_calculation_line_count = ROW_COUNT;

    INSERT INTO public.cam_run_exceptions (org_id, cam_run_id, severity, code, entity_type, entity_id, message)
    SELECT
      p_org_id, p_cam_run_id, elem->>'severity', elem->>'code', elem->>'entity_type',
      NULLIF(elem->>'entity_id', 'null')::UUID, elem->>'message'
    FROM jsonb_array_elements(COALESCE(p_exceptions, '[]'::jsonb)) elem;
    GET DIAGNOSTICS v_exception_count = ROW_COUNT;

    v_target_status := CASE WHEN p_ready_to_post THEN 'calculated' ELSE 'readiness_failed' END;
    UPDATE public.cam_runs
       SET status = v_target_status, input_hash = p_input_hash, engine_version = p_engine_version,
           run_mode = COALESCE(p_run_mode, 'preview'), updated_at = v_now
     WHERE id = p_cam_run_id;

    INSERT INTO public.audit_logs (
      org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp"
    ) VALUES (
      p_org_id, 'CamRun', p_cam_run_id::TEXT, 'cam_run_v2_results_persisted', p_actor_user_id, p_actor_email,
      CASE WHEN p_ready_to_post THEN 'info' ELSE 'warning' END, 'edge_function',
      jsonb_build_object(
        'input_hash', p_input_hash, 'engine_version', p_engine_version, 'ready_to_post', p_ready_to_post, 'run_mode', COALESCE(p_run_mode, 'preview'),
        'pool_result_count', v_pool_result_count, 'lease_result_count', v_lease_result_count,
        'calculation_line_count', v_calculation_line_count, 'exception_count', v_exception_count
      ),
      v_now
    );
  ELSE
    SELECT count(*) INTO v_pool_result_count FROM public.cam_run_pool_results WHERE cam_run_id = p_cam_run_id;
    SELECT count(*) INTO v_lease_result_count FROM public.cam_run_lease_results WHERE cam_run_id = p_cam_run_id;
    SELECT count(*) INTO v_calculation_line_count FROM public.cam_run_calculation_lines WHERE cam_run_id = p_cam_run_id;
    SELECT count(*) INTO v_exception_count FROM public.cam_run_exceptions WHERE cam_run_id = p_cam_run_id;
  END IF;

  RETURN jsonb_build_object(
    'run_id', p_cam_run_id,
    'idempotent_rerun', v_already_persisted,
    'status', (SELECT status FROM public.cam_runs WHERE id = p_cam_run_id),
    'pool_result_count', v_pool_result_count,
    'lease_result_count', v_lease_result_count,
    'calculation_line_count', v_calculation_line_count,
    'exception_count', v_exception_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_cam_run_results(UUID, UUID, UUID, TEXT, TEXT, TEXT, BOOLEAN, JSONB, JSONB, JSONB, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_cam_run_results(UUID, UUID, UUID, TEXT, TEXT, TEXT, BOOLEAN, JSONB, JSONB, JSONB, JSONB, TEXT) TO service_role;

-- ---- submit_cam_run_for_review: calculated -> under_review -> submitted ----
CREATE OR REPLACE FUNCTION public.submit_cam_run_for_review(
  p_org_id UUID,
  p_cam_run_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_run RECORD;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF p_org_id IS NULL OR p_cam_run_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id, p_cam_run_id, and p_actor_user_id are required';
  END IF;

  SELECT * INTO v_run FROM public.cam_runs WHERE id = p_cam_run_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAM run % was not found in organization %', p_cam_run_id, p_org_id;
  END IF;

  IF v_run.status <> 'calculated' THEN
    RAISE EXCEPTION 'CAM run % must be in status calculated to submit for review (current status: %)', p_cam_run_id, v_run.status;
  END IF;

  -- A preview-mode calculation may be concealing a would-be-blocking
  -- UNKNOWN prior-period adjustment (PRIOR_ADJUSTMENT_UNKNOWN is only
  -- 'blocking' in posting_eligible mode -- see estimate-reconciliation.ts).
  -- Submitting a run for review/approval must only ever happen against a
  -- calculation that actually applied the stricter gate.
  IF v_run.run_mode <> 'posting_eligible' THEN
    RAISE EXCEPTION 'CAM run % was calculated in preview mode; recalculate with run_mode=posting_eligible before submitting for review', p_cam_run_id;
  END IF;

  UPDATE public.cam_runs SET status = 'under_review', updated_at = v_now WHERE id = p_cam_run_id;
  UPDATE public.cam_runs SET status = 'submitted', submitted_at = v_now, updated_at = v_now WHERE id = p_cam_run_id;

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
  VALUES (p_org_id, 'CamRun', p_cam_run_id::TEXT, 'cam_run_submitted_for_review', p_actor_user_id, p_actor_email, 'info', 'edge_function',
    jsonb_build_object('from_status', 'calculated', 'to_status', 'submitted'), v_now);

  RETURN jsonb_build_object('run_id', p_cam_run_id, 'status', 'submitted', 'submitted_at', v_now);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_cam_run_for_review(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_cam_run_for_review(UUID, UUID, UUID, TEXT) TO service_role;

-- ---- return_cam_run_to_draft: {under_review|submitted} -> calculated (reason required) ----
CREATE OR REPLACE FUNCTION public.return_cam_run_to_draft(
  p_org_id UUID,
  p_cam_run_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_run RECORD;
  v_now TIMESTAMPTZ := now();
  v_from_status TEXT;
BEGIN
  IF p_org_id IS NULL OR p_cam_run_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id, p_cam_run_id, and p_actor_user_id are required';
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A reason is required to return a CAM run to draft';
  END IF;

  SELECT * INTO v_run FROM public.cam_runs WHERE id = p_cam_run_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAM run % was not found in organization %', p_cam_run_id, p_org_id;
  END IF;

  v_from_status := v_run.status;
  IF v_from_status NOT IN ('under_review', 'submitted') THEN
    RAISE EXCEPTION 'CAM run % must be under_review or submitted to return to draft (current status: %)', p_cam_run_id, v_from_status;
  END IF;

  IF v_from_status = 'submitted' THEN
    UPDATE public.cam_runs SET status = 'under_review', updated_at = v_now WHERE id = p_cam_run_id;
  END IF;
  UPDATE public.cam_runs SET status = 'calculated', submitted_at = NULL, updated_at = v_now WHERE id = p_cam_run_id;

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
  VALUES (p_org_id, 'CamRun', p_cam_run_id::TEXT, 'cam_run_returned_to_draft', p_actor_user_id, p_actor_email, 'warning', 'edge_function',
    jsonb_build_object('from_status', v_from_status, 'to_status', 'calculated', 'reason', trim(p_reason)), v_now);

  RETURN jsonb_build_object('run_id', p_cam_run_id, 'status', 'calculated', 'from_status', v_from_status);
END;
$$;

REVOKE ALL ON FUNCTION public.return_cam_run_to_draft(UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.return_cam_run_to_draft(UUID, UUID, UUID, TEXT, TEXT) TO service_role;

-- ---- reject_cam_run: submitted -> under_review (reason required; lighter than return-to-draft) ----
CREATE OR REPLACE FUNCTION public.reject_cam_run(
  p_org_id UUID,
  p_cam_run_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_run RECORD;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF p_org_id IS NULL OR p_cam_run_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id, p_cam_run_id, and p_actor_user_id are required';
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A reason is required to reject a CAM run';
  END IF;

  SELECT * INTO v_run FROM public.cam_runs WHERE id = p_cam_run_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAM run % was not found in organization %', p_cam_run_id, p_org_id;
  END IF;

  IF v_run.status <> 'submitted' THEN
    RAISE EXCEPTION 'CAM run % must be submitted to reject (current status: %)', p_cam_run_id, v_run.status;
  END IF;

  UPDATE public.cam_runs SET status = 'under_review', submitted_at = NULL, updated_at = v_now WHERE id = p_cam_run_id;

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
  VALUES (p_org_id, 'CamRun', p_cam_run_id::TEXT, 'cam_run_rejected', p_actor_user_id, p_actor_email, 'warning', 'edge_function',
    jsonb_build_object('from_status', 'submitted', 'to_status', 'under_review', 'reason', trim(p_reason)), v_now);

  RETURN jsonb_build_object('run_id', p_cam_run_id, 'status', 'under_review');
END;
$$;

REVOKE ALL ON FUNCTION public.reject_cam_run(UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_cam_run(UUID, UUID, UUID, TEXT, TEXT) TO service_role;

-- ---- approve_cam_run: submitted -> approved ----
CREATE OR REPLACE FUNCTION public.approve_cam_run(
  p_org_id UUID,
  p_cam_run_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_run RECORD;
  v_now TIMESTAMPTZ := now();
  v_open_blocking_count INT;
BEGIN
  IF p_org_id IS NULL OR p_cam_run_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id, p_cam_run_id, and p_actor_user_id are required';
  END IF;

  SELECT * INTO v_run FROM public.cam_runs WHERE id = p_cam_run_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAM run % was not found in organization %', p_cam_run_id, p_org_id;
  END IF;

  IF v_run.status <> 'submitted' THEN
    RAISE EXCEPTION 'CAM run % must be submitted to approve (current status: %)', p_cam_run_id, v_run.status;
  END IF;

  IF v_run.run_mode <> 'posting_eligible' THEN
    RAISE EXCEPTION 'CAM run % was not calculated in posting_eligible mode and cannot be approved', p_cam_run_id;
  END IF;

  -- "Unexplained exceptions prohibited": a blocking exception the reviewer
  -- never resolved or explicitly waived (see resolve_cam_run_exception)
  -- blocks approval outright. A blocking exception that WAS resolved/waived
  -- (with its resolution_note/resolved_by recorded) does not.
  SELECT count(*) INTO v_open_blocking_count
    FROM public.cam_run_exceptions
   WHERE cam_run_id = p_cam_run_id AND severity = 'blocking' AND resolution_status = 'open';
  IF v_open_blocking_count > 0 THEN
    RAISE EXCEPTION 'CAM run % has % unresolved blocking exception(s) — resolve or waive every blocking exception before approval', p_cam_run_id, v_open_blocking_count;
  END IF;

  UPDATE public.cam_runs SET status = 'approved', approved_by = p_actor_user_id, approved_at = v_now, updated_at = v_now WHERE id = p_cam_run_id;

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
  VALUES (p_org_id, 'CamRun', p_cam_run_id::TEXT, 'cam_run_approved', p_actor_user_id, p_actor_email, 'info', 'edge_function',
    jsonb_build_object('from_status', 'submitted', 'to_status', 'approved'), v_now);

  RETURN jsonb_build_object('run_id', p_cam_run_id, 'status', 'approved', 'approved_at', v_now);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_cam_run(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_cam_run(UUID, UUID, UUID, TEXT) TO service_role;

-- ---- resolve_cam_run_exception: records resolution_status/resolved_by/resolution_note ----
CREATE OR REPLACE FUNCTION public.resolve_cam_run_exception(
  p_org_id UUID,
  p_cam_run_id UUID,
  p_exception_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_resolution_status TEXT,
  p_resolution_note TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_run RECORD;
  v_exception RECORD;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF p_org_id IS NULL OR p_cam_run_id IS NULL OR p_exception_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id, p_cam_run_id, p_exception_id, and p_actor_user_id are required';
  END IF;
  IF p_resolution_status NOT IN ('resolved', 'waived') THEN
    RAISE EXCEPTION 'p_resolution_status must be resolved or waived';
  END IF;
  IF NULLIF(trim(COALESCE(p_resolution_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A resolution_note is required — an exception may not be resolved or waived without a recorded explanation';
  END IF;

  SELECT status INTO v_run FROM public.cam_runs WHERE id = p_cam_run_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAM run % was not found in organization %', p_cam_run_id, p_org_id;
  END IF;
  IF v_run.status IN ('posted', 'superseded', 'voided') THEN
    RAISE EXCEPTION 'CAM run % is in terminal/immutable status % — exceptions can no longer be modified', p_cam_run_id, v_run.status;
  END IF;

  SELECT * INTO v_exception FROM public.cam_run_exceptions WHERE id = p_exception_id AND cam_run_id = p_cam_run_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exception % was not found for CAM run % in organization %', p_exception_id, p_cam_run_id, p_org_id;
  END IF;

  UPDATE public.cam_run_exceptions
     SET resolution_status = p_resolution_status, resolved_by = p_actor_user_id, resolution_note = trim(p_resolution_note), updated_at = v_now
   WHERE id = p_exception_id;

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
  VALUES (p_org_id, 'CamRunException', p_exception_id::TEXT, 'cam_run_exception_resolved', p_actor_user_id, p_actor_email, 'info', 'edge_function',
    jsonb_build_object('cam_run_id', p_cam_run_id, 'severity', v_exception.severity, 'code', v_exception.code, 'resolution_status', p_resolution_status, 'resolution_note', trim(p_resolution_note)), v_now);

  RETURN jsonb_build_object('exception_id', p_exception_id, 'resolution_status', p_resolution_status);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_cam_run_exception(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_cam_run_exception(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
