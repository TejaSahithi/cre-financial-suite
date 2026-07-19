-- P2.7 — finalize_lease_extraction_for_review, extended a third time
-- (additive, same function that already owns review_readiness -- P1.6's
-- run-completion check and P2.1 correction #4's EXTRACTION_RUN_FINALIZATION_MISMATCH
-- guard were the first two extensions). No second readiness authority is
-- created; every new check below is one more guard inside the one function
-- that already decides review_readiness.
--
-- New parameter p_ledger_mode defaults to 'off' -- every existing call site
-- that doesn't pass it behaves exactly as before this migration. The new
-- active-mode checks below only run when the caller explicitly passes
-- 'active' (the Edge Function resolves this from LEASE_CLAIMS_LEDGER_MODE,
-- P2.2, before calling -- never inferred inside this function and never
-- read from a browser-supplied value).
-- CREATE OR REPLACE does NOT replace a function whose parameter list
-- arity/type signature differs -- it silently creates a SECOND overload,
-- leaving the old 6-parameter version reachable (and unpatched) by any
-- caller that happens to invoke it with exactly 6 arguments. Drop the old
-- signature explicitly first so there is only ever one
-- finalize_lease_extraction_for_review.
DROP FUNCTION IF EXISTS public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT);

CREATE OR REPLACE FUNCTION public.finalize_lease_extraction_for_review(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_generation_id UUID DEFAULT NULL,
  p_lease_id UUID DEFAULT NULL,
  p_actor_user_id UUID DEFAULT NULL,
  p_actor_email TEXT DEFAULT NULL,
  p_ledger_mode TEXT DEFAULT 'off'
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
  v_claim_count INT;
  v_projection_run public.lease_claim_projection_runs%ROWTYPE;
  v_missing_evidence_concept TEXT;
  v_open_conflict_concept TEXT;
  v_projected_field_count INT;
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

    -- ---------------------------------------------------------------------
    -- P2.7: active-mode claims-ledger readiness guards. Only enforced when
    -- the caller explicitly identifies this generation as running in
    -- 'active' ledger mode -- 'off'/'shadow' (the default) skip this
    -- entire block, so no existing or shadow-mode behavior changes.
    -- ---------------------------------------------------------------------
    IF p_ledger_mode = 'active' THEN
      SELECT count(*) INTO v_claim_count
        FROM public.lease_claims
       WHERE org_id = p_org_id AND generation_id = v_generation_id;

      IF v_claim_count = 0 THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'CLAIM_LEDGER_MISSING');
      END IF;

      -- Required evidence: any value-bearing claim for an evidence-required
      -- concept with no linked evidence blocks readiness.
      SELECT lc.concept_key INTO v_missing_evidence_concept
        FROM public.lease_claims lc
        JOIN public.lease_claim_concepts lcc
          ON lcc.concept_key = lc.concept_key AND lcc.registry_version = lc.claims_registry_version
       WHERE lc.org_id = p_org_id AND lc.generation_id = v_generation_id
         AND lcc.evidence_required = true
         AND lc.assertion_status IN ('asserted', 'derived', 'calculated')
         AND NOT EXISTS (SELECT 1 FROM public.lease_claim_evidence_links l WHERE l.claim_id = lc.id)
       LIMIT 1;

      IF v_missing_evidence_concept IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'REQUIRED_CLAIM_EVIDENCE_MISSING', 'concept_key', v_missing_evidence_concept);
      END IF;

      -- No unresolved critical conflict: any open/reopened conflict group
      -- for this generation blocks readiness until a reviewer resolves it.
      SELECT concept_key INTO v_open_conflict_concept
        FROM public.lease_claim_conflict_groups
       WHERE org_id = p_org_id AND generation_id = v_generation_id AND status IN ('open', 'reopened')
       LIMIT 1;

      IF v_open_conflict_concept IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'REQUIRED_CLAIM_CONFLICT_OPEN', 'concept_key', v_open_conflict_concept);
      END IF;

      -- Projection must exist, be completed, and belong to THIS generation
      -- (not a stale one from a superseded generation).
      SELECT * INTO v_projection_run
        FROM public.lease_claim_projection_runs
       WHERE org_id = p_org_id AND uploaded_file_id = p_uploaded_file_id
       ORDER BY created_at DESC
       LIMIT 1;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'CLAIM_PROJECTION_MISSING');
      END IF;

      IF v_projection_run.generation_id IS DISTINCT FROM v_generation_id THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'CLAIM_PROJECTION_STALE_GENERATION');
      END IF;

      IF v_projection_run.status = 'failed' THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'CLAIM_PROJECTION_FAILED');
      END IF;

      IF v_projection_run.status <> 'completed' THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'CLAIM_PROJECTION_MISSING');
      END IF;

      -- Compatibility output persisted: the projection must have actually
      -- produced at least one field row (an empty projection is not a
      -- valid substitute for the legacy compatibility payload).
      SELECT count(*) INTO v_projected_field_count
        FROM public.lease_field_projections
       WHERE projection_run_id = v_projection_run.id;

      IF v_projected_field_count = 0 THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'COMPATIBILITY_PROJECTION_INVALID');
      END IF;
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

REVOKE ALL ON FUNCTION public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT) TO service_role;
