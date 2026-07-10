-- Enterprise hardening Phase HARD-3B3A: narrow server-owned workflow for
-- the remaining E-bucket direct leases UPDATE persistence paths, closing
-- them out ahead of the HARD-3B3B leases_update RLS lockdown.
--
-- Covers three call sites, all of which only ever write a subset of the
-- SAME 7 top-level extraction_data keys (fields, field_evidence,
-- confidence_scores, workflow_output, evidence_refreshed_at,
-- extraction_debug, last_reextract_blocked_at):
--
--   1. LeaseReview.jsx handleReextractLease's manual-review-fallback write
--      (evidence_refreshed_at, extraction_debug only -- records that the
--      pipeline parked the doc for manual review so the auto-extract loop
--      stops retrying).
--   2. LeaseReview.jsx handleReextractLease's success-path write (either
--      the full merge shape -- fields/field_evidence/confidence_scores/
--      workflow_output(optional)/evidence_refreshed_at/extraction_debug --
--      or, when the re-extract produced nothing usable, the narrower
--      "blocked" shape -- extraction_debug/last_reextract_blocked_at only,
--      preserving every other extraction_data key).
--   3. ExtractionDebugPanel.jsx handleApplyLatestExtraction's write
--      (fields/field_evidence/confidence_scores/workflow_output(optional)/
--      evidence_refreshed_at -- no extraction_debug).
--
-- All the field-matching/protection/junk-sentinel-stripping computation
-- (the ~250-line merge/protection engine assessed in Phase 6D-6, and
-- confirmed by that assessment to be too large/risky to safely re-derive
-- in SQL, matching the same precedent already set for classifyExpenses()
-- and the original saveRuleSet()) stays entirely client-side, unchanged.
-- This RPC is a narrow persist-only workflow: it accepts the
-- already-computed patch and writes it transactionally with one audit row,
-- the same "persist, don't re-derive" shape as persist_expense_classification
-- and save_lease_expense_rule_set's mechanical-write slice.
--
-- Because every target site only ever sets whole top-level extraction_data
-- keys (never a nested per-field merge the way update_lease_extraction_field
-- and backfill_lease_evidence do), a single JSONB concatenation
-- (`existing || patch`) is sufficient and exactly matches each call site's
-- current `{ ...lease.extraction_data, <replaced keys> }` spread semantics:
-- every key present in the patch fully replaces the existing value for that
-- key; every key absent from the patch is left untouched.
--
-- p_action is an explicit, server-whitelisted enum (not inferred from which
-- patch keys are present) so the audit trail records which of the three
-- real-world events actually happened, matching update_lease_extraction_field's
-- per-area action whitelist precedent:
--   lease_extraction_manual_review_recorded -- target 1
--   lease_extraction_merged                 -- target 2, success branch
--   lease_extraction_merge_blocked          -- target 2, blocked branch
--   lease_extraction_debug_applied          -- target 3 (Extraction Debug
--                                               tool, distinct from the
--                                               LeaseReview-driven actions
--                                               for traceability of who
--                                               triggered what)
--
-- Deliberately NOT touched/removed here: LeaseReview.jsx's own client-side
-- logAudit({action:'lease_reextracted', ...}) call, which captures richer
-- decision-level detail (stripped junk field counts, source-backed field
-- counts, manual/approved-preserved counts) this RPC's generic before/after
-- diff does not naturally express in human-readable form. Its action name
-- differs from this RPC's own canonical action, so this is not the
-- same-name double-audit anti-pattern already fixed elsewhere this epic
-- (e.g. CAMCalculation.jsx's duplicate cam_compute removal) -- it's
-- complementary decision-level detail alongside the new canonical
-- mechanical-write audit row, the same coexistence already accepted for
-- approve_lease_workflow's per-field bulk-approval audit rows.
--
-- Approved-lease guard: same "abstract_status='approved' is locked" pattern
-- as every other lease-mutating RPC this epic has added. Neither
-- handleReextractLease's "Re-extract Lease" button nor ExtractionDebugPanel's
-- "Apply Latest Extraction" button has any approved-lease UI gate today, so
-- this is the same intentional new guarantee already established
-- repeatedly in this epic (update_lease_extraction_field,
-- save_lease_review_draft, reject_lease_abstract,
-- send_lease_back_for_reextraction, link_lease_space_assignment,
-- update_lease_field_and_columns, backfill_lease_evidence), not a
-- preserved behavior.
--
-- Payload shape is bounded by total serialized size (2MB) rather than a
-- per-key count the way backfill_lease_evidence bounds fields_patch/
-- field_evidence_patch -- extraction_debug and workflow_output are single
-- nested objects (not per-field maps), so a blanket size cap is the
-- simpler, more robust guard here.
--
-- Reuses the existing generic app.skip_lease_audit_trigger GUC so
-- fn_on_lease_changed does not write a duplicate audit row.

CREATE OR REPLACE FUNCTION public.persist_lease_extraction_merge(
  p_org_id UUID,
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_action TEXT,
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
  v_next_extraction JSONB;
  v_patch_keys TEXT[];
  v_key TEXT;
  v_audit_log_id UUID;
  v_response JSONB;
  v_allowed_actions TEXT[] := ARRAY[
    'lease_extraction_manual_review_recorded',
    'lease_extraction_merged',
    'lease_extraction_merge_blocked',
    'lease_extraction_debug_applied'
  ];
  v_allowed_patch_keys TEXT[] := ARRAY[
    'fields', 'field_evidence', 'confidence_scores', 'workflow_output',
    'evidence_refreshed_at', 'extraction_debug', 'last_reextract_blocked_at'
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
  IF NOT (p_action = ANY(v_allowed_actions)) THEN
    RAISE EXCEPTION 'action % is not permitted', p_action;
  END IF;
  IF jsonb_typeof(COALESCE(p_patch, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'patch must be a JSON object';
  END IF;
  IF octet_length(COALESCE(p_patch, '{}'::jsonb)::text) > 2000000 THEN
    RAISE EXCEPTION 'patch exceeds the maximum allowed size';
  END IF;

  SELECT array_agg(k) INTO v_patch_keys FROM jsonb_object_keys(p_patch) AS k;
  FOREACH v_key IN ARRAY COALESCE(v_patch_keys, ARRAY[]::text[]) LOOP
    IF NOT (v_key = ANY(v_allowed_patch_keys)) THEN
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
    RAISE EXCEPTION 'Lease abstract is approved and locked; extraction data cannot be modified';
  END IF;

  -- Every allowed patch key is a whole top-level extraction_data key
  -- (never a nested per-field merge), so a single concatenation replaces
  -- exactly the keys present in the patch and preserves everything else --
  -- matching each call site's existing `{ ...extraction_data, <keys> }`
  -- spread semantics exactly.
  v_next_extraction := COALESCE(v_lease.extraction_data, '{}'::jsonb) || p_patch;

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
    p_action,
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    to_jsonb(v_lease),
    to_jsonb(v_updated),
    jsonb_build_object(
      'patch_keys', to_jsonb(COALESCE(v_patch_keys, ARRAY[]::text[]))
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

-- SECURITY DEFINER bypasses RLS entirely; authorization is enforced solely
-- by persist-lease-extraction-merge's assertPageAccess() call, so EXECUTE
-- must be restricted to service_role only (matching every other lease RPC
-- this epic has added).
REVOKE ALL ON FUNCTION public.persist_lease_extraction_merge(
  UUID, UUID, UUID, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.persist_lease_extraction_merge(
  UUID, UUID, UUID, TEXT, TEXT, JSONB
) TO service_role;
