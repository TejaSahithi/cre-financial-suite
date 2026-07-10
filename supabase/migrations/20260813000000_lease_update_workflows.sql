-- Enterprise hardening Phase HARD-3B2: narrow server-owned workflows for the
-- two remaining C-bucket direct leases UPDATE paths that need a brand-new
-- RPC (evidence-backfill bulk merge, typed-column field save). The third
-- C-bucket target (post-approval building/unit auto-link) is already fully
-- covered by the existing link_lease_space_assignment RPC
-- (20260727000000_link_lease_space_assignment.sql) -- no new RPC needed
-- for it, only frontend wiring (done outside this migration).
--
-- ============================================================================
-- 1. update_lease_field_and_columns
-- ============================================================================
-- Covers LeaseReview.jsx's handleFieldSave and FieldDetailDrawer.onSaveEdit.
-- Both call sites mix (a) a dynamic set of typed lease-table columns
-- (resolved client-side via resolveFieldColumns(key), a large
-- schema-drift-tolerant alias map) with (b) a merge onto
-- extraction_data.fields[key] (and, for onSaveEdit, field_evidence[key] /
-- confidence_scores[key] too).
--
-- Column whitelist rationale: resolveFieldColumns's alias map
-- (src/lib/leaseReviewSchema.js FIELD_COLUMN_ALIASES) has ~90 distinct
-- candidate column names, most of which do NOT exist on the current
-- `leases` table (confirmed via \d leases against this environment) --
-- several are legacy/speculative aliases (e.g. "landlord_name",
-- "cam_cap_percent", dotted paths like "premises.suite") that would already
-- 400 today if a reviewer's edit resolved to one of them, since PostgREST
-- rejects an UPDATE payload referencing an unknown column outright. This
-- RPC filters p_column_updates server-side down to ONLY the verified,
-- currently-real subset (35 columns, cross-referenced against the live
-- schema below) and drops anything else from the typed-column write -- this
-- is a strict improvement over today's behavior (a stale alias currently
-- fails the WHOLE save; here it's just excluded from the typed-column sync
-- while the extraction_data.fields[key] write -- the value readers actually
-- resolve first, confirmed via leaseFieldResolver.js's canonical/display
-- fallback order -- still succeeds). Phase HARD-3B2A: dropped columns are
-- NOT silently swallowed -- they are surfaced explicitly as
-- ignored_columns in both the RPC response and the audit row's metadata,
-- alongside applied_columns for what was actually written.
--
-- Verified real columns intersected with FIELD_COLUMN_ALIASES's value set:
--   commencement_date, start_date, expiration_date, end_date, property_name,
--   suite_number, lease_date, lease_term, lease_term_months,
--   tenant_pro_rata_share, square_footage, rentable_area_sqft, tenant_rsf,
--   property_address, permitted_use, monthly_rent, annual_rent,
--   rent_per_sf, rent_frequency, escalation_type, escalation_rate,
--   renewal_escalation_percent, escalation_timing, free_rent_months,
--   ti_allowance, security_deposit, lease_type, expense_stop_amount,
--   cam_cap_rate, base_year_amount, renewal_notice_months,
--   renewal_notice_days, renewal_type, renewal_options, late_fee_grace_days.
-- None of these are foreign-key/ownership columns (property_id, unit_id,
-- building_id, org_id, tenant_id are all deliberately excluded -- they were
-- never in the alias map's value set to begin with), so no additional FK
-- ownership validation is needed beyond the standard lease/org boundary
-- check.
--
-- Uses jsonb_populate_record(v_lease, filtered_column_updates) to apply the
-- filtered patch with Postgres's built-in JSONB-to-typed-column casting
-- (dates/numerics/integers/text), rather than hand-rolling per-column casts
-- -- this also means an invalid value for a real column (e.g. a
-- non-date string for commencement_date) raises a normal Postgres cast
-- error, propagated as this RPC's own exception.
--
-- Approved-lease guard: same "abstract_status='approved' is locked" pattern
-- as every other lease-mutating RPC this epic has added
-- (update_lease_extraction_field, save_lease_review_draft,
-- reject_lease_abstract, send_lease_back_for_reextraction,
-- link_lease_space_assignment). handleFieldSave/onSaveEdit have no
-- approved-lease UI gate today (confirmed: neither FieldReviewTable's
-- quick-actions nor FieldDetailDrawer disable on abstract_status), so this
-- is the same intentional new guarantee already established five times in
-- this epic, not a preserved behavior.
--
-- Reuses the existing generic app.skip_lease_audit_trigger GUC so
-- fn_on_lease_changed does not write a duplicate audit row.

CREATE OR REPLACE FUNCTION public.update_lease_field_and_columns(
  p_org_id UUID,
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_field_key TEXT,
  p_column_updates JSONB DEFAULT '{}'::jsonb,
  p_patch JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_lease public.leases%ROWTYPE;
  v_updated public.leases%ROWTYPE;
  v_patched public.leases%ROWTYPE;
  v_next_extraction JSONB;
  v_patch_keys TEXT[];
  v_key TEXT;
  v_filtered_column_updates JSONB;
  v_applied_columns TEXT[];
  v_ignored_columns TEXT[];
  v_audit_log_id UUID;
  v_response JSONB;
  -- Verified real leases columns intersected with FIELD_COLUMN_ALIASES's
  -- value set (see migration header). Never includes id/org_id/property_id/
  -- unit_id/building_id/tenant_id/status/abstract_*/extraction_data/
  -- extracted_fields/source_file_id/created_*/updated_at/signed_*/
  -- approval_*/confidence_score/low_confidence_fields -- none of those were
  -- ever reachable via resolveFieldColumns to begin with.
  v_column_whitelist TEXT[] := ARRAY[
    'commencement_date', 'start_date', 'expiration_date', 'end_date',
    'property_name', 'suite_number', 'lease_date', 'lease_term',
    'lease_term_months', 'tenant_pro_rata_share', 'square_footage',
    'rentable_area_sqft', 'tenant_rsf', 'property_address', 'permitted_use',
    'monthly_rent', 'annual_rent', 'rent_per_sf', 'rent_frequency',
    'escalation_type', 'escalation_rate', 'renewal_escalation_percent',
    'escalation_timing', 'free_rent_months', 'ti_allowance',
    'security_deposit', 'lease_type', 'expense_stop_amount', 'cam_cap_rate',
    'base_year_amount', 'renewal_notice_months', 'renewal_notice_days',
    'renewal_type', 'renewal_options', 'late_fee_grace_days'
  ];
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
  IF NULLIF(trim(COALESCE(p_field_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'field_key is required';
  END IF;
  IF jsonb_typeof(COALESCE(p_column_updates, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'column_updates must be a JSON object';
  END IF;
  IF jsonb_typeof(COALESCE(p_patch, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'patch must be a JSON object';
  END IF;

  SELECT array_agg(k) INTO v_patch_keys FROM jsonb_object_keys(p_patch) AS k;
  FOREACH v_key IN ARRAY COALESCE(v_patch_keys, ARRAY[]::text[]) LOOP
    IF v_key NOT IN ('field', 'field_evidence', 'confidence_score') THEN
      RAISE EXCEPTION 'patch key % is not permitted', v_key;
    END IF;
  END LOOP;

  SELECT *
    INTO v_lease
    FROM public.leases
   WHERE id = p_lease_id
     AND org_id = p_org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;

  IF COALESCE(v_lease.abstract_status, '') = 'approved' THEN
    RAISE EXCEPTION 'Lease abstract is approved and locked; this field cannot be modified';
  END IF;

  -- Filter p_column_updates down to only the verified whitelist. Silently
  -- drop anything else (see migration header rationale).
  SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
    INTO v_filtered_column_updates
    FROM jsonb_each(p_column_updates) AS entry
   WHERE entry.key = ANY(v_column_whitelist);

  SELECT COALESCE(array_agg(k), ARRAY[]::text[])
    INTO v_applied_columns
    FROM jsonb_object_keys(v_filtered_column_updates) AS k;

  -- Explicit transparency (Phase HARD-3B2A): keys present in
  -- p_column_updates but NOT in the whitelist are still dropped from the
  -- typed-column write (never silently applied to an unknown/legacy
  -- column), but are no longer silently swallowed -- they are surfaced in
  -- both the RPC response and the audit row so a caller/reviewer can see
  -- exactly what was ignored and why.
  SELECT COALESCE(array_agg(k), ARRAY[]::text[])
    INTO v_ignored_columns
    FROM jsonb_object_keys(COALESCE(p_column_updates, '{}'::jsonb)) AS k
   WHERE NOT (k = ANY(v_column_whitelist));

  -- jsonb_populate_record casts each present key to its real column type
  -- (date/numeric/integer/text) and leaves every absent key at v_lease's
  -- current value -- no manual per-column type handling needed.
  v_patched := jsonb_populate_record(v_lease, v_filtered_column_updates);

  v_next_extraction := COALESCE(v_lease.extraction_data, '{}'::jsonb);

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

  PERFORM set_config('app.skip_lease_audit_trigger', 'true', true);

  UPDATE public.leases
     SET commencement_date = v_patched.commencement_date,
         start_date = v_patched.start_date,
         expiration_date = v_patched.expiration_date,
         end_date = v_patched.end_date,
         property_name = v_patched.property_name,
         suite_number = v_patched.suite_number,
         lease_date = v_patched.lease_date,
         lease_term = v_patched.lease_term,
         lease_term_months = v_patched.lease_term_months,
         tenant_pro_rata_share = v_patched.tenant_pro_rata_share,
         square_footage = v_patched.square_footage,
         rentable_area_sqft = v_patched.rentable_area_sqft,
         tenant_rsf = v_patched.tenant_rsf,
         property_address = v_patched.property_address,
         permitted_use = v_patched.permitted_use,
         monthly_rent = v_patched.monthly_rent,
         annual_rent = v_patched.annual_rent,
         rent_per_sf = v_patched.rent_per_sf,
         rent_frequency = v_patched.rent_frequency,
         escalation_type = v_patched.escalation_type,
         escalation_rate = v_patched.escalation_rate,
         renewal_escalation_percent = v_patched.renewal_escalation_percent,
         escalation_timing = v_patched.escalation_timing,
         free_rent_months = v_patched.free_rent_months,
         ti_allowance = v_patched.ti_allowance,
         security_deposit = v_patched.security_deposit,
         lease_type = v_patched.lease_type,
         expense_stop_amount = v_patched.expense_stop_amount,
         cam_cap_rate = v_patched.cam_cap_rate,
         base_year_amount = v_patched.base_year_amount,
         renewal_notice_months = v_patched.renewal_notice_months,
         renewal_notice_days = v_patched.renewal_notice_days,
         renewal_type = v_patched.renewal_type,
         renewal_options = v_patched.renewal_options,
         late_fee_grace_days = v_patched.late_fee_grace_days,
         extraction_data = v_next_extraction,
         updated_at = v_now
   WHERE id = p_lease_id
     AND org_id = p_org_id
  RETURNING * INTO v_updated;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id,
    v_updated.property_id,
    'Lease',
    p_lease_id::TEXT,
    'lease_field_manual_edit',
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    to_jsonb(v_lease),
    to_jsonb(v_updated),
    jsonb_build_object(
      'field_key', p_field_key,
      'column_updates_applied', to_jsonb(v_applied_columns),
      'ignored_columns', to_jsonb(v_ignored_columns),
      'patch_keys', to_jsonb(COALESCE(v_patch_keys, ARRAY[]::text[]))
    ),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object(
    'lease_id', v_updated.id,
    'property_id', v_updated.property_id,
    'extraction_data', v_updated.extraction_data,
    'applied_columns', to_jsonb(v_applied_columns),
    'ignored_columns', to_jsonb(v_ignored_columns),
    'updated_at', v_updated.updated_at,
    'audit_log_id', v_audit_log_id
  );
  RETURN v_response;
END;
$$;

-- SECURITY DEFINER bypasses RLS entirely; authorization is enforced solely
-- by update-lease-field-and-columns's assertPageAccess() call, so EXECUTE
-- must be restricted to service_role only (matching every other lease RPC
-- this epic has added).
REVOKE ALL ON FUNCTION public.update_lease_field_and_columns(
  UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.update_lease_field_and_columns(
  UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB
) TO service_role;

-- ============================================================================
-- 2. backfill_lease_evidence
-- ============================================================================
-- Covers LeaseReview.jsx's evidence-backfill bulk-merge useEffect. All the
-- evidence-matching computation (records[0].standard_fields/.custom_fields
-- parsing, docling text-block search, calculated-value supporting-evidence
-- lookup) stays entirely client-side, unchanged -- this RPC only persists
-- the already-computed fields/field_evidence/workflow_output patch
-- transactionally with an audit row, mirroring the precedent set by
-- persist_expense_classification / save_lease_expense_rule_set (narrow
-- persist-only RPC, not a re-derivation of a large client-side matching
-- engine).
--
-- Merge semantics match the client's exact current behavior: for each
-- top-level key present in p_fields_patch / p_field_evidence_patch, the
-- ENTIRE existing entry for that key is replaced (not deep-merged) --
-- i.e. { ...existing, ...patch } at the map level, same as the client's
-- `{ ...ed.fields, ...fieldsWithEvidence }` spread. workflow_output is
-- replaced wholesale only if provided (matching the client's
-- `...(workflowOutput ? { workflow_output: workflowOutput } : {})`).
-- evidence_backfilled_at is always stamped server-side.
--
-- Payload shape is bounded (max 300 keys per patch) to prevent an
-- unbounded/abusive payload -- the real field set in this schema is well
-- under 100 keys even counting dynamic/custom fields, so this is a
-- generous safety net, not a functional constraint.
--
-- Same approved-lease guard and audit-trigger GUC pattern as every other
-- lease-mutating RPC.

CREATE OR REPLACE FUNCTION public.backfill_lease_evidence(
  p_org_id UUID,
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_fields_patch JSONB DEFAULT '{}'::jsonb,
  p_field_evidence_patch JSONB DEFAULT '{}'::jsonb,
  p_workflow_output JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_lease public.leases%ROWTYPE;
  v_updated public.leases%ROWTYPE;
  v_next_extraction JSONB;
  v_fields_patch_keys TEXT[];
  v_field_evidence_patch_keys TEXT[];
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
  IF jsonb_typeof(COALESCE(p_fields_patch, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'fields_patch must be a JSON object';
  END IF;
  IF jsonb_typeof(COALESCE(p_field_evidence_patch, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'field_evidence_patch must be a JSON object';
  END IF;

  SELECT array_agg(k) INTO v_fields_patch_keys FROM jsonb_object_keys(p_fields_patch) AS k;
  SELECT array_agg(k) INTO v_field_evidence_patch_keys FROM jsonb_object_keys(p_field_evidence_patch) AS k;

  IF COALESCE(array_length(v_fields_patch_keys, 1), 0) > 300 THEN
    RAISE EXCEPTION 'fields_patch exceeds the maximum of 300 keys';
  END IF;
  IF COALESCE(array_length(v_field_evidence_patch_keys, 1), 0) > 300 THEN
    RAISE EXCEPTION 'field_evidence_patch exceeds the maximum of 300 keys';
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

  IF COALESCE(v_lease.abstract_status, '') = 'approved' THEN
    RAISE EXCEPTION 'Lease abstract is approved and locked; evidence cannot be backfilled';
  END IF;

  v_next_extraction := COALESCE(v_lease.extraction_data, '{}'::jsonb);

  v_next_extraction := jsonb_set(
    v_next_extraction,
    ARRAY['fields'],
    COALESCE(v_next_extraction->'fields', '{}'::jsonb) || COALESCE(p_fields_patch, '{}'::jsonb),
    true
  );

  v_next_extraction := jsonb_set(
    v_next_extraction,
    ARRAY['field_evidence'],
    COALESCE(v_next_extraction->'field_evidence', '{}'::jsonb) || COALESCE(p_field_evidence_patch, '{}'::jsonb),
    true
  );

  IF p_workflow_output IS NOT NULL THEN
    v_next_extraction := jsonb_set(v_next_extraction, ARRAY['workflow_output'], p_workflow_output, true);
  END IF;

  v_next_extraction := jsonb_set(
    v_next_extraction,
    ARRAY['evidence_backfilled_at'],
    to_jsonb(v_now),
    true
  );

  PERFORM set_config('app.skip_lease_audit_trigger', 'true', true);

  UPDATE public.leases
     SET extraction_data = v_next_extraction,
         updated_at = v_now
   WHERE id = p_lease_id
     AND org_id = p_org_id
  RETURNING * INTO v_updated;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id,
    v_updated.property_id,
    'Lease',
    p_lease_id::TEXT,
    'lease_evidence_backfilled',
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    to_jsonb(v_lease),
    to_jsonb(v_updated),
    jsonb_build_object(
      'fields_patch_keys', to_jsonb(COALESCE(v_fields_patch_keys, ARRAY[]::text[])),
      'field_evidence_patch_keys', to_jsonb(COALESCE(v_field_evidence_patch_keys, ARRAY[]::text[])),
      'workflow_output_provided', (p_workflow_output IS NOT NULL)
    ),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object(
    'lease_id', v_updated.id,
    'property_id', v_updated.property_id,
    'extraction_data', v_updated.extraction_data,
    'updated_at', v_updated.updated_at,
    'audit_log_id', v_audit_log_id
  );
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_lease_evidence(
  UUID, UUID, UUID, TEXT, JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.backfill_lease_evidence(
  UUID, UUID, UUID, TEXT, JSONB, JSONB, JSONB
) TO service_role;
