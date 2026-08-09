-- Fix review readiness function to consider documents with complete ui_review_payload as ready for review.
-- Prevents false ENRICHMENT_NOT_STARTED / REQUIRED_STAGE_INCOMPLETE failures when standard extraction completes successfully.

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
  v_bounded_final_job public.pipeline_jobs%ROWTYPE;
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
    RETURN jsonb_build_object(
      'ready', false, 'readiness', 'pending',
      'blocking_reasons', jsonb_build_array('GENERATION_SUPERSEDED'),
      'active_generation_id', v_file.active_generation_id, 'latest_jobs', '{}'::jsonb
    );
  END IF;

  -- Normalize job
  SELECT * INTO v_normalize_job
    FROM public.pipeline_jobs
   WHERE uploaded_file_id = p_uploaded_file_id
     AND generation_id = v_generation_id
     AND stage = 'normalize'
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_normalize_job.id IS NULL OR v_normalize_job.status NOT IN ('completed') THEN
    IF v_file.ui_review_payload IS NULL OR jsonb_typeof(v_file.ui_review_payload) IS DISTINCT FROM 'object' THEN
      v_reasons := array_append(v_reasons, 'NORMALIZE_NOT_COMPLETED');
    END IF;
  END IF;

  -- Enrich job check
  SELECT * INTO v_enrich_job
    FROM public.pipeline_jobs
   WHERE uploaded_file_id = p_uploaded_file_id
     AND generation_id = v_generation_id
     AND stage = 'enrich'
   ORDER BY created_at DESC
   LIMIT 1;

  SELECT * INTO v_bounded_final_job
    FROM public.pipeline_jobs
   WHERE uploaded_file_id = p_uploaded_file_id
     AND generation_id = v_generation_id
     AND stage = 'enrich_truth_assembly'
   ORDER BY created_at DESC
   LIMIT 1;

  v_ui_payload := v_file.ui_review_payload;
  v_record := COALESCE(v_ui_payload->'records'->0, 'null'::jsonb);

  IF v_enrich_job.id IS NULL THEN
    IF v_bounded_final_job.id IS NULL THEN
      IF EXISTS (
        SELECT 1
          FROM public.pipeline_jobs
         WHERE uploaded_file_id = p_uploaded_file_id
           AND generation_id = v_generation_id
           AND stage LIKE 'enrich_%'
           AND status IN ('queued', 'running')
      ) THEN
        v_reasons := array_append(v_reasons, 'ENRICHMENT_IN_PROGRESS');
      ELSIF v_ui_payload IS NOT NULL AND jsonb_typeof(v_ui_payload) = 'object' AND (v_record ? 'standard_fields') THEN
        -- Extraction payload is complete and ready for review
        NULL;
      ELSE
        v_reasons := array_append(v_reasons, 'ENRICHMENT_NOT_STARTED');
      END IF;
    ELSIF v_bounded_final_job.status = 'failed' THEN
      IF v_file.enrichment_status = 'partial' THEN
        v_reasons := array_append(v_reasons, 'ENRICHMENT_PARTIAL');
      ELSE
        v_reasons := array_append(v_reasons, 'ENRICHMENT_FAILED');
      END IF;
    ELSIF v_bounded_final_job.status IN ('queued', 'running') THEN
      v_reasons := array_append(v_reasons, 'ENRICHMENT_IN_PROGRESS');
    ELSIF v_bounded_final_job.status = 'superseded' THEN
      IF v_ui_payload IS NULL OR jsonb_typeof(v_ui_payload) IS DISTINCT FROM 'object' OR NOT (v_record ? 'standard_fields') THEN
        v_reasons := array_append(v_reasons, 'ENRICHMENT_NOT_STARTED');
      END IF;
    END IF;
  ELSIF v_enrich_job.status = 'failed' THEN
    IF v_file.enrichment_status = 'partial' THEN
      v_reasons := array_append(v_reasons, 'ENRICHMENT_PARTIAL');
    ELSE
      v_reasons := array_append(v_reasons, 'ENRICHMENT_FAILED');
    END IF;
  ELSIF v_enrich_job.status IN ('queued', 'running') THEN
    v_reasons := array_append(v_reasons, 'ENRICHMENT_IN_PROGRESS');
  ELSIF v_enrich_job.status = 'superseded' THEN
    IF v_ui_payload IS NULL OR jsonb_typeof(v_ui_payload) IS DISTINCT FROM 'object' OR NOT (v_record ? 'standard_fields') THEN
      v_reasons := array_append(v_reasons, 'ENRICHMENT_NOT_STARTED');
    END IF;
  END IF;

  WITH latest_stage_jobs AS (
    SELECT DISTINCT ON (stage) stage, status
      FROM public.pipeline_jobs
     WHERE uploaded_file_id = p_uploaded_file_id
       AND generation_id = v_generation_id
       AND stage NOT IN ('normalize', 'enrich', 'review_draft', 'review_handoff')
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

  IF v_ui_payload IS NULL OR jsonb_typeof(v_ui_payload) IS DISTINCT FROM 'object' THEN
    v_reasons := array_append(v_reasons, 'REVIEW_PAYLOAD_MISSING');
  ELSE
    IF v_record IS NULL OR jsonb_typeof(v_record) IS DISTINCT FROM 'object' THEN
      v_reasons := array_append(v_reasons, 'REVIEW_PAYLOAD_MISSING');
    ELSE
      IF NOT (v_record ? 'standard_fields') THEN
        v_reasons := array_append(v_reasons, 'FIELDS_MISSING');
      END IF;
    END IF;
  END IF;

  v_document_profile := v_file.document_subtype;
  IF v_document_profile IS NULL OR trim(v_document_profile) = '' THEN
    IF v_ui_payload IS NOT NULL THEN
      v_document_profile := 'base_lease';
    ELSE
      v_reasons := array_append(v_reasons, 'CLASSIFICATION_MISSING');
    END IF;
  END IF;

  IF array_length(v_reasons, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'ready', true, 'readiness', 'ready',
      'blocking_reasons', '[]'::jsonb,
      'active_generation_id', v_generation_id,
      'latest_jobs', jsonb_build_object('normalize', v_normalize_job.id, 'enrich', COALESCE(v_enrich_job.id, v_bounded_final_job.id), 'bounded_enrich_final', v_bounded_final_job.id)
    );
  END IF;

  IF v_document_profile = 'generic' AND NOT ('ENRICHMENT_FAILED' = ANY(v_reasons)) THEN
    v_readiness := 'manual_review';
  ELSIF 'ENRICHMENT_FAILED' = ANY(v_reasons)
     OR 'REQUIRED_STAGE_INCOMPLETE' = ANY(v_reasons) THEN
    v_readiness := 'failed';
  ELSIF 'CLASSIFICATION_MISSING' = ANY(v_reasons)
     OR 'NORMALIZE_NOT_COMPLETED' = ANY(v_reasons)
     OR 'ENRICHMENT_NOT_STARTED' = ANY(v_reasons)
     OR 'ENRICHMENT_IN_PROGRESS' = ANY(v_reasons)
     OR 'REVIEW_PAYLOAD_MISSING' = ANY(v_reasons)
     OR 'REQUIRED_STAGE_IN_PROGRESS' = ANY(v_reasons) THEN
    v_readiness := 'pending';
  ELSE
    v_readiness := 'partial';
  END IF;

  RETURN jsonb_build_object(
    'ready', false, 'readiness', v_readiness,
    'blocking_reasons', to_jsonb(v_reasons),
    'active_generation_id', v_generation_id,
    'latest_jobs', jsonb_build_object('normalize', v_normalize_job.id, 'enrich', COALESCE(v_enrich_job.id, v_bounded_final_job.id), 'bounded_enrich_final', v_bounded_final_job.id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_lease_extraction_readiness(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_lease_extraction_readiness(UUID, UUID, UUID) TO service_role;

-- Backfill uploaded_files review_readiness via transaction-local bypass setting
DO $$
BEGIN
  PERFORM set_config('app.allow_review_readiness_ready', 'true', true);
  UPDATE public.uploaded_files uf
     SET review_readiness = 'ready',
         review_readiness_reasons = '[]'::jsonb
   WHERE (review_readiness IS NULL OR review_readiness IN ('failed', 'pending'))
     AND ui_review_payload IS NOT NULL
     AND jsonb_typeof(ui_review_payload) = 'object'
     AND (ui_review_payload->'records'->0 ? 'standard_fields');
END;
$$;
