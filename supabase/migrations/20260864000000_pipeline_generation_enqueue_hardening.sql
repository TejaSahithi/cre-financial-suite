-- Release 11 hotfix: reassert generation-scoped lease extraction enqueue.
--
-- The upload confirmation path must never insert a pipeline_jobs row without
-- a generation_id. This migration intentionally republishes the RPCs after the
-- Release 10 migration set so deployed databases cannot retain an older queue
-- function definition that omits generation identity.

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
  v_new_generation_id UUID := gen_random_uuid();
  v_job_id UUID;
  v_idempotency_key TEXT;
  v_provenance_enabled BOOLEAN;
  v_run_type TEXT;
  v_extraction_run_id UUID;
  v_has_extraction_runs BOOLEAN;
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

  PERFORM 1
    FROM public.uploaded_files
   WHERE id = p_uploaded_file_id
     AND org_id = p_org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Uploaded file not found for this organization';
  END IF;

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

  v_has_extraction_runs := to_regclass('public.extraction_runs') IS NOT NULL;

  IF v_has_extraction_runs THEN
    UPDATE public.extraction_runs
       SET status = 'superseded',
           completed_at = v_now,
           updated_at = v_now,
           metadata = metadata || jsonb_build_object(
             'terminal_reason', 'superseded_by_new_generation',
             'superseded_by_generation_id', v_new_generation_id
           )
     WHERE uploaded_file_id = p_uploaded_file_id
       AND status = 'running'
       AND generation_id <> v_new_generation_id;
  END IF;

  v_idempotency_key := format(
    'lease-extraction:%s:%s:%s:%s',
    p_uploaded_file_id,
    v_new_generation_id,
    p_initial_stage,
    COALESCE(NULLIF(p_contract_version, ''), 'unversioned')
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
         review_readiness = 'pending',
         review_readiness_reasons = '[]'::jsonb,
         review_ready_at = NULL,
         review_ready_generation_id = NULL,
         enrichment_status = 'pending',
         artifact_sync_status = NULL,
         updated_at = v_now
   WHERE id = p_uploaded_file_id;

  v_provenance_enabled := COALESCE(NULLIF(p_metadata->>'provenance_enabled', '')::boolean, false);

  IF v_provenance_enabled AND v_has_extraction_runs THEN
    v_run_type := COALESCE(NULLIF(p_metadata->>'run_type', ''), 'initial_extraction');
    IF v_run_type NOT IN ('initial_extraction', 're_extraction', 'admin_replay') THEN
      v_run_type := 'initial_extraction';
    END IF;

    INSERT INTO public.extraction_runs (
      org_id, uploaded_file_id, generation_id, run_type, contract_version, status
    )
    VALUES (
      p_org_id,
      p_uploaded_file_id,
      v_new_generation_id,
      v_run_type,
      COALESCE(NULLIF(p_metadata->>'contract_version', ''), NULLIF(p_contract_version, ''), 'unversioned'),
      'running'
    )
    RETURNING id INTO v_extraction_run_id;
  END IF;

  RETURN jsonb_build_object(
    'generation_id', v_new_generation_id,
    'job_id', v_job_id,
    'extraction_run_id', v_extraction_run_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_lease_extraction_generation(
  UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_lease_extraction_generation(
  UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB
) TO service_role;

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
  v_active_generation_id UUID;
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
  IF NULLIF(trim(COALESCE(p_job_type, '')), '') IS NULL THEN
    RAISE EXCEPTION 'job_type is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_stage, '')), '') IS NULL THEN
    RAISE EXCEPTION 'stage is required';
  END IF;

  SELECT active_generation_id
    INTO v_active_generation_id
    FROM public.uploaded_files
   WHERE id = p_uploaded_file_id
     AND org_id = p_org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Uploaded file not found for this organization';
  END IF;

  IF v_active_generation_id IS NULL THEN
    RAISE EXCEPTION 'File has no active extraction generation; call start_lease_extraction_generation first';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.pipeline_jobs
   WHERE uploaded_file_id = p_uploaded_file_id
     AND job_type = p_job_type
     AND stage = p_stage
     AND generation_id = v_active_generation_id
     AND status IN ('queued', 'running')
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'created', false,
      'existing_job_id', v_existing.id,
      'generation_id', v_active_generation_id
    );
  END IF;

  v_idempotency_key := format(
    'lease-extraction:%s:%s:%s:%s',
    p_uploaded_file_id,
    v_active_generation_id,
    p_stage,
    COALESCE(NULLIF(p_contract_version, ''), 'unversioned')
  );

  BEGIN
    INSERT INTO public.pipeline_jobs (
      org_id, uploaded_file_id, job_type, stage, status,
      generation_id, idempotency_key, max_attempts, input, metadata
    )
    VALUES (
      p_org_id, p_uploaded_file_id, p_job_type, p_stage, 'queued',
      v_active_generation_id, v_idempotency_key, COALESCE(p_max_attempts, 3),
      COALESCE(p_input, '{}'::jsonb), COALESCE(p_metadata, '{}'::jsonb)
    )
    RETURNING id INTO v_job_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT *
      INTO v_existing
      FROM public.pipeline_jobs
     WHERE uploaded_file_id = p_uploaded_file_id
       AND job_type = p_job_type
       AND stage = p_stage
       AND generation_id = v_active_generation_id
       AND status IN ('queued', 'running')
     LIMIT 1;

    RETURN jsonb_build_object(
      'created', false,
      'existing_job_id', v_existing.id,
      'generation_id', v_active_generation_id
    );
  END;

  RETURN jsonb_build_object(
    'created', true,
    'job_id', v_job_id,
    'generation_id', v_active_generation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_pipeline_job(
  UUID, UUID, TEXT, TEXT, TEXT, INT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_pipeline_job(
  UUID, UUID, TEXT, TEXT, TEXT, INT, JSONB, JSONB
) TO service_role;