-- ============================================================
-- VERIFICATION SCRIPT
-- Run this in Supabase SQL Editor to check what's done vs missing.
-- It will return a checklist with PASS / MISSING for each item.
-- ============================================================

SELECT 'TABLES' AS category, check_name, status FROM (

  -- Core tables
  SELECT 'uploaded_files table' AS check_name,
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='uploaded_files')
    THEN 'PASS' ELSE 'MISSING - run 20260401_pipeline_uploaded_files.sql' END AS status

  UNION ALL SELECT 'computation_snapshots table',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='computation_snapshots')
    THEN 'PASS' ELSE 'MISSING - run 20260401_pipeline_uploaded_files.sql' END

  UNION ALL SELECT 'pipeline_logs table',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='pipeline_logs')
    THEN 'PASS' ELSE 'MISSING - run 20260407_pipeline_logs.sql' END

  UNION ALL SELECT 'user_access table',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='user_access')
    THEN 'PASS' ELSE 'MISSING - run 20260408_enterprise_schema.sql' END

  UNION ALL SELECT 'portfolios table',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='portfolios')
    THEN 'PASS' ELSE 'MISSING - run 20260322_add_core_tables.sql' END

  UNION ALL SELECT 'buildings table',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='buildings')
    THEN 'PASS' ELSE 'MISSING - run 20260322_add_core_tables.sql' END

  UNION ALL SELECT 'units table',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='units')
    THEN 'PASS' ELSE 'MISSING - run 20260322_add_core_tables.sql' END

) t

UNION ALL

SELECT 'COLUMNS' AS category, check_name, status FROM (

  -- uploaded_files columns
  SELECT 'uploaded_files.progress_percentage' AS check_name,
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='uploaded_files' AND column_name='progress_percentage')
    THEN 'PASS' ELSE 'MISSING - run 20260407_pipeline_status_columns.sql' END AS status

  UNION ALL SELECT 'uploaded_files.failed_step',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='uploaded_files' AND column_name='failed_step')
    THEN 'PASS' ELSE 'MISSING - run 20260407_pipeline_status_columns.sql' END

  UNION ALL SELECT 'uploaded_files.property_id',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='uploaded_files' AND column_name='property_id')
    THEN 'PASS' ELSE 'MISSING - run 20260407_uploaded_files_property_id.sql' END

  UNION ALL SELECT 'uploaded_files.portfolio_id',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='uploaded_files' AND column_name='portfolio_id')
    THEN 'PASS' ELSE 'MISSING - run 20260408_enterprise_schema.sql' END

  UNION ALL SELECT 'computation_snapshots.updated_at',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='computation_snapshots' AND column_name='updated_at')
    THEN 'PASS' ELSE 'MISSING - run 20260407_snapshot_history.sql' END

  UNION ALL SELECT 'properties.portfolio_id',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='portfolio_id')
    THEN 'PASS' ELSE 'MISSING - run 20260408_enterprise_schema.sql' END

  UNION ALL SELECT 'units.occupancy_status',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='units' AND column_name='occupancy_status')
    THEN 'PASS' ELSE 'MISSING - run 20260408_enterprise_schema.sql' END

  UNION ALL SELECT 'portfolios.status',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='portfolios' AND column_name='status')
    THEN 'PASS' ELSE 'MISSING - run 20260408_enterprise_schema.sql' END

) t

UNION ALL

SELECT 'VIEWS' AS category, check_name, status FROM (

  SELECT 'latest_snapshots view' AS check_name,
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.views WHERE table_schema='public' AND table_name='latest_snapshots')
    THEN 'PASS' ELSE 'MISSING - run 20260407_snapshot_history.sql' END AS status

) t

UNION ALL

SELECT 'FUNCTIONS' AS category, check_name, status FROM (

  SELECT 'is_super_admin()' AS check_name,
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='is_super_admin')
    THEN 'PASS' ELSE 'MISSING - run 20260326_security_hardening.sql' END AS status

  UNION ALL SELECT 'can_write_org_data()',
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='can_write_org_data')
    THEN 'PASS' ELSE 'MISSING - run 20260405_fix_superadmin_access.sql' END

  UNION ALL SELECT 'can_access_portfolio()',
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='can_access_portfolio')
    THEN 'PASS' ELSE 'MISSING - run 20260408_enterprise_schema.sql' END

  UNION ALL SELECT 'can_access_property()',
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='can_access_property')
    THEN 'PASS' ELSE 'MISSING - run 20260408_enterprise_schema.sql' END

  UNION ALL SELECT 'get_accessible_property_ids()',
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_accessible_property_ids')
    THEN 'PASS' ELSE 'MISSING - run 20260408_enterprise_schema.sql' END

) t

UNION ALL

SELECT 'RLS_POLICIES' AS category, check_name, status FROM (

  SELECT 'portfolios RLS enabled' AS check_name,
    CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='portfolios' AND rowsecurity=true)
    THEN 'PASS' ELSE 'MISSING - run 20260408_enterprise_schema.sql' END AS status

  UNION ALL SELECT 'pipeline_logs RLS enabled',
    CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='pipeline_logs' AND rowsecurity=true)
    THEN 'PASS' ELSE 'MISSING - run 20260407_pipeline_logs.sql' END

  UNION ALL SELECT 'user_access RLS enabled',
    CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='user_access' AND rowsecurity=true)
    THEN 'PASS' ELSE 'MISSING - run 20260408_enterprise_schema.sql' END

  UNION ALL SELECT 'portfolios_select policy (super_admin bypass)',
    CASE WHEN EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='portfolios' AND policyname='portfolios_select')
    THEN 'PASS' ELSE 'MISSING - run 20260408_enterprise_schema.sql' END

) t

ORDER BY category, status DESC, check_name;
