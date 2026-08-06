-- Reliability Phase R2: evaluate only the latest job row per extraction stage.
--
-- The lease extraction timeline can include early failed handoff/stage rows that
-- are later superseded by successful retry rows in the same generation. The
-- prior readiness function counted any queued/running/failed non-normalize and
-- non-enrich job ever written for the generation, so a stale failed row kept
-- review_readiness = 'failed' even after review_gate/evidence backfill and
-- enrichment completed. That is the failure shown by review_failed + later
-- completed enrichment events in the Lease Review timeline.
--
-- This keeps the same architecture and reason vocabulary, but considers only
-- the latest row for each stage. Latest queued/running stages are pending;
-- latest failed stages remain failed. Stale failed rows no longer poison the
-- current generation forever.
CREATE OR REPLACE FUNCTION public.evaluate_lease_extraction_readiness(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_generation_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_file public.uploaded_files%ROWTYPE;
  v_generation_id UUID;
  v_reasons TEXT[] := ARRAY[]::text[];
  v_readiness TEXT;
  v_normalize_job public.pipeline_jobs%ROWTYPE;
  v_enrich_job public.pipeline_jobs%ROWTYPE;
  v_in_progress_job_count INT;
  v_failed_job_count INT;
  v_ui_payload JSONB;
  v_record JSONB;
  v_document_profile TEXT;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_uploaded_file_id IS NULL THEN
    RAISE EXCEPTION 'uploaded_file_id is required';
  END IF;

  SELECT *
    INTO v_file
    FROM public.uploaded_files
   WHERE id = p_uploaded_file_id
     AND org_id = p_org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Uploaded file not found for this organization';
  END IF;

  v_generation_id := COALESCE(p_generation_id, v_file.active_generation_id);

  IF v_generation_id IS NULL THEN
    RETURN jsonb_build_object(
      'ready', false, 'readiness', 'pending',
      'blocking_reasons', jsonb_build_array('NO_ACTIVE_GENERATION'),
      'active_generation_id', NULL, 'latest_jobs', '{}'::jsonb
    );
  END IF;

  IF v_file.active_generation_id IS DISTINCT FROM v_generation_id THEN
    -- The generation being evaluated has already been superseded by a newer
    -- one -- its readiness is moot; report that explicitly rather than
    -- evaluating stale job state.
    RETURN jsonb_build_object(
      'ready', false, 'readiness', 'pending',
      'blocking_reasons', jsonb_build_array('GENERATION_SUPERSEDED'),
      'active_generation_id', v_file.active_generation_id, 'latest_jobs', '{}'::jsonb
    );
  END IF;

  -- Latest normalize job for this generation.
  SELECT * INTO v_normalize_job
    FROM public.pipeline_jobs
   WHERE uploaded_file_id = p_uploaded_file_id
     AND generation_id = v_generation_id
     AND stage = 'normalize'
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_normalize_job.id IS NULL OR v_normalize_job.status NOT IN ('completed') THEN
    v_reasons := array_append(v_reasons, 'NORMALIZE_NOT_COMPLETED');
  END IF;

  -- Enrichment required by default for every lease document (P0 has no
  -- reliable profile-based stage-requiredness policy yet -- see plan P0.4).
  -- Only a narrow, explicit, server-owned policy entry may mark it
  -- not-required; no such policy exists yet, so it is always required here.
  SELECT * INTO v_enrich_job
    FROM public.pipeline_jobs
   WHERE uploaded_file_id = p_uploaded_file_id
     AND generation_id = v_generation_id
     AND stage = 'enrich'
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_enrich_job.id IS NULL THEN
    v_reasons := array_append(v_reasons, 'ENRICHMENT_NOT_STARTED');
  ELSIF v_enrich_job.status = 'failed' THEN
    -- Reliability Phase R1: a resource-exhaustion (or similar) crash that
    -- happened after normalize already wrote the core fields is recorded
    -- by the worker as uploaded_files.enrichment_status = 'partial', not
    -- 'failed'. Only escalate to the hard-blocking ENRICHMENT_FAILED
    -- reason when the file-level state agrees this was a genuine loss.
    IF v_file.enrichment_status = 'partial' THEN
      v_reasons := array_append(v_reasons, 'ENRICHMENT_PARTIAL');
    ELSE
      v_reasons := array_append(v_reasons, 'ENRICHMENT_FAILED');
    END IF;
  ELSIF v_enrich_job.status IN ('queued', 'running') THEN
    v_reasons := array_append(v_reasons, 'ENRICHMENT_IN_PROGRESS');
  ELSIF v_enrich_job.status = 'superseded' THEN
    v_reasons := array_append(v_reasons, 'ENRICHMENT_NOT_STARTED');
  END IF;

  -- No other required stage for this generation may have a latest job row that
  -- is still running or genuinely failed. Older failed retry attempts are
  -- ignored once a newer row exists for the same stage.
  WITH latest_stage_jobs AS (
    SELECT DISTINCT ON (stage) stage, status
      FROM public.pipeline_jobs
     WHERE uploaded_file_id = p_uploaded_file_id
       AND generation_id = v_generation_id
       AND stage NOT IN ('normalize', 'enrich')
     ORDER BY stage, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
  )
  SELECT
    count(*) FILTER (WHERE status IN ('queued', 'running')),
    count(*) FILTER (WHERE status = 'failed')
    INTO v_in_progress_job_count, v_failed_job_count
    FROM latest_stage_jobs;

  IF COALESCE(v_failed_job_count, 0) > 0 THEN
    v_reasons := array_append(v_reasons, 'REQUIRED_STAGE_INCOMPLETE');
  ELSIF COALESCE(v_in_progress_job_count, 0) > 0 THEN
    v_reasons := array_append(v_reasons, 'REQUIRED_STAGE_IN_PROGRESS');
  END IF;
  v_ui_payload := v_file.ui_review_payload;
  v_record := COALESCE(v_ui_payload->'records'->0, 'null'::jsonb);

  IF v_ui_payload IS NULL OR jsonb_typeof(v_ui_payload) IS DISTINCT FROM 'object' THEN
    v_reasons := array_append(v_reasons, 'REVIEW_PAYLOAD_MISSING');
  ELSE
    IF v_record IS NULL OR jsonb_typeof(v_record) IS DISTINCT FROM 'object' THEN
      v_reasons := array_append(v_reasons, 'REVIEW_PAYLOAD_MISSING');
    ELSE
      IF NOT (v_record ? 'standard_fields') THEN
        v_reasons := array_append(v_reasons, 'FIELDS_MISSING');
      END IF;
      -- workflow_output presence, not truthiness -- an empty
      -- {"expense_rules": []} is a legitimate zero-result; the KEY being
      -- entirely absent means the stage never established a result at all.
      -- These are deliberately distinguished (plan P0.4).
      IF NOT (v_record ? 'workflow_output') THEN
        v_reasons := array_append(v_reasons, 'WORKFLOW_OUTPUT_MISSING');
      END IF;
    END IF;
  END IF;

  -- Document classification tri-state (plan P0.4): absent/null blocks;
  -- 'generic' (the existing uploaded_files_document_subtype_check enum's
  -- catch-all value -- there is no separate 'unknown_supported_document'
  -- string in that pre-existing, fixed vocabulary) does not block on
  -- profile-quality grounds (that's P1+ scope) but routes toward
  -- manual_review instead of a false 'failed'; a specific profile
  -- (base_lease/amendment/assignment/etc.) is the normal path.
  v_document_profile := v_file.document_subtype;
  IF v_document_profile IS NULL OR trim(v_document_profile) = '' THEN
    v_reasons := array_append(v_reasons, 'CLASSIFICATION_MISSING');
  END IF;

  -- No document may be considered ready when normalize completed but
  -- OpenAI was never actually invoked (see column comment,
  -- 20260865000000_openai_extraction_attempted_gate.sql). This is a
  -- pipeline-honesty defect, not a transient/in-progress state, so it
  -- routes to 'failed' below alongside ENRICHMENT_FAILED/
  -- REQUIRED_STAGE_INCOMPLETE rather than 'pending'.
  IF NOT v_file.openai_extraction_attempted THEN
    v_reasons := array_append(v_reasons, 'OPENAI_EXTRACTION_NOT_ATTEMPTED');
  END IF;

  IF array_length(v_reasons, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'ready', true, 'readiness', 'ready',
      'blocking_reasons', '[]'::jsonb,
      'active_generation_id', v_generation_id,
      'latest_jobs', jsonb_build_object('normalize', v_normalize_job.id, 'enrich', v_enrich_job.id)
    );
  END IF;

  -- manual_review vs. failed vs. partial: an explicitly-classified-but-
  -- unresolvable document profile is not a processing failure.
  IF v_document_profile = 'generic' AND NOT ('ENRICHMENT_FAILED' = ANY(v_reasons)) THEN
    v_readiness := 'manual_review';
  ELSIF 'ENRICHMENT_FAILED' = ANY(v_reasons)
     OR 'REQUIRED_STAGE_INCOMPLETE' = ANY(v_reasons)
     OR 'OPENAI_EXTRACTION_NOT_ATTEMPTED' = ANY(v_reasons) THEN
    v_readiness := 'failed';
  ELSIF 'CLASSIFICATION_MISSING' = ANY(v_reasons)
     OR 'NORMALIZE_NOT_COMPLETED' = ANY(v_reasons)
     OR 'ENRICHMENT_NOT_STARTED' = ANY(v_reasons)
     OR 'ENRICHMENT_IN_PROGRESS' = ANY(v_reasons)
     OR 'REVIEW_PAYLOAD_MISSING' = ANY(v_reasons)
     OR 'REQUIRED_STAGE_IN_PROGRESS' = ANY(v_reasons) THEN
    v_readiness := 'pending';
  ELSE
    -- Reliability Phase R1: ENRICHMENT_PARTIAL (and WORKFLOW_OUTPUT_MISSING,
    -- which is expected alongside it since workflow_output is itself an
    -- enrich-stage artifact) fall through to here -- review_readiness =
    -- 'partial', not 'failed'.
    v_readiness := 'partial';
  END IF;

  RETURN jsonb_build_object(
    'ready', false, 'readiness', v_readiness,
    'blocking_reasons', to_jsonb(v_reasons),
    'active_generation_id', v_generation_id,
    'latest_jobs', jsonb_build_object('normalize', v_normalize_job.id, 'enrich', v_enrich_job.id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_lease_extraction_readiness(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_lease_extraction_readiness(UUID, UUID, UUID) TO service_role;
