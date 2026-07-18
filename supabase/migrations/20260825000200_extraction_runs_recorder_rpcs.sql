-- P1.3: recorder RPCs -- the sole write path into extraction_stage_runs,
-- provider_invocations, and extraction_artifacts. Part of the Lease
-- Intelligence Enterprise P1-P8 roadmap
-- (C:\Users\tejas\.claude\plans\think-as-senior-enterprise-elegant-harbor.md).
--
-- Round-3 external review: prefer narrow, purpose-built RPCs for every
-- lifecycle transition over letting Edge Function code INSERT/UPDATE these
-- tables directly -- consistent with how P0 already centralizes
-- generation/job lifecycle logic in start_lease_extraction_generation /
-- claim_pipeline_job rather than letting Edge Functions manipulate
-- pipeline_jobs rows directly. All six: SECURITY DEFINER, service-role
-- only, conditional (idempotent) state transitions -- never a bare UPDATE
-- that could silently overwrite a terminal row -- and structured JSON
-- returns rather than letting an expected idempotency conflict surface as
-- a raw Postgres exception to the caller.

-- ---------------------------------------------------------------------------
-- start_extraction_stage_run -- one row per (run, stage, attempt). attempt
-- is server-derived (max existing attempt for this run+stage, plus one),
-- not caller-supplied -- callers should never need to track attempt
-- numbers themselves, and this guarantees a retry always gets a fresh
-- attempt rather than risking a caller passing a stale/duplicate one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_extraction_stage_run(
  p_org_id UUID,
  p_run_id UUID,
  p_stage TEXT,
  p_pipeline_job_id UUID DEFAULT NULL,
  p_provider TEXT DEFAULT NULL,
  p_input_fingerprint TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run public.extraction_runs%ROWTYPE;
  v_next_attempt INT;
  v_stage_run_id UUID;
BEGIN
  IF p_org_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'org_id and run_id are required';
  END IF;
  IF p_stage NOT IN ('parse', 'normalize', 'enrich') THEN
    RAISE EXCEPTION 'stage must be one of parse/normalize/enrich, got %', p_stage;
  END IF;

  SELECT * INTO v_run
    FROM public.extraction_runs
   WHERE id = p_run_id AND org_id = p_org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'extraction_runs row % not found for this organization', p_run_id;
  END IF;

  IF v_run.status <> 'running' THEN
    -- A terminal (completed/failed/superseded) run can never gain a new
    -- stage attempt -- that would be recording new work against a run that
    -- is no longer active, the same fencing principle P0 already applies
    -- to superseded generations.
    RAISE EXCEPTION 'extraction_runs % is not running (status=%), cannot start a new stage run', p_run_id, v_run.status;
  END IF;

  SELECT COALESCE(MAX(attempt), 0) + 1 INTO v_next_attempt
    FROM public.extraction_stage_runs
   WHERE run_id = p_run_id AND stage = p_stage;

  INSERT INTO public.extraction_stage_runs (
    org_id, run_id, pipeline_job_id, stage, attempt, provider, input_fingerprint
  )
  VALUES (
    p_org_id, p_run_id, p_pipeline_job_id, p_stage, v_next_attempt, p_provider, p_input_fingerprint
  )
  RETURNING id INTO v_stage_run_id;

  RETURN jsonb_build_object(
    'stage_run_id', v_stage_run_id,
    'attempt', v_next_attempt
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_extraction_stage_run(UUID, UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_extraction_stage_run(UUID, UUID, TEXT, UUID, TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- settle_extraction_stage_run -- DB-idempotent terminalization. The
-- conditional `WHERE status = 'running'` is the actual idempotency
-- mechanism (round-3 fix): a second settlement call, from any source
-- (a call site AND the withExtractionStage `finally` safety net both
-- calling this), matches zero rows and is a safe no-op -- it never
-- re-terminalizes an already-terminal row, and never lets a 'failed' row
-- flip to 'completed' or vice versa. The trigger
-- enforce_extraction_stage_run_terminal_guard is a second, DB-level
-- backstop against the same class of bug.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_extraction_stage_run(
  p_stage_run_id UUID,
  p_org_id UUID,
  p_status TEXT,
  p_error_code TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL,
  p_output_summary JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated_id UUID;
  v_current_status TEXT;
  v_output_summary JSONB;
BEGIN
  IF p_stage_run_id IS NULL OR p_org_id IS NULL THEN
    RAISE EXCEPTION 'stage_run_id and org_id are required';
  END IF;
  IF p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'settle_extraction_stage_run status must be completed or failed, got %', p_status;
  END IF;

  -- Defense in depth: the TS recorder (sanitizeOutputSummary) already
  -- bounds this before calling the RPC, but a future direct caller must
  -- not be able to store document-sized content here by skipping that
  -- module. Same 32KB threshold as the TS-side cap; drop to a small marker
  -- object rather than truncating mid-JSON.
  v_output_summary := p_output_summary;
  IF v_output_summary IS NOT NULL AND octet_length(v_output_summary::text) > 32000 THEN
    v_output_summary := jsonb_build_object(
      '_truncated', true,
      '_original_size_bytes', octet_length(v_output_summary::text)
    );
  END IF;

  UPDATE public.extraction_stage_runs
     SET status = p_status,
         error_code = p_error_code,
         error_message = p_error_message,
         output_summary = COALESCE(v_output_summary, output_summary),
         finished_at = now(),
         updated_at = now()
   WHERE id = p_stage_run_id
     AND org_id = p_org_id
     AND status = 'running'
  RETURNING id INTO v_updated_id;

  SELECT status INTO v_current_status
    FROM public.extraction_stage_runs
   WHERE id = p_stage_run_id AND org_id = p_org_id;

  IF v_current_status IS NULL THEN
    RAISE EXCEPTION 'extraction_stage_runs row % not found for this organization', p_stage_run_id;
  END IF;

  RETURN jsonb_build_object(
    'settled_by_this_call', v_updated_id IS NOT NULL,
    'status', v_current_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_extraction_stage_run(UUID, UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_extraction_stage_run(UUID, UUID, TEXT, TEXT, TEXT, JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- start_provider_invocation -- conflict-aware insert-or-return (round-3
-- fix): a bare INSERT relying on UNIQUE(org_id, invocation_key) would throw
-- an unhandled unique-violation on any replay/race. Behavior:
--   * no existing row for invocation_key -> insert running, created=true
--   * existing row, status='running'    -> return it, created=false
--     (a replay of an in-flight call -- never insert a second row)
--   * existing row, terminal            -> return it, created=false
--     (NEVER reset a terminal invocation back to running -- a genuine
--     retry must go through the caller's own retry logic, which produces a
--     new provider_attempt and therefore a different invocation_key/new row)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_provider_invocation(
  p_org_id UUID,
  p_run_id UUID,
  p_stage_run_id UUID,
  p_provider TEXT,
  p_operation TEXT,
  p_invocation_key TEXT,
  p_provider_attempt INT DEFAULT 1,
  p_model TEXT DEFAULT NULL,
  p_location TEXT DEFAULT NULL,
  p_chunk_index INT DEFAULT NULL,
  p_request_id TEXT DEFAULT NULL,
  p_request_fingerprint TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.provider_invocations%ROWTYPE;
  v_new_id UUID;
BEGIN
  IF p_org_id IS NULL OR p_run_id IS NULL OR p_stage_run_id IS NULL THEN
    RAISE EXCEPTION 'org_id, run_id, and stage_run_id are required';
  END IF;
  IF NULLIF(trim(COALESCE(p_invocation_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'invocation_key is required';
  END IF;

  SELECT * INTO v_existing
    FROM public.provider_invocations
   WHERE org_id = p_org_id AND invocation_key = p_invocation_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'invocation_id', v_existing.id,
      'created', false,
      'status', v_existing.status
    );
  END IF;

  INSERT INTO public.provider_invocations (
    org_id, run_id, stage_run_id, provider, operation, model, location,
    chunk_index, provider_attempt, invocation_key, request_id,
    request_fingerprint, requested_at
  )
  VALUES (
    p_org_id, p_run_id, p_stage_run_id, p_provider, p_operation, p_model, p_location,
    p_chunk_index, p_provider_attempt, p_invocation_key, p_request_id,
    p_request_fingerprint, now()
  )
  -- A concurrent racer could insert the same invocation_key between our
  -- SELECT above and this INSERT; ON CONFLICT DO NOTHING + a re-SELECT
  -- below closes that window without relying on an unhandled exception.
  ON CONFLICT (org_id, invocation_key) DO NOTHING
  RETURNING id INTO v_new_id;

  IF v_new_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'invocation_id', v_new_id,
      'created', true,
      'status', 'running'
    );
  END IF;

  -- Lost the race: someone else's row won. Return theirs, exactly like the
  -- existing-row path above.
  SELECT * INTO v_existing
    FROM public.provider_invocations
   WHERE org_id = p_org_id AND invocation_key = p_invocation_key;

  RETURN jsonb_build_object(
    'invocation_id', v_existing.id,
    'created', false,
    'status', v_existing.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_provider_invocation(UUID, UUID, UUID, TEXT, TEXT, TEXT, INT, TEXT, TEXT, INT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_provider_invocation(UUID, UUID, UUID, TEXT, TEXT, TEXT, INT, TEXT, TEXT, INT, TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- settle_provider_invocation -- same DB-idempotent conditional-UPDATE
-- pattern as settle_extraction_stage_run.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_provider_invocation(
  p_invocation_id UUID,
  p_org_id UUID,
  p_status TEXT,
  p_success BOOLEAN,
  p_failure_classification TEXT DEFAULT NULL,
  p_provider_error_code TEXT DEFAULT NULL,
  p_provider_error_status TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL,
  p_input_tokens INT DEFAULT NULL,
  p_output_tokens INT DEFAULT NULL,
  p_latency_ms INT DEFAULT NULL,
  p_http_status INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated_id UUID;
  v_current_status TEXT;
BEGIN
  IF p_invocation_id IS NULL OR p_org_id IS NULL THEN
    RAISE EXCEPTION 'invocation_id and org_id are required';
  END IF;
  IF p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'settle_provider_invocation status must be completed or failed, got %', p_status;
  END IF;

  UPDATE public.provider_invocations
     SET status = p_status,
         success = p_success,
         failure_classification = p_failure_classification,
         provider_error_code = p_provider_error_code,
         provider_error_status = p_provider_error_status,
         error_message = p_error_message,
         input_tokens = p_input_tokens,
         output_tokens = p_output_tokens,
         latency_ms = p_latency_ms,
         http_status = p_http_status,
         completed_at = now()
   WHERE id = p_invocation_id
     AND org_id = p_org_id
     AND status = 'running'
  RETURNING id INTO v_updated_id;

  SELECT status INTO v_current_status
    FROM public.provider_invocations
   WHERE id = p_invocation_id AND org_id = p_org_id;

  IF v_current_status IS NULL THEN
    RAISE EXCEPTION 'provider_invocations row % not found for this organization', p_invocation_id;
  END IF;

  RETURN jsonb_build_object(
    'settled_by_this_call', v_updated_id IS NOT NULL,
    'status', v_current_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_provider_invocation(UUID, UUID, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, INT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_provider_invocation(UUID, UUID, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, INT, INT, INT) TO service_role;

-- ---------------------------------------------------------------------------
-- register_extraction_artifact -- inserts one artifact row (inline content,
-- or an already-uploaded storage_object's bucket/path/hash/size), and
-- optionally links it back onto the owning invocation's
-- raw_request_artifact_id/raw_response_artifact_id + sets that
-- invocation's request_artifact_status/response_artifact_status
-- accordingly (both columns are deliberately excluded from
-- enforce_provider_invocation_terminal_guard's immutable-field list, so
-- this is safe to call even after the invocation itself has terminalized).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_extraction_artifact(
  p_org_id UUID,
  p_run_id UUID,
  p_artifact_type TEXT,
  p_storage_mode TEXT,
  p_byte_size INT,
  p_stage_run_id UUID DEFAULT NULL,
  p_inline_content JSONB DEFAULT NULL,
  p_storage_bucket TEXT DEFAULT NULL,
  p_storage_path TEXT DEFAULT NULL,
  p_content_type TEXT DEFAULT 'application/json',
  p_sha256 TEXT DEFAULT NULL,
  p_retention_class TEXT DEFAULT 'debug_short_term',
  p_contains_document_content BOOLEAN DEFAULT true,
  p_contains_personal_data BOOLEAN DEFAULT true,
  p_link_to_invocation_id UUID DEFAULT NULL,
  p_link_role TEXT DEFAULT NULL -- 'request' or 'response', required if p_link_to_invocation_id is set
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_artifact_id UUID;
BEGIN
  IF p_org_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'org_id and run_id are required';
  END IF;
  IF p_link_to_invocation_id IS NOT NULL AND p_link_role NOT IN ('request', 'response') THEN
    RAISE EXCEPTION 'link_role must be request or response when link_to_invocation_id is supplied';
  END IF;

  INSERT INTO public.extraction_artifacts (
    org_id, run_id, stage_run_id, artifact_type, storage_mode, inline_content,
    storage_bucket, storage_path, content_type, byte_size, sha256,
    retention_class, contains_document_content, contains_personal_data
  )
  VALUES (
    p_org_id, p_run_id, p_stage_run_id, p_artifact_type, p_storage_mode, p_inline_content,
    p_storage_bucket, p_storage_path, p_content_type, p_byte_size, p_sha256,
    p_retention_class, p_contains_document_content, p_contains_personal_data
  )
  RETURNING id INTO v_artifact_id;

  IF p_link_to_invocation_id IS NOT NULL THEN
    IF p_link_role = 'request' THEN
      UPDATE public.provider_invocations
         SET raw_request_artifact_id = v_artifact_id,
             request_artifact_status = 'stored'
       WHERE id = p_link_to_invocation_id AND org_id = p_org_id;
    ELSE
      UPDATE public.provider_invocations
         SET raw_response_artifact_id = v_artifact_id,
             response_artifact_status = 'stored'
       WHERE id = p_link_to_invocation_id AND org_id = p_org_id;
    END IF;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'provider_invocations row % not found for this organization', p_link_to_invocation_id;
    END IF;
  END IF;

  RETURN jsonb_build_object('artifact_id', v_artifact_id);
END;
$$;

REVOKE ALL ON FUNCTION public.register_extraction_artifact(UUID, UUID, TEXT, TEXT, INT, UUID, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_extraction_artifact(UUID, UUID, TEXT, TEXT, INT, UUID, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, UUID, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- fail_extraction_run -- narrow, explicit run-level failure for genuinely
-- terminal pipeline exhaustion (e.g. MAX_ATTEMPTS_EXCEEDED on the enrich
-- stage). Distinct from the P0 finalizer's 'completed' path
-- (finalize_lease_extraction_for_review, which owns success) and from
-- P1.2's 'superseded' path (start_lease_extraction_generation, which owns
-- supersession) -- this is the third and last way an extraction_runs row
-- reaches a terminal state, and the only one that represents an actual
-- processing failure.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fail_extraction_run(
  p_org_id UUID,
  p_run_id UUID,
  p_error_code TEXT,
  p_error_message TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated_id UUID;
  v_current_status TEXT;
BEGIN
  IF p_org_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'org_id and run_id are required';
  END IF;

  UPDATE public.extraction_runs
     SET status = 'failed',
         error_code = p_error_code,
         error_message = p_error_message,
         completed_at = now(),
         updated_at = now()
   WHERE id = p_run_id
     AND org_id = p_org_id
     AND status = 'running'
  RETURNING id INTO v_updated_id;

  SELECT status INTO v_current_status
    FROM public.extraction_runs
   WHERE id = p_run_id AND org_id = p_org_id;

  IF v_current_status IS NULL THEN
    RAISE EXCEPTION 'extraction_runs row % not found for this organization', p_run_id;
  END IF;

  RETURN jsonb_build_object(
    'settled_by_this_call', v_updated_id IS NOT NULL,
    'status', v_current_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fail_extraction_run(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_extraction_run(UUID, UUID, TEXT, TEXT) TO service_role;
