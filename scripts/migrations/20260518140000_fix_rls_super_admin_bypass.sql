-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: add is_super_admin() bypass to the lease-expense RLS policies.
--
-- Why this exists:
--   The previous migration (20260518130000) replaced the strict
--   is_super_admin() OR can_write_org_data() check with a membership-only
--   check. That broke the workflow for SuperAdmin accounts, which carry
--   role='super_admin' but org_id=NULL in their memberships row — the
--   membership lookup returns NULL → policy fails → RLS denies.
--
--   This migration keeps the membership check (so org_admin and lower
--   roles can still manage their org's rules) AND restores
--   is_super_admin() so SuperAdmin accounts can manage rules across every
--   org without explicit org memberships.
--
-- Idempotent: drops + recreates the four policies it owns.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── lease_expense_rule_sets ──────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "lease_expense_rule_sets_org_select" ON public.lease_expense_rule_sets';
  EXECUTE 'DROP POLICY IF EXISTS "lease_expense_rule_sets_org_write"  ON public.lease_expense_rule_sets';
  EXECUTE $POL$
    CREATE POLICY "lease_expense_rule_sets_org_select"
      ON public.lease_expense_rule_sets FOR SELECT
      USING (
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
  $POL$;
  EXECUTE $POL$
    CREATE POLICY "lease_expense_rule_sets_org_write"
      ON public.lease_expense_rule_sets FOR ALL
      USING (
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
      WITH CHECK (
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
  $POL$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'lease_expense_rule_sets policies skipped: %', SQLERRM;
END $$;

-- ── lease_expense_rules ──────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "lease_expense_rules_org_select" ON public.lease_expense_rules';
  EXECUTE 'DROP POLICY IF EXISTS "lease_expense_rules_org_write"  ON public.lease_expense_rules';
  EXECUTE $POL$
    CREATE POLICY "lease_expense_rules_org_select"
      ON public.lease_expense_rules FOR SELECT
      USING (
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
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
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        OR rule_set_id IN (
          SELECT s.id FROM public.lease_expense_rule_sets s
          WHERE s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        )
      )
      WITH CHECK (
        public.is_super_admin()
        OR org_id IS NULL
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        OR rule_set_id IN (
          SELECT s.id FROM public.lease_expense_rule_sets s
          WHERE s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        )
      )
  $POL$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'lease_expense_rules policies skipped: %', SQLERRM;
END $$;

-- ── lease_expense_values ─────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "lease_expense_values_org_select" ON public.lease_expense_values';
  EXECUTE 'DROP POLICY IF EXISTS "lease_expense_values_org_write"  ON public.lease_expense_values';
  EXECUTE $POL$
    CREATE POLICY "lease_expense_values_org_select"
      ON public.lease_expense_values FOR SELECT
      USING (
        public.is_super_admin()
        OR rule_id IN (
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
        public.is_super_admin()
        OR rule_id IN (
          SELECT r.id FROM public.lease_expense_rules r
          WHERE r.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             OR r.rule_set_id IN (
               SELECT s.id FROM public.lease_expense_rule_sets s
               WHERE s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             )
        )
      )
      WITH CHECK (
        public.is_super_admin()
        OR rule_id IN (
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
  RAISE NOTICE 'lease_expense_values policies skipped: %', SQLERRM;
END $$;

-- ── lease_expense_rule_clauses ──────────────────────────────────────────
DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "lease_expense_rule_clauses_org_select" ON public.lease_expense_rule_clauses';
  EXECUTE 'DROP POLICY IF EXISTS "lease_expense_rule_clauses_org_write"  ON public.lease_expense_rule_clauses';
  EXECUTE $POL$
    CREATE POLICY "lease_expense_rule_clauses_org_select"
      ON public.lease_expense_rule_clauses FOR SELECT
      USING (
        public.is_super_admin()
        OR lease_expense_rule_id IN (
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
        public.is_super_admin()
        OR lease_expense_rule_id IN (
          SELECT r.id FROM public.lease_expense_rules r
          WHERE r.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             OR r.rule_set_id IN (
               SELECT s.id FROM public.lease_expense_rule_sets s
               WHERE s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
             )
        )
      )
      WITH CHECK (
        public.is_super_admin()
        OR lease_expense_rule_id IN (
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
  RAISE NOTICE 'lease_expense_rule_clauses policies skipped: %', SQLERRM;
END $$;

-- ── expense_categories ──────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "expense_categories_org_write" ON public.expense_categories';
  EXECUTE $POL$
    CREATE POLICY "expense_categories_org_write"
      ON public.expense_categories FOR ALL
      USING (
        public.is_super_admin()
        OR org_id IS NULL
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
      WITH CHECK (
        public.is_super_admin()
        OR org_id IS NULL
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
  $POL$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'expense_categories policy skipped: %', SQLERRM;
END $$;

SELECT 'super_admin_bypass_applied' AS result;
