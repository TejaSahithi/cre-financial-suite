-- ===========================================================================
-- CAM Phase 4B — Step 2: Posting pipeline tables and RPCs.
--
-- All posting RPCs are SECURITY DEFINER, service_role-only. They are gated
-- on a feature flag checked inside the edge function (cam-run-workflow-v2)
-- before calling them. The RPCs themselves do NOT check the flag — the flag
-- belongs to the application layer, not the DB layer, per ADR-CAM-015.
--
-- New tables:
--   cam_run_statements          — versioned statement payloads per lease
--   cam_charge_exports          — idempotent charge export records
--   cam_adjustment_runs         — links original run → adjustment run
--   cam_restatement_runs        — links superseded run → restatement run
--   cam_real_property_validations — gate tracking (starts BLOCKED)
--
-- New RPCs:
--   post_cam_run
--   generate_cam_statements
--   create_cam_adjustment_run
--   create_cam_restatement_run
--   supersede_cam_run
--   create_cam_charge_export
--   cancel_unposted_cam_charge_export
--   mark_cam_charge_export_delivered
--
-- Statement contract (versioned JSON):
--   { schema_version, template_version, source_cam_run_id, generated_at,
--     content_hash, lease_id, tenant_name, period_label, start_date, end_date,
--     final_recovery, estimates_billed, amount_due_credit,
--     calculation_lines: [...], pool_summaries: [...] }
--
-- Charge export contract (canonical CSV, connector-hook-ready):
--   { export_version, source_cam_run_id, exported_at, rows: [...],
--     connector_adapter_stub: null }
-- ===========================================================================

-- ============================================================================
-- 1. cam_run_statements
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.cam_run_statements (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES public.organizations(id),
  cam_run_id          UUID        NOT NULL REFERENCES public.cam_runs(id),
  lease_id            UUID        REFERENCES public.leases(id),
  -- NULL lease_id = consolidated property package statement
  schema_version      TEXT        NOT NULL DEFAULT '1.0',
  template_version    TEXT        NOT NULL DEFAULT '1.0',
  statement_payload   JSONB       NOT NULL,
  content_hash        TEXT        NOT NULL,
  storage_path        TEXT,       -- Supabase Storage object path (nullable until uploaded)
  status              TEXT        NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'issued', 'void')),
  generated_by        UUID        REFERENCES auth.users(id),
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_at           TIMESTAMPTZ,
  voided_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevents re-generating an identical statement for the same run+lease.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cam_run_statements_run_lease
  ON public.cam_run_statements (cam_run_id, COALESCE(lease_id::TEXT, 'consolidated'))
  WHERE status <> 'void';

CREATE INDEX IF NOT EXISTS idx_cam_run_statements_cam_run_id ON public.cam_run_statements (cam_run_id);
CREATE INDEX IF NOT EXISTS idx_cam_run_statements_org_id     ON public.cam_run_statements (org_id);

-- ============================================================================
-- 2. cam_charge_exports
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.cam_charge_exports (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES public.organizations(id),
  cam_run_id            UUID        NOT NULL REFERENCES public.cam_runs(id),
  statement_id          UUID        REFERENCES public.cam_run_statements(id),
  export_version        TEXT        NOT NULL DEFAULT '1.0',
  export_payload        JSONB       NOT NULL,   -- canonical charge export JSON
  csv_storage_path      TEXT,                   -- Supabase Storage path for CSV file
  status                TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'delivered', 'cancelled')),
  -- Connector adapter hook: null until a real connector is registered.
  connector_adapter     TEXT,
  created_by            UUID        REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: one pending/delivered export per run at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cam_charge_exports_run_active
  ON public.cam_charge_exports (cam_run_id)
  WHERE status IN ('pending', 'delivered');

CREATE INDEX IF NOT EXISTS idx_cam_charge_exports_cam_run_id ON public.cam_charge_exports (cam_run_id);

-- ============================================================================
-- 3. cam_adjustment_runs
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.cam_adjustment_runs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID        NOT NULL REFERENCES public.organizations(id),
  original_run_id   UUID        NOT NULL REFERENCES public.cam_runs(id),
  adjustment_run_id UUID        NOT NULL REFERENCES public.cam_runs(id),
  reason            TEXT        NOT NULL,
  created_by        UUID        REFERENCES auth.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (adjustment_run_id)
);

-- ============================================================================
-- 4. cam_restatement_runs
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.cam_restatement_runs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES public.organizations(id),
  superseded_run_id     UUID        NOT NULL REFERENCES public.cam_runs(id),
  restatement_run_id    UUID        NOT NULL REFERENCES public.cam_runs(id),
  reason                TEXT        NOT NULL,
  created_by            UUID        REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (restatement_run_id)
);

-- ============================================================================
-- 5. cam_real_property_validations
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.cam_real_property_validations (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID        NOT NULL REFERENCES public.organizations(id),
  property_id       UUID        REFERENCES public.properties(id),
  cam_run_id        UUID        REFERENCES public.cam_runs(id),
  -- Gate status. Starts BLOCKED. Only an explicit manual review can set VERIFIED.
  status            TEXT        NOT NULL DEFAULT 'BLOCKED'
                      CHECK (status IN ('BLOCKED', 'IN_PROGRESS', 'VERIFIED', 'FAILED')),
  block_reason      TEXT        NOT NULL DEFAULT 'DATA_REQUIRED — No anonymized real property available for gate validation. Do not enable FEATURE_CAM_POSTING_ENABLED until this gate passes.',
  variance_report   JSONB,      -- populated during gate review
  manual_reviewer   UUID        REFERENCES auth.users(id),
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insert the initial BLOCKED gate row for the org (done at first-run time in the edge function).
-- This migration does NOT insert rows — the edge function creates them org-scoped.

-- ============================================================================
-- 6. RPC: post_cam_run
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_cam_run(
  p_org_id          UUID,
  p_cam_run_id      UUID,
  p_actor_user_id   UUID,
  p_actor_email     TEXT,
  p_reason          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_run         RECORD;
  v_open_blocking INT;
  v_unknown_adj   INT;
  v_now         TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_run FROM public.cam_runs
  WHERE id = p_cam_run_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAM run % not found in org %', p_cam_run_id, p_org_id;
  END IF;

  -- Idempotent: if already posted, return success without re-posting.
  IF v_run.status = 'posted' THEN
    RETURN jsonb_build_object('run_id', p_cam_run_id, 'status', 'posted', 'idempotent', true);
  END IF;

  IF v_run.status <> 'approved' THEN
    RAISE EXCEPTION 'Cannot post CAM run % — status is % (must be approved)', p_cam_run_id, v_run.status;
  END IF;

  IF v_run.run_mode <> 'posting_eligible' THEN
    RAISE EXCEPTION 'Cannot post CAM run % — run_mode is % (preview runs cannot be posted)', p_cam_run_id, v_run.run_mode;
  END IF;

  -- Gate 1: no open blocking exceptions
  SELECT COUNT(*) INTO v_open_blocking
  FROM public.cam_run_exceptions
  WHERE cam_run_id = p_cam_run_id AND severity = 'blocking' AND resolution_status = 'open';
  IF v_open_blocking > 0 THEN
    RAISE EXCEPTION 'Cannot post CAM run % — % open blocking exception(s) must be resolved first', p_cam_run_id, v_open_blocking;
  END IF;

  -- Gate 2: no UNKNOWN prior adjustments in a posting_eligible run
  SELECT COUNT(*) INTO v_unknown_adj
  FROM public.cam_prior_period_adjustments adj
  JOIN public.cam_run_lease_results lr ON lr.lease_id = adj.lease_id AND lr.cam_run_id = p_cam_run_id
  WHERE adj.recovery_period_id = v_run.recovery_period_id
    AND adj.org_id = p_org_id
    AND adj.state = 'UNKNOWN';
  IF v_unknown_adj > 0 THEN
    RAISE EXCEPTION 'Cannot post CAM run % — % UNKNOWN prior adjustment(s) must be resolved first', p_cam_run_id, v_unknown_adj;
  END IF;

  -- Post
  UPDATE public.cam_runs
     SET status    = 'posted',
         posted_at = v_now,
         updated_at = v_now
   WHERE id = p_cam_run_id;

  -- Immutability: lock all child rows (the existing trigger enforces this, but
  -- we also update the lease_results status to 'posted' for the statement step).
  UPDATE public.cam_run_lease_results
     SET status = 'posted', updated_at = v_now
   WHERE cam_run_id = p_cam_run_id;

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
  VALUES (p_org_id, 'CamRun', p_cam_run_id::TEXT, 'cam_run_posted',
    p_actor_user_id, p_actor_email, 'info', 'rpc',
    jsonb_build_object('reason', p_reason, 'posted_at', v_now), v_now);

  RETURN jsonb_build_object('run_id', p_cam_run_id, 'status', 'posted', 'posted_at', v_now, 'idempotent', false);
END;
$$;
REVOKE ALL ON FUNCTION public.post_cam_run(UUID,UUID,UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.post_cam_run(UUID,UUID,UUID,TEXT,TEXT) TO service_role;

-- ============================================================================
-- 7. RPC: generate_cam_statements
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generate_cam_statements(
  p_org_id          UUID,
  p_cam_run_id      UUID,
  p_actor_user_id   UUID,
  p_actor_email     TEXT,
  p_schema_version  TEXT DEFAULT '1.0',
  p_template_version TEXT DEFAULT '1.0'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_run         RECORD;
  v_lease       RECORD;
  v_period      RECORD;
  v_payload     JSONB;
  v_hash        TEXT;
  v_stmt_id     UUID;
  v_generated   INT := 0;
  v_skipped     INT := 0;
  v_now         TIMESTAMPTZ := now();
  v_stmt_ids    UUID[] := '{}';
BEGIN
  SELECT r.*, rp.start_date, rp.end_date, rp.label AS period_label
  INTO v_run
  FROM public.cam_runs r
  JOIN public.recovery_periods rp ON rp.id = r.recovery_period_id
  WHERE r.id = p_cam_run_id AND r.org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAM run % not found in org %', p_cam_run_id, p_org_id;
  END IF;

  IF v_run.status <> 'posted' THEN
    RAISE EXCEPTION 'Statements can only be generated from a posted run (status is %)', v_run.status;
  END IF;

  -- Generate one statement per lease result
  FOR v_lease IN
    SELECT lr.*, l.tenant_name
    FROM public.cam_run_lease_results lr
    JOIN public.leases l ON l.id = lr.lease_id
    WHERE lr.cam_run_id = p_cam_run_id
  LOOP
    -- Build statement payload (versioned JSON schema v1.0)
    v_payload := jsonb_build_object(
      'schema_version',    p_schema_version,
      'template_version',  p_template_version,
      'source_cam_run_id', p_cam_run_id,
      'generated_at',      v_now,
      'org_id',            p_org_id,
      'lease_id',          v_lease.lease_id,
      'tenant_name',       v_lease.tenant_name,
      'period_label',      v_run.period_label,
      'period_start',      v_run.start_date,
      'period_end',        v_run.end_date,
      'final_recovery',    v_lease.final_recovery,
      'estimates_billed',  v_lease.estimates_billed,
      'amount_due_credit', v_lease.amount_due_credit,
      'calculation_lines', (
        SELECT jsonb_agg(jsonb_build_object(
          'line_type', cl.line_type, 'formula_code', cl.formula_code,
          'category', cl.category, 'input_amount', cl.input_amount,
          'output_amount', cl.output_amount, 'adjustment', cl.adjustment,
          'explanation', cl.explanation,
          'segment_start', cl.segment_start, 'segment_end', cl.segment_end
        ) ORDER BY cl.sequence)
        FROM public.cam_run_calculation_lines cl
        WHERE cl.cam_run_id = p_cam_run_id AND cl.lease_result_id = v_lease.id
      ),
      'pool_summaries', (
        SELECT jsonb_agg(jsonb_build_object(
          'pool_id', pr.pool_id,
          'actual_amount', pr.actual_amount,
          'gross_up_adjustment', pr.gross_up_adjustment,
          'adjusted_pool', pr.adjusted_pool
        ))
        FROM public.cam_run_pool_results pr
        WHERE pr.cam_run_id = p_cam_run_id
      )
    );

    v_hash := encode(sha256(v_payload::TEXT::bytea), 'hex');

    -- Idempotent: skip if a non-void statement with this hash already exists.
    IF EXISTS (
      SELECT 1 FROM public.cam_run_statements
      WHERE cam_run_id = p_cam_run_id AND lease_id = v_lease.lease_id AND content_hash = v_hash AND status <> 'void'
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.cam_run_statements (
      org_id, cam_run_id, lease_id, schema_version, template_version,
      statement_payload, content_hash, status, generated_by, generated_at
    ) VALUES (
      p_org_id, p_cam_run_id, v_lease.lease_id, p_schema_version, p_template_version,
      v_payload, v_hash, 'draft', p_actor_user_id, v_now
    )
    RETURNING id INTO v_stmt_id;

    v_stmt_ids := array_append(v_stmt_ids, v_stmt_id);
    v_generated := v_generated + 1;
  END LOOP;

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
  VALUES (p_org_id, 'CamRun', p_cam_run_id::TEXT, 'cam_statements_generated',
    p_actor_user_id, p_actor_email, 'info', 'rpc',
    jsonb_build_object('generated', v_generated, 'skipped', v_skipped, 'statement_ids', v_stmt_ids), v_now);

  RETURN jsonb_build_object(
    'run_id', p_cam_run_id, 'generated', v_generated, 'skipped', v_skipped,
    'statement_ids', v_stmt_ids
  );
END;
$$;
REVOKE ALL ON FUNCTION public.generate_cam_statements(UUID,UUID,UUID,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.generate_cam_statements(UUID,UUID,UUID,TEXT,TEXT,TEXT) TO service_role;

-- ============================================================================
-- 8. RPC: create_cam_adjustment_run
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_cam_adjustment_run(
  p_org_id          UUID,
  p_original_run_id UUID,
  p_reason          TEXT,
  p_actor_user_id   UUID,
  p_actor_email     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_original    RECORD;
  v_adj_run     RECORD;
  v_now         TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_original FROM public.cam_runs WHERE id = p_original_run_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original CAM run % not found', p_original_run_id;
  END IF;
  IF v_original.status NOT IN ('posted', 'approved') THEN
    RAISE EXCEPTION 'Adjustment runs can only be created from posted or approved runs (status is %)', v_original.status;
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required for an adjustment run';
  END IF;

  INSERT INTO public.cam_runs (
    org_id, recovery_period_id, scope_type, scope_id, run_type,
    status, engine_version, rounding_policy, run_mode, adjustment_of_run_id, created_by
  ) VALUES (
    p_org_id, v_original.recovery_period_id, v_original.scope_type, v_original.scope_id,
    'adjustment', 'draft', v_original.engine_version, v_original.rounding_policy, 'preview',
    p_original_run_id, p_actor_user_id
  ) RETURNING * INTO v_adj_run;

  INSERT INTO public.cam_adjustment_runs (org_id, original_run_id, adjustment_run_id, reason, created_by)
  VALUES (p_org_id, p_original_run_id, v_adj_run.id, p_reason, p_actor_user_id);

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
  VALUES (p_org_id, 'CamRun', v_adj_run.id::TEXT, 'cam_adjustment_run_created',
    p_actor_user_id, p_actor_email, 'info', 'rpc',
    jsonb_build_object('original_run_id', p_original_run_id, 'reason', p_reason), v_now);

  RETURN jsonb_build_object('adjustment_run_id', v_adj_run.id, 'original_run_id', p_original_run_id, 'status', 'draft');
END;
$$;
REVOKE ALL ON FUNCTION public.create_cam_adjustment_run(UUID,UUID,TEXT,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_cam_adjustment_run(UUID,UUID,TEXT,UUID,TEXT) TO service_role;

-- ============================================================================
-- 9. RPC: create_cam_restatement_run
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_cam_restatement_run(
  p_org_id              UUID,
  p_superseded_run_id   UUID,
  p_reason              TEXT,
  p_actor_user_id       UUID,
  p_actor_email         TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_superseded  RECORD;
  v_new_run     RECORD;
  v_now         TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_superseded FROM public.cam_runs WHERE id = p_superseded_run_id AND org_id = p_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CAM run % not found', p_superseded_run_id; END IF;
  IF v_superseded.status NOT IN ('posted', 'approved') THEN
    RAISE EXCEPTION 'Restatement runs can only be created from posted or approved runs (status is %)', v_superseded.status;
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required for a restatement run';
  END IF;

  INSERT INTO public.cam_runs (
    org_id, recovery_period_id, scope_type, scope_id, run_type,
    status, engine_version, rounding_policy, run_mode, restatement_of_run_id, created_by
  ) VALUES (
    p_org_id, v_superseded.recovery_period_id, v_superseded.scope_type, v_superseded.scope_id,
    'restatement', 'draft', v_superseded.engine_version, v_superseded.rounding_policy, 'preview',
    p_superseded_run_id, p_actor_user_id
  ) RETURNING * INTO v_new_run;

  INSERT INTO public.cam_restatement_runs (org_id, superseded_run_id, restatement_run_id, reason, created_by)
  VALUES (p_org_id, p_superseded_run_id, v_new_run.id, p_reason, p_actor_user_id);

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
  VALUES (p_org_id, 'CamRun', v_new_run.id::TEXT, 'cam_restatement_run_created',
    p_actor_user_id, p_actor_email, 'info', 'rpc',
    jsonb_build_object('superseded_run_id', p_superseded_run_id, 'reason', p_reason), v_now);

  RETURN jsonb_build_object('restatement_run_id', v_new_run.id, 'superseded_run_id', p_superseded_run_id, 'status', 'draft');
END;
$$;
REVOKE ALL ON FUNCTION public.create_cam_restatement_run(UUID,UUID,TEXT,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_cam_restatement_run(UUID,UUID,TEXT,UUID,TEXT) TO service_role;

-- ============================================================================
-- 10. RPC: supersede_cam_run
-- ============================================================================
CREATE OR REPLACE FUNCTION public.supersede_cam_run(
  p_org_id          UUID,
  p_cam_run_id      UUID,
  p_new_run_id      UUID,
  p_actor_user_id   UUID,
  p_actor_email     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_now TIMESTAMPTZ := now(); BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.cam_runs WHERE id = p_cam_run_id AND org_id = p_org_id AND status = 'posted') THEN
    RAISE EXCEPTION 'Only posted runs can be superseded (run % not found or not posted)', p_cam_run_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cam_runs WHERE id = p_new_run_id AND org_id = p_org_id AND status = 'posted') THEN
    RAISE EXCEPTION 'New run % must be posted before superseding the old run', p_new_run_id;
  END IF;
  UPDATE public.cam_runs SET status = 'superseded', updated_at = v_now WHERE id = p_cam_run_id;
  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
  VALUES (p_org_id, 'CamRun', p_cam_run_id::TEXT, 'cam_run_superseded',
    p_actor_user_id, p_actor_email, 'info', 'rpc',
    jsonb_build_object('new_run_id', p_new_run_id), v_now);
  RETURN jsonb_build_object('superseded_run_id', p_cam_run_id, 'new_run_id', p_new_run_id, 'status', 'superseded');
END; $$;
REVOKE ALL ON FUNCTION public.supersede_cam_run(UUID,UUID,UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.supersede_cam_run(UUID,UUID,UUID,UUID,TEXT) TO service_role;

-- ============================================================================
-- 11. RPC: create_cam_charge_export (idempotent)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_cam_charge_export(
  p_org_id          UUID,
  p_cam_run_id      UUID,
  p_statement_id    UUID DEFAULT NULL,
  p_actor_user_id   UUID DEFAULT NULL,
  p_actor_email     TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_run         RECORD;
  v_existing    RECORD;
  v_export_id   UUID;
  v_payload     JSONB;
  v_now         TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_run FROM public.cam_runs WHERE id = p_cam_run_id AND org_id = p_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CAM run % not found', p_cam_run_id; END IF;
  IF v_run.status <> 'posted' THEN
    RAISE EXCEPTION 'Charge exports require a posted run (status is %)', v_run.status;
  END IF;

  -- Idempotent: return existing pending/delivered export if one exists.
  SELECT * INTO v_existing FROM public.cam_charge_exports
  WHERE cam_run_id = p_cam_run_id AND status IN ('pending', 'delivered')
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('export_id', v_existing.id, 'cam_run_id', p_cam_run_id, 'status', v_existing.status, 'idempotent', true);
  END IF;

  -- Build canonical export payload (v1.0 schema — CSV rows populated by edge function)
  v_payload := jsonb_build_object(
    'export_version',      '1.0',
    'source_cam_run_id',   p_cam_run_id,
    'exported_at',         v_now,
    'org_id',              p_org_id,
    'connector_adapter_stub', NULL,  -- hook for future AR connector integration
    'rows', (
      SELECT jsonb_agg(jsonb_build_object(
        'lease_id',          lr.lease_id,
        'final_recovery',    lr.final_recovery,
        'estimates_billed',  lr.estimates_billed,
        'amount_due_credit', lr.amount_due_credit,
        'charge_type',       'cam_reconciliation',
        'period_start',      rp.start_date,
        'period_end',        rp.end_date
      ))
      FROM public.cam_run_lease_results lr
      JOIN public.recovery_periods rp ON rp.id = v_run.recovery_period_id
      WHERE lr.cam_run_id = p_cam_run_id
    )
  );

  INSERT INTO public.cam_charge_exports (
    org_id, cam_run_id, statement_id, export_version, export_payload, status, created_by
  ) VALUES (
    p_org_id, p_cam_run_id, p_statement_id, '1.0', v_payload, 'pending', p_actor_user_id
  ) RETURNING id INTO v_export_id;

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
  VALUES (p_org_id, 'CamChargeExport', v_export_id::TEXT, 'cam_charge_export_created',
    p_actor_user_id, p_actor_email, 'info', 'rpc', jsonb_build_object('cam_run_id', p_cam_run_id), v_now);

  RETURN jsonb_build_object('export_id', v_export_id, 'cam_run_id', p_cam_run_id, 'status', 'pending', 'idempotent', false);
END;
$$;
REVOKE ALL ON FUNCTION public.create_cam_charge_export(UUID,UUID,UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_cam_charge_export(UUID,UUID,UUID,UUID,TEXT) TO service_role;

-- ============================================================================
-- 12. RPC: cancel_unposted_cam_charge_export
-- ============================================================================
CREATE OR REPLACE FUNCTION public.cancel_unposted_cam_charge_export(
  p_org_id          UUID,
  p_export_id       UUID,
  p_actor_user_id   UUID,
  p_actor_email     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_now TIMESTAMPTZ := now(); BEGIN
  UPDATE public.cam_charge_exports
     SET status = 'cancelled', cancelled_at = v_now, updated_at = v_now
   WHERE id = p_export_id AND org_id = p_org_id AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Export % not found, not pending, or already cancelled/delivered', p_export_id;
  END IF;
  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
  VALUES (p_org_id, 'CamChargeExport', p_export_id::TEXT, 'cam_charge_export_cancelled',
    p_actor_user_id, p_actor_email, 'info', 'rpc', '{}'::jsonb, v_now);
  RETURN jsonb_build_object('export_id', p_export_id, 'status', 'cancelled');
END; $$;
REVOKE ALL ON FUNCTION public.cancel_unposted_cam_charge_export(UUID,UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cancel_unposted_cam_charge_export(UUID,UUID,UUID,TEXT) TO service_role;

-- ============================================================================
-- 13. RPC: mark_cam_charge_export_delivered
-- ============================================================================
CREATE OR REPLACE FUNCTION public.mark_cam_charge_export_delivered(
  p_org_id          UUID,
  p_export_id       UUID,
  p_actor_user_id   UUID,
  p_actor_email     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_now TIMESTAMPTZ := now(); BEGIN
  UPDATE public.cam_charge_exports
     SET status = 'delivered', delivered_at = v_now, updated_at = v_now
   WHERE id = p_export_id AND org_id = p_org_id AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Export % not found or not in pending status', p_export_id;
  END IF;
  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, metadata, "timestamp")
  VALUES (p_org_id, 'CamChargeExport', p_export_id::TEXT, 'cam_charge_export_delivered',
    p_actor_user_id, p_actor_email, 'info', 'rpc', '{}'::jsonb, v_now);
  RETURN jsonb_build_object('export_id', p_export_id, 'status', 'delivered', 'delivered_at', v_now);
END; $$;
REVOKE ALL ON FUNCTION public.mark_cam_charge_export_delivered(UUID,UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.mark_cam_charge_export_delivered(UUID,UUID,UUID,TEXT) TO service_role;

-- ============================================================================
-- RLS: all new tables follow the same org-isolation pattern as existing tables.
-- ============================================================================
ALTER TABLE public.cam_run_statements           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_charge_exports           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_adjustment_runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_restatement_runs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cam_real_property_validations ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS — these are sufficient for Phase 4B.
CREATE POLICY "cam_run_statements_service_role" ON public.cam_run_statements TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "cam_charge_exports_service_role" ON public.cam_charge_exports TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "cam_adjustment_runs_service_role" ON public.cam_adjustment_runs TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "cam_restatement_runs_service_role" ON public.cam_restatement_runs TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "cam_real_property_validations_service_role" ON public.cam_real_property_validations TO service_role USING (true) WITH CHECK (true);

-- Read access for authenticated users (org-scoped)
CREATE POLICY "cam_run_statements_read" ON public.cam_run_statements FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.memberships WHERE user_id = auth.uid()));
CREATE POLICY "cam_charge_exports_read" ON public.cam_charge_exports FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.memberships WHERE user_id = auth.uid()));
CREATE POLICY "cam_real_property_validations_read" ON public.cam_real_property_validations FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.memberships WHERE user_id = auth.uid()));
