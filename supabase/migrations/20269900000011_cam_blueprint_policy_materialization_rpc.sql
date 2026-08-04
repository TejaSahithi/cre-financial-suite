-- ===========================================================================
-- Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 2A: policy
-- materialization.
--
-- materialize_lease_recovery_policy converts ONE approved lease_expense_rules
-- row into a typed lease_recovery_policies row + ordered
-- lease_recovery_policy_steps, preserving the source rule and its document
-- evidence (frozen snapshot, not a live join). It is idempotent: calling it
-- twice for the same rule version (same lease_expense_rules.updated_at) is
-- a safe no-op that returns the existing policy unchanged, using the
-- (org_id, source_rule_id, source_rule_updated_at) uniqueness constraint
-- from 20269900000009 as the literal idempotency key. Calling it again
-- after the rule was edited (updated_at changed) supersedes the prior
-- policy version and creates a new one — the lease_recovery_policies
-- EXCLUDE constraint from the same migration guarantees at most one active
-- (non-superseded) policy per (lease_id, source_rule_id) at any instant.
--
-- Design decisions made explicit here (documented again in the final Phase
-- 2 report):
--   - p_effective_from is a REQUIRED caller-supplied parameter, never
--     inferred inside the RPC. lease_expense_rules carries no reliable
--     "this rule became effective on this date" field of its own (a rule
--     may derive from the base lease or from an amendment with its own
--     effective_date), so guessing would violate "never silently infer a
--     mandatory financial term." The caller (a future amendment-processing
--     workflow, or a manual Setup UI action) is responsible for sourcing
--     this from the lease's real commencement date or the amendment's
--     effective_date.
--   - Materialized policies are created with status='approved' directly,
--     not 'draft': the rule that backs them was already human-approved,
--     and this RPC performs a deterministic, non-judgmental projection of
--     that approval, not a new decision. If a separate review gate on the
--     materialized policy itself turns out to be wanted, it is a small
--     follow-up (flip the default status and add an approve RPC) — flagged
--     as an open assumption in the Phase 2 report, not silently decided
--     for good.
--   - Missing/ambiguous mandatory financial terms (e.g. has_base_year=true
--     but base_year_amount is null) are NOT hard-failed here and are NOT
--     silently defaulted either. Materialization mechanically projects
--     exactly what the rule says, gaps included; Phase 2C's readiness
--     engine is what turns "policy step exists but a required parameter is
--     null" into a formal, named exception (e.g. BASE_YEAR_MISSING) before
--     any CAM run may proceed. This keeps materialization a pure,
--     reviewable projection rather than a place where financial defaults
--     get silently invented.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.materialize_lease_recovery_policy(
  p_org_id UUID,
  p_rule_id UUID,
  p_effective_from DATE,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_lease_amendment_id UUID DEFAULT NULL,
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
  v_existing_same_version public.lease_recovery_policies%ROWTYPE;
  v_existing_prior_version public.lease_recovery_policies%ROWTYPE;
  v_policy public.lease_recovery_policies%ROWTYPE;
  v_policy_type TEXT;
  v_source_evidence JSONB;
  v_sequence INT := 1;
  v_already_materialized BOOLEAN := false;
  v_superseded_prior_id UUID;
  v_step_ids JSONB := '[]'::jsonb;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_rule_id IS NULL THEN
    RAISE EXCEPTION 'rule_id is required';
  END IF;
  IF p_effective_from IS NULL THEN
    RAISE EXCEPTION 'effective_from is required — it must be sourced from the lease commencement date or amendment effective_date by the caller, never inferred here';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;

  SELECT * INTO v_rule FROM public.lease_expense_rules WHERE id = p_rule_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease expense rule not found for this organization';
  END IF;

  -- Only approved rules may be materialized — this is the input gate the
  -- blueprint asks for ("Convert only approved lease expense rules").
  IF lower(COALESCE(v_rule.approval_status, '')) IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Only approved lease expense rules can be materialized into a recovery policy (rule % has approval_status=%)', p_rule_id, COALESCE(v_rule.approval_status, '(none)');
  END IF;

  SELECT * INTO v_lease FROM public.leases WHERE id = v_rule.lease_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;

  IF p_lease_amendment_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.lease_amendments WHERE id = p_lease_amendment_id AND org_id = p_org_id AND lease_id = v_rule.lease_id
    ) THEN
      RAISE EXCEPTION 'Amendment % not found for this lease/organization', p_lease_amendment_id;
    END IF;
  END IF;

  -- Idempotency: an existing policy for the EXACT same rule version is a
  -- safe no-op — return it unchanged, no new row, no new steps.
  SELECT * INTO v_existing_same_version
    FROM public.lease_recovery_policies
   WHERE org_id = p_org_id AND source_rule_id = p_rule_id AND source_rule_updated_at = v_rule.updated_at
   LIMIT 1;

  IF FOUND THEN
    v_already_materialized := true;
    v_policy := v_existing_same_version;
  ELSE
    -- The rule changed (or this is the first materialization). Supersede
    -- any prior ACTIVE policy for this rule before inserting the new one,
    -- so the EXCLUDE constraint on overlapping effective windows is
    -- satisfied and history is preserved (never deleted, only marked
    -- superseded).
    SELECT * INTO v_existing_prior_version
      FROM public.lease_recovery_policies
     WHERE org_id = p_org_id AND source_rule_id = p_rule_id AND status <> 'superseded'
     FOR UPDATE;

    IF FOUND THEN
      UPDATE public.lease_recovery_policies
         SET status = 'superseded',
             effective_to = (p_effective_from - INTERVAL '1 day')::date,
             updated_at = v_now
       WHERE id = v_existing_prior_version.id;
      v_superseded_prior_id := v_existing_prior_version.id;
    END IF;

    -- Policy type: a straightforward, non-ambiguous classification derived
    -- from existing rule fields (not a missing dollar amount/date/rate),
    -- so deriving it here does not violate "never silently infer a
    -- mandatory financial term."
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
      source_rule_updated_at, source_evidence, policy_type,
      effective_from, effective_to, status, superseded_by_policy_id,
      approved_by, approved_at, notes
    ) VALUES (
      p_org_id, v_rule.lease_id, p_lease_amendment_id, v_rule.rule_set_id, p_rule_id,
      v_rule.updated_at, v_source_evidence, v_policy_type,
      p_effective_from, p_effective_to, 'approved', NULL,
      v_rule.approved_by, v_rule.approved_at,
      CASE WHEN v_superseded_prior_id IS NOT NULL THEN format('Materialized after rule update; supersedes policy %s', v_superseded_prior_id) ELSE NULL END
    )
    RETURNING * INTO v_policy;

    IF v_superseded_prior_id IS NOT NULL THEN
      UPDATE public.lease_recovery_policies SET superseded_by_policy_id = v_policy.id WHERE id = v_superseded_prior_id;
    END IF;

    -- Ordered policy steps, mapped deterministically from the rule's own
    -- fields. See the Phase 2 report for the full field->step mapping
    -- table. Steps whose parameters are genuinely absent on the rule are
    -- still created (with those parameters null/omitted) rather than
    -- skipped or defaulted — Phase 2C's readiness engine is what surfaces
    -- a missing mandatory parameter as a blocking exception.
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
          jsonb_build_object(
            'recovery_method', v_rule.recovery_method,
            'allocation_basis', v_rule.allocation_basis,
            'tenant_share_percent', v_rule.tenant_share_percent
          )
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
      jsonb_build_object('source_rule_id', p_rule_id, 'superseded_policy_id', v_superseded_prior_id, 'step_count', v_sequence - 1),
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

REVOKE ALL ON FUNCTION public.materialize_lease_recovery_policy(UUID, UUID, DATE, UUID, TEXT, UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_lease_recovery_policy(UUID, UUID, DATE, UUID, TEXT, UUID, DATE) TO service_role;
