-- ===========================================================================
-- Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 2
-- corrections 2 and 3 (requested before Phase 3 begins).
--
-- Correction 2: materialization idempotency was keyed on
-- lease_expense_rules.updated_at alone — a real weakness confirmed during
-- Phase 2 testing (this table has ZERO triggers, so updated_at is only as
-- reliable as every caller remembering to set it, and it changes on ANY
-- edit including ones with no financial meaning, e.g. a notes field).
-- Replaced with: source_rule_hash (an md5 digest of every column the
-- materialization mapping actually reads), source_approved_at (the real
-- approval timestamp, not a generic edit timestamp), and
-- materializer_version (so a future change to the mapping logic itself can
-- be distinguished from a change to the rule). The uniqueness constraint
-- now keys on the hash, not updated_at.
--
-- Correction 3: effective_from is no longer a caller-supplied value taken
-- on faith. The RPC now derives it from reliable sources in priority
-- order (amendment effective_date, then lease commencement_date/start_date)
-- and only accepts a manual override when the caller supplies BOTH a
-- reason and an approver. If none of these are available, materialization
-- is refused outright — the rule stays un-materialized, which the existing
-- evaluate_cam_readiness() already reports as POLICY_MISSING. This is the
-- "blocking readiness exception instead of guessing" behavior: no new
-- exception table was needed since an un-materialized approved rule is
-- already a first-class readiness condition.
-- ===========================================================================

ALTER TABLE public.lease_recovery_policies
  ADD COLUMN IF NOT EXISTS source_rule_hash TEXT,
  ADD COLUMN IF NOT EXISTS source_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS materializer_version TEXT NOT NULL DEFAULT 'materializer_v1',
  ADD COLUMN IF NOT EXISTS effective_date_source TEXT
    CHECK (effective_date_source IN ('amendment_effective_date', 'lease_commencement', 'manual_override')),
  ADD COLUMN IF NOT EXISTS effective_date_reason TEXT,
  ADD COLUMN IF NOT EXISTS effective_date_approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Drop the old updated_at-based idempotency key, replace with the hash-based one.
ALTER TABLE public.lease_recovery_policies
  DROP CONSTRAINT IF EXISTS lease_recovery_policies_source_rule_version_unique;

ALTER TABLE public.lease_recovery_policies
  ADD CONSTRAINT lease_recovery_policies_source_rule_hash_unique
  UNIQUE (org_id, source_rule_id, source_rule_hash);

-- Backfill existing rows (from Phase 2 testing) so the new NOT NULL-ish
-- expectations have something sane rather than leaving them null forever.
-- effective_date_source is left NULL for pre-existing rows since we cannot
-- honestly reconstruct which source was actually used at the time.
UPDATE public.lease_recovery_policies p
   SET source_rule_hash = md5(COALESCE(p.source_rule_updated_at::TEXT, p.id::TEXT)),
       source_approved_at = p.approved_at
 WHERE p.source_rule_hash IS NULL;

CREATE OR REPLACE FUNCTION public.materialize_lease_recovery_policy(
  p_org_id UUID,
  p_rule_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_lease_amendment_id UUID DEFAULT NULL,
  p_effective_from DATE DEFAULT NULL,
  p_effective_date_reason TEXT DEFAULT NULL,
  p_effective_date_approved_by UUID DEFAULT NULL,
  p_effective_to DATE DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_rule public.lease_expense_rules%ROWTYPE;
  v_lease public.leases%ROWTYPE;
  v_amendment public.lease_amendments%ROWTYPE;
  v_existing_same_version public.lease_recovery_policies%ROWTYPE;
  v_existing_prior_version public.lease_recovery_policies%ROWTYPE;
  v_policy public.lease_recovery_policies%ROWTYPE;
  v_policy_type TEXT;
  v_source_evidence JSONB;
  v_sequence INT := 1;
  v_already_materialized BOOLEAN := false;
  v_superseded_prior_id UUID;
  v_step_ids JSONB := '[]'::jsonb;
  v_rule_hash TEXT;
  v_effective_from DATE;
  v_effective_date_source TEXT;
  v_effective_date_reason TEXT;
  v_effective_date_approved_by UUID;
  CURRENT_MATERIALIZER_VERSION CONSTANT TEXT := 'materializer_v1';
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_rule_id IS NULL THEN RAISE EXCEPTION 'rule_id is required'; END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'actor_user_id is required'; END IF;

  SELECT * INTO v_rule FROM public.lease_expense_rules WHERE id = p_rule_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease expense rule not found for this organization';
  END IF;

  IF lower(COALESCE(v_rule.approval_status, '')) IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Only approved lease expense rules can be materialized into a recovery policy (rule % has approval_status=%)', p_rule_id, COALESCE(v_rule.approval_status, '(none)');
  END IF;

  SELECT * INTO v_lease FROM public.leases WHERE id = v_rule.lease_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;

  -- ---- Correction 3: derive effective_from from reliable sources; never
  -- guess. Priority: explicit amendment > manual override (with mandatory
  -- reason + approver) > lease commencement. Nothing reliable -> refuse.
  IF p_lease_amendment_id IS NOT NULL THEN
    SELECT * INTO v_amendment FROM public.lease_amendments WHERE id = p_lease_amendment_id AND org_id = p_org_id AND lease_id = v_rule.lease_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Amendment % not found for this lease/organization', p_lease_amendment_id;
    END IF;
    IF v_amendment.effective_date IS NULL THEN
      RAISE EXCEPTION 'Amendment % has no effective_date recorded — cannot derive a reliable effective_from; supply one manually with a reason and approver instead', p_lease_amendment_id;
    END IF;
    v_effective_from := v_amendment.effective_date;
    v_effective_date_source := 'amendment_effective_date';
  ELSIF p_effective_from IS NOT NULL THEN
    IF NULLIF(trim(COALESCE(p_effective_date_reason, '')), '') IS NULL THEN
      RAISE EXCEPTION 'effective_date_reason is required when supplying a manual effective_from override';
    END IF;
    v_effective_from := p_effective_from;
    v_effective_date_source := 'manual_override';
    v_effective_date_reason := trim(p_effective_date_reason);
    v_effective_date_approved_by := COALESCE(p_effective_date_approved_by, p_actor_user_id);
  ELSIF COALESCE(v_lease.commencement_date, v_lease.start_date) IS NOT NULL THEN
    v_effective_from := COALESCE(v_lease.commencement_date, v_lease.start_date);
    v_effective_date_source := 'lease_commencement';
  ELSE
    RAISE EXCEPTION 'Cannot determine a reliable effective_from for rule % — no amendment was supplied, no manual override with reason/approver was given, and the lease has no commencement_date or start_date. Materialization is blocked; the rule remains un-materialized and will surface as a POLICY_MISSING readiness exception rather than being guessed.', p_rule_id;
  END IF;

  -- ---- Correction 2: hash-based idempotency over every financially
  -- relevant rule field the materialization mapping actually reads.
  v_rule_hash := md5(concat_ws('|',
    v_rule.expense_category_id::TEXT, COALESCE(v_rule.is_excluded::TEXT, ''), COALESCE(v_rule.rule_type, ''),
    COALESCE(v_rule.recovery_method, ''), COALESCE(v_rule.allocation_basis, ''), COALESCE(v_rule.tenant_share_percent::TEXT, ''),
    COALESCE(v_rule.estimated_annual_amount::TEXT, ''), COALESCE(v_rule.gross_up_applicable::TEXT, ''), COALESCE(v_rule.gross_up_percent::TEXT, ''),
    COALESCE(v_rule.has_base_year::TEXT, ''), COALESCE(v_rule.base_year, ''), COALESCE(v_rule.base_year_amount::TEXT, ''), COALESCE(v_rule.base_year_type, ''),
    COALESCE(v_rule.expense_stop_amount::TEXT, ''), COALESCE(v_rule.is_subject_to_cap::TEXT, ''), COALESCE(v_rule.cap_type, ''),
    COALESCE(v_rule.cap_amount::TEXT, ''), COALESCE(v_rule.cap_percent::TEXT, ''), COALESCE(v_rule.cap_value::TEXT, ''),
    COALESCE(v_rule.admin_fee_applicable::TEXT, ''), COALESCE(v_rule.admin_fee_percent::TEXT, '')
  ));

  SELECT * INTO v_existing_same_version
    FROM public.lease_recovery_policies
   WHERE org_id = p_org_id AND source_rule_id = p_rule_id AND source_rule_hash = v_rule_hash
   LIMIT 1;

  IF FOUND THEN
    v_already_materialized := true;
    v_policy := v_existing_same_version;
  ELSE
    SELECT * INTO v_existing_prior_version
      FROM public.lease_recovery_policies
     WHERE org_id = p_org_id AND source_rule_id = p_rule_id AND status <> 'superseded'
     FOR UPDATE;

    IF FOUND THEN
      UPDATE public.lease_recovery_policies
         SET status = 'superseded',
             effective_to = (v_effective_from - INTERVAL '1 day')::date,
             updated_at = v_now
       WHERE id = v_existing_prior_version.id;
      v_superseded_prior_id := v_existing_prior_version.id;
    END IF;

    v_policy_type := CASE
      WHEN COALESCE(v_rule.is_excluded, false) IS TRUE OR lower(COALESCE(v_rule.rule_type, '')) = 'excluded' THEN 'exclusion'
      WHEN lower(COALESCE(v_rule.rule_type, '')) = 'fixed_charge' THEN 'direct_charge'
      ELSE 'category_recovery'
    END;

    v_source_evidence := jsonb_build_object(
      'source_page', v_rule.source_page,
      'exact_source_text', v_rule.exact_source_text,
      'confidence_score', v_rule.confidence_score,
      'approved_by', v_rule.approved_by,
      'approved_at', v_rule.approved_at,
      'rule_source', v_rule.source,
      'generation_source', v_rule.generation_source
    );

    INSERT INTO public.lease_recovery_policies (
      org_id, lease_id, lease_amendment_id, source_rule_set_id, source_rule_id,
      source_rule_updated_at, source_rule_hash, source_approved_at, materializer_version,
      source_evidence, policy_type,
      effective_from, effective_to, effective_date_source, effective_date_reason, effective_date_approved_by,
      status, superseded_by_policy_id,
      approved_by, approved_at, notes
    ) VALUES (
      p_org_id, v_rule.lease_id, p_lease_amendment_id, v_rule.rule_set_id, p_rule_id,
      v_rule.updated_at, v_rule_hash, v_rule.approved_at, CURRENT_MATERIALIZER_VERSION,
      v_source_evidence, v_policy_type,
      v_effective_from, p_effective_to, v_effective_date_source, v_effective_date_reason, v_effective_date_approved_by,
      'approved', NULL,
      v_rule.approved_by, v_rule.approved_at,
      CASE WHEN v_superseded_prior_id IS NOT NULL THEN format('Materialized after rule content changed (hash); supersedes policy %s', v_superseded_prior_id) ELSE NULL END
    )
    RETURNING * INTO v_policy;

    IF v_superseded_prior_id IS NOT NULL THEN
      UPDATE public.lease_recovery_policies SET superseded_by_policy_id = v_policy.id WHERE id = v_superseded_prior_id;
    END IF;

    IF v_policy_type = 'exclusion' THEN
      INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters, source_evidence)
      VALUES (p_org_id, v_policy.id, v_sequence, 'EXCLUDE_CATEGORY', v_rule.expense_category_id, '{}'::jsonb, v_source_evidence);
      v_sequence := v_sequence + 1;
    ELSE
      INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters, source_evidence)
      VALUES (p_org_id, v_policy.id, v_sequence, 'INCLUDE_CATEGORY', v_rule.expense_category_id, '{}'::jsonb, v_source_evidence);
      v_sequence := v_sequence + 1;

      IF v_policy_type = 'direct_charge' THEN
        INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
        VALUES (p_org_id, v_policy.id, v_sequence, 'DIRECT_ASSIGN', v_rule.expense_category_id, jsonb_build_object('estimated_annual_amount', v_rule.estimated_annual_amount));
        v_sequence := v_sequence + 1;
      ELSE
        INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
        VALUES (
          p_org_id, v_policy.id, v_sequence, 'CALCULATE_SHARE', v_rule.expense_category_id,
          jsonb_build_object('recovery_method', v_rule.recovery_method, 'allocation_basis', v_rule.allocation_basis, 'tenant_share_percent', v_rule.tenant_share_percent)
        );
        v_sequence := v_sequence + 1;

        IF COALESCE(v_rule.gross_up_applicable, false) IS TRUE THEN
          INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
          VALUES (p_org_id, v_policy.id, v_sequence, 'GROSS_UP_VARIABLE', v_rule.expense_category_id, jsonb_build_object('target_occupancy_pct', v_rule.gross_up_percent));
          v_sequence := v_sequence + 1;
        END IF;

        IF COALESCE(v_rule.has_base_year, false) IS TRUE THEN
          INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
          VALUES (
            p_org_id, v_policy.id, v_sequence, 'APPLY_BASE_YEAR', v_rule.expense_category_id,
            jsonb_build_object('base_year', v_rule.base_year, 'base_year_amount', v_rule.base_year_amount, 'base_year_type', v_rule.base_year_type)
          );
          v_sequence := v_sequence + 1;
        END IF;

        IF v_rule.expense_stop_amount IS NOT NULL THEN
          INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
          VALUES (p_org_id, v_policy.id, v_sequence, 'APPLY_EXPENSE_STOP', v_rule.expense_category_id, jsonb_build_object('expense_stop_amount', v_rule.expense_stop_amount));
          v_sequence := v_sequence + 1;
        END IF;

        IF COALESCE(v_rule.is_subject_to_cap, false) IS TRUE THEN
          INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
          VALUES (
            p_org_id, v_policy.id, v_sequence, 'APPLY_CAP', v_rule.expense_category_id,
            jsonb_build_object('cap_type', v_rule.cap_type, 'cap_amount', v_rule.cap_amount, 'cap_percent', v_rule.cap_percent, 'cap_value', v_rule.cap_value)
          );
          v_sequence := v_sequence + 1;
        END IF;

        IF COALESCE(v_rule.admin_fee_applicable, false) IS TRUE THEN
          INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
          VALUES (p_org_id, v_policy.id, v_sequence, 'ADD_ADMIN_FEE', v_rule.expense_category_id, jsonb_build_object('admin_fee_percent', v_rule.admin_fee_percent, 'admin_fee_basis', 'eligible_expenses'));
          v_sequence := v_sequence + 1;
        END IF;
      END IF;

      INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
      VALUES (p_org_id, v_policy.id, v_sequence, 'PRORATE', v_rule.expense_category_id, '{}'::jsonb);
      v_sequence := v_sequence + 1;

      INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
      VALUES (p_org_id, v_policy.id, v_sequence, 'RECONCILE_ESTIMATES', v_rule.expense_category_id, '{}'::jsonb);
      v_sequence := v_sequence + 1;
    END IF;

    INSERT INTO public.audit_logs (
      org_id, property_id, entity_type, entity_id, action,
      actor_user_id, actor_email, severity, source, after, metadata, "timestamp"
    ) VALUES (
      p_org_id, v_rule.property_id, 'LeaseRecoveryPolicy', v_policy.id::TEXT,
      'lease_recovery_policy_materialized', p_actor_user_id, p_actor_email, 'info', 'edge_function',
      to_jsonb(v_policy),
      jsonb_build_object('source_rule_id', p_rule_id, 'superseded_policy_id', v_superseded_prior_id, 'step_count', v_sequence - 1, 'source_rule_hash', v_rule_hash),
      v_now
    );
  END IF;

  SELECT jsonb_agg(jsonb_build_object('id', id, 'sequence', sequence, 'step_type', step_type) ORDER BY sequence)
    INTO v_step_ids
    FROM public.lease_recovery_policy_steps WHERE policy_id = v_policy.id;

  RETURN jsonb_build_object(
    'policy', to_jsonb(v_policy),
    'steps', COALESCE(v_step_ids, '[]'::jsonb),
    'already_materialized', v_already_materialized,
    'superseded_policy_id', v_superseded_prior_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.materialize_lease_recovery_policy(UUID, UUID, UUID, TEXT, UUID, DATE, TEXT, UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_lease_recovery_policy(UUID, UUID, UUID, TEXT, UUID, DATE, TEXT, UUID, DATE) TO service_role;

-- The old 7-argument signature (p_org_id, p_rule_id, p_effective_from,
-- p_actor_user_id, p_actor_email, p_lease_amendment_id, p_effective_to) is
-- superseded by the 9-argument one above (p_effective_from moved later and
-- became optional; two new reason/approver params inserted). Drop it
-- explicitly so no duplicate overload remains — same lesson as
-- review_expense_classification earlier this session.
DROP FUNCTION IF EXISTS public.materialize_lease_recovery_policy(UUID, UUID, DATE, UUID, TEXT, UUID, DATE);
