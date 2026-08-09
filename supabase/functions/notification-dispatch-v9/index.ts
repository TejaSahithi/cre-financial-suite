// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isNotificationsEnabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import { buildNotification } from "../_shared/integrations/notification-service.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const TWILIO_FROM_NUMBER = Deno.env.get("TWILIO_FROM_NUMBER") || "";
const TWILIO_MESSAGING_SERVICE_SID = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID") || "";

const CHANNELS = Object.freeze({ EMAIL: "email", SMS: "sms" });
const TYPES = Object.freeze({
  ACTION_REQUIRED: "ACTION_REQUIRED",
  INFORMATIONAL: "INFORMATIONAL",
  WARNING: "WARNING",
  CRITICAL: "CRITICAL",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  CORRECTION_REQUIRED: "CORRECTION_REQUIRED",
});
const ROLES = Object.freeze({
  ORG_OWNER: "org_owner",
  ORG_ADMIN: "org_admin",
  PROPERTY_MANAGER: "property_manager",
  FINANCE: "finance",
  ACCOUNTING: "accounting",
  AUDITOR: "auditor",
  ASSET_OWNER: "asset_owner",
  TENANT: "tenant",
});
const ROLE_ALIASES = Object.freeze({
  owner: ROLES.ORG_OWNER,
  org_owner: ROLES.ORG_OWNER,
  admin: ROLES.ORG_ADMIN,
  org_admin: ROLES.ORG_ADMIN,
  manager: ROLES.PROPERTY_MANAGER,
  property_manager: ROLES.PROPERTY_MANAGER,
  portfolio_manager: ROLES.PROPERTY_MANAGER,
  asset_manager: ROLES.PROPERTY_MANAGER,
  finance: ROLES.FINANCE,
  cfo_controller: ROLES.FINANCE,
  accounts_manager: ROLES.ACCOUNTING,
  accounting: ROLES.ACCOUNTING,
  auditor: ROLES.AUDITOR,
  compliance_officer: ROLES.AUDITOR,
  internal_auditor: ROLES.AUDITOR,
  asset_owner: ROLES.ASSET_OWNER,
  tenant: ROLES.TENANT,
});
const STANDARD_PERMISSIONS = Object.freeze({
  [ROLES.ORG_OWNER]: ["*.*"],
  [ROLES.ORG_ADMIN]: ["*.*"],
  [ROLES.PROPERTY_MANAGER]: [
    "portfolio.view", "property.view", "property.manage",
    "lease.view", "lease.create", "lease.edit", "lease.review", "lease.approve",
    "expense.view", "expense.create", "expense.edit", "expense.review",
    "cam.view", "cam.review",
    "budget.view", "budget.create", "budget.edit", "budget.review",
    "critical_dates.view", "critical_dates.manage",
  ],
  [ROLES.FINANCE]: [
    "expense.view", "expense.review", "expense.approve",
    "cam.view", "cam.review", "cam.approve",
    "budget.view", "budget.review", "budget.approve",
    "critical_dates.view",
  ],
  [ROLES.ACCOUNTING]: [
    "expense.view", "expense.review",
    "cam.view", "cam.review",
    "budget.view", "budget.review",
    "critical_dates.view",
  ],
  [ROLES.AUDITOR]: [
    "lease.view", "lease.review",
    "expense.view", "expense.review",
    "cam.view", "cam.review",
    "budget.view", "budget.review",
    "critical_dates.view",
  ],
});
const PAGE_PERMISSION_PREFIX = Object.freeze({
  Portfolios: "portfolio",
  PortfolioInsights: "portfolio",
  Properties: "property",
  PropertyDetail: "property",
  Leases: "lease",
  LeaseReview: "lease",
  LeaseUpload: "lease",
  LeaseDetail: "lease",
  Expenses: "expense",
  AddExpense: "expense",
  ExpenseReview: "expense",
  LeaseExpenseClassification: "expense",
  CAMDashboard: "cam",
  CAMSetup: "cam",
  CAMRun: "cam",
  CAMApproval: "cam",
  CAMExceptionReview: "cam",
  BudgetDashboard: "budget",
  CreateBudget: "budget",
  BudgetReview: "budget",
  CriticalDates: "critical_dates",
});

const role = (roleKey: string, notificationType: string, options = {}) => ({
  role: roleKey,
  notificationType,
  requiresAction: [
    TYPES.ACTION_REQUIRED,
    TYPES.APPROVAL_REQUIRED,
    TYPES.CORRECTION_REQUIRED,
    TYPES.CRITICAL,
  ].includes(notificationType),
  ...options,
});
const assigned = (notificationType: string, options = {}) => ({ assigned: true, notificationType, requiresAction: true, ...options });
const ownerApproval = (module: string) => ({ module, scope: "ORGANIZATION", finalOrgOwnerApproval: true });

const EVENT_POLICIES = Object.freeze({
  "portfolio.created": {
    module: "portfolio",
    entityType: "portfolio",
    scope: "PORTFOLIO",
    permission: "portfolio.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
    ],
  },
  "portfolio.manager_assigned": {
    module: "portfolio",
    entityType: "portfolio",
    scope: "PORTFOLIO",
    permission: "portfolio.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.ACTION_REQUIRED),
      assigned(TYPES.ACTION_REQUIRED, { permission: "portfolio.manage" }),
    ],
  },
  "property.created": {
    module: "property",
    entityType: "property",
    scope: "PROPERTY",
    permission: "property.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
    ],
  },
  "building.created": {
    module: "property",
    entityType: "building",
    scope: "PROPERTY",
    permission: "property.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
    ],
  },
  "property.manager_assigned": {
    module: "property",
    entityType: "property",
    scope: "PROPERTY",
    permission: "property.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.ACTION_REQUIRED),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
      assigned(TYPES.ACTION_REQUIRED, { permission: "property.manage" }),
    ],
  },
  "property.bulk_import_completed": {
    module: "property",
    entityType: "property",
    scope: "PROPERTY",
    permission: "property.view",
    recipients: [
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      assigned(TYPES.INFORMATIONAL, { permission: "property.view" }),
    ],
  },
  "property.bulk_import_failed": {
    module: "property",
    entityType: "property",
    scope: "PROPERTY",
    permission: "property.view",
    recipients: [
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      assigned(TYPES.ACTION_REQUIRED, { permission: "property.manage" }),
    ],
  },
  "lease.uploaded": {
    module: "lease",
    entityType: "lease",
    scope: "PROPERTY",
    permission: "lease.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      assigned(TYPES.INFORMATIONAL, { permission: "lease.view" }),
    ],
  },
  "lease.extraction_completed": {
    module: "lease",
    entityType: "lease",
    scope: "PROPERTY",
    permission: "lease.view",
    recipients: [
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      role(ROLES.AUDITOR, TYPES.INFORMATIONAL),
      assigned(TYPES.INFORMATIONAL, { permission: "lease.view" }),
    ],
  },
  "lease.review_required": {
    module: "lease",
    entityType: "lease",
    scope: "PROPERTY",
    permission: "lease.review",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.ACTION_REQUIRED, { permission: "lease.review" }),
      role(ROLES.AUDITOR, TYPES.ACTION_REQUIRED, { permission: "lease.review" }),
      assigned(TYPES.INFORMATIONAL, { permission: "lease.view" }),
    ],
  },
  "lease.ready_for_approval": {
    module: "lease",
    entityType: "lease",
    scope: "PROPERTY",
    permission: "lease.approve",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.ACTION_REQUIRED, { permission: "lease.approve" }),
      role(ROLES.ASSET_OWNER, TYPES.ACTION_REQUIRED, { external: true, permission: "lease.approve" }),
      role(ROLES.AUDITOR, TYPES.INFORMATIONAL),
    ],
  },
  "lease.pm_approved": {
    module: "lease",
    entityType: "lease",
    scope: "PROPERTY",
    permission: "lease.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      role(ROLES.ASSET_OWNER, TYPES.ACTION_REQUIRED, { external: true }),
    ],
  },
  "lease.asset_owner_approval_required": {
    module: "lease",
    entityType: "lease",
    scope: "ASSET",
    permission: "lease.approve",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      role(ROLES.ASSET_OWNER, TYPES.ACTION_REQUIRED, { external: true }),
    ],
  },
  "lease.org_owner_approval_required": {
    ...ownerApproval("lease"),
    entityType: "lease",
    permission: "lease.approve",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.APPROVAL_REQUIRED, { permission: "lease.approve" }),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
    ],
  },
  "lease.approved": {
    module: "lease",
    entityType: "lease",
    scope: "PROPERTY",
    permission: "lease.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.APPROVED),
      role(ROLES.ORG_ADMIN, TYPES.APPROVED),
      role(ROLES.PROPERTY_MANAGER, TYPES.APPROVED),
      role(ROLES.ASSET_OWNER, TYPES.APPROVED, { external: true }),
      role(ROLES.AUDITOR, TYPES.APPROVED),
      role(ROLES.TENANT, TYPES.INFORMATIONAL, { external: true, tenantConditional: true }),
      assigned(TYPES.INFORMATIONAL, { permission: "lease.view" }),
    ],
  },
  "lease.rejected": {
    module: "lease",
    entityType: "lease",
    scope: "PROPERTY",
    permission: "lease.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.REJECTED),
      role(ROLES.ORG_ADMIN, TYPES.REJECTED),
      role(ROLES.PROPERTY_MANAGER, TYPES.REJECTED),
      role(ROLES.AUDITOR, TYPES.REJECTED),
      assigned(TYPES.CORRECTION_REQUIRED, { permission: "lease.edit" }),
    ],
  },
  "lease.correction_required": {
    module: "lease",
    entityType: "lease",
    scope: "PROPERTY",
    permission: "lease.edit",
    recipients: [
      role(ROLES.PROPERTY_MANAGER, TYPES.CORRECTION_REQUIRED, { permission: "lease.edit" }),
      role(ROLES.AUDITOR, TYPES.INFORMATIONAL),
      assigned(TYPES.CORRECTION_REQUIRED, { permission: "lease.edit" }),
    ],
  },
  "expense.submitted": {
    module: "expense",
    entityType: "expense",
    scope: "PROPERTY",
    permission: "expense.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.ACTION_REQUIRED, { permission: "expense.review" }),
      role(ROLES.FINANCE, TYPES.ACTION_REQUIRED, { permission: "expense.review" }),
      role(ROLES.ACCOUNTING, TYPES.ACTION_REQUIRED, { permission: "expense.review" }),
    ],
  },
  "expense.review_required": {
    module: "expense",
    entityType: "expense",
    scope: "PROPERTY",
    permission: "expense.review",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.ACTION_REQUIRED, { permission: "expense.review" }),
      role(ROLES.FINANCE, TYPES.ACTION_REQUIRED, { permission: "expense.review" }),
      role(ROLES.ACCOUNTING, TYPES.ACTION_REQUIRED, { permission: "expense.review" }),
      role(ROLES.AUDITOR, TYPES.ACTION_REQUIRED, { permission: "expense.review", when: "audit_required" }),
    ],
  },
  "expense.final_approval_required": {
    ...ownerApproval("expense"),
    entityType: "expense",
    permission: "expense.approve",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.APPROVAL_REQUIRED, { permission: "expense.approve" }),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
      role(ROLES.FINANCE, TYPES.INFORMATIONAL),
      role(ROLES.ACCOUNTING, TYPES.INFORMATIONAL),
      role(ROLES.AUDITOR, TYPES.INFORMATIONAL),
    ],
  },
  "expense.approved": {
    module: "expense",
    entityType: "expense",
    scope: "PROPERTY",
    permission: "expense.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.APPROVED),
      role(ROLES.ORG_ADMIN, TYPES.APPROVED),
      role(ROLES.PROPERTY_MANAGER, TYPES.APPROVED),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
      role(ROLES.FINANCE, TYPES.APPROVED),
      role(ROLES.ACCOUNTING, TYPES.APPROVED),
      role(ROLES.AUDITOR, TYPES.APPROVED),
    ],
  },
  "expense.rejected": {
    module: "expense",
    entityType: "expense",
    scope: "PROPERTY",
    permission: "expense.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.REJECTED),
      role(ROLES.ORG_ADMIN, TYPES.REJECTED),
      role(ROLES.PROPERTY_MANAGER, TYPES.REJECTED),
      role(ROLES.FINANCE, TYPES.REJECTED),
      role(ROLES.ACCOUNTING, TYPES.REJECTED),
      role(ROLES.AUDITOR, TYPES.REJECTED),
      assigned(TYPES.CORRECTION_REQUIRED, { permission: "expense.edit" }),
    ],
  },
  "cam.eligible": {
    module: "cam",
    entityType: "expense",
    scope: "PROPERTY",
    permission: "cam.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
      role(ROLES.FINANCE, TYPES.ACTION_REQUIRED, { permission: "cam.review" }),
      role(ROLES.ACCOUNTING, TYPES.ACTION_REQUIRED, { permission: "cam.review" }),
    ],
  },
  "cam.calculation_generated": {
    module: "cam",
    entityType: "cam",
    scope: "PROPERTY",
    permission: "cam.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
      role(ROLES.FINANCE, TYPES.ACTION_REQUIRED, { permission: "cam.review" }),
      role(ROLES.ACCOUNTING, TYPES.ACTION_REQUIRED, { permission: "cam.review" }),
    ],
  },
  "cam.review_required": {
    module: "cam",
    entityType: "cam",
    scope: "PROPERTY",
    permission: "cam.review",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.ACTION_REQUIRED, { permission: "cam.review" }),
      role(ROLES.FINANCE, TYPES.ACTION_REQUIRED, { permission: "cam.review" }),
      role(ROLES.ACCOUNTING, TYPES.ACTION_REQUIRED, { permission: "cam.review" }),
      role(ROLES.AUDITOR, TYPES.ACTION_REQUIRED, { permission: "cam.review" }),
    ],
  },
  "cam.final_approval_required": {
    ...ownerApproval("cam"),
    entityType: "cam",
    permission: "cam.approve",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.APPROVAL_REQUIRED, { permission: "cam.approve" }),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
      role(ROLES.FINANCE, TYPES.INFORMATIONAL),
      role(ROLES.ACCOUNTING, TYPES.INFORMATIONAL),
      role(ROLES.AUDITOR, TYPES.INFORMATIONAL),
    ],
  },
  "cam.approved": {
    module: "cam",
    entityType: "cam",
    scope: "PROPERTY",
    permission: "cam.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.APPROVED),
      role(ROLES.ORG_ADMIN, TYPES.APPROVED),
      role(ROLES.PROPERTY_MANAGER, TYPES.APPROVED),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
      role(ROLES.FINANCE, TYPES.APPROVED),
      role(ROLES.ACCOUNTING, TYPES.APPROVED),
      role(ROLES.AUDITOR, TYPES.APPROVED),
    ],
  },
  "cam.reconciliation_ready": {
    module: "cam",
    entityType: "cam_reconciliation",
    scope: "TENANT",
    permission: "cam.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
      role(ROLES.FINANCE, TYPES.INFORMATIONAL),
      role(ROLES.ACCOUNTING, TYPES.INFORMATIONAL),
      role(ROLES.TENANT, TYPES.ACTION_REQUIRED, { external: true, tenantPublishedOnly: true }),
    ],
  },
  "budget.generated": {
    module: "budget",
    entityType: "budget",
    scope: "PROPERTY",
    permission: "budget.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
      role(ROLES.FINANCE, TYPES.INFORMATIONAL),
      role(ROLES.ACCOUNTING, TYPES.INFORMATIONAL),
    ],
  },
  "budget.review_required": {
    module: "budget",
    entityType: "budget",
    scope: "PROPERTY",
    permission: "budget.review",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.ACTION_REQUIRED, { permission: "budget.review" }),
      role(ROLES.FINANCE, TYPES.ACTION_REQUIRED, { permission: "budget.review" }),
      role(ROLES.ACCOUNTING, TYPES.ACTION_REQUIRED, { permission: "budget.review" }),
      role(ROLES.AUDITOR, TYPES.ACTION_REQUIRED, { permission: "budget.review", when: "audit_required" }),
    ],
  },
  "budget.final_approval_required": {
    ...ownerApproval("budget"),
    entityType: "budget",
    permission: "budget.approve",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.APPROVAL_REQUIRED, { permission: "budget.approve" }),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
      role(ROLES.FINANCE, TYPES.INFORMATIONAL),
      role(ROLES.ACCOUNTING, TYPES.INFORMATIONAL),
      role(ROLES.AUDITOR, TYPES.INFORMATIONAL),
    ],
  },
  "budget.approved": {
    module: "budget",
    entityType: "budget",
    scope: "PROPERTY",
    permission: "budget.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.APPROVED),
      role(ROLES.ORG_ADMIN, TYPES.APPROVED),
      role(ROLES.PROPERTY_MANAGER, TYPES.APPROVED),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
      role(ROLES.FINANCE, TYPES.APPROVED),
      role(ROLES.ACCOUNTING, TYPES.APPROVED),
      role(ROLES.AUDITOR, TYPES.APPROVED),
    ],
  },
  "budget.rejected": {
    module: "budget",
    entityType: "budget",
    scope: "PROPERTY",
    permission: "budget.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.REJECTED),
      role(ROLES.ORG_ADMIN, TYPES.REJECTED),
      role(ROLES.PROPERTY_MANAGER, TYPES.CORRECTION_REQUIRED, { permission: "budget.edit" }),
      role(ROLES.FINANCE, TYPES.CORRECTION_REQUIRED, { permission: "budget.edit" }),
      role(ROLES.ACCOUNTING, TYPES.CORRECTION_REQUIRED, { permission: "budget.edit" }),
      assigned(TYPES.CORRECTION_REQUIRED, { permission: "budget.edit" }),
    ],
  },
  "critical_date.due_soon": {
    module: "critical_dates",
    entityType: "critical_date",
    scope: "PROPERTY",
    permission: "critical_dates.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.ACTION_REQUIRED, { permission: "critical_dates.manage" }),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
      role(ROLES.TENANT, TYPES.INFORMATIONAL, { external: true, tenantConditional: true }),
      assigned(TYPES.ACTION_REQUIRED, { permission: "critical_dates.manage" }),
    ],
  },
  "critical_date.due_today": {
    module: "critical_dates",
    entityType: "critical_date",
    scope: "PROPERTY",
    permission: "critical_dates.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.ACTION_REQUIRED, { permission: "critical_dates.manage" }),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
      role(ROLES.TENANT, TYPES.INFORMATIONAL, { external: true, tenantConditional: true }),
      assigned(TYPES.ACTION_REQUIRED, { permission: "critical_dates.manage" }),
    ],
  },
  "critical_date.overdue": {
    module: "critical_dates",
    entityType: "critical_date",
    scope: "PROPERTY",
    permission: "critical_dates.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.CRITICAL),
      role(ROLES.ORG_ADMIN, TYPES.CRITICAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.CRITICAL, { permission: "critical_dates.manage" }),
      role(ROLES.ASSET_OWNER, TYPES.INFORMATIONAL, { external: true }),
      role(ROLES.TENANT, TYPES.INFORMATIONAL, { external: true, tenantConditional: true }),
      assigned(TYPES.ACTION_REQUIRED, { permission: "critical_dates.manage" }),
    ],
  },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeId(value: unknown) {
  const text = String(value || "").trim();
  return UUID_RE.test(text) ? text : "";
}

function normalizeObject(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeArray(value: unknown) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeRole(value: unknown, membership = {}) {
  if (membership?.status === "owner") return ROLES.ORG_OWNER;
  const roleKey = String(value || membership?.role || "").trim().toLowerCase();
  return ROLE_ALIASES[roleKey] || roleKey || null;
}

function isActiveStatus(value: unknown) {
  const status = String(value || "active").toLowerCase();
  return ["active", "owner", "approved"].includes(status);
}

function addPermission(set: Set<string>, permission: string) {
  if (permission && permission.includes(".")) set.add(permission);
}

function permissionsFromNestedPayload(payload: unknown) {
  const permissions = new Set<string>();
  Object.entries(normalizeObject(payload)).forEach(([module, value]) => {
    if (value === true) {
      addPermission(permissions, `${module}.*`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((action) => addPermission(permissions, `${module}.${action}`));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([action, allowed]) => {
        if (allowed === true || allowed === "true" || allowed === "yes" || allowed === 1) {
          addPermission(permissions, `${module}.${action}`);
        }
      });
    }
  });
  return permissions;
}

function getMembershipPermissions(membership: any) {
  const permissions = new Set<string>();
  const capabilities = normalizeObject(membership.capabilities);
  [
    normalizeRole(membership.role, membership),
    ...normalizeArray(capabilities.roles).map((item) => normalizeRole(item, membership)),
  ].filter(Boolean).forEach((roleKey) => {
    (STANDARD_PERMISSIONS[roleKey] || []).forEach((permission) => addPermission(permissions, permission));
  });

  [capabilities.permissions, capabilities.notification_permissions, capabilities.custom_permissions, capabilities.privileges, membership.permissions]
    .forEach((source) => permissionsFromNestedPayload(source).forEach((permission) => permissions.add(permission)));

  Object.entries(normalizeObject(membership.page_permissions)).forEach(([page, level]) => {
    const prefix = PAGE_PERMISSION_PREFIX[page];
    const access = String(level || "").toLowerCase();
    if (!prefix) return;
    if (["read", "read_only", "readonly", "view", "write", "edit", "full", "admin", "approve"].includes(access)) {
      addPermission(permissions, `${prefix}.view`);
    }
    if (["write", "edit", "full", "admin", "approve"].includes(access)) {
      addPermission(permissions, `${prefix}.edit`);
    }
    if (["approve", "full", "admin"].includes(access)) {
      addPermission(permissions, `${prefix}.review`);
      addPermission(permissions, `${prefix}.approve`);
    }
  });

  Object.entries(normalizeObject(membership.module_permissions)).forEach(([module, level]) => {
    const access = String(level || "").toLowerCase();
    if (["read", "read_only", "readonly", "view", "write", "edit", "full", "admin", "approve"].includes(access)) {
      addPermission(permissions, `${module}.view`);
    }
    if (["write", "edit", "full", "admin", "approve"].includes(access)) addPermission(permissions, `${module}.edit`);
    if (["approve", "full", "admin"].includes(access)) {
      addPermission(permissions, `${module}.review`);
      addPermission(permissions, `${module}.approve`);
    }
  });

  return permissions;
}

function permissionMatches(candidate: string, required: string) {
  if (!candidate || !required) return false;
  if (candidate === "*.*" || candidate === required) return true;
  const [candidateModule, candidateAction] = candidate.split(".");
  const [requiredModule] = required.split(".");
  return candidateModule === requiredModule && candidateAction === "*";
}

function hasPermission(membership: any, required: string) {
  if (!required) return true;
  return Array.from(getMembershipPermissions(membership)).some((permission) => permissionMatches(permission, required));
}

function userAccessIsActive(grant: any) {
  if (!grant?.is_active && grant?.is_active !== undefined) return false;
  if (!grant?.expires_at) return true;
  return new Date(grant.expires_at).getTime() > Date.now();
}

function memberHasScopeAccess(membership: any, event: any, userAccess: any[]) {
  const roleKey = normalizeRole(membership.role, membership);
  if ([ROLES.ORG_OWNER, ROLES.ORG_ADMIN].includes(roleKey)) return true;

  const scopeAccess = normalizeObject(normalizeObject(membership.capabilities).scope_access);
  if (scopeAccess.all_portfolios || scopeAccess.all_properties) return true;

  const assignedPortfolioIds = new Set([
    ...normalizeArray(membership.assigned_portfolios),
    ...normalizeArray(scopeAccess.portfolio_ids),
  ]);
  const assignedPropertyIds = new Set(normalizeArray(scopeAccess.property_ids));

  if (event.portfolio_id && assignedPortfolioIds.has(event.portfolio_id)) return true;
  if (event.property_id && assignedPropertyIds.has(event.property_id)) return true;

  const grants = userAccess.filter((grant) =>
    grant.user_id === membership.user_id &&
    grant.org_id === event.org_id &&
    userAccessIsActive(grant)
  );
  if (!event.portfolio_id && !event.property_id) return true;
  if (grants.length === 0 && [ROLES.FINANCE, ROLES.ACCOUNTING, ROLES.AUDITOR].includes(roleKey)) return true;

  return grants.some((grant) =>
    (grant.scope === "portfolio" && event.portfolio_id && grant.scope_id === event.portfolio_id) ||
    (grant.scope === "property" && event.property_id && grant.scope_id === event.property_id)
  );
}

function memberMatchesRole(membership: any, roleKey: string) {
  const capabilities = normalizeObject(membership.capabilities);
  return [
    normalizeRole(membership.role, membership),
    ...normalizeArray(capabilities.roles).map((item) => normalizeRole(item, membership)),
  ].includes(roleKey);
}

function conditionMatches(rule: any, event: any) {
  if (rule.when === "audit_required") return Boolean(event.audit_required || event.metadata?.audit_required);
  if (rule.tenantConditional) return Boolean(event.tenant_id || event.metadata?.tenant_related);
  if (rule.tenantPublishedOnly) return Boolean(event.tenant_id && (event.published_to_tenant || event.metadata?.published_to_tenant));
  return true;
}

function requiredPermission(rule: any, policy: any) {
  return rule.permission || policy.permission || null;
}

function titleFor(event: any, rule: any) {
  if (event.title) return event.title;
  const base = String(event.event_type || "Notification").replace(/\./g, " ");
  if (rule.notificationType === TYPES.APPROVAL_REQUIRED) return `${base} requires approval`;
  if (rule.notificationType === TYPES.ACTION_REQUIRED) return `${base} requires action`;
  return base.replace(/\b\w/g, (char) => char.toUpperCase());
}

function messageFor(event: any, rule: any) {
  if (event.message) return event.message;
  if (rule.notificationType === TYPES.APPROVAL_REQUIRED) return `${event.entity_label || event.entity_type || "This item"} requires your approval.`;
  if (rule.notificationType === TYPES.CORRECTION_REQUIRED) return `${event.entity_label || event.entity_type || "This item"} requires correction before the workflow can continue.`;
  return `${event.entity_label || event.entity_type || "A workflow item"} has an update.`;
}

function addRecipient(map: Map<string, any>, event: any, policy: any, rule: any, recipient: any, reason: any) {
  const key = recipient.userId ? `user:${recipient.userId}` : `external:${recipient.externalType || "contact"}:${recipient.id || recipient.email}`;
  if (!key || key.endsWith(":undefined")) return;
  const existing = map.get(key);
  const reasonPayload = {
    role: reason.role || rule.role || null,
    permission: requiredPermission(rule, policy),
    scope: policy.scope,
    source: reason.source,
  };

  if (existing) {
    existing.matching_reasons.push(reasonPayload);
    if (rule.requiresAction) existing.requires_action = true;
    if (rule.notificationType === TYPES.APPROVAL_REQUIRED) existing.notification_type = TYPES.APPROVAL_REQUIRED;
    return;
  }

  map.set(key, {
    ...recipient,
    key,
    event_type: event.event_type,
    module: policy.module,
    entity_type: event.entity_type || policy.entityType,
    entity_id: event.entity_id || null,
    org_id: event.org_id,
    portfolio_id: event.portfolio_id || null,
    property_id: event.property_id || null,
    tenant_id: event.tenant_id || null,
    notification_type: rule.notificationType,
    title: titleFor(event, rule),
    message: messageFor(event, rule),
    action_url: event.action_url || event.link || "",
    requires_action: Boolean(rule.requiresAction),
    matching_reasons: [reasonPayload],
    channels: [CHANNELS.EMAIL, CHANNELS.SMS],
  });
}

function resolveInternalRecipients(event: any, policy: any, rule: any, context: any, map: Map<string, any>) {
  if (!conditionMatches(rule, event)) return;
  const assignedUserIds = new Set([
    ...normalizeArray(event.assigned_user_ids),
    ...normalizeArray(event.responsible_user_ids),
    ...normalizeArray(event.participant_user_ids),
    event.assigned_user_id,
    event.created_by,
  ].filter(Boolean));

  context.memberships.forEach((membership: any) => {
    const isAssignedMatch = rule.assigned && assignedUserIds.has(membership.user_id);
    const isRoleMatch = rule.role ? memberMatchesRole(membership, rule.role) : false;
    const permission = requiredPermission(rule, policy);
    const capabilities = normalizeObject(membership.capabilities);
    const isCustomPermissionMatch = Boolean(capabilities.custom_role || normalizeArray(capabilities.roles).includes("custom")) &&
      Boolean(permission) &&
      hasPermission(membership, permission);

    if (!isAssignedMatch && !isRoleMatch && !isCustomPermissionMatch) return;
    if (permission && !hasPermission(membership, permission)) return;
    if (!memberHasScopeAccess(membership, event, context.userAccess)) return;

    const profile = context.profilesByUserId[membership.user_id] || {};
    addRecipient(map, event, policy, rule, {
      userId: membership.user_id,
      email: profile.email || membership.email || "",
      phone: membership.phone || profile.phone || "",
      displayName: profile.full_name || membership.full_name || membership.user_id,
    }, {
      role: normalizeRole(membership.role, membership),
      source: isAssignedMatch ? "assignment" : (isCustomPermissionMatch ? "custom_permission" : "role"),
    });
  });
}

function stakeholderMatches(stakeholder: any, event: any, roleKey: string) {
  const stakeholderRole = normalizeRole(stakeholder.role || stakeholder.type || stakeholder.stakeholder_type);
  if (roleKey === ROLES.ASSET_OWNER && stakeholderRole !== ROLES.ASSET_OWNER) return false;
  if (roleKey === ROLES.TENANT && stakeholderRole !== ROLES.TENANT) return false;
  if (stakeholder.org_id && stakeholder.org_id !== event.org_id) return false;
  if (roleKey === ROLES.ASSET_OWNER && event.asset_owner_id && stakeholder.id !== event.asset_owner_id && stakeholder.user_id !== event.asset_owner_id) return false;
  if (roleKey === ROLES.TENANT && event.tenant_id && stakeholder.tenant_id !== event.tenant_id && stakeholder.id !== event.tenant_id) return false;
  if (stakeholder.property_id && event.property_id && stakeholder.property_id !== event.property_id) return false;
  if (stakeholder.portfolio_id && event.portfolio_id && stakeholder.portfolio_id !== event.portfolio_id) return false;
  return true;
}

function resolveExternalRecipients(event: any, policy: any, rule: any, context: any, map: Map<string, any>) {
  if (!rule.external || !conditionMatches(rule, event)) return;
  context.stakeholders.forEach((stakeholder: any) => {
    if (!stakeholderMatches(stakeholder, event, rule.role)) return;
    addRecipient(map, event, policy, rule, {
      id: stakeholder.id || stakeholder.user_id || stakeholder.email,
      externalType: rule.role,
      email: stakeholder.email || "",
      phone: stakeholder.phone || stakeholder.mobile || "",
      displayName: stakeholder.name || stakeholder.full_name || stakeholder.email,
    }, { role: rule.role, source: "external_scope" });
  });
}

function resolveRecipients(event: any, policy: any, context: any) {
  const map = new Map();
  policy.recipients.forEach((rule: any) => {
    resolveInternalRecipients(event, policy, rule, context, map);
    resolveExternalRecipients(event, policy, rule, context, map);
  });
  return Array.from(map.values());
}

async function fetchContext(supabaseAdmin: any, orgId: string) {
  const [membershipsResult, userAccessResult, stakeholdersResult] = await Promise.all([
    supabaseAdmin
      .from("memberships")
      .select("user_id, org_id, role, status, phone, custom_role, assigned_portfolios, capabilities, module_permissions, page_permissions")
      .eq("org_id", orgId),
    supabaseAdmin
      .from("user_access")
      .select("user_id, org_id, scope, scope_id, role, is_active, expires_at")
      .eq("org_id", orgId)
      .eq("is_active", true),
    supabaseAdmin
      .from("stakeholders")
      .select("id, org_id, property_id, name, email, role")
      .eq("org_id", orgId),
  ]);
  if (membershipsResult.error) throw membershipsResult.error;
  if (userAccessResult.error) throw userAccessResult.error;
  if (stakeholdersResult.error) throw stakeholdersResult.error;

  const memberships = (membershipsResult.data || []).filter((membership: any) => isActiveStatus(membership.status));
  const userIds = [...new Set(memberships.map((membership: any) => membership.user_id).filter(Boolean))];
  const profilesResult = userIds.length
    ? await supabaseAdmin.from("profiles").select("id, email, full_name, phone").in("id", userIds)
    : { data: [], error: null };
  if (profilesResult.error) throw profilesResult.error;

  return {
    memberships,
    userAccess: userAccessResult.data || [],
    stakeholders: stakeholdersResult.data || [],
    profilesByUserId: Object.fromEntries((profilesResult.data || []).map((profile: any) => [profile.id, profile])),
  };
}

function escapeHtml(value: unknown) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function emailHtml(title: string, message: string, actionUrl: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CRE Platform</title>
  <style>
    body { margin: 0; padding: 0; background: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .wrapper { max-width: 600px; margin: 40px auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; }
    .header { padding: 28px 36px; background: linear-gradient(135deg, #1a2744 0%, #2d4a8a 100%); color: #ffffff; font-size: 18px; font-weight: 700; }
    .body { padding: 32px 36px; color: #475569; line-height: 1.6; font-size: 15px; }
    .body h1 { color: #0f172a; margin: 0 0 12px; font-size: 24px; }
    .button { display: inline-block; margin-top: 20px; padding: 12px 18px; border-radius: 10px; background: #1d4ed8; color: #ffffff; text-decoration: none; font-weight: 600; }
    .footer { border-top: 1px solid #e2e8f0; background: #f8fafc; padding: 18px 36px; text-align: center; color: #94a3b8; font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">CRE Platform</div>
    <div class="body">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${actionUrl ? `<a class="button" href="${escapeHtml(actionUrl)}">Open in CRE Platform</a>` : ""}
    </div>
    <div class="footer">CRE Platform · support@cresuite.org</div>
  </div>
</body>
</html>`;
}

async function resolveRecipientEmail(supabaseAdmin: any, recipient: any) {
  if (recipient.email) return recipient.email;
  if (!recipient.userId) return "";
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(recipient.userId);
  if (error) {
    console.error("[notification-dispatch-v9] auth recipient lookup failed:", error.message);
    return "";
  }
  return data?.user?.email || "";
}

async function sendEmail(to: string, title: string, message: string, actionUrl: string) {
  if (!RESEND_API_KEY) return { status: "failed", error_message: "RESEND_API_KEY is not configured" };
  if (!to) return { status: "skipped", error_message: "Recipient has no email address" };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "CRE Platform <support@cresuite.org>",
      to: [to],
      subject: `CRE Platform Notification: ${title}`,
      html: emailHtml(title, message, actionUrl),
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      status: "failed",
      error_message: payload?.message || payload?.error || "Failed to send email",
      provider_message_id: null,
    };
  }
  return { status: "sent", provider_message_id: payload?.id || null, sent_at: new Date().toISOString() };
}

function normalizePhone(value: unknown) {
  const phone = String(value || "").trim();
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : "";
}

async function sendSms(to: string, message: string) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || (!TWILIO_FROM_NUMBER && !TWILIO_MESSAGING_SERVICE_SID)) {
    return { status: "failed", error_message: "Twilio SMS provider is not configured" };
  }

  const normalizedTo = normalizePhone(to);
  if (!normalizedTo) return { status: "skipped", error_message: "Recipient has no valid E.164 phone number" };

  const form = new URLSearchParams();
  form.set("To", normalizedTo);
  form.set("Body", message.replace(/\s+/g, " ").trim().slice(0, 1600));
  if (TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", TWILIO_FROM_NUMBER);

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { status: "failed", error_message: payload?.message || "Failed to send SMS", provider_message_id: null };
  }
  return { status: "sent", provider_message_id: payload?.sid || null, sent_at: new Date().toISOString() };
}

async function logAudit(supabaseAdmin: any, payload: any) {
  await supabaseAdmin.from("audit_logs").insert({
    action: payload.action,
    entity_type: "Notification",
    entity_id: payload.entity_id || null,
    org_id: payload.org_id,
    actor_user_id: payload.actor_user_id || null,
    severity: payload.severity || "info",
    source: "edge_function",
    metadata: payload.metadata || {},
  });
}

async function createNotification(supabaseAdmin: any, event: any, recipient: any) {
  const { data, error } = await supabaseAdmin
    .from("notifications")
    .insert({
      org_id: event.org_id,
      organization_id: event.org_id,
      recipient_user_id: recipient.userId || null,
      event_type: event.event_type,
      module: recipient.module,
      entity_type: recipient.entity_type,
      entity_id: recipient.entity_id,
      portfolio_id: recipient.portfolio_id,
      property_id: recipient.property_id,
      tenant_id: recipient.tenant_id,
      notification_type: recipient.notification_type,
      type: event.event_type,
      title: recipient.title,
      message: recipient.message,
      action_url: recipient.action_url,
      link: recipient.action_url || recipient.entity_id || "",
      is_read: false,
      read_at: null,
      requires_action: recipient.requires_action,
      priority: recipient.requires_action ? "high" : "normal",
      metadata: {
        ...(event.metadata || {}),
        external_type: recipient.externalType || null,
        external_recipient_id: recipient.id || null,
        matching_reasons: recipient.matching_reasons,
        channels: recipient.channels,
        source: "notification_dispatch_v9",
      },
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function createDelivery(supabaseAdmin: any, notificationId: string, channel: string, destination: string, result: any) {
  await supabaseAdmin.from("notification_deliveries").insert({
    notification_id: notificationId,
    channel,
    destination: destination || null,
    status: result.status,
    provider_message_id: result.provider_message_id || null,
    attempts: result.status === "skipped" ? 0 : 1,
    sent_at: result.sent_at || null,
    delivered_at: result.delivered_at || null,
    failed_at: result.status === "failed" ? new Date().toISOString() : null,
    error_message: result.error_message || null,
  });
}

async function dispatchBusinessEvent(req: Request, body: any) {
  const { user, supabaseAdmin, isInternal } = await verifyUser(req);
  const requestedOrgId = normalizeId(body.org_id || body.orgId || body.organization_id || body.organizationId);
  const orgId = requestedOrgId || await getUserOrgId(user.id, supabaseAdmin, req);
  const eventType = String(body.event_type || body.type || "").trim();
  const policy = EVENT_POLICIES[eventType];
  if (!eventType || !policy) {
    return jsonResponse({ error: true, message: `Unsupported notification event: ${eventType || "missing"}` }, 400);
  }

  if (!isInternal) {
    const { data: callerMembership, error } = await supabaseAdmin
      .from("memberships")
      .select("user_id, org_id, role, status")
      .eq("org_id", orgId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (error || !callerMembership || !isActiveStatus(callerMembership.status)) {
      return jsonResponse({ error: true, message: "Caller is not an active member of this organization" }, 403);
    }
  }

  const event = {
    ...body,
    org_id: orgId,
    organization_id: orgId,
    event_type: eventType,
    metadata: normalizeObject(body.metadata),
    entity_type: body.entity_type || policy.entityType,
    entity_id: normalizeId(body.entity_id || body.entityId || body.id),
    portfolio_id: normalizeId(body.portfolio_id || body.portfolioId),
    property_id: normalizeId(body.property_id || body.propertyId),
    tenant_id: normalizeId(body.tenant_id || body.tenantId),
    asset_owner_id: normalizeId(body.asset_owner_id || body.assetOwnerId),
    entity_label: body.entity_label || body.entityLabel || body.portfolio_name || body.portfolioName || body.name,
    action_url: body.action_url || body.actionUrl || body.link || "",
    created_by: body.created_by || body.createdBy || user.id,
  };

  const context = await fetchContext(supabaseAdmin, orgId);
  const recipients = resolveRecipients(event, policy, context);
  const notifications = [];

  await logAudit(supabaseAdmin, {
    action: "notification_event_created",
    org_id: orgId,
    actor_user_id: isInternal ? null : user.id,
    metadata: {
      event_type: eventType,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      portfolio_id: event.portfolio_id,
      property_id: event.property_id,
      recipient_count: recipients.length,
      source: "notification_dispatch_v9",
    },
  });

  for (const recipient of recipients) {
    const notification = await createNotification(supabaseAdmin, event, recipient);
    const email = await resolveRecipientEmail(supabaseAdmin, recipient);
    const phone = normalizePhone(recipient.phone);
    const emailResult = await sendEmail(email, recipient.title, recipient.message, recipient.action_url);
    const smsResult = await sendSms(phone, recipient.message);

    await createDelivery(supabaseAdmin, notification.id, CHANNELS.EMAIL, email, emailResult);
    await createDelivery(supabaseAdmin, notification.id, CHANNELS.SMS, phone, smsResult);

    await logAudit(supabaseAdmin, {
      action: "notification_recipient_dispatched",
      entity_id: notification.id,
      org_id: orgId,
      actor_user_id: isInternal ? null : user.id,
      severity: [emailResult.status, smsResult.status].includes("failed") ? "warning" : "info",
      metadata: {
        event_type: eventType,
        recipient_user_id: recipient.userId || null,
        external_recipient_id: recipient.id || null,
        email_status: emailResult.status,
        sms_status: smsResult.status,
        email_error: emailResult.error_message || null,
        sms_error: smsResult.error_message || null,
        matching_reasons: recipient.matching_reasons,
      },
    });

    notifications.push({
      notification_id: notification.id,
      recipient_user_id: recipient.userId || null,
      external_recipient_id: recipient.id || null,
      email_status: emailResult.status,
      sms_status: smsResult.status,
    });
  }

  return jsonResponse({
    schemaVersion: "notification-dispatch-response-v2",
    success: true,
    event_type: eventType,
    recipient_count: recipients.length,
    notifications,
  });
}

if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: true, message: "Method not allowed" }, 405);

  try {
    if (!isNotificationsEnabled()) return jsonResponse({ error: true, message: "Notifications are disabled" }, 403);
    const body = await req.json().catch(() => ({}));

    if (body.templateKey && body.channel) {
      const { user, supabaseAdmin } = await verifyUser(req);
      const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
      const notification = buildNotification({
        organizationId: orgId,
        templateKey: body.templateKey,
        channel: body.channel,
        recipientType: body.recipientType,
        recipientKey: body.recipientKey,
        payload: body.payload ?? {},
        eventId: body.eventId ?? null,
        workflowTaskId: body.workflowTaskId ?? null,
        scheduledAt: body.scheduledAt,
      });
      return jsonResponse({ schemaVersion: "notification-dispatch-response-v1", notification });
    }

    return await dispatchBusinessEvent(req, body);
  } catch (error: any) {
    console.error(`[notification-dispatch-v9] ${error?.message ?? error}`);
    return jsonResponse({ error: true, message: error?.message ?? "Notification dispatch failed" }, 500);
  }
});
