-- Extends the canonical-category pattern already established for
-- cam_expense_inputs (20269900000039) one step earlier in the pipeline, onto
-- expense_classifications itself. Confirmed via code audit: expense_classifications
-- has only free-text category/subcategory columns -- no canonical id -- so
-- "Needs Category" (as a real canonical-match concept, not just "label is
-- non-empty") cannot be evaluated pre-publish. Reuses the EXISTING
-- resolve_expense_category_id() resolver verbatim -- no second matching
-- algorithm, no new RPC pattern, same fail-closed precedence and the same
-- EXACT-match-only rule (never fuzzy).

-- ---------------------------------------------------------------------------
-- 1. Canonical category column
-- ---------------------------------------------------------------------------
ALTER TABLE public.expense_classifications
  ADD COLUMN IF NOT EXISTS expense_category_id UUID
    REFERENCES public.expense_categories(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.expense_classifications.expense_category_id IS
  'Canonical expense category, resolved the same way as cam_expense_inputs.expense_category_id '
  '(20269900000039). NULL means the label could not be resolved to exactly one category -- '
  'surfaces as a "Needs Category" CAM input decision rather than being guessed.';

CREATE INDEX IF NOT EXISTS idx_expense_classifications_expense_category
  ON public.expense_classifications(org_id, property_id, expense_category_id);

-- ---------------------------------------------------------------------------
-- 2. Population trigger -- same precedence as cam_expense_inputs's trigger:
--    explicit id wins, then the linked lease_expense_rule's own canonical
--    category, then exact-match resolution of the text label via the
--    EXISTING public.resolve_expense_category_id() (defined in 20269900000039,
--    not redefined here).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expense_classifications_set_canonical_category()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_resolved JSONB;
  v_rule_category UUID;
  v_rule_id UUID;
BEGIN
  IF NEW.expense_category_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_rule_id := COALESCE(NEW.lease_expense_rule_id, NEW.linked_expense_rule_id, NEW.recovery_rule_id);
  IF v_rule_id IS NOT NULL THEN
    SELECT r.expense_category_id
      INTO v_rule_category
      FROM public.lease_expense_rules r
     WHERE r.id = v_rule_id;

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

DROP TRIGGER IF EXISTS trg_expense_classifications_canonical_category ON public.expense_classifications;
CREATE TRIGGER trg_expense_classifications_canonical_category
  BEFORE INSERT OR UPDATE OF category, lease_expense_rule_id, expense_category_id
  ON public.expense_classifications
  FOR EACH ROW
  EXECUTE FUNCTION public.expense_classifications_set_canonical_category();

-- ---------------------------------------------------------------------------
-- 3. One-time backfill for existing rows, same resolver, same fail-closed
--    rule (ambiguous/unknown labels are left NULL, never guessed, never
--    deleted, no amount touched). Not a persistent remediation RPC -- unlike
--    cam_expense_inputs, expense_classifications has no established need for
--    repeat remediation after publish; a one-time backfill covers the
--    existing-data gap without adding new API surface.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_row RECORD;
  v_resolved JSONB;
  v_rule_category UUID;
  v_rule_id UUID;
BEGIN
  FOR v_row IN
    SELECT id, org_id, category, lease_expense_rule_id, linked_expense_rule_id, recovery_rule_id
      FROM public.expense_classifications
     WHERE expense_category_id IS NULL
  LOOP
    v_rule_category := NULL;
    v_rule_id := COALESCE(v_row.lease_expense_rule_id, v_row.linked_expense_rule_id, v_row.recovery_rule_id);

    IF v_rule_id IS NOT NULL THEN
      SELECT r.expense_category_id INTO v_rule_category
        FROM public.lease_expense_rules r
       WHERE r.id = v_rule_id;
    END IF;

    IF v_rule_category IS NOT NULL THEN
      UPDATE public.expense_classifications SET expense_category_id = v_rule_category, updated_at = now() WHERE id = v_row.id;
      CONTINUE;
    END IF;

    v_resolved := public.resolve_expense_category_id(v_row.org_id, v_row.category);
    IF (v_resolved ->> 'expense_category_id') IS NOT NULL THEN
      UPDATE public.expense_classifications
         SET expense_category_id = (v_resolved ->> 'expense_category_id')::UUID, updated_at = now()
       WHERE id = v_row.id;
    END IF;
  END LOOP;
END;
$$;
