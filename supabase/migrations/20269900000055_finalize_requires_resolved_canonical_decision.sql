-- UAT Finding A fix: review_expense_classification's 'finalize' action trusted
-- the caller-supplied p_recovery_status as financial truth and never checked
-- that the classification had actually resolved to a real recovery decision.
-- Result: an unmatched classification (no linked rule, no policy coverage)
-- could be finalized as "recoverable" simply by editing the recovery-status
-- field before clicking Finalize. Reproduced against 7 real rows this UAT
-- (property-level Riverfront Commerce Center expenses, $121,950.25).
--
-- Fix: finalize now independently resolves the classification to one of the
-- six canonical financial decisions (Pooled CAM, Direct Recovery, Direct
-- Bill, Tenant Direct, Included in Rent, Nonrecoverable) from the linked
-- rule -- or, when no single rule is linked, from real approved/effective
-- pooled recovery-policy coverage for the canonical category on this
-- property (property-wide pooled CAM legitimately has no single lease_id/
-- rule). Unmatched / conditional / policy-conflict / needs-category / needs-
-- scope / needs-service-period / needs-tenant-lease classifications are
-- rejected outright, regardless of what p_recovery_status claims. Once
-- resolved, p_recovery_status must still agree with the resolved bucket
-- (e.g. a tenant-direct rule can never be finalized "recoverable") -- this is
-- the "do not trust caller-supplied recovery_status" half of the fix.
--
-- This reuses the exact same rule fields and precedence
-- deriveClassificationDecision()/deriveNormalizedContractModel() already use
-- client-side (src/components/lease-expense/utils/expenseClassificationUiContract.js,
-- src/services/utils/ruleDecisionEngine.js), reimplemented server-side so the
-- gate cannot be bypassed by the client. Only the 'finalize' branch of
-- review_expense_classification is touched below -- every other branch
-- (reopen/approve/reject/mark_na/resolve) and send_expense_classification_to_cam_workflow
-- are reproduced verbatim from 20269900000007_cam_publication_remainder_checks.sql,
-- unchanged. Signature is unchanged (still 9 params), so a plain
-- CREATE OR REPLACE is sufficient -- no DROP needed.

-- ---------------------------------------------------------------------------
-- 1. Resolver: classification -> one of the six canonical decisions, or a
--    reject_code identifying which review state blocks finalization.
--    STABLE, read-only, independently callable/testable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_classification_financial_decision(
  p_org_id UUID,
  p_classification_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_classification public.expense_classifications%ROWTYPE;
  v_rule public.lease_expense_rules%ROWTYPE;
  v_payment_treatment TEXT;
  v_recovery_method TEXT;
  v_bucket TEXT;
  v_pooled_policy_exists BOOLEAN := false;
BEGIN
  SELECT * INTO v_classification
    FROM public.expense_classifications
   WHERE id = p_classification_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('bucket', NULL, 'reject_code', 'not_found');
  END IF;

  -- Ordered rejection checks -- same precedence deriveClassificationDecision()
  -- uses client-side: policy conflict, missing category/scope/service period,
  -- then unresolved condition, all outrank any treatment-based bucket.
  IF lower(COALESCE(v_classification.exception_type, '')) = 'policy_conflict' THEN
    RETURN jsonb_build_object('bucket', NULL, 'reject_code', 'policy_conflict');
  END IF;
  IF v_classification.expense_category_id IS NULL THEN
    RETURN jsonb_build_object('bucket', NULL, 'reject_code', 'needs_category');
  END IF;
  IF v_classification.property_id IS NULL THEN
    RETURN jsonb_build_object('bucket', NULL, 'reject_code', 'needs_scope');
  END IF;
  IF v_classification.service_period_start IS NULL OR v_classification.service_period_end IS NULL THEN
    RETURN jsonb_build_object('bucket', NULL, 'reject_code', 'needs_service_period');
  END IF;
  IF lower(COALESCE(v_classification.recoverability_result, '')) = 'conditional' THEN
    RETURN jsonb_build_object('bucket', NULL, 'reject_code', 'conditional_review');
  END IF;

  IF v_classification.linked_expense_rule_id IS NOT NULL THEN
    SELECT * INTO v_rule
      FROM public.lease_expense_rules
     WHERE id = v_classification.linked_expense_rule_id
       AND COALESCE(org_id, p_org_id) = p_org_id
       AND lower(COALESCE(approval_status, '')) = 'approved';
    IF NOT FOUND THEN
      -- Linked rule is missing or not approved -- there is no resolved basis.
      RETURN jsonb_build_object('bucket', NULL, 'reject_code', 'unmatched');
    END IF;

    v_payment_treatment := lower(COALESCE(v_rule.payment_treatment, ''));
    v_recovery_method := lower(COALESCE(NULLIF(v_rule.recovery_method, ''), v_rule.billing_treatment, ''));

    IF COALESCE(v_rule.included_in_base_rent, false) IS TRUE OR v_payment_treatment = 'included_in_base_rent' THEN
      v_bucket := 'included_in_rent';
    ELSIF v_payment_treatment = 'tenant_direct_contract' OR COALESCE(v_rule.is_excluded, false) IS TRUE THEN
      v_bucket := 'tenant_direct';
    ELSIF v_recovery_method = 'direct_bill' THEN
      v_bucket := 'direct_bill';
    ELSIF v_recovery_method = 'direct_recovery' THEN
      IF v_classification.lease_id IS NULL AND v_classification.tenant_id IS NULL THEN
        RETURN jsonb_build_object('bucket', NULL, 'reject_code', 'needs_tenant_lease');
      END IF;
      v_bucket := 'direct_recovery';
    ELSIF lower(COALESCE(v_rule.recoverable_from_tenant, '')) IN ('no', 'non_recoverable', 'excluded') THEN
      v_bucket := 'nonrecoverable';
    ELSE
      v_bucket := 'pooled_cam';
    END IF;
  ELSE
    -- No single linked rule. The only legitimate path here is property-wide
    -- Pooled CAM, and only with real, approved, effective policy coverage --
    -- never guessed. Reuses the exact policy/step shape
    -- materialize_lease_recovery_policy() already writes
    -- (lease_recovery_policies + lease_recovery_policy_steps), scoped to
    -- leases on THIS classification's property.
    SELECT EXISTS (
      SELECT 1
        FROM public.lease_recovery_policies p
        JOIN public.lease_recovery_policy_steps s ON s.policy_id = p.id
        JOIN public.leases l ON l.id = p.lease_id AND l.org_id = p_org_id
        JOIN public.lease_expense_rules r ON r.id = p.source_rule_id AND r.org_id = p_org_id
       WHERE p.org_id = p_org_id
         AND l.property_id = v_classification.property_id
         AND p.status = 'approved'
         AND s.expense_category_id = v_classification.expense_category_id
         AND daterange(p.effective_from, p.effective_to, '[]')
             && daterange(v_classification.service_period_start, v_classification.service_period_end, '[]')
         AND COALESCE(r.included_in_base_rent, false) IS NOT TRUE
         AND lower(COALESCE(r.payment_treatment, '')) NOT IN ('included_in_base_rent', 'tenant_direct_contract')
         AND COALESCE(r.is_excluded, false) IS NOT TRUE
         AND lower(COALESCE(NULLIF(r.recovery_method, ''), r.billing_treatment, '')) NOT IN ('direct_bill', 'direct_recovery')
    ) INTO v_pooled_policy_exists;

    IF NOT v_pooled_policy_exists THEN
      RETURN jsonb_build_object('bucket', NULL, 'reject_code', 'unmatched');
    END IF;
    v_bucket := 'pooled_cam';
  END IF;

  RETURN jsonb_build_object('bucket', v_bucket, 'reject_code', NULL);
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_classification_financial_decision(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_classification_financial_decision(UUID, UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. review_expense_classification, verbatim from 20269900000007 except the
--    'finalize' branch, which gains the resolver gate as its first step.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.review_expense_classification(
  p_org_id uuid,
  p_classification_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_action text,
  p_recovery_status text DEFAULT NULL::text,
  p_approved_status text DEFAULT NULL::text,
  p_remainder_accepted boolean DEFAULT false,
  p_remainder_reason text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_action TEXT := lower(COALESCE(p_action, ''));
  v_recovery_status TEXT := lower(COALESCE(p_recovery_status, ''));
  v_approved_status TEXT := lower(COALESCE(p_approved_status, ''));
  v_classification public.expense_classifications%ROWTYPE;
  v_expense public.expenses%ROWTYPE;
  v_expense_id UUID;
  v_before JSONB;
  v_after public.expense_classifications%ROWTYPE;
  v_after_json JSONB;
  v_next_step TEXT;
  v_next_status TEXT;
  v_amount NUMERIC;
  v_recoverable_amount NUMERIC := 0;
  v_non_recoverable_amount NUMERIC := 0;
  v_conditional_amount NUMERIC := 0;
  v_excluded_amount NUMERIC := 0;
  v_audit_action TEXT;
  v_audit_log_id UUID;
  v_response JSONB;
  v_published public.cam_expense_inputs%ROWTYPE;
  v_scope_level TEXT;
  v_scope_id UUID;
  v_stale_result RECORD;
  v_withdraw_metadata JSONB := NULL;
  v_remainder NUMERIC;
  v_remainder_reason TEXT := NULLIF(trim(COALESCE(p_remainder_reason, '')), '');
  v_decision JSONB;
  v_bucket TEXT;
  v_allowed_recovery_statuses TEXT[];
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_classification_id IS NULL THEN
    RAISE EXCEPTION 'classification_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF v_action NOT IN ('finalize', 'reopen', 'approve', 'reject', 'mark_na', 'resolve') THEN
    RAISE EXCEPTION 'action must be one of finalize, reopen, approve, reject, mark_na, resolve';
  END IF;
  IF v_action IN ('finalize', 'approve') AND v_recovery_status NOT IN ('recoverable', 'non_recoverable', 'conditional', 'excluded') THEN
    RAISE EXCEPTION 'recovery_status must be one of recoverable, non_recoverable, conditional, excluded for %', v_action;
  END IF;
  IF v_action = 'approve' AND v_approved_status NOT IN ('approved', 'needs_review', 'rejected') THEN
    RAISE EXCEPTION 'approved_status must be one of approved, needs_review, rejected for approve';
  END IF;
  IF p_remainder_accepted IS TRUE AND v_remainder_reason IS NULL THEN
    RAISE EXCEPTION 'remainder_reason is required when remainder_accepted is true';
  END IF;

  SELECT * INTO v_classification
    FROM public.expense_classifications
   WHERE id = p_classification_id AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense classification not found for this organization';
  END IF;

  v_expense_id := COALESCE(v_classification.expense_id, v_classification.actual_expense_id);
  IF v_expense_id IS NULL THEN
    RAISE EXCEPTION 'Expense classification has no linked expense';
  END IF;

  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = v_expense_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Linked expense not found for this organization';
  END IF;

  v_before := to_jsonb(v_classification);
  v_amount := COALESCE(v_classification.amount, v_expense.amount, 0);

  IF v_action = 'finalize' THEN
    -- UAT Finding A gate: resolve the classification's own financial
    -- decision server-side instead of trusting p_recovery_status. Any
    -- unresolved review state (unmatched, conditional, policy conflict,
    -- missing category/scope/service period/tenant-lease) is rejected
    -- outright, regardless of what the caller passed.
    v_decision := public.resolve_classification_financial_decision(p_org_id, p_classification_id);
    v_bucket := v_decision ->> 'bucket';
    IF v_bucket IS NULL THEN
      RAISE EXCEPTION 'Cannot finalize: classification has not resolved to a canonical recovery decision (%)', COALESCE(v_decision ->> 'reject_code', 'unresolved');
    END IF;

    v_allowed_recovery_statuses := CASE v_bucket
      WHEN 'pooled_cam' THEN ARRAY['recoverable']
      WHEN 'direct_recovery' THEN ARRAY['recoverable']
      WHEN 'direct_bill' THEN ARRAY['recoverable']
      WHEN 'tenant_direct' THEN ARRAY['excluded', 'non_recoverable']
      WHEN 'included_in_rent' THEN ARRAY['excluded', 'non_recoverable']
      WHEN 'nonrecoverable' THEN ARRAY['excluded', 'non_recoverable']
      ELSE ARRAY[]::TEXT[]
    END;
    IF NOT (v_recovery_status = ANY(v_allowed_recovery_statuses)) THEN
      RAISE EXCEPTION 'Cannot finalize: recovery_status "%" is inconsistent with the resolved % decision (expected one of: %)', v_recovery_status, v_bucket, array_to_string(v_allowed_recovery_statuses, ', ');
    END IF;

    -- "allocated amount total must not exceed the approved expense amount"
    IF v_amount > COALESCE(v_expense.amount, v_amount) THEN
      RAISE EXCEPTION 'Cannot finalize: classification amount (%) exceeds the approved expense amount (%)', v_amount, v_expense.amount;
    END IF;

    -- "unresolved remainder exists without an accepted exception" blocks finalize.
    v_remainder := GREATEST(COALESCE(v_expense.amount, v_amount) - v_amount, 0);
    IF v_remainder > 0 AND NOT COALESCE(p_remainder_accepted, false) THEN
      RAISE EXCEPTION 'Cannot finalize: % of the expense amount is unallocated (classification amount % of expense amount %) — pass remainder_accepted with a reason, or allocate the full amount', v_remainder, v_amount, v_expense.amount;
    END IF;

    v_recoverable_amount := CASE WHEN v_recovery_status = 'recoverable' THEN v_amount ELSE 0 END;
    v_non_recoverable_amount := CASE WHEN v_recovery_status = 'non_recoverable' THEN v_amount ELSE 0 END;
    v_conditional_amount := CASE WHEN v_recovery_status = 'conditional' THEN v_amount ELSE 0 END;
    v_excluded_amount := CASE WHEN v_recovery_status = 'excluded' THEN v_amount ELSE 0 END;
    v_next_step := CASE
      WHEN lower(COALESCE(v_classification.cam_eligible, '')) = 'yes' AND v_recovery_status = 'recoverable' THEN 'Send to CAM'
      ELSE 'Ready for projection'
    END;

    UPDATE public.expenses
       SET classification_updated_at = v_now,
           classification_updated_by = p_actor_user_id,
           recovery_status = v_recovery_status,
           recoverability_result = v_recovery_status,
           classification = v_recovery_status
     WHERE id = v_expense_id AND org_id = p_org_id;

    UPDATE public.expense_classifications
       SET recoverability_result = v_recovery_status,
           recovery_status = v_recovery_status,
           approved_status = 'approved',
           classification_status = 'finalized',
           exception_type = NULL,
           reviewed_at = v_now,
           reviewed_by = p_actor_user_id,
           approved_at = v_now,
           approved_by = p_actor_user_id,
           finalized_at = v_now,
           recoverable_amount = v_recoverable_amount,
           non_recoverable_amount = v_non_recoverable_amount,
           conditional_amount = v_conditional_amount,
           excluded_amount = v_excluded_amount,
           remainder_accepted = COALESCE(p_remainder_accepted, false),
           remainder_reason = v_remainder_reason,
           next_step = v_next_step
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_finalized';
  ELSIF v_action = 'reopen' THEN
    -- Cascade: if this classification currently has an ACTIVE published CAM
    -- input, withdraw it first (same effect as withdraw_cam_expense_input)
    -- so reopening never leaves a stale published input pointing at a
    -- classification that's back in draft/review. Inlined rather than
    -- calling withdraw_cam_expense_input directly so a missing published
    -- row (the common case: most reopens happen before anything was ever
    -- published) is a silent no-op here, not an error.
    SELECT * INTO v_published
      FROM public.cam_expense_inputs
     WHERE classification_result_id = p_classification_id
       AND publication_status = 'published'
     FOR UPDATE;

    IF FOUND THEN
      UPDATE public.cam_expense_inputs
         SET publication_status = 'withdrawn',
             withdrawn_by = p_actor_user_id,
             withdrawn_at = v_now,
             withdrawal_reason = 'Classification reopened for review',
             updated_at = v_now
       WHERE id = v_published.id;

      v_scope_id := COALESCE(v_published.unit_id, v_published.building_id, v_published.property_id);
      v_scope_level := CASE
        WHEN v_published.unit_id IS NOT NULL THEN 'unit'
        WHEN v_published.building_id IS NOT NULL THEN 'building'
        WHEN v_published.property_id IS NOT NULL THEN 'property'
        ELSE NULL
      END;

      IF v_published.fiscal_year IS NOT NULL AND v_scope_level IS NOT NULL THEN
        SELECT * INTO v_stale_result
          FROM public.mark_cam_snapshots_stale(p_org_id, v_published.property_id, v_scope_level, v_scope_id, v_published.fiscal_year,
            format('Classification %s reopened after CAM publication', p_classification_id));
      END IF;

      v_withdraw_metadata := jsonb_build_object(
        'withdrawn_cam_input_id', v_published.id,
        'stale_snapshot_count', COALESCE(v_stale_result.stale_count, 0),
        'restatement_required_snapshot_count', COALESCE(v_stale_result.restatement_count, 0)
      );
    END IF;

    UPDATE public.expense_classifications
       SET classification_status = 'matched',
           finalized_at = NULL,
           cam_status = NULL,
           sent_to_cam = false,
           sent_to_cam_at = NULL,
           sent_to_cam_by = NULL,
           next_step = 'Finalize row'
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_reopened';
  ELSIF v_action = 'approve' THEN
    v_next_status := CASE
      WHEN v_approved_status = 'approved' THEN
        CASE WHEN v_recovery_status IN ('recoverable', 'non_recoverable', 'excluded') THEN 'finalized' ELSE 'conditional' END
      ELSE
        CASE
          WHEN v_recovery_status = 'conditional' THEN 'conditional'
          WHEN v_recovery_status IN ('non_recoverable', 'excluded') THEN 'excluded'
          ELSE 'matched'
        END
    END;
    v_recoverable_amount := CASE WHEN v_recovery_status = 'recoverable' THEN v_amount ELSE 0 END;
    v_non_recoverable_amount := CASE WHEN v_recovery_status = 'non_recoverable' THEN v_amount ELSE 0 END;
    v_conditional_amount := CASE WHEN v_recovery_status = 'conditional' THEN v_amount ELSE 0 END;
    v_excluded_amount := CASE WHEN v_recovery_status = 'excluded' THEN v_amount ELSE 0 END;

    UPDATE public.expense_classifications
       SET recoverability_result = v_recovery_status,
           recovery_status = v_recovery_status,
           approved_status = p_approved_status,
           classification_status = v_next_status,
           exception_type = CASE WHEN v_next_status IN ('finalized', 'excluded') THEN NULL ELSE exception_type END,
           reviewed_at = v_now,
           finalized_at = CASE WHEN v_next_status IN ('finalized', 'excluded') THEN v_now ELSE NULL END,
           recoverable_amount = v_recoverable_amount,
           non_recoverable_amount = v_non_recoverable_amount,
           conditional_amount = v_conditional_amount,
           excluded_amount = v_excluded_amount,
           next_step = CASE WHEN v_next_status IN ('finalized', 'excluded') THEN 'Ready for projection' ELSE 'Finalize row' END
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_approved';
  ELSIF v_action = 'reject' THEN
    UPDATE public.expense_classifications
       SET classification_status = 'excluded',
           recoverability_result = 'excluded',
           recovery_status = 'excluded',
           exception_type = NULL,
           recoverable_amount = 0,
           non_recoverable_amount = 0,
           conditional_amount = 0,
           excluded_amount = v_amount,
           next_step = 'Ready for projection'
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_rejected';
  ELSIF v_action = 'mark_na' THEN
    UPDATE public.expense_classifications
       SET classification_status = 'excluded',
           recoverability_result = 'non_recoverable',
           recovery_status = 'non_recoverable',
           exception_type = NULL,
           recoverable_amount = 0,
           non_recoverable_amount = v_amount,
           conditional_amount = 0,
           excluded_amount = 0,
           next_step = 'Ready for projection'
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_marked_na';
  ELSE -- resolve
    UPDATE public.expense_classifications
       SET classification_status = 'matched',
           exception_type = NULL,
           next_step = 'Finalize row'
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_resolved';
  END IF;

  v_after_json := to_jsonb(v_after);

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id,
    v_after.property_id,
    'ExpenseClassification',
    v_after.id::TEXT,
    v_audit_action,
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    v_before,
    v_after_json,
    COALESCE(v_withdraw_metadata, '{}'::jsonb) || jsonb_build_object('expense_id', v_expense_id, 'action', v_action),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object('row', v_after_json, 'audit_log_id', v_audit_log_id) || COALESCE(v_withdraw_metadata, '{}'::jsonb);
  RETURN v_response;
END;
$function$;

-- Signature is unchanged from 20269900000007, so grants were never reset by
-- a DROP here -- reissued anyway, matching that migration's own defense-in-
-- depth practice, so this lockdown is never silently dependent on grants
-- surviving an unrelated future CREATE OR REPLACE.
REVOKE ALL ON FUNCTION public.review_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.review_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT
) TO service_role;

NOTIFY pgrst, 'reload schema';
