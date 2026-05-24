-- Fix RLS for lease_expense_rule_sets and lease_expense_rules to allow property-level access

DO $$
BEGIN
  -- Fix lease_expense_rule_sets
  EXECUTE 'DROP POLICY IF EXISTS "lease_expense_rule_sets_org_select" ON public.lease_expense_rule_sets';
  EXECUTE 'DROP POLICY IF EXISTS "lease_expense_rule_sets_org_write" ON public.lease_expense_rule_sets';

  EXECUTE $POL$
    CREATE POLICY "lease_expense_rule_sets_org_select"
      ON public.lease_expense_rule_sets FOR SELECT
      USING (
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        OR ((property_id IS NULL) OR public.can_access_property(property_id))
      )
  $POL$;

  EXECUTE $POL$
    CREATE POLICY "lease_expense_rule_sets_org_write"
      ON public.lease_expense_rule_sets FOR ALL
      USING (
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        OR (public.can_write_page(org_id, 'Leases') AND ((property_id IS NULL) OR public.can_access_property(property_id)))
      )
      WITH CHECK (
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        OR (public.can_write_page(org_id, 'Leases') AND ((property_id IS NULL) OR public.can_access_property(property_id)))
      )
  $POL$;

  -- Fix lease_expense_rules
  EXECUTE 'DROP POLICY IF EXISTS "lease_expense_rules_org_select" ON public.lease_expense_rules';
  EXECUTE 'DROP POLICY IF EXISTS "lease_expense_rules_org_write" ON public.lease_expense_rules';

  EXECUTE $POL$
    CREATE POLICY "lease_expense_rules_org_select"
      ON public.lease_expense_rules FOR SELECT
      USING (
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        OR rule_set_id IN (
          SELECT s.id FROM public.lease_expense_rule_sets s 
          WHERE (s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid()))
             OR ((s.property_id IS NULL) OR public.can_access_property(s.property_id))
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
          WHERE (s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid()))
             OR (public.can_write_page(s.org_id, 'Leases') AND ((s.property_id IS NULL) OR public.can_access_property(s.property_id)))
        )
      )
      WITH CHECK (
        public.is_super_admin()
        OR org_id IS NULL
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        OR rule_set_id IN (
          SELECT s.id FROM public.lease_expense_rule_sets s 
          WHERE (s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid()))
             OR (public.can_write_page(s.org_id, 'Leases') AND ((s.property_id IS NULL) OR public.can_access_property(s.property_id)))
        )
      )
  $POL$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Failed to update RLS for lease_expense_rules: %', SQLERRM;
END $$;
