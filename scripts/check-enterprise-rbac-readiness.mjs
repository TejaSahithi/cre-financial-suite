#!/usr/bin/env node
import fs from "node:fs";

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function includesAll(source, needles) {
  return needles.filter((needle) => !source.includes(needle));
}

const files = {
  migration: "supabase/migrations/20260907000000_enterprise_rbac_scope_approval_foundation.sql",
  rlsRepairMigration: "supabase/migrations/20260908000000_repair_enterprise_role_write_access_and_invite_status.sql",
  authEngine: "src/lib/authorizationEngine.js",
  rbac: "src/lib/rbac.js",
  userPermissions: "src/lib/userPermissions.js",
  customRoleService: "src/services/customRoleService.js",
  approvalPolicyService: "src/services/approvalPolicyService.js",
  approvalWorkflowEngine: "src/services/approvalWorkflowEngine.js",
  moduleAdapters: "src/services/moduleApprovalAdapters.js",
  moduleBridge: "src/services/moduleApprovalWorkflowBridge.js",
  tenantEmailService: "src/services/tenantEmailService.js",
  criticalDateService: "src/services/criticalDateService.js",
  approvalsPage: "src/pages/Approvals.jsx",
  approvalPoliciesPage: "src/pages/ApprovalPolicies.jsx",
  approvalWorkflowsPage: "src/pages/ApprovalWorkflows.jsx",
  userManagementPage: "src/pages/UserManagement.jsx",
  pagesConfig: "src/pages.config.js",
  layout: "src/Layout.jsx",
  moduleConfig: "src/lib/moduleConfig.js",
  expensesPage: "src/pages/Expenses.jsx",
  createBudgetPage: "src/pages/CreateBudget.jsx",
  leaseReviewPage: "src/pages/LeaseReview.jsx",
  camRunPage: "src/pages/CAMRun.jsx",
  inviteUserFunction: "supabase/functions/invite-user/index.ts",
};

const requiredFiles = [
  ...Object.values(files),
  "src/lib/__tests__/authorizationEngine.test.js",
  "src/lib/__tests__/userPermissionsStandardRoles.test.js",
  "src/services/__tests__/enterpriseWorkflowServices.test.js",
  "src/services/__tests__/tenantAndCriticalDateNotifications.test.js",
  "scripts/enterprise-rbac-postflight.sql",
  "docs/enterprise-rbac-production-readiness.md",
  files.inviteUserFunction,
];

const failures = [];
const warnings = [];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) failures.push({ gate: "required_file_exists", file });
}

const migration = read(files.migration);
const rlsRepairMigration = read(files.rlsRepairMigration);
const authEngine = read(files.authEngine);
const rbac = read(files.rbac);
const userPermissions = read(files.userPermissions);
const workflowEngine = read(files.approvalWorkflowEngine);
const bridge = read(files.moduleBridge);
const pagesConfig = read(files.pagesConfig);
const layout = read(files.layout);
const moduleConfig = read(files.moduleConfig);

const standardRoles = [
  "org_owner",
  "org_admin",
  "portfolio_manager",
  "property_manager",
  "lease_admin",
  "leasing_agent",
  "finance",
  "property_owner",
  "auditor",
  "tenant",
  "custom_role",
];

const migrationTables = [
  "user_scope_assignments",
  "approval_policies",
  "approval_thresholds",
  "approval_workflow_instances",
  "approval_workflow_steps",
  "approval_actions",
  "approval_delegations",
  "tenant_contacts",
  "tenant_email_events",
  "critical_date_notification_rules",
];

const migrationFunctions = [
  "cre_normalize_role",
  "cre_role_permission_allows",
  "cre_user_has_scope",
  "cre_has_permission",
  "cre_approval_limit",
  "cre_can_approve",
];

const migrationRequired = [
  "tenant_portal_enabled BOOLEAN NOT NULL DEFAULT FALSE",
  "approval_limits JSONB NOT NULL DEFAULT '{}'::jsonb",
  "notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb",
  "ENABLE ROW LEVEL SECURITY",
  "scope_type TEXT NOT NULL",
  "current_step_id UUID",
  "require_property_owner_approval",
  "allow_self_approval",
  '"lease":["view","review","reject","comment"]',
  '"cam":["view","create","edit","submit","review","validate","comment","export"]',
  "i.workflow_type || '.validate'",
  "public.cre_can_approve(i.org_id, i.workflow_type, 'property', i.property_id, i.amount, i.submitted_by)",
  "i.workflow_type || '.sign'",
  "ON CONFLICT DO NOTHING",
];

for (const missing of includesAll(migration, [
  ...migrationTables.map((table) => `CREATE TABLE IF NOT EXISTS public.${table}`),
  ...migrationFunctions.map((fn) => `CREATE OR REPLACE FUNCTION public.${fn}`),
  ...migrationRequired,
  ...standardRoles.map((role) => `'${role}'`),
])) {
  failures.push({ gate: "migration_contract", missing });
}

for (const missing of includesAll(rlsRepairMigration, [
  "role_default_page_access",
  "portfolio_manager",
  "public.can_write_page(org_id, 'Buildings')",
  "public.can_write_page(org_id, 'Properties')",
  "m.status = 'invited'",
  "i.status IN ('pending', 'pending_approval')",
])) {
  failures.push({ gate: "rls_repair_migration_contract", missing });
}

for (const table of migrationTables) {
  if (!migration.includes(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`)) {
    failures.push({ gate: "migration_rls_enabled", table });
  }
}

const authEngineExports = [
  "STANDARD_ROLE_DEFINITIONS",
  "AUTHORIZATION_ACTIONS",
  "normalizeRole",
  "roleAllowsPermission",
  "getUserPermissions",
  "hasScope",
  "can(",
  "getApprovalLimit",
  "canApprove",
  "resolveApprovalPolicy",
  "getRequiredApprovalChain",
  "validateRejectionAction",
  "getNotificationRecipients",
];
for (const missing of includesAll(authEngine, authEngineExports)) {
  failures.push({ gate: "authorization_engine_contract", missing });
}
for (const role of standardRoles) {
  if (!authEngine.includes(`${role}:`) && !authEngine.includes(`"${role}"`) && !authEngine.includes(`'${role}'`)) {
    failures.push({ gate: "authorization_engine_standard_role", role });
  }
}

for (const missing of includesAll(rbac, ["org_owner", "property_owner", "custom_role", "Approvals", "ApprovalPolicies"])) {
  failures.push({ gate: "rbac_page_role_access", missing });
}
for (const missing of includesAll(userPermissions, standardRoles)) {
  failures.push({ gate: "user_permissions_standard_role", missing });
}

for (const missing of includesAll(workflowEngine, [
  "ACTION_PERMISSION",
  "getEffectiveWorkflowAction",
  "currentStepAllowsUser",
  "resolveWorkflowActionTransition",
  "current_step_id",
  "approval_workflow_instances",
  "approval_workflow_steps",
  "approval_actions",
  "delegated_from_user_id",
  "delegated_authority_id",
  "requested_action",
  "createNotificationsForEvent",
  "logAudit",
])) {
  failures.push({ gate: "approval_workflow_engine_contract", missing });
}

for (const missing of includesAll(bridge, [
  "submitOrReuseModuleApprovalWorkflow",
  "recordModuleApprovalAction",
  "submitExpenseApprovalWorkflow",
  "submitBudgetApprovalWorkflow",
  "submitLeaseApprovalWorkflow",
  "submitCamApprovalWorkflow",
  "schema_missing",
])) {
  failures.push({ gate: "module_approval_bridge_contract", missing });
}

const pageRegistrations = [
  ["Approvals", files.approvalsPage],
  ["ApprovalPolicies", files.approvalPoliciesPage],
];
for (const [page, file] of pageRegistrations) {
  if (!pagesConfig.includes(`const ${page} = lazy(() => import('./pages/${page}'))`)) {
    failures.push({ gate: "page_lazy_registration", page });
  }
  if (!pagesConfig.includes(`"${page}": ${page}`)) {
    failures.push({ gate: "page_route_registration", page });
  }
  if (!fs.existsSync(file)) failures.push({ gate: "page_component_exists", page, file });
}

for (const missing of includesAll(layout, ["Approval Inbox", "Approval Policies"])) {
  failures.push({ gate: "navigation_entry", missing });
}
for (const missing of includesAll(moduleConfig, ["Approvals", "ApprovalPolicies"])) {
  failures.push({ gate: "module_access_entry", missing });
}

const modulePages = [
  [files.expensesPage, "expense", "recordModuleApprovalAction"],
  [files.createBudgetPage, "budget", "submitOrReuseModuleApprovalWorkflow"],
  [files.leaseReviewPage, "lease", "submitOrReuseModuleApprovalWorkflow"],
  [files.camRunPage, "cam", "recordModuleApprovalAction"],
];
for (const [file, workflowType, marker] of modulePages) {
  const source = read(file);
  for (const missing of includesAll(source, [`workflowType: "${workflowType}"`, marker])) {
    failures.push({ gate: "module_workflow_wiring", file, workflowType, missing });
  }
}

const serviceContracts = [
  [files.customRoleService, ["buildCustomRolePayload", "cloneStandardRoleAsCustomRole", "ensureInlineCustomRoleDefinition", "approvalLimits", "notificationPreferences"]],
  [files.approvalPolicyService, ["buildApprovalPolicyPayload", "resolveApprovalChainForTransaction", "upsertApprovalPolicy", "maybeSingle", ".insert(payload)"]],
  [files.tenantEmailService, ["TENANT_EMAIL_CATEGORIES", "queueTenantEmailEventsForContacts", "tenantContactCanReceive"]],
  [files.criticalDateService, ["resolveCriticalDateReminderPlan", "listCriticalDateNotificationRules"]],
  [files.userManagementPage, ["ensureInlineCustomRoleDefinition", "user_scope_assignments", "custom_role_label", "ApprovalAuthorityEditor", "NotificationPreferencesEditor", "serializeApprovalAuthority", "ROLE_PAGE_ACCESS_LEVELS", "getRoleDefaultPagePerms", "inheritedPermissions", "Role default", "approval_limits", "notification_preferences", "7. Review"]],
  [files.inviteUserFunction, ["org_owner", "property_owner", "approval_limits", "notification_preferences", "role not assignable by your current role"]],
];

for (const [file, markers] of serviceContracts) {
  const source = read(file);
  for (const missing of includesAll(source, markers)) {
    failures.push({ gate: "service_contract_marker", file, missing });
  }
}

const negativeMarkers = [
  [files.approvalPolicyService, 'onConflict: "workflow_type,org_id,scope_type,scope_id"'],
  [files.approvalPolicyService, ".upsert(payload"],
];
for (const [file, marker] of negativeMarkers) {
  if (read(file).includes(marker)) failures.push({ gate: "forbidden_marker_absent", file, marker });
}

const testMarkers = [
  ["src/lib/__tests__/authorizationEngine.test.js", ["cross-organization", "prevents creators from approving their own work", "Property Owners", "delegated Organization Admin approval", "DB-shaped delegations"]],
  ["src/lib/__tests__/userPermissionsStandardRoles.test.js", ["org_owner", "property_owner", "lease_admin", "custom"]],
  ["src/services/__tests__/enterpriseWorkflowServices.test.js", ["resolveWorkflowActionTransition", "getEffectiveWorkflowAction", "delegated authority metadata", "final business approver", "buildApprovalPolicyPayload", "buildApprovalWorkflowInput"]],
  ["src/services/__tests__/tenantAndCriticalDateNotifications.test.js", ["tenant email", "critical date"]],
];
for (const [file, markers] of testMarkers) {
  const source = read(file);
  for (const missing of includesAll(source, markers)) {
    failures.push({ gate: "test_coverage_marker", file, missing });
  }
}

if (!migration.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_policies_active_scope")) {
  warnings.push({ gate: "approval_policy_uniqueness", warning: "active-scope expression index not found" });
}

const phaseCoverage = [
  "business_hierarchy_scope_tables",
  "standard_roles_seeded",
  "org_owner_authority_and_thresholds",
  "org_admin_delegated_authority",
  "portfolio_property_scope_enforcement",
  "custom_role_payloads_and_user_management",
  "approval_policy_precedence_and_thresholds",
  "generic_approval_workflow_engine",
  "expense_budget_lease_cam_workflow_adapters",
  "approval_inbox_ui",
  "approval_policy_admin_ui",
  "notifications_and_recipient_rules",
  "tenant_email_foundation_disabled_by_default",
  "audit_logging_for_role_policy_workflow_actions",
  "tests_static_check_and_db_postflight_path",
];

const dbVerification = {
  required: true,
  migrations: [files.migration, files.rlsRepairMigration],
  postflightSql: "scripts/enterprise-rbac-postflight.sql",
  commands: [
    "Apply supabase/migrations/20260907000000_enterprise_rbac_scope_approval_foundation.sql with your approved Supabase deployment process",
    "Apply supabase/migrations/20260908000000_repair_enterprise_role_write_access_and_invite_status.sql with your approved Supabase deployment process",
    "psql \"$DATABASE_URL\" -f scripts/enterprise-rbac-postflight.sql",
  ],
};

const status = failures.length === 0 ? "static_ready_db_verification_required" : "not_ready";
console.log(JSON.stringify({
  schemaVersion: "enterprise-rbac-readiness-check-v1",
  status,
  phaseCoverage,
  failures,
  warnings,
  dbVerification,
}, null, 2));

if (failures.length > 0) process.exitCode = 1;
