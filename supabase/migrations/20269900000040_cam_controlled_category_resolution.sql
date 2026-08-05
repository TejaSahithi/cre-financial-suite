-- ===========================================================================
-- CAM Enhancement and Budget Readiness Specification v2.0 — controlled
-- ambiguity resolution (deployment gate step D) and staleness propagation
-- (step E / specification section 24).
--
-- Migration 039 deliberately leaves expense_category_id NULL whenever a text
-- label does not resolve to exactly one canonical category ('Insurance'
-- matches both insurance_property and insurance_liability). Specification 27
-- forbids auto-mapping those. This migration supplies the ONLY sanctioned way
-- to close them: an explicit human decision carrying a selected category,
-- reason, actor, and evidence.
--
-- There is deliberately no "pick the first textual match" path anywhere here.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Candidate enumeration.
--
-- resolve_expense_category_id() (migration 039) reports HOW MANY candidates a
-- label has but not WHICH, because it must return a single answer or none.
-- Review needs the actual candidate set, so this returns the candidate ids at
-- the first precedence level that matches at all — the exact set that made the
-- label ambiguous. Precedence order is identical to 039's; keep them in sync.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_expense_category_candidates(
  p_org_id UUID,
  p_category TEXT
)
RETURNS UUID[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_text TEXT := NULLIF(btrim(COALESCE(p_category, '')), '');
  v_ids UUID[];
  v_rule RECORD;
BEGIN
  IF v_text IS NULL THEN
    RETURN ARRAY[]::UUID[];
  END IF;

  FOR v_rule IN
    SELECT * FROM (VALUES
      ('org_category_name',      1, 'category_name'),
      ('system_category_name',   2, 'category_name'),
      ('org_normalized_key',     1, 'normalized_key'),
      ('system_normalized_key',  2, 'normalized_key'),
      ('org_subcategory_name',   1, 'subcategory_name'),
      ('system_subcategory_name',2, 'subcategory_name')
    ) AS t(method, scope, field)
  LOOP
    SELECT array_agg(c.id ORDER BY c.display_order, c.id)
      INTO v_ids
      FROM public.expense_categories c
     WHERE c.is_active IS NOT FALSE
       AND ((v_rule.scope = 1 AND c.org_id = p_org_id)
         OR (v_rule.scope = 2 AND c.org_id IS NULL))
       AND lower(btrim(
             CASE v_rule.field
               WHEN 'category_name'    THEN c.category_name
               WHEN 'normalized_key'   THEN c.normalized_key
               ELSE c.subcategory_name
             END)) = lower(v_text);

    IF v_ids IS NOT NULL AND array_length(v_ids, 1) >= 1 THEN
      RETURN v_ids;
    END IF;
  END LOOP;

  RETURN ARRAY[]::UUID[];
END;
$function$;

REVOKE ALL ON FUNCTION public.list_expense_category_candidates(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_expense_category_candidates(UUID, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Review payload (specification step D).
--
-- For every unresolved published input, return the full business context a
-- reviewer needs to make a defensible choice: the source expense and its
-- vendor/description/invoice, the classification it came from, the full
-- property/building/unit/lease scope, every candidate category, and — the
-- part that actually disambiguates in practice — whether each candidate is
-- referenced by an approved policy step or an existing pool in this scope.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_cam_input_category_candidates(
  p_org_id UUID,
  p_property_id UUID DEFAULT NULL,
  p_recovery_period_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row RECORD;
  v_items JSONB := '[]'::jsonb;
  v_candidates JSONB;
  v_ids UUID[];
  v_resolved JSONB;
  v_period_start DATE;
  v_period_end DATE;
  v_total NUMERIC := 0;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;

  IF p_recovery_period_id IS NOT NULL THEN
    SELECT start_date, end_date INTO v_period_start, v_period_end
      FROM public.recovery_periods WHERE id = p_recovery_period_id AND org_id = p_org_id;
  END IF;

  FOR v_row IN
    SELECT ei.*,
           e.vendor_name, e.vendor, e.description, e.invoice_number,
           e.amount AS source_amount,
           ec.category AS classification_category,
           ec.cam_eligible, ec.recoverability_result, ec.classification_status,
           p.name AS property_name, b.name AS building_name, u.unit_number
      FROM public.cam_expense_inputs ei
      LEFT JOIN public.expenses e ON e.id = ei.actual_expense_id
      LEFT JOIN public.expense_classifications ec ON ec.id = ei.classification_result_id
      LEFT JOIN public.properties p ON p.id = ei.property_id
      LEFT JOIN public.buildings b ON b.id = ei.building_id
      LEFT JOIN public.units u ON u.id = ei.unit_id
     WHERE ei.org_id = p_org_id
       AND ei.expense_category_id IS NULL
       AND ei.publication_status = 'published'
       AND COALESCE(ei.amount, 0) <> 0
       AND (p_property_id IS NULL OR ei.property_id = p_property_id)
       -- Period scoping mirrors the preparer: explicit service period wins,
       -- fiscal_year is the coarse fallback, and an input carrying neither is
       -- excluded rather than guessed into the period.
       AND (
         p_recovery_period_id IS NULL
         OR (ei.service_period_start IS NOT NULL AND ei.service_period_end IS NOT NULL
             AND ei.service_period_start <= v_period_end AND ei.service_period_end >= v_period_start)
         OR (ei.service_period_start IS NULL AND ei.fiscal_year IS NOT NULL
             AND ei.fiscal_year = EXTRACT(YEAR FROM v_period_start)::INT)
       )
     ORDER BY ei.amount DESC NULLS LAST
  LOOP
    v_ids := public.list_expense_category_candidates(v_row.org_id, v_row.category);
    v_resolved := public.resolve_expense_category_id(v_row.org_id, v_row.category);
    v_total := v_total + COALESCE(v_row.amount, 0);

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'expense_category_id', c.id,
             'category_name', c.category_name,
             'subcategory_name', c.subcategory_name,
             'normalized_key', c.normalized_key,
             'is_system_default', c.is_system_default,
             -- Disambiguation signal: a candidate actually referenced by an
             -- approved policy step or an existing pool in this scope is far
             -- more likely correct than one referenced by neither. This is
             -- shown to the reviewer, never auto-applied.
             'referenced_by_policy_steps', (
               SELECT COUNT(*) FROM public.lease_recovery_policy_steps s
                WHERE s.org_id = p_org_id AND s.expense_category_id = c.id),
             'referenced_by_pool_categories', (
               SELECT COUNT(*) FROM public.recovery_pool_categories rpc2
                JOIN public.recovery_pools rp ON rp.id = rpc2.pool_id
                WHERE rpc2.org_id = p_org_id AND rpc2.expense_category_id = c.id
                  AND (p_property_id IS NULL OR rp.property_id = p_property_id)
                  AND (p_recovery_period_id IS NULL OR rp.period_id = p_recovery_period_id))
           ) ORDER BY c.display_order), '[]'::jsonb)
      INTO v_candidates
      FROM public.expense_categories c
     WHERE c.id = ANY(v_ids);

    v_items := v_items || jsonb_build_object(
      'cam_expense_input_id', v_row.id,
      'amount', v_row.amount,
      'category_label', v_row.category,
      'unresolved_reason', v_resolved ->> 'unresolved_reason',
      'source_expense', jsonb_build_object(
        'actual_expense_id', v_row.actual_expense_id,
        'vendor', COALESCE(v_row.vendor_name, v_row.vendor),
        'description', v_row.description,
        'invoice_number', v_row.invoice_number,
        'source_amount', v_row.source_amount),
      'classification', jsonb_build_object(
        'classification_result_id', v_row.classification_result_id,
        'category', v_row.classification_category,
        'cam_eligible', v_row.cam_eligible,
        'recoverability_result', v_row.recoverability_result,
        'classification_status', v_row.classification_status),
      'scope', jsonb_build_object(
        'property_id', v_row.property_id, 'property_name', v_row.property_name,
        'building_id', v_row.building_id, 'building_name', v_row.building_name,
        'unit_id', v_row.unit_id, 'unit_number', v_row.unit_number,
        'lease_id', v_row.lease_id),
      'service_period', jsonb_build_object(
        'start', v_row.service_period_start, 'end', v_row.service_period_end,
        'fiscal_year', v_row.fiscal_year),
      'candidates', v_candidates,
      'candidate_count', COALESCE(jsonb_array_length(v_candidates), 0)
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'org_id', p_org_id,
    'property_id', p_property_id,
    'recovery_period_id', p_recovery_period_id,
    'unresolved_count', jsonb_array_length(v_items),
    'unresolved_amount', v_total,
    'items', v_items
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_cam_input_category_candidates(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_cam_input_category_candidates(UUID, UUID, UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Staleness fields on cam_runs (specification 24 / step E).
--
-- computation_snapshots already carries stale/stale_reason and the rule that
-- a locked snapshot is flagged restatement_required rather than mutated. The
-- V2 cam_runs ledger had no equivalent, so a corrected source input could not
-- invalidate a draft run. Mirrors that proven pattern rather than inventing a
-- second staleness model.
-- ---------------------------------------------------------------------------
ALTER TABLE public.cam_runs
  ADD COLUMN IF NOT EXISTS stale BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stale_reason TEXT,
  ADD COLUMN IF NOT EXISTS stale_at TIMESTAMPTZ;

COMMENT ON COLUMN public.cam_runs.stale IS
  'Set when an authoritative source this run consumed changed after the run '
  'was calculated. Only ever set on runs that are NOT approved/posted. An '
  'approved or posted run is immutable and is never written to at all: the '
  'enforce_cam_run_immutability trigger rejects any such UPDATE, and affected '
  'posted runs are REPORTED (in the RPC response and the audit record) so a '
  'deliberate restatement run can be opened instead.';

-- ---------------------------------------------------------------------------
-- 4. Controlled resolution (specification step D + E).
--
-- Requires a user-selected category, a reason, an actor, and evidence. The
-- selected category MUST be one of the enumerated candidates, so a caller
-- cannot smuggle in an arbitrary or first-alphabetical category.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_cam_input_category(
  p_org_id UUID,
  p_cam_expense_input_id UUID,
  p_expense_category_id UUID,
  p_reason TEXT,
  p_evidence JSONB,
  p_actor_user_id UUID,
  p_actor_email TEXT DEFAULT NULL,
  p_allow_non_candidate BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_input public.cam_expense_inputs%ROWTYPE;
  v_candidates UUID[];
  v_category public.expense_categories%ROWTYPE;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_stale_runs INT := 0;
  v_restate_runs INT := 0;
  v_affected_posted_runs UUID[] := ARRAY[]::UUID[];
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_cam_expense_input_id IS NULL THEN RAISE EXCEPTION 'cam_expense_input_id is required'; END IF;
  IF p_expense_category_id IS NULL THEN RAISE EXCEPTION 'A canonical expense_category_id must be selected explicitly; there is no automatic fallback for an ambiguous category'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'A business reason is required to resolve an ambiguous category'; END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'actor_user_id is required'; END IF;
  IF p_evidence IS NULL OR p_evidence = '{}'::jsonb OR p_evidence = 'null'::jsonb THEN
    RAISE EXCEPTION 'Evidence is required to resolve an ambiguous category (specification 19.3)';
  END IF;

  SELECT * INTO v_input FROM public.cam_expense_inputs
   WHERE id = p_cam_expense_input_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CAM expense input not found for this organization'; END IF;

  IF v_input.expense_category_id IS NOT NULL THEN
    RAISE EXCEPTION 'CAM expense input % already has canonical category %; use a supersession workflow to change an already-resolved category',
      v_input.id, v_input.expense_category_id;
  END IF;

  SELECT * INTO v_category FROM public.expense_categories
   WHERE id = p_expense_category_id AND (org_id = p_org_id OR org_id IS NULL);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected expense category % does not exist or belongs to another organization', p_expense_category_id;
  END IF;

  -- The selection must come from the enumerated candidate set unless the
  -- caller explicitly and auditably overrides that (e.g. the correct category
  -- was never a textual match at all). Never silently accept an off-list pick.
  v_candidates := public.list_expense_category_candidates(p_org_id, v_input.category);
  IF NOT (p_expense_category_id = ANY(v_candidates)) AND NOT p_allow_non_candidate THEN
    RAISE EXCEPTION 'Selected category % is not among the candidates for label %; pass p_allow_non_candidate := true with a reason to record a deliberate off-list correction',
      p_expense_category_id, COALESCE(v_input.category, '(none)');
  END IF;

  UPDATE public.cam_expense_inputs
     SET expense_category_id = p_expense_category_id,
         updated_at = now()
   WHERE id = v_input.id;

  -- Staleness: draft//calculated runs that consumed this input are invalidated;
  -- approved and posted runs are NEVER mutated, only flagged for restatement.
  UPDATE public.cam_runs r
     SET stale = true, stale_reason = 'CAM input category resolved: ' || v_reason, stale_at = now()
   WHERE r.org_id = p_org_id
     AND r.status NOT IN ('approved', 'posted', 'superseded', 'voided')
     AND EXISTS (
       SELECT 1 FROM public.cam_input_pool_assignments a
        JOIN public.recovery_pools rp ON rp.id = a.recovery_pool_id
       WHERE a.cam_expense_input_id = v_input.id AND rp.period_id = r.recovery_period_id);
  GET DIAGNOSTICS v_stale_runs = ROW_COUNT;

  -- Approved/posted runs are IMMUTABLE and are deliberately NOT written to,
  -- not even to flag them: public.enforce_cam_run_immutability rejects any
  -- UPDATE to a posted run outright, and the specification's own rule is
  -- "never mutate approved or posted run snapshots". They are counted and
  -- returned instead, so the operator can open an explicit restatement run.
  SELECT COALESCE(array_agg(r.id), ARRAY[]::UUID[])
    INTO v_affected_posted_runs
    FROM public.cam_runs r
   WHERE r.org_id = p_org_id
     AND r.status IN ('approved', 'posted')
     AND EXISTS (
       SELECT 1 FROM public.cam_input_pool_assignments a
        JOIN public.recovery_pools rp ON rp.id = a.recovery_pool_id
       WHERE a.cam_expense_input_id = v_input.id AND rp.period_id = r.recovery_period_id);
  v_restate_runs := COALESCE(array_length(v_affected_posted_runs, 1), 0);

  -- audit_logs.source is constrained to frontend/edge_function/webhook/system,
  -- so the decision record lives in the before/after/metadata jsonb columns.
  INSERT INTO public.audit_logs (
    org_id, entity_type, entity_id, action, field_changed,
    old_value, new_value, actor_user_id, actor_email, property_id, severity, source,
    before, after, metadata
  ) VALUES (
    p_org_id, 'cam_expense_inputs', v_input.id::TEXT, 'resolve_category', 'expense_category_id',
    NULL, p_expense_category_id::TEXT, p_actor_user_id, p_actor_email, v_input.property_id, 'info', 'system',
    jsonb_build_object('expense_category_id', NULL, 'category_label', v_input.category),
    jsonb_build_object('expense_category_id', p_expense_category_id,
                       'category_name', v_category.category_name,
                       'subcategory_name', v_category.subcategory_name),
    jsonb_build_object(
      'reason', v_reason,
      'evidence', p_evidence,
      'candidates', to_jsonb(v_candidates),
      'off_list_override', p_expense_category_id <> ALL(v_candidates),
      'draft_runs_marked_stale', v_stale_runs,
      'posted_runs_requiring_restatement', to_jsonb(v_affected_posted_runs)
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'cam_expense_input_id', v_input.id,
    'category_label', v_input.category,
    'resolved_expense_category_id', p_expense_category_id,
    'resolved_category_name', v_category.category_name,
    'resolved_subcategory_name', v_category.subcategory_name,
    'reason', v_reason,
    'actor_user_id', p_actor_user_id,
    'off_list_override', p_expense_category_id <> ALL(v_candidates),
    'draft_runs_marked_stale', v_stale_runs,
    'posted_runs_requiring_restatement', v_restate_runs,
    'posted_run_ids_requiring_restatement', to_jsonb(v_affected_posted_runs),
    'resolved_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_cam_input_category(UUID, UUID, UUID, TEXT, JSONB, UUID, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_cam_input_category(UUID, UUID, UUID, TEXT, JSONB, UUID, TEXT, BOOLEAN) TO service_role;
