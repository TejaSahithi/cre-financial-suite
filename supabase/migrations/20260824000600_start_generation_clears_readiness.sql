-- P0.8 gap fix: start_lease_extraction_generation (P0.2) was written before
-- the review_readiness/enrichment_status columns existed (P0.4) and was
-- never revisited to clear them. Without this, a "ready" file that gets
-- explicitly re-extracted keeps stale review_readiness='ready'/
-- review_ready_at/review_ready_generation_id pointing at the now-superseded
-- generation -- exactly the "New generation after readiness" acceptance
-- scenario (plan P0.8) this migration closes. Signature unchanged, so a
-- plain CREATE OR REPLACE is safe (no DROP FUNCTION needed).
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

  -- P0.8 fix: a previously-'ready' generation's readiness provenance must
  -- never survive pointing at a now-superseded generation. Reset to
  -- 'pending' and clear review_ready_at/review_ready_generation_id/
  -- review_readiness_reasons -- the new generation has not been evaluated
  -- yet, so nothing here should still claim 'ready'.
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
