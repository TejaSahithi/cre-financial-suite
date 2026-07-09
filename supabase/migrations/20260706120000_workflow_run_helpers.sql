-- Enterprise hardening Phase 0: shared plpgsql helpers for the server-owned
-- workflow pattern documented in docs/server-owned-workflow-pattern.md.
--
-- Additive only. Does not touch existing workflow RPCs
-- (approve_lease_workflow, send_expense_classification_to_cam_workflow,
-- publish_lease_expense_rule_to_cam_workflow) or their run tables, which keep
-- their own named entity-id columns (lease_id, classification_id, ...) and
-- their own hand-written run bookkeeping.
--
-- New workflow run tables built from here forward should use a single
-- generic `entity_id UUID` column (in addition to whichever FK columns the
-- workflow also needs for its own joins) so they can use these helpers:
--
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
--   entity_id UUID NOT NULL,
--   idempotency_key TEXT NOT NULL,
--   status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started','completed','failed')),
--   request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
--   response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
--   error_message TEXT,
--   actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
--   actor_email TEXT,
--   started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
--   completed_at TIMESTAMPTZ,
--   created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
--   updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
--   UNIQUE (org_id, idempotency_key)

CREATE OR REPLACE FUNCTION public.begin_workflow_run(
  p_runs_table REGCLASS,
  p_org_id UUID,
  p_entity_id UUID,
  p_idempotency_key TEXT,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_request_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  run_id UUID,
  run_entity_id UUID,
  run_status TEXT,
  run_request_payload JSONB,
  run_response_payload JSONB,
  is_duplicate_entity BOOLEAN,
  is_duplicate_payload BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run_id UUID;
  v_entity_id UUID;
  v_status TEXT;
  v_request JSONB;
  v_response JSONB;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_entity_id IS NULL THEN
    RAISE EXCEPTION 'entity_id is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_idempotency_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;

  EXECUTE format(
    'INSERT INTO %s (org_id, entity_id, idempotency_key, status, request_payload, actor_user_id, actor_email)
     VALUES ($1, $2, $3, ''started'', $4, $5, $6)
     ON CONFLICT (org_id, idempotency_key) DO NOTHING',
    p_runs_table
  ) USING p_org_id, p_entity_id, p_idempotency_key, COALESCE(p_request_payload, '{}'::jsonb), p_actor_user_id, p_actor_email;

  EXECUTE format(
    'SELECT id, entity_id, status, request_payload, response_payload FROM %s WHERE org_id = $1 AND idempotency_key = $2 FOR UPDATE',
    p_runs_table
  ) INTO v_run_id, v_entity_id, v_status, v_request, v_response
  USING p_org_id, p_idempotency_key;

  RETURN QUERY SELECT
    v_run_id,
    v_entity_id,
    v_status,
    v_request,
    v_response,
    (v_entity_id IS DISTINCT FROM p_entity_id),
    (v_request IS DISTINCT FROM COALESCE(p_request_payload, '{}'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_workflow_run(
  p_runs_table REGCLASS,
  p_run_id UUID,
  p_response_payload JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'run_id is required';
  END IF;

  EXECUTE format(
    'UPDATE %s SET status = ''completed'', response_payload = $1, completed_at = now(), error_message = NULL WHERE id = $2',
    p_runs_table
  ) USING p_response_payload, p_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_workflow_run(
  p_runs_table REGCLASS,
  p_run_id UUID,
  p_error_message TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_run_id IS NULL THEN
    RETURN;
  END IF;

  EXECUTE format(
    'UPDATE %s SET status = ''failed'', error_message = $1 WHERE id = $2',
    p_runs_table
  ) USING p_error_message, p_run_id;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_workflow_run(REGCLASS, UUID, UUID, TEXT, UUID, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_workflow_run(REGCLASS, UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fail_workflow_run(REGCLASS, UUID, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.begin_workflow_run(REGCLASS, UUID, UUID, TEXT, UUID, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_workflow_run(REGCLASS, UUID, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fail_workflow_run(REGCLASS, UUID, TEXT) TO authenticated, service_role;
