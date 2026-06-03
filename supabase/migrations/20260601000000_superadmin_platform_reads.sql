-- Migration: 20260601000000_superadmin_platform_reads.sql
-- Description: Adds SELECT-only RLS bypass policies for platform-level super_admin
--              to ensure super_admin can read all data across all organizations
--              without needing a direct org membership row in each org.
--              Does NOT add INSERT/UPDATE/DELETE bypass. Writes still require org_id.

DO $$
DECLARE
  table_names text[] := ARRAY[
    'portfolios',
    'properties',
    'buildings',
    'units',
    'leases',
    'expenses',
    'budgets',
    'revenues',
    'tenants',
    'vendors',
    'documents',
    'lease_expense_rules',
    'expense_classifications',
    'cam_calculations',
    'computation_snapshots',
    'budget_line_items',
    'gl_accounts',
    'invoices',
    'reconciliations',
    'workflows',
    'rent_projections',
    'expense_projections',
    'actuals',
    'variances',
    'billings',
    'lease_expense_rule_sets',
    'lease_expense_values'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY table_names
  LOOP
    -- Safely drop existing super_admin select policy if it was somehow created earlier
    EXECUTE format('DROP POLICY IF EXISTS "%I_select_super_admin" ON public.%I', t, t);
    
    -- Create the SELECT-only bypass policy
    EXECUTE format(
      'CREATE POLICY "%I_select_super_admin" ON public.%I FOR SELECT USING (public.is_super_admin())',
      t, t
    );
  END LOOP;
END
$$;
