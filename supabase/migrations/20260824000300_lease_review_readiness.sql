-- P0.4: readiness columns, provenance, and one SQL readiness authority.
-- Part of the Lease Review pipeline-honesty plan
-- (C:\Users\tejas\.claude\plans\think-as-senior-enterprise-elegant-harbor.md).
--
-- Why enrichment_status/review_readiness need to be real columns, not just
-- JSONB: deriveDisplayState (pipeline-status/status-utils.ts) and any SQL
-- authority need to read them without digging into ui_review_payload, and a
-- CHECK constraint needs a real column to constrain. ui_review_payload's
-- own enrichment_status key is left untouched for back-compat — every
-- existing writer adds the new column to the same .update() call.
--
-- Why review_readiness is a separate, more authoritative concept than
-- enrichment_status: enrichment_status describes one stage's outcome.
-- review_readiness describes whether the file as a whole is safe to call
-- "ready for review" -- computed once by evaluate_lease_extraction_readiness
-- below, not re-derived ad hoc by every consumer.

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS enrichment_status TEXT NULL,
  ADD COLUMN IF NOT EXISTS review_readiness TEXT NULL,
  ADD COLUMN IF NOT EXISTS review_readiness_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS review_ready_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS review_ready_generation_id UUID NULL,
  ADD COLUMN IF NOT EXISTS extraction_finalization_version TEXT NULL,
  ADD COLUMN IF NOT EXISTS artifact_sync_status TEXT NULL;

-- Backfill enrichment_status from the existing JSONB location, permissively
-- -- anything not matching the expected vocabulary is left NULL rather than
-- failing the migration (mirrors this repo's established backfill pattern).
UPDATE public.uploaded_files
SET enrichment_status = ui_review_payload->>'enrichment_status'
WHERE enrichment_status IS NULL
  AND ui_review_payload->>'enrichment_status' IN ('pending', 'running', 'completed', 'failed');

ALTER TABLE public.uploaded_files
  DROP CONSTRAINT IF EXISTS uploaded_files_enrichment_status_check;
ALTER TABLE public.uploaded_files
  ADD CONSTRAINT uploaded_files_enrichment_status_check
    CHECK (enrichment_status IS NULL OR enrichment_status IN ('pending', 'running', 'completed', 'failed'));

ALTER TABLE public.uploaded_files
  DROP CONSTRAINT IF EXISTS uploaded_files_review_readiness_check;
ALTER TABLE public.uploaded_files
  ADD CONSTRAINT uploaded_files_review_readiness_check
    CHECK (review_readiness IS NULL OR review_readiness IN ('pending', 'partial', 'ready', 'failed', 'manual_review'));

ALTER TABLE public.uploaded_files
  DROP CONSTRAINT IF EXISTS uploaded_files_artifact_sync_status_check;
ALTER TABLE public.uploaded_files
  ADD CONSTRAINT uploaded_files_artifact_sync_status_check
    CHECK (artifact_sync_status IS NULL OR artifact_sync_status IN ('pending', 'running', 'completed', 'failed'));

COMMENT ON COLUMN public.uploaded_files.review_readiness IS
  'pending: required work remains. partial: some review data exists but required work is incomplete -- reviewer may inspect for troubleshooting, but this state must never be labeled "Ready for Review" (review_accessible is a separate concept from review_readiness). ready: the active generation''s required pipeline work completed and was finalized by finalize_lease_extraction_for_review -- see the trigger below, only that function may set this value. failed: a required stage failed. manual_review: automated processing cannot complete (e.g. document_subtype classified only as the generic catch-all, not a specific supported profile); requires an explicit human workflow, distinct from failed.';
COMMENT ON COLUMN public.uploaded_files.review_readiness_reasons IS
  'Array of blocking_reasons strings from the last evaluate_lease_extraction_readiness call, e.g. ["ENRICHMENT_FAILED","WORKFLOW_OUTPUT_MISSING"].';

-- --- Legacy backfill for review_readiness -----------------------------------
-- Existing rows must not be promoted to 'ready' merely because
-- status='review_required' -- that would fabricate finalization evidence
-- that never happened. Backfill conservatively to 'partial'/'failed' only;
-- only a future real call to finalize_lease_extraction_for_review may ever
-- write 'ready'.
UPDATE public.uploaded_files
SET review_readiness = 'failed',
    review_readiness_reasons = '["ENRICHMENT_FAILED"]'::jsonb
WHERE review_readiness IS NULL
  AND status = 'review_required'
  AND enrichment_status = 'failed';

UPDATE public.uploaded_files
SET review_readiness = 'partial',
    review_readiness_reasons = '["LEGACY_ROW_NOT_FINALIZED"]'::jsonb
WHERE review_readiness IS NULL
  AND status = 'review_required';

-- --- One SQL readiness authority --------------------------------------------
-- Tenant-scoped (org_id verified internally, not a bare file-id lookup).
-- Called from pipeline-status, the extraction finalizer (P0.5), and the
-- approval finalizer (P0.6) -- one implementation, three callers, so
-- TypeScript and SQL can never independently drift on what "ready" means.
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
  ELSIF 'ENRICHMENT_FAILED' = ANY(v_reasons) OR 'REQUIRED_STAGE_INCOMPLETE' = ANY(v_reasons) THEN
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
