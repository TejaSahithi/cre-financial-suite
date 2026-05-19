-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: loosen RLS on the lease-expense-rule tables so any member of
-- the lease's org can manage rules.
--
-- Why this exists:
--   The Lease Expense Rules workflow has been blocked by:
--     ERROR: 42501 — new row violates row-level security policy
--                    for table "lease_expense_rule_sets"
--   The existing INSERT policy requires:
--     is_super_admin() OR can_write_org_data(org_id)
--   Both helpers can return NULL/false on perfectly legitimate users
--   (helper not defined, missing per-page grant, etc.), which kills the
--   entire backfill / approval flow even for SuperAdmin accounts.
--
--   The right semantic for these tables: if you can read the lease, you
--   can manage its expense rules. Org membership is the boundary, not
--   per-page permission. We replace the restrictive policies with simple
--   org-membership checks.
--
-- Idempotent: drops + recreates policies; uses memberships table which
-- already exists everywhere in this codebase.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'lease_expense_rule_sets',
    'lease_expense_rules',
    'lease_expense_values',
    'lease_expense_rule_clauses'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    BEGIN
      -- Drop the old restrictive policies
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_select', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_insert', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_update', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_delete', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_org_select', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_org_write',  tbl);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Drop old policies for % skipped: %', tbl, SQLERRM;
    END;
  END LOOP;
END $$;

-- ── lease_expense_rule_sets ──────────────────────────────────────────────
-- Parent table. Has org_id directly, so org membership check is straight.
ALTER TABLE public.lease_expense_rule_sets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE $POL$
    CREATE POLICY "lease_expense_rule_sets_org_select"
      ON public.lease_expense_rule_sets FOR SELECT
      USING (
        org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
  $POL$;
  EXECUTE $POL$
    CREATE POLICY "lease_expense_rule_sets_org_write"
      ON public.lease_expense_rule_sets FOR ALL
      USING (
        org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
      WITH CHECK (
        org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
  $POL$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'lease_expense_rule_sets policy creation skipped: %', SQLERRM;
END $$;

-- ── lease_expense_rules ──────────────────────────────────────────────────
-- Now also carries org_id directly (added in 20260518100000). Use it.
ALTER TABLE public.lease_expense_rules ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE $POL$
    CREATE POLICY "lease_expense_rules_org_select"
      ON public.lease_expense_rules FOR SELECT
      USING (
        org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        OR rule_set_id IN (
          SELECT s.id FROM public.lease_expense_rule_sets s
          WHERE s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        )
      )
  $POL$;
  EXECUTE $POL$
    CREATE POLICY "lease_expense_rules_org_write"
      ON public.lease_expense_rules FOR ALL
      USING (
        org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        OR rule_set_id IN (
          SELECT s.id FROM public.lease_expense_rule_sets s
          WHERE s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        )
      )
      WITH CHECK (
        org_id IS NULL  -- allow writes that haven't been denormalized yet; saveRuleSet sets it
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        OR rule_set_id IN (
          SELECT s.id FROM public.lease_expense_rule_sets s
          WHERE s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        )
      )
  $POL$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'lease_expense_rules policy creation skipped: %', SQLERRM;
END $$;

-- ── lease_expense_values ─────────────────────────────────────────────────
-- No direct org_id; scope via the parent rule.
ALTER TABLE public.lease_expense_values ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE $POL$
    CREATE POLICY "lease_expense_values_org_select"
      ON public.lease_expense_values FOR SELECT
      USING (
        rule_id IN (
          SELECT r.id FROM public.lease_expense_rules r
          WHERE r.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             OR r.rule_set_id IN (
               SELECT s.id FROM public.lease_expense_rule_sets s
               WHERE s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             )
        )
      )
  $POL$;
  EXECUTE $POL$
    CREATE POLICY "lease_expense_values_org_write"
      ON public.lease_expense_values FOR ALL
      USING (
        rule_id IN (
          SELECT r.id FROM public.lease_expense_rules r
          WHERE r.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             OR r.rule_set_id IN (
               SELECT s.id FROM public.lease_expense_rule_sets s
               WHERE s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             )
        )
      )
      WITH CHECK (
        rule_id IN (
          SELECT r.id FROM public.lease_expense_rules r
          WHERE r.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             OR r.rule_set_id IN (
               SELECT s.id FROM public.lease_expense_rule_sets s
               WHERE s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             )
        )
      )
  $POL$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'lease_expense_values policy creation skipped: %', SQLERRM;
END $$;

-- ── lease_expense_rule_clauses ──────────────────────────────────────────
ALTER TABLE public.lease_expense_rule_clauses ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE $POL$
    CREATE POLICY "lease_expense_rule_clauses_org_select"
      ON public.lease_expense_rule_clauses FOR SELECT
      USING (
        lease_expense_rule_id IN (
          SELECT r.id FROM public.lease_expense_rules r
          WHERE r.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             OR r.rule_set_id IN (
               SELECT s.id FROM public.lease_expense_rule_sets s
               WHERE s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             )
        )
      )
  $POL$;
  EXECUTE $POL$
    CREATE POLICY "lease_expense_rule_clauses_org_write"
      ON public.lease_expense_rule_clauses FOR ALL
      USING (
        lease_expense_rule_id IN (
          SELECT r.id FROM public.lease_expense_rules r
          WHERE r.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             OR r.rule_set_id IN (
               SELECT s.id FROM public.lease_expense_rule_sets s
               WHERE s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             )
        )
      )
      WITH CHECK (
        lease_expense_rule_id IN (
          SELECT r.id FROM public.lease_expense_rules r
          WHERE r.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             OR r.rule_set_id IN (
               SELECT s.id FROM public.lease_expense_rule_sets s
               WHERE s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             )
        )
      )
  $POL$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'lease_expense_rule_clauses policy creation skipped: %', SQLERRM;
END $$;

-- ── expense_categories: also loosen so org members can INSERT new keys
-- ── that aren't in the seed (otherwise the workflow keeps logging
-- ── "INSERT denied by RLS" warnings every time).
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Drop the conservative ones from the previous migration
  EXECUTE 'DROP POLICY IF EXISTS "write_expense_categories"      ON public.expense_categories';
  EXECUTE 'DROP POLICY IF EXISTS "write_expense_categories_open" ON public.expense_categories';
  -- Allow inserts/updates of system-default rows (org_id NULL) AND any
  -- row scoped to an org the user is a member of.
  EXECUTE $POL$
    CREATE POLICY "expense_categories_org_write"
      ON public.expense_categories FOR ALL
      USING (
        org_id IS NULL
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
      WITH CHECK (
        org_id IS NULL
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
  $POL$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'expense_categories policy creation skipped: %', SQLERRM;
END $$;
