-- P0.2: dedicated generation-start RPC + generation-scoped enqueue/claim.
-- Part of the Lease Review pipeline-honesty plan
-- (C:\Users\tejas\.claude\plans\think-as-senior-enterprise-elegant-harbor.md).
--
-- Why a dedicated generation-start boundary is needed: if any ordinary
-- enqueue call were allowed to decide "this is a new generation," two
-- concurrent explicit re-extraction requests could both advance
-- uploaded_files.active_generation_id, racing each other. Starting a
-- generation must be its own atomic, narrowly-invoked operation --
-- start_lease_extraction_generation below is the only place a new
-- generation is ever created. enqueue_pipeline_job only adds a later-stage
-- job (e.g. "enrich" after "normalize" completes) to an EXISTING generation.
--
-- Why cancel-then-insert (the pattern this replaces in ingest-file.ts and
-- enrichment-dispatch.ts) was unsafe, not just non-atomic: flipping a job
-- row's status to 'cancelled'/'superseded' does not stop an Edge Function
-- invocation that is already executing -- that invocation can finish and
-- persist stale output after a replacement generation has started. This
-- migration only fixes the bookkeeping race (two dispatches both deciding
-- to supersede/insert); the "stale worker still finishes and writes" half
-- of the problem is fixed separately in P0.3 by fencing every persistence
-- write against uploaded_files.active_generation_id, not here.

-- --- Uniqueness: the actual DB-enforced invariant -------------------------
-- Requires pipeline_jobs.generation_id to be NOT NULL (done in the previous
-- migration) -- a unique index over a nullable column would not protect
-- NULL-generation rows, since SQL NULLs never compare equal to each other.
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_jobs_active_generation_stage_unique
  ON public.pipeline_jobs (uploaded_file_id, job_type, stage, generation_id)
  WHERE status IN ('queued', 'running');

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_jobs_idempotency_unique
  ON public.pipeline_jobs (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- --- start_lease_extraction_generation ------------------------------------
-- The only place a new generation is born. Called only from: initial
-- ingestion, explicit user-initiated re-extraction, explicit administrative
-- replay (new contract/provider version). Retries of an existing generation
-- never call this -- they reuse the existing generation_id/job row via
-- enqueue_pipeline_job or the worker's own retry path.
CREATE OR REPLACE FUNCTION public.start_lease_extraction_generation(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_job_type TEXT,
  p_initial_stage TEXT,
  p_contract_version TEXT,
  p_input JSONB DEFAULT '{}'::jsonb,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_file public.uploaded_files%ROWTYPE;
  v_new_generation_id UUID := gen_random_uuid();
  v_job_id UUID;
  v_idempotency_key TEXT;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_uploaded_file_id IS NULL THEN
    RAISE EXCEPTION 'uploaded_file_id is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_job_type, '')), '') IS NULL THEN
    RAISE EXCEPTION 'job_type is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_initial_stage, '')), '') IS NULL THEN
    RAISE EXCEPTION 'initial_stage is required';
  END IF;

  SELECT *
    INTO v_file
    FROM public.uploaded_files
   WHERE id = p_uploaded_file_id
     AND org_id = p_org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Uploaded file not found for this organization';
  END IF;

  -- Supersede the previous generation's still-active jobs. Queued jobs can
  -- be marked terminal immediately (nothing is executing them yet). Running
  -- jobs only get cancel_requested_at set -- they are left non-terminal
  -- until the worker itself observes the flag and acknowledges cancellation
  -- (see lease-extraction-worker's existing cancel_requested_at checkpoints).
  UPDATE public.pipeline_jobs
     SET status = 'superseded',
         error_code = 'SUPERSEDED_BY_NEW_GENERATION',
         error_message = 'Superseded by a newer extraction generation.',
         completed_at = v_now,
         updated_at = v_now
   WHERE uploaded_file_id = p_uploaded_file_id
     AND status = 'queued';

  UPDATE public.pipeline_jobs
     SET cancel_requested_at = COALESCE(cancel_requested_at, v_now),
         updated_at = v_now
   WHERE uploaded_file_id = p_uploaded_file_id
     AND status = 'running';

  v_idempotency_key := format(
    'lease-extraction:%s:%s:%s:%s',
    p_uploaded_file_id, v_new_generation_id, p_initial_stage, COALESCE(p_contract_version, 'unversioned')
  );

  INSERT INTO public.pipeline_jobs (
    org_id, uploaded_file_id, job_type, stage, status,
    generation_id, idempotency_key, max_attempts, input, metadata
  )
  VALUES (
    p_org_id, p_uploaded_file_id, p_job_type, p_initial_stage, 'queued',
    v_new_generation_id, v_idempotency_key, 3,
    COALESCE(p_input, '{}'::jsonb), COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_job_id;

  UPDATE public.uploaded_files
     SET active_generation_id = v_new_generation_id,
         updated_at = v_now
   WHERE id = p_uploaded_file_id;

  RETURN jsonb_build_object(
    'generation_id', v_new_generation_id,
    'job_id', v_job_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_lease_extraction_generation(
  UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_lease_extraction_generation(
  UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB
) TO service_role;

-- --- enqueue_pipeline_job --------------------------------------------------
-- Adds a later-stage job (e.g. "enrich" after "normalize") to the file's
-- EXISTING active generation. Never creates a generation. Same-generation
-- duplicate request returns the existing active job untouched rather than
-- creating a second one -- the unique index above is the final backstop if
-- two callers race past the existence check simultaneously.
CREATE OR REPLACE FUNCTION public.enqueue_pipeline_job(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_job_type TEXT,
  p_stage TEXT,
  p_contract_version TEXT,
  p_max_attempts INT DEFAULT 3,
  p_input JSONB DEFAULT '{}'::jsonb,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_file public.uploaded_files%ROWTYPE;
  v_existing public.pipeline_jobs%ROWTYPE;
  v_job_id UUID;
  v_idempotency_key TEXT;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_uploaded_file_id IS NULL THEN
    RAISE EXCEPTION 'uploaded_file_id is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_stage, '')), '') IS NULL THEN
    RAISE EXCEPTION 'stage is required';
  END IF;

  SELECT *
    INTO v_file
    FROM public.uploaded_files
   WHERE id = p_uploaded_file_id
     AND org_id = p_org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Uploaded file not found for this organization';
  END IF;

  IF v_file.active_generation_id IS NULL THEN
    RAISE EXCEPTION 'File has no active extraction generation; call start_lease_extraction_generation first';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.pipeline_jobs
   WHERE uploaded_file_id = p_uploaded_file_id
     AND job_type = p_job_type
     AND stage = p_stage
     AND generation_id = v_file.active_generation_id
     AND status IN ('queued', 'running')
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'created', false,
      'existing_job_id', v_existing.id,
      'generation_id', v_file.active_generation_id
    );
  END IF;

  v_idempotency_key := format(
    'lease-extraction:%s:%s:%s:%s',
    p_uploaded_file_id, v_file.active_generation_id, p_stage, COALESCE(p_contract_version, 'unversioned')
  );

  BEGIN
    INSERT INTO public.pipeline_jobs (
      org_id, uploaded_file_id, job_type, stage, status,
      generation_id, idempotency_key, max_attempts, input, metadata
    )
    VALUES (
      p_org_id, p_uploaded_file_id, p_job_type, p_stage, 'queued',
      v_file.active_generation_id, v_idempotency_key, COALESCE(p_max_attempts, 3),
      COALESCE(p_input, '{}'::jsonb), COALESCE(p_metadata, '{}'::jsonb)
    )
    RETURNING id INTO v_job_id;
  EXCEPTION WHEN unique_violation THEN
    -- Lost a race against a concurrent caller between the existence check
    -- above and this insert; return the row that won instead of erroring.
    SELECT *
      INTO v_existing
      FROM public.pipeline_jobs
     WHERE uploaded_file_id = p_uploaded_file_id
       AND job_type = p_job_type
       AND stage = p_stage
       AND generation_id = v_file.active_generation_id
       AND status IN ('queued', 'running')
     LIMIT 1;

    RETURN jsonb_build_object(
      'created', false,
      'existing_job_id', v_existing.id,
      'generation_id', v_file.active_generation_id
    );
  END;

  RETURN jsonb_build_object(
    'created', true,
    'job_id', v_job_id,
    'generation_id', v_file.active_generation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_pipeline_job(
  UUID, UUID, TEXT, TEXT, TEXT, INT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_pipeline_job(
  UUID, UUID, TEXT, TEXT, TEXT, INT, JSONB, JSONB
) TO service_role;

-- --- claim_pipeline_job ----------------------------------------------------
-- Atomic conditional claim, replacing the worker's previous unconditional
-- `.update({status:'running',...}).eq('id', job.id)` (no predicate beyond
-- id -- it could "claim" a job that had already been superseded/cancelled
-- between the worker's initial fetch and this update). Returns the claimed
-- row as jsonb, or NULL if no row matched (already claimed, superseded,
-- cancelled, not yet available, or attempts exhausted) -- callers must
-- treat NULL as "stop, do not proceed," never retry-claim in a loop.
CREATE OR REPLACE FUNCTION public.claim_pipeline_job(
  p_job_id UUID,
  p_worker_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_claimed public.pipeline_jobs%ROWTYPE;
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'job_id is required';
  END IF;

  UPDATE public.pipeline_jobs
     SET status = 'running',
         started_at = COALESCE(started_at, now()),
         attempt = attempt + 1,
         worker_name = p_worker_name,
         updated_at = now()
   WHERE id = p_job_id
     AND status = 'queued'
     AND available_at <= now()
     AND cancel_requested_at IS NULL
     AND attempt < max_attempts
  RETURNING * INTO v_claimed;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN to_jsonb(v_claimed);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_pipeline_job(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pipeline_job(UUID, TEXT) TO service_role;
