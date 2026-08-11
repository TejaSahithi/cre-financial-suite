\set ON_ERROR_STOP on

DO $$
DECLARE
  missing TEXT[];
  expected_tables TEXT[] := ARRAY[
    'user_scope_assignments',
    'approval_policies',
    'approval_thresholds',
    'approval_workflow_instances',
    'approval_workflow_steps',
    'approval_actions',
    'approval_delegations',
    'tenant_contacts',
    'tenant_email_events',
    'critical_date_notification_rules'
  ];
  expected_functions TEXT[] := ARRAY[
    'cre_normalize_role',
    'cre_role_permission_allows',
    'cre_user_has_scope',
    'cre_has_permission',
    'cre_approval_limit',
    'cre_can_approve'
  ];
  expected_roles TEXT[] := ARRAY[
    'org_owner',
    'org_admin',
    'portfolio_manager',
    'property_manager',
    'lease_admin',
    'leasing_agent',
    'finance',
    'property_owner',
    'auditor',
    'tenant',
    'custom_role'
  ];
  expected_workflows TEXT[] := ARRAY['expense', 'budget', 'cam', 'lease'];
BEGIN
  SELECT array_agg(table_name)
  INTO missing
  FROM unnest(expected_tables) AS table_name
  WHERE to_regclass(format('public.%I', table_name)) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Enterprise RBAC postflight failed: missing tables %', missing;
  END IF;

  SELECT array_agg(column_name)
  INTO missing
  FROM unnest(ARRAY[
    'organizations.tenant_portal_enabled',
    'memberships.assigned_properties',
    'memberships.assigned_buildings',
    'memberships.assigned_units',
    'memberships.assigned_leases',
    'memberships.approval_limits',
    'memberships.notification_preferences',
    'role_definitions.role_type',
    'role_definitions.permission_set',
    'role_definitions.approval_limits',
    'role_definitions.notification_preferences',
    'role_definitions.is_active'
  ]) AS column_name
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = split_part(column_name, '.', 1)
      AND c.column_name = split_part(column_name, '.', 2)
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Enterprise RBAC postflight failed: missing columns %', missing;
  END IF;

  SELECT array_agg(function_name)
  INTO missing
  FROM unnest(expected_functions) AS function_name
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = function_name
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Enterprise RBAC postflight failed: missing functions %', missing;
  END IF;

  SELECT array_agg(table_name)
  INTO missing
  FROM unnest(expected_tables) AS table_name
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_class cls
    JOIN pg_namespace ns ON ns.oid = cls.relnamespace
    WHERE ns.nspname = 'public'
      AND cls.relname = table_name
      AND cls.relrowsecurity = TRUE
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Enterprise RBAC postflight failed: RLS is not enabled on %', missing;
  END IF;

  SELECT array_agg(role_key)
  INTO missing
  FROM unnest(expected_roles) AS role_key
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.role_definitions rd
    WHERE rd.role_key = role_key
      AND rd.is_active = TRUE
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Enterprise RBAC postflight failed: missing active standard roles %', missing;
  END IF;

  SELECT array_agg(workflow_type)
  INTO missing
  FROM unnest(expected_workflows) AS workflow_type
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.approval_policies p
    WHERE p.workflow_type = workflow_type
      AND p.scope_type = 'system'
      AND p.org_id IS NULL
      AND p.is_active = TRUE
      AND jsonb_array_length(p.thresholds) > 0
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Enterprise RBAC postflight failed: missing active system approval policies %', missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'approval_policies'
      AND indexname = 'idx_approval_policies_active_scope'
  ) THEN
    RAISE EXCEPTION 'Enterprise RBAC postflight failed: missing approval policy active-scope unique index';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.organizations
    WHERE tenant_portal_enabled IS DISTINCT FROM FALSE
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Enterprise RBAC postflight failed: tenant portal must remain disabled by default';
  END IF;
END $$;

SELECT jsonb_pretty(jsonb_build_object(
  'schemaVersion', 'enterprise-rbac-db-postflight-v1',
  'status', 'passed',
  'tablesVerified', ARRAY[
    'user_scope_assignments',
    'approval_policies',
    'approval_thresholds',
    'approval_workflow_instances',
    'approval_workflow_steps',
    'approval_actions',
    'approval_delegations',
    'tenant_contacts',
    'tenant_email_events',
    'critical_date_notification_rules'
  ],
  'functionsVerified', ARRAY[
    'cre_normalize_role',
    'cre_role_permission_allows',
    'cre_user_has_scope',
    'cre_has_permission',
    'cre_approval_limit',
    'cre_can_approve'
  ],
  'rolesVerified', ARRAY[
    'org_owner',
    'org_admin',
    'portfolio_manager',
    'property_manager',
    'lease_admin',
    'leasing_agent',
    'finance',
    'property_owner',
    'auditor',
    'tenant',
    'custom_role'
  ]
));
