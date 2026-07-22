-- Enforce (at the DB layer, not just in application code) that no document
-- can reach review_readiness='ready' without OpenAI having been attempted
-- at least once. Today `normalizeBusinessExtractionMode()` defaulted an
-- unset BUSINESS_EXTRACTION_PROVIDER to legacy_hybrid, and legacy_hybrid's
-- rule/table extraction can genuinely resolve every missing field without
-- ever entering llm-extractor.ts's OpenAI call -- nothing anywhere detected
-- or blocked that. The diagnostic that WOULD detect it (`llm_call_attempted`,
-- computed in llm-extractor.ts's makeDiag()) already exists but is read by
-- nothing. This migration adds a durable column normalize-pdf-output writes
-- honestly, and one new check inside the existing single readiness
-- authority (evaluate_lease_extraction_readiness, from
-- 20260824000300_lease_review_readiness.sql) so the guarantee holds
-- regardless of which caller reaches finalize_lease_extraction_for_review --
-- that function already requires ready=true from this evaluator before
-- finalizing, so no other caller needs to change.

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS openai_extraction_attempted BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.uploaded_files.openai_extraction_attempted IS
  'Set by normalize-pdf-output from the business-extraction result''s llm_call_attempted diagnostic (or forced true when ALLOW_RULE_ONLY_EXTRACTION is explicitly set -- the documented emergency bypass). Read by evaluate_lease_extraction_readiness to block review_required for any generation where OpenAI was never actually invoked.';

-- Backfill: existing rows predate this column and its extraction runs are
-- long finalized: do not retroactively fail readiness for documents already
-- reviewed/approved under the prior (undetected) behavior. Only NEW
-- generations, evaluated fresh from here on, are held to this gate.
UPDATE public.uploaded_files
SET openai_extraction_attempted = true
WHERE review_readiness IN ('ready', 'partial', 'manual_review');

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
  v_blocking_job_count INT;
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
    v_reasons := array_append(v_reasons, 'ENRICHMENT_FAILED');
  ELSIF v_enrich_job.status IN ('queued', 'running') THEN
    v_reasons := array_append(v_reasons, 'ENRICHMENT_IN_PROGRESS');
  ELSIF v_enrich_job.status = 'superseded' THEN
    v_reasons := array_append(v_reasons, 'ENRICHMENT_NOT_STARTED');
  END IF;

  -- No other required job for this generation may be queued/running/failed.
  SELECT count(*) INTO v_blocking_job_count
    FROM public.pipeline_jobs
   WHERE uploaded_file_id = p_uploaded_file_id
     AND generation_id = v_generation_id
     AND stage NOT IN ('normalize', 'enrich')
     AND status IN ('queued', 'running', 'failed');
  IF v_blocking_job_count > 0 THEN
    v_reasons := array_append(v_reasons, 'REQUIRED_STAGE_INCOMPLETE');
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

  -- New: no document may be considered ready when normalize completed but
  -- OpenAI was never actually invoked (see column comment above). This is a
  -- pipeline-honesty defect, not a transient/in-progress state, so it routes
  -- to 'failed' below alongside ENRICHMENT_FAILED/REQUIRED_STAGE_INCOMPLETE
  -- rather than 'pending'.
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
     OR 'REVIEW_PAYLOAD_MISSING' = ANY(v_reasons) THEN
    v_readiness := 'pending';
  ELSE
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
