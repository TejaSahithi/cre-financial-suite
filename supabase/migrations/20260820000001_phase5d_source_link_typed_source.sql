-- Phase 5D: source-link hardening.
-- Keep the typed leases.source_file_id column in the same transaction/audit
-- boundary as update_lease_extraction_field(source_link). The Edge Function
-- validates uploaded_files.org_id before calling this service-role-only RPC;
-- this migration removes the need for a second leases UPDATE and therefore
-- preserves the existing one canonical audit row contract.
CREATE OR REPLACE FUNCTION public.update_lease_extraction_field(
  p_org_id UUID,
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_field_area TEXT,   -- 'field_value' | 'source_link' | 'lease_flag'
  p_action TEXT,       -- whitelisted per area, see below
  p_field_key TEXT,    -- required iff p_field_area = 'field_value'
  p_patch JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_lease public.leases%ROWTYPE;
  v_updated_lease public.leases%ROWTYPE;
  v_next_extraction JSONB;
  v_patch_keys TEXT[];
  v_key TEXT;
  v_audit_log_id UUID;
  v_response JSONB;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_lease_id IS NULL THEN
    RAISE EXCEPTION 'lease_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF p_field_area NOT IN ('field_value', 'source_link', 'lease_flag') THEN
    RAISE EXCEPTION 'field_area must be one of field_value, source_link, lease_flag';
  END IF;
  IF p_field_area = 'field_value' AND NULLIF(trim(COALESCE(p_field_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'field_key is required for field_area=field_value';
  END IF;
  IF p_field_area = 'field_value' AND p_action NOT IN ('field_evidence_edit', 'custom_field_added') THEN
    RAISE EXCEPTION 'action % is not permitted for field_area=field_value', p_action;
  END IF;
  IF p_field_area = 'source_link' AND p_action NOT IN (
    'source_file_manually_linked', 'source_file_auto_linked',
    'source_file_linked_on_upload', 'source_file_relinked_debug'
  ) THEN
    RAISE EXCEPTION 'action % is not permitted for field_area=source_link', p_action;
  END IF;
  IF p_field_area = 'lease_flag' AND p_action NOT IN ('document_type_override_set') THEN
    RAISE EXCEPTION 'action % is not permitted for field_area=lease_flag', p_action;
  END IF;
  IF jsonb_typeof(COALESCE(p_patch, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'patch must be a JSON object';
  END IF;

  SELECT *
    INTO v_lease
    FROM public.leases
   WHERE id = p_lease_id
     AND org_id = p_org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;

  -- Approved/locked guard. No dedicated "locked" column exists; any
  -- send-back/rejection already transitions abstract_status away from
  -- 'approved', so blocking exactly this value is sufficient.
  IF COALESCE(v_lease.abstract_status, '') = 'approved' THEN
    RAISE EXCEPTION 'Lease abstract is approved and locked; extraction_data cannot be modified';
  END IF;

  SELECT array_agg(k) INTO v_patch_keys FROM jsonb_object_keys(p_patch) AS k;
  v_next_extraction := COALESCE(v_lease.extraction_data, '{}'::jsonb);

  IF p_field_area = 'field_value' THEN
    FOREACH v_key IN ARRAY COALESCE(v_patch_keys, ARRAY[]::text[]) LOOP
      IF v_key NOT IN ('field', 'field_evidence', 'confidence_score') THEN
        RAISE EXCEPTION 'patch key % is not permitted for field_area=field_value', v_key;
      END IF;
    END LOOP;

    -- Single-level jsonb_set on 'fields'/'field_evidence'/'confidence_scores'
    -- (not a 2-level path) so create_missing=true reliably creates the
    -- container when it doesn't exist yet -- jsonb_set cannot create
    -- multiple missing intermediate levels in one call.
    IF p_patch ? 'field' THEN
      v_next_extraction := jsonb_set(
        v_next_extraction,
        ARRAY['fields'],
        COALESCE(v_next_extraction->'fields', '{}'::jsonb) ||
          jsonb_build_object(
            p_field_key,
            COALESCE(v_next_extraction #> ARRAY['fields', p_field_key], '{}'::jsonb) || (p_patch->'field')
          ),
        true
      );
    END IF;

    IF p_patch ? 'field_evidence' THEN
      v_next_extraction := jsonb_set(
        v_next_extraction,
        ARRAY['field_evidence'],
        COALESCE(v_next_extraction->'field_evidence', '{}'::jsonb) ||
          jsonb_build_object(
            p_field_key,
            COALESCE(v_next_extraction #> ARRAY['field_evidence', p_field_key], '{}'::jsonb) || (p_patch->'field_evidence')
          ),
        true
      );
    END IF;

    IF p_patch ? 'confidence_score' THEN
      v_next_extraction := jsonb_set(
        v_next_extraction,
        ARRAY['confidence_scores'],
        COALESCE(v_next_extraction->'confidence_scores', '{}'::jsonb) ||
          jsonb_build_object(p_field_key, p_patch->'confidence_score'),
        true
      );
    END IF;
  ELSIF p_field_area = 'source_link' THEN
    FOREACH v_key IN ARRAY COALESCE(v_patch_keys, ARRAY[]::text[]) LOOP
      IF v_key NOT IN (
        'source_file_id', 'source_file_name', 'manually_linked_at', 'auto_linked_at',
        'auto_link_score', 'auto_link_reasons', 'source_file_linked_at',
        'document_subtype', 'source_relinked_at'
      ) THEN
        RAISE EXCEPTION 'patch key % is not permitted for field_area=source_link', v_key;
      END IF;
    END LOOP;

    v_next_extraction := v_next_extraction || p_patch;
  ELSE -- lease_flag
    FOREACH v_key IN ARRAY COALESCE(v_patch_keys, ARRAY[]::text[]) LOOP
      IF v_key NOT IN ('document_type_override') THEN
        RAISE EXCEPTION 'patch key % is not permitted for field_area=lease_flag', v_key;
      END IF;
    END LOOP;

    v_next_extraction := v_next_extraction || p_patch;
  END IF;

  -- Skip fn_on_lease_changed's own audit_logs insert -- this RPC writes its
  -- own canonical row below in the same transaction. Transaction-local
  -- (SET LOCAL semantics): reverts automatically at COMMIT/ROLLBACK.
  PERFORM set_config('app.skip_lease_audit_trigger', 'true', true);

  UPDATE public.leases
     SET source_file_id = CASE
           WHEN p_field_area = 'source_link' AND p_patch ? 'source_file_id'
             THEN (p_patch->>'source_file_id')::uuid
           ELSE v_lease.source_file_id
         END,
         extraction_data = v_next_extraction,
         updated_at = v_now
   WHERE id = p_lease_id
     AND org_id = p_org_id
  RETURNING * INTO v_updated_lease;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id,
    v_updated_lease.property_id,
    'Lease',
    p_lease_id::TEXT,
    p_action,
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    to_jsonb(v_lease),
    to_jsonb(v_updated_lease),
    jsonb_build_object(
      'field_area', p_field_area,
      'field_key', p_field_key,
      'patch_keys', to_jsonb(COALESCE(v_patch_keys, ARRAY[]::text[]))
    ),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object(
    'lease_id', v_updated_lease.id,
    'extraction_data', v_updated_lease.extraction_data,
    'audit_log_id', v_audit_log_id
  );
  RETURN v_response;
END;
$$;

-- Grant unchanged (signature unchanged) -- restated for clarity/idempotency.
REVOKE ALL ON FUNCTION public.update_lease_extraction_field(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.update_lease_extraction_field(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB
) TO service_role;
