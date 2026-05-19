-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: supplement expense_categories with the keys the workflow
-- extractor produces that weren't covered by the initial seed.
--
-- Why this exists:
--   The Lease Expense Rules workflow (lease-workflow.ts → EXPENSE_RULE_BLUEPRINTS)
--   emits category keys like "interior_repairs", "tenant_caused_repairs",
--   "excess_utilities", "legal_default_costs" etc. The initial seed only
--   covered the most common 30 categories, so when a workflow rule had one
--   of these uncommon keys, ensurePersistentCategories tried to INSERT it
--   at runtime — and RLS denied that for non-super-admin users, causing
--   the whole rule-persistence to fail (visible in console as
--   "new row violates row-level security policy for table 'expense_categories'").
--
-- By seeding every blueprint key here once, runtime never has to INSERT.
--
-- Idempotent: every row uses ON CONFLICT DO NOTHING via the existing
-- unique index on (org_id, normalized_key).
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.expense_categories
  (org_id, is_system_default, is_active, display_order, normalized_key, category_name, subcategory_name, parent_key, classification)
VALUES
  -- CAM aliases (workflow stores both "cam" and "common_area_maintenance"
  -- as separate keys even though they map to the same canonical category)
  (NULL, true, true,   11, 'cam',                       'CAM',                          NULL,            'common_area_maintenance',  'recoverable'),

  -- Granular repair / maintenance keys the workflow emits
  (NULL, true, true,  301, 'interior_repairs',          'Interior Repairs',             NULL,            'repairs_maintenance',      'conditional'),
  (NULL, true, true,  302, 'exterior_repairs',          'Exterior Repairs',             NULL,            'repairs_maintenance',      'conditional'),
  (NULL, true, true,  303, 'tenant_caused_repairs',     'Tenant-Caused Repairs',        NULL,            NULL,                       'recoverable'),
  (NULL, true, true,  304, 'tenant_alterations',        'Tenant Alterations',           NULL,            'alterations',              'non_recoverable'),

  -- Retail / mixed-use fee categories
  (NULL, true, true,  420, 'marketing_fund',            'Marketing Fund',               NULL,            NULL,                       'conditional'),
  (NULL, true, true,  430, 'merchant_association_dues', 'Merchant Association Dues',    NULL,            NULL,                       'conditional'),
  (NULL, true, true,  440, 'percentage_rent',           'Percentage Rent',              NULL,            NULL,                       'conditional'),

  -- Default cost variants
  (NULL, true, true,  701, 'legal_default_costs',       'Legal / Default Costs',        NULL,            'legal_enforcement_fees',   'conditional'),
  (NULL, true, true,  702, 'legal_fees',                'Legal Fees',                   NULL,            'legal_enforcement_fees',   'conditional'),

  -- Excess / special usage
  (NULL, true, true,  611, 'excess_utilities',          'Excess Utilities',             NULL,            'utilities',                'conditional'),
  (NULL, true, true,  612, 'special_equipment_usage',   'Special Equipment Usage',      NULL,            NULL,                       'conditional')
ON CONFLICT DO NOTHING;
