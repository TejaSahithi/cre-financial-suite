-- P2.6 — persist_lease_claim_projection.
--
-- Accepts only compatibility-shaped field projection entries (field_key +
-- claim_id + assertion_status + value) -- never raw claims, and never
-- accepts a caller-supplied registry hash (looked up server-side from
-- lease_claim_registry_versions, the single source of truth already
-- established in P2.1). Generation-fenced, idempotent by an optional
-- caller-supplied p_projection_run_id.
CREATE OR REPLACE FUNCTION public.persist_lease_claim_projection(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_lease_id UUID,
  p_generation_id UUID,
  p_extraction_run_id UUID,
  p_ledger_mode TEXT,
  p_projection_version TEXT,
  p_compatibility_contract_version TEXT,
  p_field_projections JSONB,
  p_projection_run_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active_generation_id UUID;
  v_registry_version TEXT := 'lease-claims-v1';
  v_registry_hash TEXT;
  v_projection_run_id UUID;
  v_entry JSONB;
  v_fields_inserted INT := 0;
BEGIN
  SELECT active_generation_id INTO v_active_generation_id
    FROM public.uploaded_files
   WHERE id = p_uploaded_file_id AND org_id = p_org_id;

  IF v_active_generation_id IS NULL OR v_active_generation_id IS DISTINCT FROM p_generation_id THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'STALE_GENERATION');
  END IF;

  SELECT registry_hash INTO v_registry_hash
    FROM public.lease_claim_registry_versions
   WHERE registry_version = v_registry_version;

  IF v_registry_hash IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'REGISTRY_VERSION_NOT_FOUND');
  END IF;

  -- Idempotency: if the caller supplied a projection_run_id that already
  -- exists (a retried call for the same logical attempt), return the
  -- existing run's identity rather than creating a second one.
  IF p_projection_run_id IS NOT NULL THEN
    SELECT id INTO v_projection_run_id
      FROM public.lease_claim_projection_runs
     WHERE id = p_projection_run_id AND org_id = p_org_id;
  END IF;

  IF v_projection_run_id IS NULL THEN
    v_projection_run_id := COALESCE(p_projection_run_id, gen_random_uuid());
    INSERT INTO public.lease_claim_projection_runs (
      id, org_id, uploaded_file_id, lease_id, generation_id, extraction_run_id,
      status, claims_registry_version, claims_registry_hash, projection_version,
      compatibility_contract_version, ledger_mode, input_claim_count,
      completed_at
    ) VALUES (
      v_projection_run_id, p_org_id, p_uploaded_file_id, p_lease_id, p_generation_id, p_extraction_run_id,
      'completed', v_registry_version, v_registry_hash, p_projection_version,
      p_compatibility_contract_version, p_ledger_mode, jsonb_array_length(COALESCE(p_field_projections, '[]'::jsonb)),
      now()
    );

    FOR v_entry IN SELECT * FROM jsonb_array_elements(COALESCE(p_field_projections, '[]'::jsonb))
    LOOP
      IF NULLIF(v_entry->>'claim_id', '') IS NULL THEN
        CONTINUE; -- unresolved fields have no claim_id and are not projected as a row (P2.6: never a fabricated projection row)
      END IF;

      INSERT INTO public.lease_field_projections (
        org_id, projection_run_id, extraction_run_id, field_key, claim_id, assertion_status, value
      ) VALUES (
        p_org_id, v_projection_run_id, p_extraction_run_id,
        v_entry->>'field_key', (v_entry->>'claim_id')::uuid, v_entry->>'assertion_status', v_entry->>'value'
      )
      ON CONFLICT (projection_run_id, field_key) DO NOTHING;
      v_fields_inserted := v_fields_inserted + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'projection_run_id', v_projection_run_id,
    'fields_inserted', v_fields_inserted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_claim_projection(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, UUID) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.persist_lease_claim_projection(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, UUID) TO service_role;
