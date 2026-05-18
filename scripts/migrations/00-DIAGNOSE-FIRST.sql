-- =====================================================================
-- DIAGNOSTIC PREPASS — run this BEFORE any migration in this folder.
-- Paste into the Supabase SQL editor → Run. The output tells us what
-- the bundle is about to collide with on your remote schema.
-- =====================================================================

-- 1. Which of the bundle's tables already exist?
SELECT
  table_name,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND columns.table_name = t.table_name) AS column_count
FROM (VALUES
  ('documents'),
  ('expense_classifications'),
  ('budget_line_items'),
  ('lease_clauses'),
  ('lease_expense_rule_sets'),
  ('lease_expense_rules'),
  ('lease_expense_values'),
  ('lease_expense_rule_clauses'),
  ('cam_profiles'),
  ('lease_field_reviews'),
  ('lease_critical_dates'),
  ('rent_schedules')
) AS t(table_name)
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND tables.table_name = t.table_name
);

-- 2. For every existing table above, which columns are there?
-- (Helps us see if a table exists but is missing 'lease_id', 'org_id', etc.)
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'documents', 'expense_classifications', 'budget_line_items',
    'lease_clauses', 'lease_expense_rule_sets', 'lease_expense_rules',
    'lease_expense_values', 'lease_expense_rule_clauses', 'cam_profiles',
    'lease_field_reviews', 'lease_critical_dates', 'rent_schedules'
  )
ORDER BY table_name, ordinal_position;

-- 3. Does the leases table have the columns the bundle references?
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'leases'
  AND column_name IN (
    'id', 'org_id', 'property_id', 'start_date', 'end_date',
    'commencement_date', 'expiration_date', 'renewal_notice_days',
    'rent_commencement_date', 'extraction_data', 'abstract_status',
    'abstract_version', 'abstract_snapshot', 'signed_by', 'signed_at',
    'approval_comments', 'approval_document_url'
  )
ORDER BY column_name;

-- 4. Do the bundle's helper functions exist?
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'is_super_admin', 'get_my_org_ids', 'can_write_org_data',
    'can_write_page', 'can_write_any_page', 'can_access_property',
    'set_workflow_updated_at'
  )
ORDER BY routine_name;
