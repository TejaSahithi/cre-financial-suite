-- Real gap found consolidating the Hudson & Pine duplicate lease records
-- (property A1, org 7d16919f-6587-4fbc-b21f-e27e15a752ee): there was no
-- controlled way to mark an already-APPROVED lease record as a duplicate
-- superseded by a canonical one. reject_lease_abstract exists, but its own
-- guard explicitly refuses to touch abstract_status='approved' leases (by
-- design -- rejection is for still-in-review documents, not a retraction
-- of an approved lease). Consolidating duplicate extractions of the same
-- physical lease is a different, legitimate action and needs its own
-- controlled RPC -- this is expected to recur (the extraction pipeline has
-- already produced this exact pattern more than once), not a one-off fix.
ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS superseded_by_lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leases_superseded_by ON public.leases(superseded_by_lease_id) WHERE superseded_by_lease_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.supersede_duplicate_lease(
  p_org_id UUID,
  p_duplicate_lease_id UUID,
  p_canonical_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_duplicate public.leases%ROWTYPE;
  v_canonical public.leases%ROWTYPE;
  v_updated public.leases%ROWTYPE;
  v_before JSONB;
  v_after JSONB;
  v_audit_log_id UUID;
  v_next_extraction JSONB;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_duplicate_lease_id IS NULL THEN
    RAISE EXCEPTION 'duplicate_lease_id is required';
  END IF;
  IF p_canonical_lease_id IS NULL THEN
    RAISE EXCEPTION 'canonical_lease_id is required';
  END IF;
  IF p_duplicate_lease_id = p_canonical_lease_id THEN
    RAISE EXCEPTION 'duplicate_lease_id and canonical_lease_id must be different leases';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'reason is required';
  END IF;

  SELECT * INTO v_duplicate FROM public.leases WHERE id = p_duplicate_lease_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Duplicate lease not found for this organization';
  END IF;

  SELECT * INTO v_canonical FROM public.leases WHERE id = p_canonical_lease_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Canonical lease not found for this organization';
  END IF;

  IF COALESCE(v_canonical.status, '') = 'superseded' THEN
    RAISE EXCEPTION 'Canonical lease % is itself superseded -- point to its own canonical lease instead', p_canonical_lease_id;
  END IF;

  -- Idempotent rerun: already superseded by exactly this canonical lease
  -- returns the current row rather than erroring or re-writing.
  IF v_duplicate.status = 'superseded' AND v_duplicate.superseded_by_lease_id = p_canonical_lease_id THEN
    RETURN jsonb_build_object(
      'lease_id', v_duplicate.id, 'status', v_duplicate.status,
      'superseded_by_lease_id', v_duplicate.superseded_by_lease_id, 'already_superseded', true
    );
  END IF;
  IF v_duplicate.status = 'superseded' AND v_duplicate.superseded_by_lease_id IS DISTINCT FROM p_canonical_lease_id THEN
    RAISE EXCEPTION 'Lease % is already superseded by a different lease (%) -- resolve that conflict explicitly before repointing it', p_duplicate_lease_id, v_duplicate.superseded_by_lease_id;
  END IF;

  v_before := jsonb_build_object('status', v_duplicate.status, 'abstract_status', v_duplicate.abstract_status, 'superseded_by_lease_id', v_duplicate.superseded_by_lease_id);

  v_next_extraction := jsonb_set(
    COALESCE(v_duplicate.extraction_data, '{}'::jsonb),
    ARRAY['superseded'],
    jsonb_build_object('reason', p_reason, 'superseded_at', v_now, 'superseded_by_lease_id', p_canonical_lease_id, 'actor_user_id', p_actor_user_id, 'actor_email', p_actor_email),
    true
  );

  -- Same skip-audit-trigger convention as reject_lease_abstract -- this RPC
  -- writes its own canonical audit_logs row below in the same transaction.
  PERFORM set_config('app.skip_lease_audit_trigger', 'true', true);

  UPDATE public.leases
     SET status = 'superseded',
         abstract_status = 'superseded',
         superseded_by_lease_id = p_canonical_lease_id,
         extraction_data = v_next_extraction,
         updated_at = v_now
   WHERE id = p_duplicate_lease_id AND org_id = p_org_id
  RETURNING * INTO v_updated;

  v_after := jsonb_build_object('status', v_updated.status, 'abstract_status', v_updated.abstract_status, 'superseded_by_lease_id', v_updated.superseded_by_lease_id);

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_updated.property_id, 'Lease', p_duplicate_lease_id::TEXT, 'lease_superseded_as_duplicate',
    p_actor_user_id, p_actor_email, 'info', 'edge_function', v_before, v_after,
    jsonb_build_object('reason', p_reason, 'canonical_lease_id', p_canonical_lease_id, 'tenant_name', v_duplicate.tenant_name),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  RETURN jsonb_build_object(
    'lease_id', v_updated.id, 'status', v_updated.status, 'abstract_status', v_updated.abstract_status,
    'superseded_by_lease_id', v_updated.superseded_by_lease_id, 'already_superseded', false, 'audit_log_id', v_audit_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.supersede_duplicate_lease(UUID, UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supersede_duplicate_lease(UUID, UUID, UUID, UUID, TEXT, TEXT) TO service_role;
