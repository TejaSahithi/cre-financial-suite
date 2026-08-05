-- ===========================================================================
-- CAM Enhancement and Budget Readiness Specification v2.0 — section 8.3
-- ("Mandatory enhancement": canonical expense_category_id on cam_expense_inputs)
-- and section 27 (dry-run/apply remediation for published CAM inputs missing a
-- canonical category ID).
--
-- ROOT CAUSE THIS MIGRATION CLOSES
-- --------------------------------
-- cam_expense_inputs stores only `category TEXT` (a human label such as
-- 'Insurance'), while every downstream CAM structure keys categories by the
-- canonical UUID public.expense_categories(id):
--
--   * recovery_pool_categories.expense_category_id   UUID
--   * lease_recovery_policy_steps.expense_category_id UUID
--
-- The engine and the setup preparer nevertheless compare those UUIDs directly
-- against the TEXT label:
--
--   pools/pool-builder.ts (applyCategoryInclusionExclusion)
--     categories.find((c) => c.expense_category_id === amount.category ...)
--   setup/prepare-cam-automatically.ts
--     poolsByCategoryId.get(exp.category)
--
-- A UUID never equals 'Insurance', so in production:
--   * an explicit EXCLUDE category rule never matches and therefore never
--     excludes -- and, because a pool that has any include rule treats a
--     non-matching amount as excluded, every expense in a normally-configured
--     pool falls through to `excluded`, driving the pool to 0.00 and the
--     tenant recovery to zero;
--   * expense-to-pool assignment suggestions never match, producing the empty
--     CAM Setup this specification's section 2 describes.
--
-- The existing unit tests pass only because their fixtures use symbolic
-- strings (expense_category_id: "utilities" against category: "utilities"),
-- so the UUID/label mismatch cannot surface synthetically -- the same class of
-- gap 20269900000020's own header describes.
--
-- DESIGN
-- ------
-- * `category` TEXT is preserved unchanged as the frozen display/audit
--   snapshot (specification section 8.3: "Keep the text label only for
--   display/audit snapshots").
-- * `expense_category_id` is NULLABLE on purpose. Resolution is exact and
--   deterministic; when a label cannot be resolved to exactly one category the
--   column stays NULL and the row surfaces through the existing
--   EXPENSE_CATEGORY_MISSING readiness exception. That is fail-closed by
--   design -- specification section 1 rule 5 ("Do not silently invent ...
--   category mappings") and section 27 ("Do not auto-map ambiguous
--   categories"). 'Insurance' resolves to two seeded rows
--   (insurance_property, insurance_liability) and therefore deliberately does
--   NOT auto-map.
-- * Population happens in a BEFORE INSERT OR UPDATE trigger rather than inside
--   one publication RPC because five separate migrations insert into
--   cam_expense_inputs; a single table-level enforcement point covers every
--   writer without forking the publication model (section 1 rule 4).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Canonical category column
-- ---------------------------------------------------------------------------
ALTER TABLE public.cam_expense_inputs
  ADD COLUMN IF NOT EXISTS expense_category_id UUID
    REFERENCES public.expense_categories(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.cam_expense_inputs.expense_category_id IS
  'Canonical expense category (specification 8.3). Authoritative for pool '
  'category matching and expense-to-pool assignment. NULL means the source '
  'label could not be resolved to exactly one category; the row then blocks '
  'via EXPENSE_CATEGORY_MISSING rather than being guessed.';

COMMENT ON COLUMN public.cam_expense_inputs.category IS
  'Frozen human-readable category label for display/audit only (specification '
  '8.3). Never use for category matching -- use expense_category_id.';

CREATE INDEX IF NOT EXISTS idx_cam_expense_inputs_expense_category
  ON public.cam_expense_inputs(org_id, property_id, expense_category_id);

-- ---------------------------------------------------------------------------
-- 2. Deterministic, unambiguous-only text -> canonical category resolver
--
-- Returns jsonb so that the trigger and the remediation RPC share one
-- implementation and one set of reason codes (no second mapping model).
--   { "expense_category_id": uuid|null,
--     "method": text|null,
--     "confidence": "exact"|null,
--     "candidate_count": int,
--     "unresolved_reason": text|null }
--
-- Every rule is an EXACT (trimmed, case-insensitive) comparison that must
-- match exactly one row. There is deliberately no fuzzy/similarity matching
-- (specification section 16: "Do not use fuzzy text matching as the
-- authoritative assignment").
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_expense_category_id(
  p_org_id UUID,
  p_category TEXT
)
RETURNS JSONB
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
    RETURN jsonb_build_object(
      'expense_category_id', NULL, 'method', NULL, 'confidence', NULL,
      'candidate_count', 0, 'unresolved_reason', 'CATEGORY_TEXT_EMPTY');
  END IF;

  -- Ordered exact-match rules. Organization-owned categories always win over
  -- system defaults so an org that renamed//forked a category controls its own
  -- mapping.
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
    SELECT array_agg(c.id)
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

    IF v_ids IS NOT NULL AND array_length(v_ids, 1) = 1 THEN
      RETURN jsonb_build_object(
        'expense_category_id', v_ids[1], 'method', v_rule.method,
        'confidence', 'exact', 'candidate_count', 1, 'unresolved_reason', NULL);
    ELSIF v_ids IS NOT NULL AND array_length(v_ids, 1) > 1 THEN
      -- Ambiguous at this precedence level: stop and report rather than
      -- silently picking one (specification section 27).
      RETURN jsonb_build_object(
        'expense_category_id', NULL, 'method', v_rule.method,
        'confidence', NULL, 'candidate_count', array_length(v_ids, 1),
        'unresolved_reason', 'CATEGORY_AMBIGUOUS');
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'expense_category_id', NULL, 'method', NULL, 'confidence', NULL,
    'candidate_count', 0, 'unresolved_reason', 'CATEGORY_NOT_FOUND');
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_expense_category_id(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_expense_category_id(UUID, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Population trigger (covers every writer of cam_expense_inputs)
--
-- Precedence:
--   1. An explicitly supplied expense_category_id is never overwritten.
--   2. The linked approved lease_expense_rule's canonical category -- this is
--      contractual truth already carrying a UUID, so it is preferred over any
--      text derivation.
--   3. Exact unambiguous resolution of the frozen label.
--   4. NULL -> EXPENSE_CATEGORY_MISSING readiness blocker.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cam_expense_inputs_set_canonical_category()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_resolved JSONB;
  v_rule_category UUID;
BEGIN
  IF NEW.expense_category_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.lease_expense_rule_id IS NOT NULL THEN
    SELECT r.expense_category_id
      INTO v_rule_category
      FROM public.lease_expense_rules r
     WHERE r.id = NEW.lease_expense_rule_id;

    IF v_rule_category IS NOT NULL THEN
      NEW.expense_category_id := v_rule_category;
      RETURN NEW;
    END IF;
  END IF;

  v_resolved := public.resolve_expense_category_id(NEW.org_id, NEW.category);
  IF (v_resolved ->> 'expense_category_id') IS NOT NULL THEN
    NEW.expense_category_id := (v_resolved ->> 'expense_category_id')::UUID;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_cam_expense_inputs_canonical_category ON public.cam_expense_inputs;
CREATE TRIGGER trg_cam_expense_inputs_canonical_category
  BEFORE INSERT OR UPDATE OF category, lease_expense_rule_id, expense_category_id
  ON public.cam_expense_inputs
  FOR EACH ROW
  EXECUTE FUNCTION public.cam_expense_inputs_set_canonical_category();

-- ---------------------------------------------------------------------------
-- 4. Remediation for already-published rows (specification section 27)
--
-- Dry-run by default. Reports organization/property, source ID, old value,
-- proposed value, derivation method, confidence, and unresolved reason, and
-- never auto-maps an ambiguous label.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remediate_cam_input_category_ids(
  p_org_id UUID,
  p_dry_run BOOLEAN DEFAULT true,
  p_property_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row RECORD;
  v_resolved JSONB;
  v_proposed UUID;
  v_rule_category UUID;
  v_method TEXT;
  v_results JSONB := '[]'::jsonb;
  v_resolvable INT := 0;
  v_unresolved INT := 0;
  v_applied INT := 0;
  v_total INT := 0;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;

  FOR v_row IN
    SELECT ei.id, ei.org_id, ei.property_id, ei.category, ei.amount,
           ei.lease_expense_rule_id, ei.publication_status
      FROM public.cam_expense_inputs ei
     WHERE ei.org_id = p_org_id
       AND ei.expense_category_id IS NULL
       AND (p_property_id IS NULL OR ei.property_id = p_property_id)
     ORDER BY ei.created_at
  LOOP
    v_total := v_total + 1;
    v_proposed := NULL;
    v_method := NULL;
    v_resolved := NULL;
    v_rule_category := NULL;

    IF v_row.lease_expense_rule_id IS NOT NULL THEN
      SELECT r.expense_category_id INTO v_rule_category
        FROM public.lease_expense_rules r
       WHERE r.id = v_row.lease_expense_rule_id;
      IF v_rule_category IS NOT NULL THEN
        v_proposed := v_rule_category;
        v_method := 'lease_expense_rule';
      END IF;
    END IF;

    IF v_proposed IS NULL THEN
      v_resolved := public.resolve_expense_category_id(v_row.org_id, v_row.category);
      IF (v_resolved ->> 'expense_category_id') IS NOT NULL THEN
        v_proposed := (v_resolved ->> 'expense_category_id')::UUID;
        v_method := v_resolved ->> 'method';
      END IF;
    END IF;

    IF v_proposed IS NOT NULL THEN
      v_resolvable := v_resolvable + 1;
      IF NOT p_dry_run THEN
        UPDATE public.cam_expense_inputs
           SET expense_category_id = v_proposed,
               updated_at = now()
         WHERE id = v_row.id;
        v_applied := v_applied + 1;
      END IF;
    ELSE
      v_unresolved := v_unresolved + 1;
    END IF;

    v_results := v_results || jsonb_build_object(
      'org_id', v_row.org_id,
      'property_id', v_row.property_id,
      'source_id', v_row.id,
      'publication_status', v_row.publication_status,
      'amount', v_row.amount,
      'old_value', NULL,
      'old_label', v_row.category,
      'proposed_value', v_proposed,
      'method', v_method,
      'confidence', CASE WHEN v_proposed IS NOT NULL THEN 'exact' ELSE NULL END,
      'applied', (v_proposed IS NOT NULL AND NOT p_dry_run),
      'unresolved_reason', CASE
        WHEN v_proposed IS NOT NULL THEN NULL
        ELSE COALESCE(v_resolved ->> 'unresolved_reason', 'CATEGORY_NOT_FOUND')
      END
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'dry_run', p_dry_run,
    'org_id', p_org_id,
    'property_id', p_property_id,
    'counts', jsonb_build_object(
      'inspected', v_total,
      'resolvable', v_resolvable,
      'unresolved', v_unresolved,
      'applied', v_applied
    ),
    'rows', v_results,
    'applied_by', auth.uid(),
    'applied_at', CASE WHEN p_dry_run THEN NULL ELSE now() END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.remediate_cam_input_category_ids(UUID, BOOLEAN, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remediate_cam_input_category_ids(UUID, BOOLEAN, UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Backfill existing rows using the same unambiguous resolver.
--
-- This is an in-migration apply of the remediation above for every org. Rows
-- whose label is ambiguous or unknown are intentionally left NULL and remain
-- visible through EXPENSE_CATEGORY_MISSING; nothing is guessed and no row is
-- deleted or amount changed.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org RECORD;
BEGIN
  FOR v_org IN
    SELECT DISTINCT org_id FROM public.cam_expense_inputs
     WHERE org_id IS NOT NULL AND expense_category_id IS NULL
  LOOP
    PERFORM public.remediate_cam_input_category_ids(v_org.org_id, false, NULL);
  END LOOP;
END;
$$;
