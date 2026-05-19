-- ════════════════════════════════════════════════════════════════════════════
-- APPLY-ALL-EXPENSE-RULES.sql
--
-- One-shot bundle of the four migrations needed to make the Lease Expense
-- Rules workflow functional end-to-end. Paste the entire file into the
-- Supabase SQL editor (or any psql session) and run.
--
-- Idempotent throughout: every CREATE uses IF NOT EXISTS, every INSERT uses
-- ON CONFLICT DO NOTHING, every policy DROPs before CREATE, and every block
-- that might fail on legacy shapes is wrapped in DO/EXCEPTION WHEN OTHERS.
-- Safe to re-run any number of times.
--
-- Order matters and is preserved here:
--   1. lease_expense_rules spec columns
--   2. expense_categories table + base seed
--   3. expense_categories supplement (workflow keys)
--   4. RLS loosening on all lease-expense tables
--
-- Source files (all kept individually under scripts/migrations/):
--   20260518100000_lease_expense_rules_spec_columns.sql
--   20260518110000_expense_categories_table_and_seed.sql
--   20260518120000_expense_categories_seed_supplement.sql
--   20260518130000_fix_lease_expense_rls.sql
-- ════════════════════════════════════════════════════════════════════════════


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 1. lease_expense_rules — add spec columns                                │
-- └──────────────────────────────────────────────────────────────────────────┘

ALTER TABLE public.lease_expense_rules
  -- Scope (denormalized from rule_set for direct queries)
  ADD COLUMN IF NOT EXISTS org_id                       UUID,
  ADD COLUMN IF NOT EXISTS lease_id                     UUID,
  ADD COLUMN IF NOT EXISTS approved_lease_abstract_id   UUID,
  ADD COLUMN IF NOT EXISTS property_id                  UUID,
  ADD COLUMN IF NOT EXISTS building_id                  UUID,
  ADD COLUMN IF NOT EXISTS unit_id                      UUID,
  ADD COLUMN IF NOT EXISTS tenant_id                    UUID,

  -- Canonical category mirror (decoupled from expense_categories FK)
  ADD COLUMN IF NOT EXISTS expense_category             TEXT,
  ADD COLUMN IF NOT EXISTS expense_subcategory          TEXT,

  -- Classification enums (TEXT for easy evolution)
  ADD COLUMN IF NOT EXISTS operational_responsibility   TEXT,   -- landlord | tenant | shared | unknown
  ADD COLUMN IF NOT EXISTS payment_treatment            TEXT,   -- included_in_base_rent | separately_billed | tenant_direct_contract | reimbursable | not_applicable
  ADD COLUMN IF NOT EXISTS recoverable_from_tenant      TEXT,   -- yes | no | conditional | unknown
  ADD COLUMN IF NOT EXISTS cam_eligible                 TEXT,   -- yes | no | conditional | unknown
  ADD COLUMN IF NOT EXISTS billing_treatment            TEXT,
  ADD COLUMN IF NOT EXISTS recovery_method              TEXT,
  ADD COLUMN IF NOT EXISTS allocation_basis             TEXT,

  -- Cap / base year / expense stop / admin / gross-up
  ADD COLUMN IF NOT EXISTS included_in_base_rent        BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS cap_amount                   NUMERIC,
  ADD COLUMN IF NOT EXISTS cap_percent                  NUMERIC,
  ADD COLUMN IF NOT EXISTS base_year                    INTEGER,
  ADD COLUMN IF NOT EXISTS base_year_amount             NUMERIC,
  ADD COLUMN IF NOT EXISTS expense_stop_amount          NUMERIC,
  ADD COLUMN IF NOT EXISTS gross_up_percent             NUMERIC,

  -- Billing & reconciliation
  ADD COLUMN IF NOT EXISTS billing_frequency            TEXT,
  ADD COLUMN IF NOT EXISTS reconciliation_required      BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS reconciliation_frequency     TEXT,

  -- Source evidence
  ADD COLUMN IF NOT EXISTS source_page                  INTEGER,
  ADD COLUMN IF NOT EXISTS exact_source_text            TEXT,
  ADD COLUMN IF NOT EXISTS confidence_score             NUMERIC,

  -- Lifecycle
  ADD COLUMN IF NOT EXISTS extraction_status            TEXT DEFAULT 'extracted',
  ADD COLUMN IF NOT EXISTS review_status                TEXT DEFAULT 'needs_review',
  ADD COLUMN IF NOT EXISTS approval_status              TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS published_to_cam             BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_by                  TEXT,
  ADD COLUMN IF NOT EXISTS approved_at                  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_from                 TEXT DEFAULT 'workflow';

-- Backfill scope columns from the rule_set parent.
DO $$
BEGIN
  UPDATE public.lease_expense_rules r
  SET
    org_id      = COALESCE(r.org_id,      s.org_id),
    lease_id    = COALESCE(r.lease_id,    s.lease_id),
    property_id = COALESCE(r.property_id, s.property_id)
  FROM public.lease_expense_rule_sets s
  WHERE r.rule_set_id = s.id
    AND (r.org_id IS NULL OR r.lease_id IS NULL OR r.property_id IS NULL);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'rule_set scope backfill skipped: %', SQLERRM;
END $$;

-- Backfill building/unit/tenant from the lease row.
DO $$
BEGIN
  UPDATE public.lease_expense_rules r
  SET
    building_id = COALESCE(r.building_id, l.building_id),
    unit_id     = COALESCE(r.unit_id,     l.unit_id),
    tenant_id   = COALESCE(r.tenant_id,   l.tenant_id),
    org_id      = COALESCE(r.org_id,      l.org_id),
    property_id = COALESCE(r.property_id, l.property_id)
  FROM public.leases l
  WHERE r.lease_id = l.id
    AND (r.building_id IS NULL OR r.unit_id IS NULL OR r.tenant_id IS NULL OR r.org_id IS NULL OR r.property_id IS NULL);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'lease scope backfill skipped: %', SQLERRM;
END $$;

-- Backfill expense_category text from expense_categories. (Will silently
-- skip on first run if expense_categories doesn't exist yet — Section 2
-- creates it.)
DO $$
BEGIN
  UPDATE public.lease_expense_rules r
  SET
    expense_category    = COALESCE(r.expense_category,    c.normalized_key, c.category_name),
    expense_subcategory = COALESCE(r.expense_subcategory, c.subcategory_name)
  FROM public.expense_categories c
  WHERE r.expense_category_id = c.id
    AND r.expense_category IS NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'expense_category text backfill skipped: %', SQLERRM;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_lease    ON public.lease_expense_rules(lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_property ON public.lease_expense_rules(property_id);
CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_scope    ON public.lease_expense_rules(org_id, property_id, building_id, unit_id);
CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_review   ON public.lease_expense_rules(review_status, approval_status);
CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_category ON public.lease_expense_rules(expense_category);


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 2. expense_categories table + base seed                                  │
-- └──────────────────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS public.expense_categories (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID,
  is_system_default   BOOLEAN NOT NULL DEFAULT false,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  display_order       INTEGER NOT NULL DEFAULT 1000,
  normalized_key      TEXT NOT NULL,
  category_name       TEXT NOT NULL,
  subcategory_name    TEXT,
  parent_key          TEXT,
  classification      TEXT,
  expense_classification TEXT,
  description         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_org_key
  ON public.expense_categories (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'), normalized_key);

CREATE INDEX IF NOT EXISTS idx_expense_categories_normalized_key ON public.expense_categories(normalized_key);
CREATE INDEX IF NOT EXISTS idx_expense_categories_active         ON public.expense_categories(is_active);

DO $$
BEGIN
  DROP TRIGGER IF EXISTS trg_expense_categories_updated_at ON public.expense_categories;
  CREATE TRIGGER trg_expense_categories_updated_at
    BEFORE UPDATE ON public.expense_categories
    FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'expense_categories trigger skipped (set_workflow_updated_at missing?): %', SQLERRM;
END $$;

-- Base seed (30 canonical categories)
INSERT INTO public.expense_categories
  (org_id, is_system_default, is_active, display_order, normalized_key, category_name, subcategory_name, parent_key, classification)
VALUES
  (NULL, true, true,   10, 'common_area_maintenance',  'Common Area Maintenance',      NULL,            NULL,                       'recoverable'),
  (NULL, true, true,   20, 'operating_expenses',        'Operating Expenses',           NULL,            NULL,                       'recoverable'),
  (NULL, true, true,   30, 'real_estate_taxes',         'Real Estate Taxes',            NULL,            NULL,                       'recoverable'),
  (NULL, true, true,   40, 'property_insurance',        'Property Insurance',           NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  100, 'utilities',                 'Utilities',                    NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  110, 'electricity',               'Utilities',                    'Electricity',   'utilities',                'recoverable'),
  (NULL, true, true,  120, 'water',                     'Utilities',                    'Water',         'utilities',                'recoverable'),
  (NULL, true, true,  130, 'sewer',                     'Utilities',                    'Sewer',         'utilities',                'recoverable'),
  (NULL, true, true,  140, 'gas',                       'Utilities',                    'Gas',           'utilities',                'recoverable'),
  (NULL, true, true,  150, 'hvac',                      'HVAC',                         NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  200, 'janitorial',                'Janitorial',                   NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  210, 'trash_removal',             'Trash Removal',                NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  220, 'security',                  'Security',                     NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  230, 'landscaping',               'Landscaping',                  NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  240, 'snow_removal',              'Snow Removal',                 NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  250, 'parking',                   'Parking',                      NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  300, 'repairs_maintenance',       'Repairs & Maintenance',        NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  310, 'roof_structure',            'Roof / Structure',             NULL,            NULL,                       'capital'),
  (NULL, true, true,  320, 'foundation_structure',      'Foundation / Structure',       NULL,            NULL,                       'capital'),
  (NULL, true, true,  330, 'capital_expenditures',      'Capital Expenditures',         NULL,            NULL,                       'capital'),
  (NULL, true, true,  400, 'management_fees',           'Management Fees',              NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  410, 'administrative_fees',       'Administrative Fees',          NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  500, 'tenant_insurance',          'Tenant Insurance',             NULL,            NULL,                       'non_recoverable'),
  (NULL, true, true,  510, 'tenant_improvements',       'Tenant Improvements',          NULL,            NULL,                       'non_recoverable'),
  (NULL, true, true,  520, 'alterations',               'Alterations',                  NULL,            NULL,                       'non_recoverable'),
  (NULL, true, true,  530, 'tenant_caused_damage',      'Tenant-Caused Damage',         NULL,            NULL,                       'conditional'),
  (NULL, true, true,  600, 'separately_metered_charges','Separately Metered Charges',   NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  610, 'excess_usage',              'Excess Usage',                 NULL,            NULL,                       'conditional'),
  (NULL, true, true,  700, 'legal_enforcement_fees',    'Legal / Enforcement Fees',     NULL,            NULL,                       'conditional'),
  (NULL, true, true,  710, 'late_fees',                 'Late Fees',                    NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  720, 'interest',                  'Interest',                     NULL,            NULL,                       'recoverable')
ON CONFLICT DO NOTHING;

UPDATE public.expense_categories
   SET expense_classification = COALESCE(expense_classification, classification)
 WHERE classification IS NOT NULL AND expense_classification IS NULL;

-- Now back-fill the rules' expense_category text again (now that the table
-- exists) so rules persisted before this migration get the text mirror.
DO $$
BEGIN
  UPDATE public.lease_expense_rules r
  SET
    expense_category    = COALESCE(r.expense_category,    c.normalized_key, c.category_name),
    expense_subcategory = COALESCE(r.expense_subcategory, c.subcategory_name)
  FROM public.expense_categories c
  WHERE r.expense_category_id = c.id
    AND r.expense_category IS NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'second-pass category backfill skipped: %', SQLERRM;
END $$;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 3. expense_categories supplement (workflow blueprint keys)               │
-- └──────────────────────────────────────────────────────────────────────────┘

INSERT INTO public.expense_categories
  (org_id, is_system_default, is_active, display_order, normalized_key, category_name, subcategory_name, parent_key, classification)
VALUES
  (NULL, true, true,   11, 'cam',                       'CAM',                          NULL,            'common_area_maintenance',  'recoverable'),
  (NULL, true, true,  301, 'interior_repairs',          'Interior Repairs',             NULL,            'repairs_maintenance',      'conditional'),
  (NULL, true, true,  302, 'exterior_repairs',          'Exterior Repairs',             NULL,            'repairs_maintenance',      'conditional'),
  (NULL, true, true,  303, 'tenant_caused_repairs',     'Tenant-Caused Repairs',        NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  304, 'tenant_alterations',        'Tenant Alterations',           NULL,            'alterations',              'non_recoverable'),
  (NULL, true, true,  420, 'marketing_fund',            'Marketing Fund',               NULL,            NULL,                       'conditional'),
  (NULL, true, true,  430, 'merchant_association_dues', 'Merchant Association Dues',    NULL,            NULL,                       'conditional'),
  (NULL, true, true,  440, 'percentage_rent',           'Percentage Rent',              NULL,            NULL,                       'conditional'),
  (NULL, true, true,  701, 'legal_default_costs',       'Legal / Default Costs',        NULL,            'legal_enforcement_fees',   'conditional'),
  (NULL, true, true,  702, 'legal_fees',                'Legal Fees',                   NULL,            'legal_enforcement_fees',   'conditional'),
  (NULL, true, true,  611, 'excess_utilities',          'Excess Utilities',             NULL,            'utilities',                'conditional'),
  (NULL, true, true,  612, 'special_equipment_usage',   'Special Equipment Usage',      NULL,            NULL,                       'conditional')
ON CONFLICT DO NOTHING;


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 4. RLS — loosen so any org member can manage rule sets/rules             │
-- └──────────────────────────────────────────────────────────────────────────┘

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
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_select', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_insert', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_update', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_delete', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_org_select', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_org_write',  tbl);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'drop old policies on % skipped: %', tbl, SQLERRM;
    END;
  END LOOP;
END $$;

ALTER TABLE public.lease_expense_rule_sets ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  EXECUTE $POL$
    CREATE POLICY "lease_expense_rule_sets_org_select"
      ON public.lease_expense_rule_sets FOR SELECT
      USING (org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid()))
  $POL$;
  EXECUTE $POL$
    CREATE POLICY "lease_expense_rule_sets_org_write"
      ON public.lease_expense_rule_sets FOR ALL
      USING (org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid()))
      WITH CHECK (org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid()))
  $POL$;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'lease_expense_rule_sets policies skipped: %', SQLERRM; END $$;

ALTER TABLE public.lease_expense_rules ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
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
        org_id IS NULL
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        OR rule_set_id IN (
          SELECT s.id FROM public.lease_expense_rule_sets s
          WHERE s.org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
        )
      )
  $POL$;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'lease_expense_rules policies skipped: %', SQLERRM; END $$;

ALTER TABLE public.lease_expense_values ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
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
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'lease_expense_values policies skipped: %', SQLERRM; END $$;

ALTER TABLE public.lease_expense_rule_clauses ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
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
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'lease_expense_rule_clauses policies skipped: %', SQLERRM; END $$;

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "write_expense_categories"      ON public.expense_categories';
  EXECUTE 'DROP POLICY IF EXISTS "write_expense_categories_open" ON public.expense_categories';
  EXECUTE 'DROP POLICY IF EXISTS "expense_categories_org_write"  ON public.expense_categories';
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


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ Verification block — run this after; should return non-zero counts       │
-- └──────────────────────────────────────────────────────────────────────────┘

SELECT
  (SELECT count(*) FROM public.expense_categories WHERE is_system_default = true) AS seeded_categories,
  (SELECT count(*) FROM public.lease_expense_rule_sets) AS rule_sets,
  (SELECT count(*) FROM public.lease_expense_rules)     AS rules,
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('lease_expense_rule_sets', 'lease_expense_rules', 'lease_expense_values', 'lease_expense_rule_clauses', 'expense_categories')) AS rls_policies;
