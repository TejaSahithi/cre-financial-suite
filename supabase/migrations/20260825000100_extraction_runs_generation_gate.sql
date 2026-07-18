-- P1.2: feature-gated extraction_runs creation, wired into the P0
-- start_lease_extraction_generation RPC.
--
-- The flag must actually gate the one write that matters: whether a new
-- generation ever gets an extraction_runs row. The Edge Function (never the
-- browser) resolves ENABLE_EXTRACTION_PROVENANCE via
-- _shared/extraction/provenance/feature-flag.ts and passes the resolved
-- boolean into this RPC's existing p_metadata JSONB parameter -- no new
-- parameter is added, so no DROP FUNCTION/overload risk (the signature is
-- byte-identical to 20260824000200's original).
--
-- p_metadata shape when the caller wants provenance recorded:
--   { "provenance_enabled": true, "run_type": "initial_extraction", "contract_version": "lease-review-evidence-v3" }
-- With provenance_enabled absent or false (the default for any caller that
-- hasn't been updated yet, or with the flag off): no extraction_runs row,
-- no stage runs, no invocations, no artifacts -- zero bytes of new
-- behavior, exactly the P0-established generation/job semantics.

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
  v_provenance_enabled BOOLEAN;
  v_run_type TEXT;
  v_extraction_run_id UUID;
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

  -- A superseded generation's extraction_runs row (if provenance was on for it)
  -- must not sit in 'running' forever: nothing will ever finalize a generation
  -- that was superseded before completion, so mirror the same terminal outcome
  -- pipeline_jobs already records above onto extraction_runs.
  --
  -- 'superseded', not 'failed' (round-3 review correction): a generation
  -- replaced by a newer one before finishing is a normal lifecycle event --
  -- the user/system started a new extraction -- not a processing failure.
  -- error_code/error_message stay NULL (this isn't an error); the reason is
  -- recorded in metadata instead, distinguishing "the pipeline failed" from
  -- "a newer extraction started" for anything reading this data later.
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
         review_readiness = 'pending',
         review_readiness_reasons = '[]'::jsonb,
         review_ready_at = NULL,
         review_ready_generation_id = NULL,
         enrichment_status = 'pending',
         artifact_sync_status = NULL,
         updated_at = v_now
   WHERE id = p_uploaded_file_id;

  -- P1.2: the flag genuinely gates this write. Note the metadata key is
  -- read with COALESCE(...,false) -- absent/null/non-boolean all mean
  -- "disabled", matching the feature-flag module's own default-false
  -- posture; only an explicit `true` boolean turns it on.
  v_provenance_enabled := COALESCE((p_metadata->>'provenance_enabled')::boolean, false);

  IF v_provenance_enabled THEN
    v_run_type := COALESCE(NULLIF(p_metadata->>'run_type', ''), 'initial_extraction');
    IF v_run_type NOT IN ('initial_extraction', 're_extraction', 'admin_replay') THEN
      v_run_type := 'initial_extraction';
    END IF;

    INSERT INTO public.extraction_runs (
      org_id, uploaded_file_id, generation_id, run_type, contract_version, status
    )
    VALUES (
      p_org_id, p_uploaded_file_id, v_new_generation_id, v_run_type,
      COALESCE(NULLIF(p_metadata->>'contract_version', ''), p_contract_version, 'unversioned'),
      'running'
    )
    RETURNING id INTO v_extraction_run_id;
  END IF;

  RETURN jsonb_build_object(
    'generation_id', v_new_generation_id,
    'job_id', v_job_id,
    'extraction_run_id', v_extraction_run_id  -- NULL when provenance is disabled
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_lease_extraction_generation(
  UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_lease_extraction_generation(
  UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB
) TO service_role;
