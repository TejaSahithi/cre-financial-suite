-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: create `expense_categories` table and seed the canonical set
-- the Lease Expense Rules workflow depends on.
--
-- Why this exists:
--   The Lease Expense Rules page and the leaseExpenseRuleService both read
--   `expense_categories`. The table was never created in the deployed schema,
--   so every category lookup returns "Could not find table 'public.expense_categories'
--   in the schema cache" (PGRST205). That makes `saveRuleSet` filter every
--   rule out (no UUID resolves), and the page shows 0 rules even after
--   approval.
--
-- This migration is idempotent: it creates the table only if missing and
-- inserts canonical rows only when the normalized_key is not already there.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.expense_categories (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID,                                 -- NULL = system default, available to every org
  is_system_default   BOOLEAN NOT NULL DEFAULT false,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  display_order       INTEGER NOT NULL DEFAULT 1000,
  normalized_key      TEXT NOT NULL,                        -- canonical machine key (e.g. "common_area_maintenance")
  category_name       TEXT NOT NULL,                        -- display name (e.g. "Common Area Maintenance")
  subcategory_name    TEXT,                                 -- optional finer-grained label (e.g. "Electricity" under "Utilities")
  parent_key          TEXT,                                 -- normalized_key of the parent if this is a subcategory
  classification      TEXT,                                 -- recoverable | non_recoverable | conditional | capital | other
  expense_classification TEXT,                              -- legacy alias some code reads
  description         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique per (org_id, normalized_key) — NULL org_id is the system default.
-- The unique index uses COALESCE so the global default and an org-specific
-- override of the same key can coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_org_key
  ON public.expense_categories (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'), normalized_key);

CREATE INDEX IF NOT EXISTS idx_expense_categories_normalized_key ON public.expense_categories(normalized_key);
CREATE INDEX IF NOT EXISTS idx_expense_categories_active         ON public.expense_categories(is_active);

-- Updated-at trigger reuses the project-wide helper.
DROP TRIGGER IF EXISTS trg_expense_categories_updated_at ON public.expense_categories;
CREATE TRIGGER trg_expense_categories_updated_at
  BEFORE UPDATE ON public.expense_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();

-- ── Seed canonical categories ────────────────────────────────────────────
-- Every row uses ON CONFLICT DO NOTHING so re-runs are safe. org_id = NULL
-- means "system default, visible to every org".

INSERT INTO public.expense_categories
  (org_id, is_system_default, is_active, display_order, normalized_key, category_name, subcategory_name, parent_key, classification)
VALUES
  -- Recoverable operating expense pool
  (NULL, true, true,   10, 'common_area_maintenance',  'Common Area Maintenance',      NULL,            NULL,                       'recoverable'),
  (NULL, true, true,   20, 'operating_expenses',        'Operating Expenses',           NULL,            NULL,                       'recoverable'),
  (NULL, true, true,   30, 'real_estate_taxes',         'Real Estate Taxes',            NULL,            NULL,                       'recoverable'),
  (NULL, true, true,   40, 'property_insurance',        'Property Insurance',           NULL,            NULL,                       'recoverable'),

  -- Utilities umbrella + sub
  (NULL, true, true,  100, 'utilities',                 'Utilities',                    NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  110, 'electricity',               'Utilities',                    'Electricity',   'utilities',                'recoverable'),
  (NULL, true, true,  120, 'water',                     'Utilities',                    'Water',         'utilities',                'recoverable'),
  (NULL, true, true,  130, 'sewer',                     'Utilities',                    'Sewer',         'utilities',                'recoverable'),
  (NULL, true, true,  140, 'gas',                       'Utilities',                    'Gas',           'utilities',                'recoverable'),
  (NULL, true, true,  150, 'hvac',                      'HVAC',                         NULL,            NULL,                       'recoverable'),

  -- Site services
  (NULL, true, true,  200, 'janitorial',                'Janitorial',                   NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  210, 'trash_removal',             'Trash Removal',                NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  220, 'security',                  'Security',                     NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  230, 'landscaping',               'Landscaping',                  NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  240, 'snow_removal',              'Snow Removal',                 NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  250, 'parking',                   'Parking',                      NULL,            NULL,                       'recoverable'),

  -- Building maintenance
  (NULL, true, true,  300, 'repairs_maintenance',       'Repairs & Maintenance',        NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  310, 'roof_structure',            'Roof / Structure',             NULL,            NULL,                       'capital'),
  (NULL, true, true,  320, 'foundation_structure',      'Foundation / Structure',       NULL,            NULL,                       'capital'),
  (NULL, true, true,  330, 'capital_expenditures',      'Capital Expenditures',         NULL,            NULL,                       'capital'),

  -- Fee categories
  (NULL, true, true,  400, 'management_fees',           'Management Fees',              NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  410, 'administrative_fees',       'Administrative Fees',          NULL,            NULL,                       'recoverable'),

  -- Tenant-side
  (NULL, true, true,  500, 'tenant_insurance',          'Tenant Insurance',             NULL,            NULL,                       'non_recoverable'),
  (NULL, true, true,  510, 'tenant_improvements',       'Tenant Improvements',          NULL,            NULL,                       'non_recoverable'),
  (NULL, true, true,  520, 'alterations',               'Alterations',                  NULL,            NULL,                       'non_recoverable'),
  (NULL, true, true,  530, 'tenant_caused_damage',      'Tenant-Caused Damage',         NULL,            NULL,                       'conditional'),

  -- Direct / excess pass-throughs
  (NULL, true, true,  600, 'separately_metered_charges','Separately Metered Charges',   NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  610, 'excess_usage',              'Excess Usage',                 NULL,            NULL,                       'conditional'),

  -- Enforcement / legal
  (NULL, true, true,  700, 'legal_enforcement_fees',    'Legal / Enforcement Fees',     NULL,            NULL,                       'conditional'),
  (NULL, true, true,  710, 'late_fees',                 'Late Fees',                    NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  720, 'interest',                  'Interest',                     NULL,            NULL,                       'recoverable')
ON CONFLICT DO NOTHING;

-- Backfill any existing rows that came in without classification.
UPDATE public.expense_categories
   SET expense_classification = COALESCE(expense_classification, classification)
 WHERE classification IS NOT NULL AND expense_classification IS NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read system defaults (org_id IS NULL) and their
-- own org's categories. Wrapped in DO so a missing helper doesn't abort.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'get_my_org_ids' AND pronamespace = 'public'::regnamespace
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS "read_expense_categories" ON public.expense_categories';
    EXECUTE $POL$
      CREATE POLICY "read_expense_categories"
        ON public.expense_categories FOR SELECT
        USING (org_id IS NULL OR org_id = ANY (public.get_my_org_ids()))
    $POL$;
  ELSE
    -- Fallback: allow read to any authenticated user. Service-role writes
    -- still bypass RLS. This is acceptable for system defaults that are
    -- intentionally global.
    EXECUTE 'DROP POLICY IF EXISTS "read_expense_categories_open" ON public.expense_categories';
    EXECUTE $POL$
      CREATE POLICY "read_expense_categories_open"
        ON public.expense_categories FOR SELECT
        USING (true)
    $POL$;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'expense_categories read policy creation skipped: %', SQLERRM;
END $$;

-- Writes (insert/update) — let any authenticated user with org access write
-- org-scoped categories. Wrapped in DO so missing helpers don't abort.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'get_my_org_ids' AND pronamespace = 'public'::regnamespace
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS "write_expense_categories" ON public.expense_categories';
    EXECUTE $POL$
      CREATE POLICY "write_expense_categories"
        ON public.expense_categories FOR ALL
        USING (org_id IS NULL OR org_id = ANY (public.get_my_org_ids()))
        WITH CHECK (org_id IS NULL OR org_id = ANY (public.get_my_org_ids()))
    $POL$;
  ELSE
    EXECUTE 'DROP POLICY IF EXISTS "write_expense_categories_open" ON public.expense_categories';
    EXECUTE $POL$
      CREATE POLICY "write_expense_categories_open"
        ON public.expense_categories FOR ALL
        USING (true) WITH CHECK (true)
    $POL$;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'expense_categories write policy creation skipped: %', SQLERRM;
END $$;
