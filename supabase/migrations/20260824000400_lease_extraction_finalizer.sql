-- P0.5: extraction finalizer, DB-enforced as the sole writer of
-- review_readiness='ready'. Part of the Lease Review pipeline-honesty plan
-- (C:\Users\tejas\.claude\plans\think-as-senior-enterprise-elegant-harbor.md).
--
-- Why a trigger, not just "only call this RPC by convention": the service
-- role bypasses RLS, so nothing stops a future edge function from directly
-- UPDATE-ing uploaded_files.review_readiness to 'ready' unless the database
-- itself rejects any path other than this one function. The trigger below
-- checks a transaction-local setting that only finalize_lease_extraction_for_review
-- sets, immediately before the one UPDATE that's allowed to flip the value.

CREATE OR REPLACE FUNCTION public.enforce_review_readiness_ready_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.review_readiness = 'ready'
     AND OLD.review_readiness IS DISTINCT FROM 'ready'
     AND current_setting('app.allow_review_readiness_ready', true) IS DISTINCT FROM 'true'
  THEN
    RAISE EXCEPTION 'review_readiness=ready may only be set by finalize_lease_extraction_for_review';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_review_readiness_ready ON public.uploaded_files;
CREATE TRIGGER trg_enforce_review_readiness_ready
  BEFORE UPDATE ON public.uploaded_files
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_review_readiness_ready_guard();

-- --- finalize_lease_extraction_for_review -----------------------------------
-- Tenant- and generation-scoped. p_lease_id is optional: at the point this
-- normally runs (right after normalize/enrich conclude), no lease row may
-- exist yet -- lease creation happens later, during human review/approval
-- (P0.6). When a lease id IS supplied (e.g. a later re-finalization call
-- after re-extracting an already-linked lease), it is verified against the
-- deterministic leases.source_file_id authority before pipeline_jobs.lease_id
-- is backfilled -- extraction_data.extraction_debug.source_file_id (JSONB)
-- is never used as the relational authority.
CREATE OR REPLACE FUNCTION public.finalize_lease_extraction_for_review(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_generation_id UUID DEFAULT NULL,
  p_lease_id UUID DEFAULT NULL,
  p_actor_user_id UUID DEFAULT NULL,
  p_actor_email TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_file public.uploaded_files%ROWTYPE;
  v_generation_id UUID;
  v_readiness JSONB;
  v_lease public.leases%ROWTYPE;
  v_coverage JSONB;
  v_extraction_run_status TEXT;
BEGIN
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
       AND org_id = p_org_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Uploaded file not found for this organization';
    END IF;

    v_generation_id := COALESCE(p_generation_id, v_file.active_generation_id);

    -- Re-derive eligibility server-side via the one shared readiness
    -- authority -- never trust a caller-supplied "it's ready" claim.
    v_readiness := public.evaluate_lease_extraction_readiness(p_org_id, p_uploaded_file_id, v_generation_id);

    IF (v_readiness->>'ready')::boolean IS NOT TRUE THEN
      -- Not ready yet is a normal, expected outcome -- not an exception.
      -- Only clear stale 'ready' provenance if a newer generation already
      -- superseded a previously-ready one; otherwise persist the current
      -- assessment so consumers (pipeline-status, the frontend) see it.
      UPDATE public.uploaded_files
         SET review_readiness = v_readiness->>'readiness',
             review_readiness_reasons = COALESCE(v_readiness->'blocking_reasons', '[]'::jsonb),
             review_ready_at = CASE WHEN review_ready_generation_id IS DISTINCT FROM v_generation_id THEN NULL ELSE review_ready_at END,
             review_ready_generation_id = CASE WHEN review_ready_generation_id IS DISTINCT FROM v_generation_id THEN NULL ELSE review_ready_generation_id END,
             updated_at = v_now
       WHERE id = p_uploaded_file_id;

      RETURN jsonb_build_object(
        'success', true,
        'ready', false,
        'readiness', v_readiness->>'readiness',
        'blocking_reasons', v_readiness->'blocking_reasons',
        'active_generation_id', v_generation_id
      );
    END IF;

    -- Ready. Resolve the lease/source link if a lease id was supplied.
    IF p_lease_id IS NOT NULL THEN
      SELECT *
        INTO v_lease
        FROM public.leases
       WHERE id = p_lease_id
         AND org_id = p_org_id
         AND source_file_id = p_uploaded_file_id
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Lease % does not belong to this organization/source file', p_lease_id;
      END IF;

      UPDATE public.pipeline_jobs
         SET lease_id = p_lease_id,
             updated_at = v_now
       WHERE uploaded_file_id = p_uploaded_file_id
         AND generation_id = v_generation_id
         AND lease_id IS NULL;
    END IF;

    -- Coverage detail: distinguishes a legitimate zero-result from a stage
    -- that never ran (plan P0.4/P0.5) -- expense-rule count read from the
    -- already-persisted workflow_output, not recomputed here.
    v_coverage := jsonb_build_object(
      'expense_rule_generation', jsonb_build_object(
        'status', 'completed',
        'rules_generated', jsonb_array_length(
          COALESCE(v_file.ui_review_payload->'records'->0->'workflow_output'->'expense_rules', '[]'::jsonb)
        )
      )
    );

    -- P1.6: complete this generation's extraction_runs row (P1's provenance
    -- ledger, if it was enabled for this generation) in the same
    -- transaction that establishes review_readiness='ready' -- the same
    -- authority that decides readiness also decides run completion, no
    -- separate/distributed completion logic in the worker. Uses
    -- v_generation_id (already correctly derived above, not a raw
    -- p_generation_id parameter) since that's the same generation identity
    -- every other decision in this function already relies on.
    SELECT status INTO v_extraction_run_status
      FROM public.extraction_runs
     WHERE org_id = p_org_id AND generation_id = v_generation_id;
    -- NULL here means provenance was OFF for this generation -- nothing to
    -- check, nothing to complete, proceed as before P1 existed.

    IF v_extraction_run_status = 'running' THEN
      UPDATE public.extraction_runs
         SET status = 'completed', completed_at = v_now, updated_at = v_now
       WHERE org_id = p_org_id AND generation_id = v_generation_id AND status = 'running';
      v_extraction_run_status := 'completed';
    END IF;

    IF v_extraction_run_status IS NOT NULL AND v_extraction_run_status <> 'completed' THEN
      -- Provenance was enabled for this generation but its run is 'failed'
      -- or 'superseded', not 'running'/'completed' -- readiness must not
      -- become 'ready' on top of a run that isn't (or can no longer be)
      -- successful. Re-finalizing an already-'completed' run (idempotent
      -- recall) is NOT a mismatch and falls through normally below.
      RETURN jsonb_build_object(
        'success', false,
        'error_code', 'EXTRACTION_RUN_FINALIZATION_MISMATCH',
        'extraction_run_status', v_extraction_run_status
      );
    END IF;

    -- Idempotent: calling this twice on an already-ready generation is a
    -- no-op re-assertion, not a duplicate side effect -- no audit table is
    -- written here (unlike the approval finalizer, P0.6), so there is
    -- nothing to duplicate beyond the UPDATE itself, which is naturally
    -- idempotent.
    PERFORM set_config('app.allow_review_readiness_ready', 'true', true);

    UPDATE public.uploaded_files
       SET review_readiness = 'ready',
           review_readiness_reasons = '[]'::jsonb,
           review_ready_at = v_now,
           review_ready_generation_id = v_generation_id,
           extraction_finalization_version = 'lease-review-evidence-v3',
           updated_at = v_now
     WHERE id = p_uploaded_file_id;

    RETURN jsonb_build_object(
      'success', true,
      'ready', true,
      'readiness', 'ready',
      'blocking_reasons', '[]'::jsonb,
      'active_generation_id', v_generation_id,
      'coverage', v_coverage
    );
  EXCEPTION WHEN OTHERS THEN
    -- Structured failure result, not a re-raised exception: re-raising would
    -- roll back this transaction, which would also undo any "mark this
    -- durably failed" write attempted in the same transaction (Postgres
    -- rolls back the entire transaction on an unhandled exception). The
    -- caller (the Edge Function) converts this into an HTTP error response.
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'FINALIZATION_FAILED',
      'error_message', SQLERRM
    );
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT) TO service_role;
