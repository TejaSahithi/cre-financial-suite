-- ===========================================================================
-- CAM Phase 4B — Step 1: Annual rounding scope columns and ROUNDING_DETAIL
-- persistence support.
--
-- Changes:
--   1. cam_runs.annual_rounding_scope TEXT — the boundary at which annual
--      CAM recovery is rounded (DEFAULT 'LEASE_POOL_PERIOD'). Backfills
--      all existing rows to the new default so every historical run has an
--      explicit, correct value.
--
--   2. cam_runs.rounding_policy gains annual_rounding_scope and
--      estimate_rounding_scope inside its JSONB column via trigger-backed
--      default injection; existing rows are backfilled with the defaults.
--
--   3. cam_run_calculation_lines gains four new columns for the
--      ROUNDING_DETAIL line type emitted by the Phase 4B engine:
--        unrounded_aggregate  NUMERIC(18,6) — internal-precision sum
--        rounding_scope       TEXT          — which boundary was applied
--        rounded_amount       NUMERIC(18,6) — final ledger-rounded value
--        rounding_residual    NUMERIC(18,6) — rounded_amount - unrounded
--
--   4. persist_cam_run_results RPC: the calculation_lines JSONB now carries
--      these four extra fields; the INSERT reads them via NULLIF/COALESCE
--      exactly as it does for the existing optional fields (input_amount etc.)
--      — backward compatible, old callers just omit the new keys.
--
-- ADR-CAM-011 context: internal calculation precision vs final ledger
-- rounding are two distinct concerns. This migration makes the boundary
-- and its effect an observable, queryable, auditable part of the ledger,
-- not an implicit side-effect inside the engine binary.
-- ===========================================================================

-- 1. Add annual_rounding_scope to cam_runs as a first-class column.
ALTER TABLE public.cam_runs
  ADD COLUMN IF NOT EXISTS annual_rounding_scope TEXT NOT NULL DEFAULT 'LEASE_POOL_PERIOD'
    CHECK (annual_rounding_scope IN ('SEGMENT', 'MONTH', 'LEASE_POOL_PERIOD', 'LEASE_PERIOD', 'STATEMENT'));

-- 2. Backfill rounding_policy JSONB to include the new scope fields for
--    rows that were created before this migration.
UPDATE public.cam_runs
   SET rounding_policy = rounding_policy
     || jsonb_build_object(
          'annual_rounding_scope',   COALESCE(rounding_policy->>'annual_rounding_scope', 'LEASE_POOL_PERIOD'),
          'estimate_rounding_scope', COALESCE(rounding_policy->>'estimate_rounding_scope', 'MONTH')
        )
 WHERE NOT (rounding_policy ? 'annual_rounding_scope');

-- 3. Add the four ROUNDING_DETAIL columns to cam_run_calculation_lines.
ALTER TABLE public.cam_run_calculation_lines
  ADD COLUMN IF NOT EXISTS unrounded_aggregate NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS rounding_scope       TEXT,
  ADD COLUMN IF NOT EXISTS rounded_amount       NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS rounding_residual    NUMERIC(18,6);

-- 4. Drop and re-create persist_cam_run_results with the new column writes.
--    The outer signature is identical (same 12 named parameters); the only
--    change is that the calculation_lines INSERT now reads 4 extra optional
--    JSONB keys. Old callers that omit those keys see NULL values in the
--    new columns, which is correct and expected for pre-Phase-4B lines.
DROP FUNCTION IF EXISTS public.persist_cam_run_results(UUID, UUID, UUID, TEXT, TEXT, TEXT, BOOLEAN, JSONB, JSONB, JSONB, JSONB, TEXT);

CREATE OR REPLACE FUNCTION public.persist_cam_run_results(
  p_org_id             UUID,
  p_cam_run_id         UUID,
  p_actor_user_id      UUID,
  p_actor_email        TEXT,
  p_input_hash         TEXT,
  p_engine_version     TEXT,
  p_ready_to_post      BOOLEAN,
  p_pool_results       JSONB,
  p_lease_results      JSONB,
  p_calculation_lines  JSONB,
  p_exceptions         JSONB,
  p_run_mode           TEXT DEFAULT 'preview'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_run                    RECORD;
  v_now                    TIMESTAMPTZ := now();
  v_already_persisted      BOOLEAN     := false;
  v_pool_result_count      INT         := 0;
  v_lease_result_count     INT         := 0;
  v_calculation_line_count INT         := 0;
  v_exception_count        INT         := 0;
  v_target_status          TEXT;
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

  -- Idempotent-rerun guard: same input_hash + same run_mode = already persisted.
  IF v_run.status = 'calculated'
     AND v_run.input_hash IS NOT NULL AND v_run.input_hash = p_input_hash
     AND v_run.run_mode = COALESCE(p_run_mode, 'preview') THEN
    v_already_persisted := true;
  END IF;

  IF NOT v_already_persisted THEN
    IF v_run.status <> 'calculating' THEN
      UPDATE public.cam_runs SET status = 'calculating', updated_at = v_now WHERE id = p_cam_run_id;
    END IF;

    DELETE FROM public.cam_run_calculation_lines WHERE cam_run_id = p_cam_run_id;
    DELETE FROM public.cam_run_exceptions         WHERE cam_run_id = p_cam_run_id;
    DELETE FROM public.cam_run_lease_results      WHERE cam_run_id = p_cam_run_id;
    DELETE FROM public.cam_run_pool_results       WHERE cam_run_id = p_cam_run_id;

    CREATE TEMP TABLE IF NOT EXISTS tmp_pool_result_map  (pool_id  UUID PRIMARY KEY, pool_result_id  UUID) ON COMMIT DROP;
    CREATE TEMP TABLE IF NOT EXISTS tmp_lease_result_map (lease_id UUID PRIMARY KEY, lease_result_id UUID) ON COMMIT DROP;
    DELETE FROM tmp_pool_result_map  WHERE true;
    DELETE FROM tmp_lease_result_map WHERE true;

    INSERT INTO tmp_pool_result_map (pool_id, pool_result_id)
    SELECT (elem->>'pool_id')::UUID, gen_random_uuid()
    FROM jsonb_array_elements(COALESCE(p_pool_results, '[]'::jsonb)) elem;

    INSERT INTO public.cam_run_pool_results (
      id, org_id, cam_run_id, pool_id,
      actual_amount, excluded_amount, gross_up_adjustment, amortization, adjusted_pool, denominator_metrics
    )
    SELECT
      m.pool_result_id, p_org_id, p_cam_run_id, (elem->>'pool_id')::UUID,
      COALESCE((elem->>'actual_amount')::NUMERIC,        0),
      COALESCE((elem->>'excluded_amount')::NUMERIC,      0),
      COALESCE((elem->>'gross_up_adjustment')::NUMERIC,  0),
      COALESCE((elem->>'amortization')::NUMERIC,         0),
      COALESCE((elem->>'adjusted_pool')::NUMERIC,        0),
      COALESCE(elem->'denominator_metrics',              '{}'::jsonb)
    FROM jsonb_array_elements(COALESCE(p_pool_results, '[]'::jsonb)) elem
    JOIN tmp_pool_result_map m ON m.pool_id = (elem->>'pool_id')::UUID;
    GET DIAGNOSTICS v_pool_result_count = ROW_COUNT;

    INSERT INTO tmp_lease_result_map (lease_id, lease_result_id)
    SELECT (elem->>'lease_id')::UUID, gen_random_uuid()
    FROM jsonb_array_elements(COALESCE(p_lease_results, '[]'::jsonb)) elem;

    INSERT INTO public.cam_run_lease_results (
      id, org_id, cam_run_id, lease_id,
      final_recovery, estimates_billed, amount_due_credit, status
    )
    SELECT
      m.lease_result_id, p_org_id, p_cam_run_id, (elem->>'lease_id')::UUID,
      COALESCE((elem->>'final_recovery')::NUMERIC,    0),
      COALESCE((elem->>'estimates_billed')::NUMERIC,  0),
      COALESCE((elem->>'amount_due_credit')::NUMERIC, 0),
      'calculated'
    FROM jsonb_array_elements(COALESCE(p_lease_results, '[]'::jsonb)) elem
    JOIN tmp_lease_result_map m ON m.lease_id = (elem->>'lease_id')::UUID;
    GET DIAGNOSTICS v_lease_result_count = ROW_COUNT;

    -- Phase 4B: calculation_lines now carries 4 optional rounding columns.
    -- Old callers that omit them will get NULL in those columns (correct).
    INSERT INTO public.cam_run_calculation_lines (
      org_id, cam_run_id, lease_result_id, pool_result_id,
      sequence, line_type, category, formula_code,
      input_amount, output_amount, adjustment, policy_step_id, explanation,
      unrounded_aggregate, rounding_scope, rounded_amount, rounding_residual
    )
    SELECT
      p_org_id, p_cam_run_id, lm.lease_result_id, pm.pool_result_id,
      COALESCE((elem->>'sequence')::INT, 0),
      elem->>'line_type', elem->>'category', elem->>'formula_code',
      NULLIF(elem->>'input_amount',  'null')::NUMERIC,
      NULLIF(elem->>'output_amount', 'null')::NUMERIC,
      NULLIF(elem->>'adjustment',    'null')::NUMERIC,
      NULLIF(elem->>'policy_step_id','null')::UUID,
      elem->>'explanation',
      -- Phase 4B rounding columns (optional; NULL for non-ROUNDING_DETAIL lines).
      NULLIF(elem->>'unrounded_aggregate', 'null')::NUMERIC,
      NULLIF(elem->>'rounding_scope',      'null'),
      NULLIF(elem->>'rounded_amount',      'null')::NUMERIC,
      NULLIF(elem->>'rounding_residual',   'null')::NUMERIC
    FROM jsonb_array_elements(COALESCE(p_calculation_lines, '[]'::jsonb)) elem
    LEFT JOIN tmp_lease_result_map lm ON lm.lease_id = NULLIF(elem->>'lease_id', 'null')::UUID
    LEFT JOIN tmp_pool_result_map  pm ON pm.pool_id  = NULLIF(elem->>'pool_id',  'null')::UUID;
    GET DIAGNOSTICS v_calculation_line_count = ROW_COUNT;

    INSERT INTO public.cam_run_exceptions (org_id, cam_run_id, severity, code, entity_type, entity_id, message)
    SELECT
      p_org_id, p_cam_run_id,
      elem->>'severity', elem->>'code', elem->>'entity_type',
      NULLIF(elem->>'entity_id', 'null')::UUID, elem->>'message'
    FROM jsonb_array_elements(COALESCE(p_exceptions, '[]'::jsonb)) elem;
    GET DIAGNOSTICS v_exception_count = ROW_COUNT;

    v_target_status := CASE WHEN p_ready_to_post THEN 'calculated' ELSE 'readiness_failed' END;
    UPDATE public.cam_runs
       SET status         = v_target_status,
           input_hash     = p_input_hash,
           engine_version = p_engine_version,
           run_mode       = COALESCE(p_run_mode, 'preview'),
           -- Sync the scalar column with the JSONB policy for queryability.
           annual_rounding_scope = COALESCE(
             (rounding_policy->>'annual_rounding_scope'), 'LEASE_POOL_PERIOD'
           ),
           updated_at     = v_now
     WHERE id = p_cam_run_id;

    INSERT INTO public.audit_logs (
      org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp"
    ) VALUES (
      p_org_id, 'CamRun', p_cam_run_id::TEXT, 'cam_run_v2_results_persisted',
      p_actor_user_id, p_actor_email,
      CASE WHEN p_ready_to_post THEN 'info' ELSE 'warning' END,
      'edge_function',
      jsonb_build_object(
        'input_hash',             p_input_hash,
        'engine_version',         p_engine_version,
        'ready_to_post',          p_ready_to_post,
        'run_mode',               COALESCE(p_run_mode, 'preview'),
        'annual_rounding_scope',  COALESCE((SELECT annual_rounding_scope FROM public.cam_runs WHERE id = p_cam_run_id), 'LEASE_POOL_PERIOD'),
        'pool_result_count',      v_pool_result_count,
        'lease_result_count',     v_lease_result_count,
        'calculation_line_count', v_calculation_line_count,
        'exception_count',        v_exception_count
      ),
      v_now
    );
  ELSE
    SELECT count(*) INTO v_pool_result_count      FROM public.cam_run_pool_results      WHERE cam_run_id = p_cam_run_id;
    SELECT count(*) INTO v_lease_result_count     FROM public.cam_run_lease_results     WHERE cam_run_id = p_cam_run_id;
    SELECT count(*) INTO v_calculation_line_count FROM public.cam_run_calculation_lines WHERE cam_run_id = p_cam_run_id;
    SELECT count(*) INTO v_exception_count        FROM public.cam_run_exceptions        WHERE cam_run_id = p_cam_run_id;
  END IF;

  RETURN jsonb_build_object(
    'run_id',                  p_cam_run_id,
    'idempotent_rerun',        v_already_persisted,
    'status',                  (SELECT status FROM public.cam_runs WHERE id = p_cam_run_id),
    'annual_rounding_scope',   (SELECT annual_rounding_scope FROM public.cam_runs WHERE id = p_cam_run_id),
    'pool_result_count',       v_pool_result_count,
    'lease_result_count',      v_lease_result_count,
    'calculation_line_count',  v_calculation_line_count,
    'exception_count',         v_exception_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_cam_run_results(UUID,UUID,UUID,TEXT,TEXT,TEXT,BOOLEAN,JSONB,JSONB,JSONB,JSONB,TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.persist_cam_run_results(UUID,UUID,UUID,TEXT,TEXT,TEXT,BOOLEAN,JSONB,JSONB,JSONB,JSONB,TEXT) TO service_role;
