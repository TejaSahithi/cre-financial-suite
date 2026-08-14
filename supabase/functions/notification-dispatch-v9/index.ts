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
const BRAND_NAME = "ProForma OS";
const SUPPORT_EMAIL = "support@proformaos.ai";
const DEFAULT_FRONTEND_URL = "https://www.proformaos.ai";
function resolveFrontendUrl(value?: string | null) {
  const url = String(value || "").trim().replace(/\/$/, "");
  return url && !/(vercel\.app|localhost)/i.test(url) ? url : DEFAULT_FRONTEND_URL;
}
const APP_BASE_URL = resolveFrontendUrl(Deno.env.get("FRONTEND_URL") || Deno.env.get("SITE_URL"));
const FROM_DEFAULT = `${BRAND_NAME} <${SUPPORT_EMAIL}>`;
const LOGO_URL = `${APP_BASE_URL}/assets/proforma-os-logo.png`;

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
  "unit.created": {
    module: "property",
    entityType: "unit",
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
      assigned(TYPES.APPROVAL_REQUIRED),
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
  "lease_rule.review_required": {
    module: "lease",
    entityType: "lease_expense_rule",
    scope: "PROPERTY",
    permission: "lease.review",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.ACTION_REQUIRED, { permission: "lease.review" }),
      role(ROLES.FINANCE, TYPES.ACTION_REQUIRED, { permission: "cam.review" }),
      role(ROLES.ACCOUNTING, TYPES.ACTION_REQUIRED, { permission: "cam.review" }),
      role(ROLES.AUDITOR, TYPES.INFORMATIONAL),
    ],
  },
  "lease_rule.approved": {
    module: "lease",
    entityType: "lease_expense_rule",
    scope: "PROPERTY",
    permission: "lease.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.APPROVED),
      role(ROLES.ORG_ADMIN, TYPES.APPROVED),
      role(ROLES.PROPERTY_MANAGER, TYPES.APPROVED),
      role(ROLES.FINANCE, TYPES.INFORMATIONAL),
      role(ROLES.ACCOUNTING, TYPES.INFORMATIONAL),
      role(ROLES.AUDITOR, TYPES.INFORMATIONAL),
    ],
  },
  "lease_rule.rejected": {
    module: "lease",
    entityType: "lease_expense_rule",
    scope: "PROPERTY",
    permission: "lease.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.REJECTED),
      role(ROLES.ORG_ADMIN, TYPES.REJECTED),
      role(ROLES.PROPERTY_MANAGER, TYPES.CORRECTION_REQUIRED, { permission: "lease.edit" }),
      role(ROLES.FINANCE, TYPES.INFORMATIONAL),
      role(ROLES.ACCOUNTING, TYPES.INFORMATIONAL),
      role(ROLES.AUDITOR, TYPES.INFORMATIONAL),
    ],
  },
  "lease_rule.published_to_cam": {
    module: "cam",
    entityType: "lease_expense_rule",
    scope: "PROPERTY",
    permission: "cam.view",
    recipients: [
      role(ROLES.ORG_OWNER, TYPES.INFORMATIONAL),
      role(ROLES.ORG_ADMIN, TYPES.INFORMATIONAL),
      role(ROLES.PROPERTY_MANAGER, TYPES.INFORMATIONAL),
      role(ROLES.FINANCE, TYPES.ACTION_REQUIRED, { permission: "cam.review" }),
      role(ROLES.ACCOUNTING, TYPES.ACTION_REQUIRED, { permission: "cam.review" }),
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
      assigned(TYPES.APPROVAL_REQUIRED),
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
      assigned(TYPES.APPROVAL_REQUIRED),
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
      assigned(TYPES.APPROVAL_REQUIRED),
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

const EVENT_EMAIL_TEMPLATES = Object.freeze({
  "portfolio.created": {
    title: "Portfolio Created",
    summary: "A new portfolio has been created and is now available for organizational tracking, property assignment, budgeting, CAM workflows, and reporting.",
    impact: "Portfolio-level access, ownership visibility, and downstream property setup can now begin.",
    nextStep: "Review the portfolio record, confirm ownership and manager assignments, and add the required property details before financial workflows begin.",
    actionLabel: "Open Portfolio",
  },
  "portfolio.manager_assigned": {
    title: "Portfolio Manager Assigned",
    summary: "Portfolio responsibility has been assigned or updated.",
    impact: "The assigned manager is now expected to maintain portfolio data quality, coordinate property setup, and monitor related workflow activity.",
    nextStep: "Review the portfolio assignment and confirm that the responsible manager has the correct access and operating context.",
    actionLabel: "Review Assignment",
  },
  "property.created": {
    title: "Property Created",
    summary: "A new property has been added to the organization.",
    impact: "Property facts such as rentable area, ownership, address, CAM setup, and building/unit structure are required before reliable budgets or allocations can be produced.",
    nextStep: "Complete the property profile and confirm hierarchy, square footage, and operating assumptions.",
    actionLabel: "Open Property",
  },
  "building.created": {
    title: "Building Created",
    summary: "A new building has been added under a property.",
    impact: "Building-level setup can affect rentable square footage, unit allocation, recoverability analysis, and CAM charge calculations.",
    nextStep: "Verify building details, rentable area, unit structure, and any property-level allocation assumptions.",
    actionLabel: "Open Building",
  },
  "unit.created": {
    title: "Unit Created",
    summary: "A new unit has been added under a property or building.",
    impact: "Unit-level setup can affect tenant occupancy, rentable square footage, lease linkage, recovery allocation, and CAM charge calculations.",
    nextStep: "Verify unit number, rentable square footage, occupancy status, tenant linkage, and building/property hierarchy.",
    actionLabel: "Open Unit",
  },
  "property.manager_assigned": {
    title: "Property Manager Assigned",
    summary: "Property management responsibility has been assigned or updated.",
    impact: "The assigned manager is now accountable for property data quality and operating workflow follow-up.",
    nextStep: "Review the assignment and confirm the manager has the required access to property, lease, expense, CAM, and budget workflows.",
    actionLabel: "Review Property",
  },
  "property.bulk_import_completed": {
    title: "Property Import Completed",
    summary: "A property master-data import has completed.",
    impact: "Imported data should be reviewed before it is used in lease, expense, budget, CAM, or reporting workflows.",
    nextStep: "Review imported records, confirm rejected or skipped rows, and validate required property hierarchy fields.",
    actionLabel: "Review Import",
  },
  "property.bulk_import_failed": {
    title: "Property Import Failed",
    summary: "A property master-data import could not be completed successfully.",
    impact: "Missing or failed master-data imports can block property setup, lease linking, square-footage validation, budgeting, and CAM allocation.",
    nextStep: "Open the import results, correct the rejected rows or file format, and rerun the import.",
    actionLabel: "Review Import Errors",
  },
  "lease.uploaded": {
    title: "Lease Uploaded",
    summary: "A lease document has been uploaded and is ready for intake processing.",
    impact: "The lease cannot feed critical dates, rent schedules, budgets, CAM rules, or reporting until extraction and review are completed.",
    nextStep: "Monitor processing status and review the extracted lease when it becomes available.",
    actionLabel: "Open Lease Upload",
  },
  "lease.extraction_completed": {
    title: "Lease Extraction Completed",
    summary: "Lease extraction has completed and extracted terms are available for review.",
    impact: "Extracted lease facts should be validated before they become the approved system of record.",
    nextStep: "Review required fields, confidence, source evidence, rent terms, recovery obligations, and approval readiness.",
    actionLabel: "Review Lease",
  },
  "lease.review_required": {
    title: "Lease Review Required",
    summary: "A lease requires reviewer attention before it can be approved.",
    impact: "Approval blockers, missing evidence, low-confidence fields, or manual review items may prevent downstream budget and CAM workflows.",
    nextStep: "Open the lease review queue, resolve required blockers, and confirm source-backed values before approval.",
    actionLabel: "Open Lease Review",
  },
  "lease.ready_for_approval": {
    title: "Lease Ready for Approval",
    summary: "A lease has reached the approval stage and requires final review.",
    impact: "Once approved, lease terms may drive rent projections, critical dates, expense rules, budgets, CAM setup, and reporting.",
    nextStep: "Review the approval summary and approve only after required terms and supporting evidence are complete.",
    actionLabel: "Approve Lease",
  },
  "lease.pm_approved": {
    title: "Lease Manager Approval Completed",
    summary: "The property manager review step has been completed.",
    impact: "The lease may now require asset owner or organization owner review before becoming final.",
    nextStep: "Review the approval status and complete any remaining approval steps.",
    actionLabel: "Review Lease Status",
  },
  "lease.asset_owner_approval_required": {
    title: "Asset Owner Lease Approval Required",
    summary: "A lease requires asset owner approval.",
    impact: "Commercial terms, obligations, and recovery provisions should be approved before downstream finance workflows use this lease.",
    nextStep: "Review the lease abstract, source evidence, and approval summary, then approve or send back for correction.",
    actionLabel: "Review Approval",
  },
  "lease.org_owner_approval_required": {
    title: "Organization Owner Lease Approval Required",
    summary: "A lease requires final organization owner approval.",
    impact: "This approval establishes the lease as an authoritative source for financial operations and controls.",
    nextStep: "Review the final approval package and approve only when the lease abstract is complete and audit-ready.",
    actionLabel: "Open Final Approval",
  },
  "lease.approved": {
    title: "Lease Approved",
    summary: "The lease abstract has been approved and is available for downstream workflows.",
    impact: "Approved lease facts may now support rent projection, critical dates, expense rules, budgets, CAM, and reporting.",
    nextStep: "Confirm that post-approval outputs such as rent schedules, critical dates, and expense rules completed successfully.",
    actionLabel: "Open Approved Lease",
  },
  "lease.rejected": {
    title: "Lease Rejected",
    summary: "A lease approval was rejected or sent back.",
    impact: "The lease cannot be used as an approved source for budgets, CAM, rent projections, or reporting until corrections are completed.",
    nextStep: "Review the rejection reason, correct the lease abstract or source evidence, and resubmit for approval.",
    actionLabel: "Review Rejection",
  },
  "lease.correction_required": {
    title: "Lease Correction Required",
    summary: "A lease requires correction before the workflow can continue.",
    impact: "Unresolved lease corrections can block approval and downstream financial workflows.",
    nextStep: "Open the lease, address the required correction items, and resubmit for review.",
    actionLabel: "Correct Lease",
  },
  "lease_rule.review_required": {
    title: "Lease Expense Rule Review Required",
    summary: "A lease-derived expense or CAM rule requires review.",
    impact: "Unreviewed rules can block CAM setup, budget assumptions, and recoverability decisions.",
    nextStep: "Review the rule evidence, recovery treatment, scope, and approval blockers before publishing to CAM.",
    actionLabel: "Review Rule",
  },
  "lease_rule.approved": {
    title: "Lease Expense Rule Approved",
    summary: "A lease-derived expense or CAM rule has been approved.",
    impact: "Approved rules can be used for expense classification, CAM setup, budget assumptions, and audit traceability.",
    nextStep: "Confirm whether the approved rule has been published to CAM setup or requires additional downstream review.",
    actionLabel: "Open Rule",
  },
  "lease_rule.rejected": {
    title: "Lease Expense Rule Rejected",
    summary: "A lease-derived expense or CAM rule has been rejected or sent back.",
    impact: "Rejected rules should not be used for CAM setup, budget assumptions, or recoverability decisions until corrected.",
    nextStep: "Review the rejection reason, correct the rule evidence or treatment, and resubmit if appropriate.",
    actionLabel: "Review Rejected Rule",
  },
  "lease_rule.published_to_cam": {
    title: "Lease Expense Rule Published to CAM",
    summary: "An approved lease expense rule has been published to CAM setup.",
    impact: "CAM reviewers can now use the approved rule as an input for recoverability, pools, allocations, and charge calculations.",
    nextStep: "Review CAM setup readiness and confirm that related classifications can proceed.",
    actionLabel: "Open CAM Setup",
  },
  "expense.submitted": {
    title: "Expense Submitted",
    summary: "An expense has been submitted for review.",
    impact: "Expense approval and classification determine whether the amount can flow into CAM, budgets, reporting, and reconciliation.",
    nextStep: "Review the expense details, coding, property scope, vendor, amount, and recoverability context.",
    actionLabel: "Review Expense",
  },
  "expense.review_required": {
    title: "Expense Review Required",
    summary: "An expense requires reviewer attention.",
    impact: "Unmatched, conditional, low-confidence, or incomplete classifications can affect recoverability and CAM charges.",
    nextStep: "Open the expense review queue, resolve classification issues, and approve or reject the expense treatment.",
    actionLabel: "Open Expense Review",
  },
  "expense.final_approval_required": {
    title: "Expense Final Approval Required",
    summary: "An expense requires final approval before it can be treated as approved actuals.",
    impact: "Final approval controls whether the expense can support CAM, budget variance, and accounting workflows.",
    nextStep: "Review the expense amount, vendor, period, property scope, recoverability, and supporting evidence before approval.",
    actionLabel: "Approve Expense",
  },
  "expense.approved": {
    title: "Expense Approved",
    summary: "An expense has been approved.",
    impact: "The approved expense may now be available for classification, CAM, budget variance, reporting, and reconciliation workflows.",
    nextStep: "Confirm any downstream classification or CAM handoff that depends on this expense.",
    actionLabel: "Open Expense",
  },
  "expense.rejected": {
    title: "Expense Rejected",
    summary: "An expense has been rejected or sent back for correction.",
    impact: "Rejected expenses will not be used as approved actuals for CAM, budgets, or reconciliation until corrected and approved.",
    nextStep: "Review the rejection reason, correct the record if appropriate, and resubmit for review.",
    actionLabel: "Review Expense",
  },
  "cam.eligible": {
    title: "CAM Item Eligible for Review",
    summary: "A CAM-related item is eligible for review or handoff.",
    impact: "Eligible inputs should be reviewed before they affect tenant recoveries or CAM charge calculations.",
    nextStep: "Review the eligible item and confirm it is ready for CAM processing.",
    actionLabel: "Review CAM Item",
  },
  "cam.calculation_generated": {
    title: "CAM Calculation Generated",
    summary: "A CAM calculation snapshot has been generated.",
    impact: "The snapshot may be used for review, export, tenant charges, and reconciliation support.",
    nextStep: "Review calculation inputs, exceptions, tenant shares, caps, and any material variances before final approval or export.",
    actionLabel: "Open CAM Calculation",
  },
  "cam.review_required": {
    title: "CAM Review Required",
    summary: "A CAM workflow item requires review.",
    impact: "Review may be required because of missing prerequisites, exceptions, stale inputs, or calculation items requiring approval.",
    nextStep: "Open the CAM review queue and resolve blockers before approving or exporting charges.",
    actionLabel: "Open CAM Review",
  },
  "cam.final_approval_required": {
    title: "CAM Final Approval Required",
    summary: "A CAM calculation or reconciliation package requires final approval.",
    impact: "Final approval may authorize tenant billing, statement generation, or official CAM reporting.",
    nextStep: "Review tenant shares, caps, gross-ups, exclusions, variances, and supporting inputs before approval.",
    actionLabel: "Approve CAM Package",
  },
  "cam.approved": {
    title: "CAM Approved",
    summary: "A CAM workflow item has been approved.",
    impact: "Approved CAM outputs may now support billing, exports, reporting, or reconciliation workflows.",
    nextStep: "Confirm the next billing or reporting step and retain the approved snapshot for audit traceability.",
    actionLabel: "Open CAM",
  },
  "cam.reconciliation_ready": {
    title: "CAM Reconciliation Ready",
    summary: "CAM reconciliation output is ready for review or tenant communication.",
    impact: "True-up balances, refunds, charges, and material exceptions should be reviewed before statements are sent.",
    nextStep: "Review tenant-level reconciliation results, variance thresholds, and statement readiness.",
    actionLabel: "Open Reconciliation",
  },
  "budget.generated": {
    title: "Budget Generated",
    summary: "A budget draft has been generated.",
    impact: "The budget should be reviewed against lease, expense, CAM, and prior-period assumptions before submission.",
    nextStep: "Review budget assumptions, variance drivers, and required supporting inputs.",
    actionLabel: "Open Budget",
  },
  "budget.review_required": {
    title: "Budget Review Required",
    summary: "A budget has been submitted for review.",
    impact: "Budget review controls the financial baseline used for forecasting, CAM comparisons, and reporting.",
    nextStep: "Review the budget package, key assumptions, variance explanations, and stakeholder comments.",
    actionLabel: "Review Budget",
  },
  "budget.final_approval_required": {
    title: "Budget Final Approval Required",
    summary: "A budget requires final approval.",
    impact: "Final approval may establish the official budget baseline for the organization, property, or fiscal year.",
    nextStep: "Review final budget totals, major variances, supporting assumptions, and any open rework comments before approval.",
    actionLabel: "Approve Budget",
  },
  "budget.approved": {
    title: "Budget Approved",
    summary: "A budget has been approved.",
    impact: "The approved budget can now be used as the financial baseline for variance analysis, CAM comparison, and reporting.",
    nextStep: "Confirm that downstream reporting and budget dashboard views reflect the approved baseline.",
    actionLabel: "Open Budget Dashboard",
  },
  "budget.rejected": {
    title: "Budget Sent Back for Rework",
    summary: "A budget has been rejected or returned for updates.",
    impact: "The budget cannot be treated as an approved financial baseline until the requested changes are completed and approved.",
    nextStep: "Review the rework comments, update the budget assumptions or line items, and resubmit for review.",
    actionLabel: "Review Budget Rework",
  },
  "critical_date.due_soon": {
    title: "Critical Date Due Soon",
    summary: "A critical date is approaching.",
    impact: "Missed lease, renewal, option, insurance, or compliance dates can create legal, operational, or financial risk.",
    nextStep: "Review the date, confirm ownership, and complete or update the required follow-up action.",
    actionLabel: "Open Critical Date",
  },
  "critical_date.due_today": {
    title: "Critical Date Due Today",
    summary: "A critical date is due today.",
    impact: "Immediate action may be required to prevent a missed deadline or operational escalation.",
    nextStep: "Complete the required action today or update the responsible owner and status.",
    actionLabel: "Open Critical Date",
  },
  "critical_date.overdue": {
    title: "Critical Date Overdue",
    summary: "A critical date is overdue.",
    impact: "Overdue critical dates require prompt escalation because they may represent missed legal, financial, or compliance obligations.",
    nextStep: "Review the overdue item, assign ownership if needed, record the resolution plan, and close the item when complete.",
    actionLabel: "Resolve Overdue Item",
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

function humanize(value: unknown) {
  return String(value || "")
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function templateFor(event: any) {
  return EVENT_EMAIL_TEMPLATES[event.event_type] || {
    title: humanize(event.event_type || "Notification"),
    summary: `A workflow notification was generated in ${BRAND_NAME}.`,
    impact: "Review the record to confirm whether action is required.",
    nextStep: "Open the related record and complete any assigned follow-up.",
    actionLabel: `Open in ${BRAND_NAME}`,
  };
}

function absoluteAppUrl(value: string) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return `${APP_BASE_URL}${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch (_err) {
      return url;
    }
  }
  return `${APP_BASE_URL}${url.startsWith("/") ? url : `/${url}`}`;
}

function metadataValue(event: any, keys: string[]) {
  const metadata = normalizeObject(event.metadata);
  for (const key of keys) {
    const value = event?.[key] ?? metadata?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function formatCurrency(value: unknown) {
  if (value === undefined || value === null || value === "") return "";
  const amount = Number(String(value).replace(/[$,]/g, ""));
  if (!Number.isFinite(amount)) return String(value);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(amount);
}

function formatPercent(value: unknown) {
  if (value === undefined || value === null || value === "") return "";
  const numeric = Number(String(value).replace(/[%]/g, ""));
  if (!Number.isFinite(numeric)) return String(value);
  return `${numeric}${String(value).includes("%") ? "" : "%"}`;
}

function roleLabel(recipient: any) {
  const role = recipient?.matching_reasons?.[0]?.role || recipient?.externalType || "";
  return role ? humanize(role) : "";
}

function notificationTypeLabel(value: unknown) {
  return humanize(String(value || "").toLowerCase());
}

function titleFor(event: any, rule: any) {
  if (event.title) return event.title;
  return templateFor(event).title;
}

function messageFor(event: any, rule: any) {
  if (event.message) return event.message;
  const template = templateFor(event);
  const label = event.entity_label || metadataValue(event, ["record_name", "name", "portfolio_name", "property_name", "lease_name", "tenant_name"]);
  const actionContext = rule.notificationType === TYPES.APPROVAL_REQUIRED
    ? " Approval is required."
    : rule.notificationType === TYPES.ACTION_REQUIRED
      ? " Action is required."
      : rule.notificationType === TYPES.CORRECTION_REQUIRED
        ? " Correction is required."
        : "";
  return `${label ? `${label}: ` : ""}${template.summary}${actionContext}`;
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

function emailDetailRows(event: any, recipient: any) {
  const rows = [
    ["Record", event.entity_label || metadataValue(event, ["record_name", "name", "title"])],
    ["Portfolio", metadataValue(event, ["portfolio_name", "portfolioName"])],
    ["Property", metadataValue(event, ["property_name", "propertyName"])],
    ["Building", metadataValue(event, ["building_name", "buildingName"])],
    ["Unit", metadataValue(event, ["unit_name", "unitName", "unit_number", "unitNumber"])],
    ["Lease", metadataValue(event, ["lease_name", "leaseName", "lease_number", "leaseNumber"])],
    ["Tenant", metadataValue(event, ["tenant_name", "tenantName"])],
    ["Vendor", metadataValue(event, ["vendor_name", "vendorName"])],
    ["Fiscal Year", metadataValue(event, ["fiscal_year", "fiscalYear", "year"])],
    ["Amount", formatCurrency(metadataValue(event, ["amount", "total_amount", "expense_amount", "budget_amount", "variance_amount"]))],
    ["Variance", formatPercent(metadataValue(event, ["variance_pct", "variancePercent", "variance_percent"]))],
    ["Due Date", metadataValue(event, ["due_date", "dueDate", "deadline"])],
    ["Current Status", notificationTypeLabel(metadataValue(event, ["status", "workflow_status", "approval_status"]))],
    ["Recipient Role", roleLabel(recipient)],
    ["Notification Type", notificationTypeLabel(recipient.notification_type)],
  ];
  return rows.filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "");
}

function emailText(model: any) {
  const details = model.details.map(([label, value]: any[]) => `${label}: ${value}`).join("\n");
  return [
    model.title,
    "",
    model.summary,
    "",
    `Why this matters: ${model.impact}`,
    `Next step: ${model.nextStep}`,
    details ? `\nDetails\n${details}` : "",
    model.actionUrl ? `\nOpen in ${BRAND_NAME}: ${model.actionUrl}` : "",
  ].filter(Boolean).join("\n");
}

function buildEmailModel(event: any, recipient: any) {
  const template = templateFor(event);
  const record = event.entity_label || metadataValue(event, ["record_name", "name", "title", "portfolio_name", "property_name", "lease_name"]) || "";
  const title = recipient.title || template.title;
  const summary = recipient.message || messageFor(event, { notificationType: recipient.notification_type });
  const actionRequired = Boolean(recipient.requires_action);
  return {
    title,
    subject: record ? `${title}: ${record}` : title,
    preheader: `${template.summary} ${actionRequired ? "Action may be required." : "Review for awareness."}`,
    summary,
    impact: template.impact,
    nextStep: template.nextStep,
    actionLabel: template.actionLabel || `Open in ${BRAND_NAME}`,
    actionUrl: absoluteAppUrl(recipient.action_url || event.action_url || ""),
    eventType: event.event_type,
    module: humanize(recipient.module || event.entity_type || ""),
    badge: actionRequired ? "Action Required" : notificationTypeLabel(recipient.notification_type || TYPES.INFORMATIONAL),
    details: emailDetailRows(event, recipient),
  };
}

function emailHtml(model: any) {
  const detailRows = model.details.map(([label, value]: any[]) => `
          <tr>
            <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; width: 34%;">${escapeHtml(label)}</td>
            <td style="padding: 10px 12px; border-bottom: 1px solid #e5e7eb; color: #0f172a; font-size: 14px; font-weight: 600;">${escapeHtml(value)}</td>
          </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(model.subject)}</title>
</head>
<body style="margin: 0; padding: 0; background: #f4f7fb; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent;">${escapeHtml(model.preheader)}</div>
  <div style="max-width: 680px; margin: 36px auto; background: #ffffff; border: 1px solid #dbe3ee; border-radius: 18px; overflow: hidden;">
    <div style="padding: 28px 36px; background: linear-gradient(135deg, #0f2a44 0%, #173b5c 100%); color: #ffffff;">
      <img src="${LOGO_URL}" alt="${BRAND_NAME}" style="width: 196px; max-width: 70%; height: auto; display: block; background: #ffffff; border-radius: 8px; padding: 8px 10px;" />
      <div style="margin-top: 8px; font-size: 22px; line-height: 1.2; font-weight: 750;">${escapeHtml(model.module || "Workflow Notification")}</div>
    </div>
    <div style="padding: 34px 36px 30px; color: #334155; line-height: 1.6;">
      <div style="display: inline-block; margin-bottom: 16px; padding: 5px 10px; border-radius: 999px; background: #eef4ff; color: #1d4ed8; font-size: 12px; font-weight: 700;">${escapeHtml(model.badge)}</div>
      <h1 style="margin: 0 0 14px; color: #0f172a; font-size: 28px; line-height: 1.15; font-weight: 760;">${escapeHtml(model.title)}</h1>
      <p style="margin: 0 0 22px; color: #475569; font-size: 15px;">${escapeHtml(model.summary)}</p>
      <div style="margin: 0 0 20px; padding: 16px 18px; border-left: 4px solid #b8893a; background: #fffbeb; border-radius: 10px;">
        <div style="color: #78350f; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em;">Why this matters</div>
        <div style="margin-top: 6px; color: #334155; font-size: 14px;">${escapeHtml(model.impact)}</div>
      </div>
      <div style="margin: 0 0 24px; padding: 16px 18px; border: 1px solid #dbe3ee; background: #f8fafc; border-radius: 10px;">
        <div style="color: #0f2a44; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em;">Next step</div>
        <div style="margin-top: 6px; color: #0f172a; font-size: 14px; font-weight: 600;">${escapeHtml(model.nextStep)}</div>
      </div>
      ${detailRows ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin: 0 0 26px; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden;">${detailRows}</table>` : ""}
      ${model.actionUrl ? `<a href="${escapeHtml(model.actionUrl)}" style="display: inline-block; padding: 13px 18px; border-radius: 10px; background: #173b5c; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 750;">${escapeHtml(model.actionLabel)}</a>` : ""}
    </div>
    <div style="border-top: 1px solid #e2e8f0; background: #f8fafc; padding: 18px 36px; color: #64748b; font-size: 12px; line-height: 1.5;">
      This notification was generated by ${BRAND_NAME} based on your role, assignment, or workflow responsibility.
      <br />${BRAND_NAME} &middot; ${SUPPORT_EMAIL}
    </div>
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

async function sendEmail(to: string, event: any, recipient: any) {
  if (!RESEND_API_KEY) return { status: "failed", error_message: "RESEND_API_KEY is not configured" };
  if (!to) return { status: "skipped", error_message: "Recipient has no email address" };
  const model = buildEmailModel(event, recipient);
  const attachments = sanitizeEmailAttachments(event.email_attachments);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_DEFAULT,
      to: [to],
      subject: `${BRAND_NAME}: ${model.subject}`,
      html: emailHtml(model),
      text: emailText(model),
      ...(attachments.length > 0 ? { attachments } : {}),
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

function sanitizeEmailAttachments(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).map((attachment) => {
    const filename = String(attachment?.filename || "").trim().replace(/[^\w .()-]/g, "_").slice(0, 120);
    const content = String(attachment?.content || "").trim();
    if (!filename || !content) return null;
    if (content.length > 5_600_000) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content)) return null;
    return { filename, content };
  }).filter(Boolean);
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
    email_attachments: sanitizeEmailAttachments(body.email_attachments || body.emailAttachments),
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
    const emailResult = await sendEmail(email, event, recipient);
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
