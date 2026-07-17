-- P0.6: approval finalizer + separate artifact-sync truth. Part of the
-- Lease Review pipeline-honesty plan
-- (C:\Users\tejas\.claude\plans\think-as-senior-enterprise-elegant-harbor.md).
--
-- This is the SECOND gate, correctly scoped as later than the extraction
-- finalizer (P0.5): it owns "review completed -> approved", gated on
-- review_readiness already being 'ready'. It does not claim the file is
-- fully 'stored' until artifact fan-out (CAM/clause sync, still a
-- best-effort ~2000-line JS step -- porting it to SQL is explicitly P1+
-- scope) also completes -- the UI must never see "stored" while that is
-- still pending/running/failed.
--
-- Follows the server-owned-workflow-pattern already established in this
-- repo (docs/server-owned-workflow-pattern.md): idempotency-run table with
-- UNIQUE(org_id, idempotency_key), lock it, re-derive eligibility from
-- locked state, one transaction, structured failure result (not a re-raised
-- exception -- same reasoning as P0.5's finalizer).

CREATE TABLE IF NOT EXISTS public.lease_review_finalization_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'failed')),
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT NULL,
  actor_user_id UUID NULL,
  actor_email TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key)
);

ALTER TABLE public.lease_review_finalization_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lease_review_finalization_runs_select" ON public.lease_review_finalization_runs
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.org_id = lease_review_finalization_runs.org_id)
  );
-- No INSERT/UPDATE/DELETE policy for authenticated/anon -- service-role
-- (SECURITY DEFINER RPC below) is the only writer, matching the pattern's
-- established grant shape.

-- --- finalize_lease_review_approval ----------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_lease_review_approval(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_generation_id UUID DEFAULT NULL,
  p_lease_id UUID DEFAULT NULL,
  p_actor_user_id UUID DEFAULT NULL,
  p_actor_email TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_run public.lease_review_finalization_runs%ROWTYPE;
  v_file public.uploaded_files%ROWTYPE;
  v_generation_id UUID;
  v_readiness JSONB;
  v_key TEXT;
  v_response JSONB;
BEGIN
  BEGIN
    IF p_org_id IS NULL THEN
      RAISE EXCEPTION 'org_id is required';
    END IF;
    IF p_uploaded_file_id IS NULL THEN
      RAISE EXCEPTION 'uploaded_file_id is required';
    END IF;

    v_key := COALESCE(p_idempotency_key, format('lease-review-approval:%s:%s', p_uploaded_file_id, COALESCE(p_generation_id, '00000000-0000-0000-0000-000000000000'::uuid)));

    INSERT INTO public.lease_review_finalization_runs (
      org_id, uploaded_file_id, idempotency_key, status, request_payload, actor_user_id, actor_email
    )
    VALUES (
      p_org_id, p_uploaded_file_id, v_key, 'started',
      jsonb_build_object('generation_id', p_generation_id, 'lease_id', p_lease_id),
      p_actor_user_id, p_actor_email
    )
    ON CONFLICT (org_id, idempotency_key) DO NOTHING;

    SELECT * INTO v_run
      FROM public.lease_review_finalization_runs
     WHERE org_id = p_org_id AND idempotency_key = v_key
     FOR UPDATE;

    IF v_run.status = 'completed' THEN
      -- Idempotent replay: return the prior result, do not re-run side effects.
      RETURN v_run.response_payload;
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

    -- Re-derive eligibility server-side, never trust a caller-supplied
    -- claim -- same shared readiness authority the extraction finalizer
    -- uses (P0.4), so approval and extraction never independently disagree
    -- on what "ready" means.
    v_readiness := public.evaluate_lease_extraction_readiness(p_org_id, p_uploaded_file_id, v_generation_id);

    -- P0 fails closed: only 'ready' may proceed to approval. 'manual_review'
    -- is routed to a separate manual-resolution workflow (not implemented
    -- in this P0 release), not ordinary approval. No waiver bypass exists
    -- in this first P0 release -- its prerequisites (profile policy, role
    -- policy, audit snapshot schema) are P1+ scope.
    IF (v_readiness->>'ready')::boolean IS NOT TRUE THEN
      v_response := jsonb_build_object(
        'success', false,
        'error_code', 'NOT_READY',
        'readiness', v_readiness->>'readiness',
        'blocking_reasons', v_readiness->'blocking_reasons'
      );
      UPDATE public.lease_review_finalization_runs
         SET status = 'failed', response_payload = v_response, error_message = 'review_readiness is not ready', updated_at = v_now
       WHERE id = v_run.id;
      RETURN v_response;
    END IF;

    -- Lease/source-link authority (P0.6, deterministic): leases.source_file_id
    -- -> uploaded_files.id is the only relationship used here.
    -- extraction_data.extraction_debug.source_file_id (JSONB) is never used.
    IF p_lease_id IS NOT NULL THEN
      PERFORM 1 FROM public.leases
       WHERE id = p_lease_id AND org_id = p_org_id AND source_file_id = p_uploaded_file_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Lease % does not belong to this organization/source file', p_lease_id;
      END IF;
    END IF;

    -- Single terminal write for this transaction: 'approved'. 'storing' is
    -- set in the same transaction (existing FSM requires passing through it
    -- before 'stored') to represent "approved, artifact sync about to run" --
    -- but 'stored' itself is NOT set here; it is only set by a later,
    -- separate call once artifact fan-out (CAM/clause sync, still JS-side,
    -- P1+ scope to port) actually completes. artifact_sync_status is the
    -- explicit, separate truth the UI must check before saying "stored".
    UPDATE public.uploaded_files
       SET status = 'storing',
           artifact_sync_status = 'pending',
           updated_at = v_now
     WHERE id = p_uploaded_file_id;

    v_response := jsonb_build_object(
      'success', true,
      'approval_state', 'approved',
      'artifact_sync_status', 'pending',
      'active_generation_id', v_generation_id
    );

    UPDATE public.lease_review_finalization_runs
       SET status = 'completed', response_payload = v_response, updated_at = v_now
     WHERE id = v_run.id;

    RETURN v_response;
  EXCEPTION WHEN OTHERS THEN
    -- Structured failure, not a re-raised exception -- re-raising would
    -- roll back this transaction, undoing the "mark run failed" write too.
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'APPROVAL_FINALIZATION_FAILED',
      'error_message', SQLERRM
    );
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_lease_review_approval(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_lease_review_approval(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT) TO service_role;

-- --- mark_lease_artifact_sync_result ----------------------------------------
-- Small, separate RPC: only this may transition storing -> stored (on
-- success) or record artifact_sync_status='failed' (on failure), keeping
-- the "stored means artifacts synced too" invariant enforced in one place
-- rather than relying on every call site remembering it.
CREATE OR REPLACE FUNCTION public.mark_lease_artifact_sync_result(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_success BOOLEAN,
  p_error_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
BEGIN
  IF p_success THEN
    UPDATE public.uploaded_files
       SET status = 'stored',
           artifact_sync_status = 'completed',
           updated_at = v_now
     WHERE id = p_uploaded_file_id
       AND org_id = p_org_id
       AND status = 'storing';
  ELSE
    UPDATE public.uploaded_files
       SET artifact_sync_status = 'failed',
           updated_at = v_now
     WHERE id = p_uploaded_file_id
       AND org_id = p_org_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'artifact_sync_status', CASE WHEN p_success THEN 'completed' ELSE 'failed' END);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error_code', 'ARTIFACT_SYNC_MARK_FAILED', 'error_message', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_lease_artifact_sync_result(UUID, UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_lease_artifact_sync_result(UUID, UUID, BOOLEAN, TEXT) TO service_role;
