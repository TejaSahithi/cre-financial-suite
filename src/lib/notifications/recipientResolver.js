import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  PERMISSION_ACTION_BY_NOTIFICATION_TYPE,
  ROLE_KEYS,
} from "@/lib/notifications/notificationConstants";
import { getNotificationPolicy } from "@/lib/notifications/notificationPolicies";

const ROLE_ALIASES = Object.freeze({
  owner: ROLE_KEYS.ORG_OWNER,
  org_owner: ROLE_KEYS.ORG_OWNER,
  admin: ROLE_KEYS.ORG_ADMIN,
  org_admin: ROLE_KEYS.ORG_ADMIN,
  manager: ROLE_KEYS.PROPERTY_MANAGER,
  property_manager: ROLE_KEYS.PROPERTY_MANAGER,
  portfolio_manager: ROLE_KEYS.PROPERTY_MANAGER,
  asset_manager: ROLE_KEYS.PROPERTY_MANAGER,
  finance: ROLE_KEYS.FINANCE,
  cfo_controller: ROLE_KEYS.FINANCE,
  accounts_manager: ROLE_KEYS.ACCOUNTING,
  accounting: ROLE_KEYS.ACCOUNTING,
  auditor: ROLE_KEYS.AUDITOR,
  compliance_officer: ROLE_KEYS.AUDITOR,
  internal_auditor: ROLE_KEYS.AUDITOR,
  tenant: ROLE_KEYS.TENANT,
  asset_owner: ROLE_KEYS.ASSET_OWNER,
});

const STANDARD_ROLE_PERMISSIONS = Object.freeze({
  [ROLE_KEYS.ORG_OWNER]: ["*.*"],
  [ROLE_KEYS.ORG_ADMIN]: ["*.*"],
  [ROLE_KEYS.PROPERTY_MANAGER]: [
    "portfolio.view", "property.view", "property.manage",
    "lease.view", "lease.create", "lease.edit", "lease.review", "lease.approve",
    "expense.view", "expense.create", "expense.edit", "expense.review",
    "cam.view", "cam.review",
    "budget.view", "budget.create", "budget.edit", "budget.review",
    "critical_dates.view", "critical_dates.manage",
  ],
  [ROLE_KEYS.FINANCE]: [
    "expense.view", "expense.review", "expense.approve",
    "cam.view", "cam.review", "cam.approve",
    "budget.view", "budget.review", "budget.approve",
    "critical_dates.view",
  ],
  [ROLE_KEYS.ACCOUNTING]: [
    "expense.view", "expense.review",
    "cam.view", "cam.review",
    "budget.view", "budget.review",
    "critical_dates.view",
  ],
  [ROLE_KEYS.AUDITOR]: [
    "lease.view", "lease.review",
    "expense.view", "expense.review",
    "cam.view", "cam.review",
    "budget.view", "budget.review",
    "critical_dates.view",
  ],
});

const PAGE_TO_PERMISSION_PREFIX = Object.freeze({
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

function normalizeObject(value) {
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

function normalizeArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

export function normalizeNotificationRole(role, membership = {}) {
  if (membership?.status === "owner") return ROLE_KEYS.ORG_OWNER;
  const raw = String(role || membership?.role || "").trim().toLowerCase();
  if (!raw) return null;
  return ROLE_ALIASES[raw] || raw;
}

export function splitPermission(permission) {
  const [module, action] = String(permission || "").split(".");
  return { module, action };
}

function permissionMatches(candidate, required) {
  if (!candidate || !required) return false;
  if (candidate === "*.*" || candidate === required) return true;
  const left = splitPermission(candidate);
  const right = splitPermission(required);
  return left.module === right.module && left.action === "*";
}

function addPermission(set, permission) {
  if (permission && typeof permission === "string" && permission.includes(".")) {
    set.add(permission);
  }
}

function addPermissionGroup(set, module, actions) {
  normalizeArray(actions).forEach((action) => addPermission(set, `${module}.${action}`));
}

function permissionsFromNestedPayload(payload) {
  const permissions = new Set();
  Object.entries(normalizeObject(payload)).forEach(([module, value]) => {
    if (value === true) {
      addPermission(permissions, `${module}.*`);
      return;
    }
    if (Array.isArray(value)) {
      addPermissionGroup(permissions, module, value);
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

function permissionsFromPagePermissions(pagePermissions) {
  const permissions = new Set();
  Object.entries(normalizeObject(pagePermissions)).forEach(([pageName, level]) => {
    const prefix = PAGE_TO_PERMISSION_PREFIX[pageName];
    if (!prefix) return;
    const normalizedLevel = String(level || "").toLowerCase();
    if (["read", "read_only", "readonly", "view"].includes(normalizedLevel)) {
      addPermission(permissions, `${prefix}.view`);
    }
    if (["write", "edit", "full", "admin", "approve"].includes(normalizedLevel)) {
      addPermission(permissions, `${prefix}.view`);
      addPermission(permissions, `${prefix}.edit`);
    }
    if (["approve", "full", "admin"].includes(normalizedLevel)) {
      addPermission(permissions, `${prefix}.review`);
      addPermission(permissions, `${prefix}.approve`);
    }
  });
  return permissions;
}

function permissionsFromModulePermissions(modulePermissions) {
  const permissions = new Set();
  Object.entries(normalizeObject(modulePermissions)).forEach(([module, level]) => {
    const normalizedLevel = String(level || "").toLowerCase();
    if (["read", "read_only", "readonly", "view", "write", "edit", "full", "admin", "approve"].includes(normalizedLevel)) {
      addPermission(permissions, `${module}.view`);
    }
    if (["write", "edit", "full", "admin", "approve"].includes(normalizedLevel)) {
      addPermission(permissions, `${module}.edit`);
    }
    if (["approve", "full", "admin"].includes(normalizedLevel)) {
      addPermission(permissions, `${module}.review`);
      addPermission(permissions, `${module}.approve`);
    }
  });
  return permissions;
}

export function getMembershipPermissions(membership = {}) {
  const permissions = new Set();
  const roleKeys = [
    normalizeNotificationRole(membership.role, membership),
    ...normalizeArray(normalizeObject(membership.capabilities)?.roles).map((role) => normalizeNotificationRole(role, membership)),
  ].filter(Boolean);

  roleKeys.forEach((roleKey) => {
    (STANDARD_ROLE_PERMISSIONS[roleKey] || []).forEach((permission) => addPermission(permissions, permission));
  });

  const capabilities = normalizeObject(membership.capabilities);
  const customPermissionSources = [
    capabilities.permissions,
    capabilities.notification_permissions,
    capabilities.custom_permissions,
    capabilities.privileges,
    membership.permissions,
  ];

  customPermissionSources.forEach((source) => {
    permissionsFromNestedPayload(source).forEach((permission) => permissions.add(permission));
  });

  permissionsFromPagePermissions(membership.page_permissions).forEach((permission) => permissions.add(permission));
  permissionsFromModulePermissions(membership.module_permissions).forEach((permission) => permissions.add(permission));

  return permissions;
}

export function hasNotificationPermission(membership, requiredPermission) {
  if (!requiredPermission) return true;
  const permissions = getMembershipPermissions(membership);
  return Array.from(permissions).some((permission) => permissionMatches(permission, requiredPermission));
}

function isActiveMembership(membership, orgId) {
  if (!membership) return false;
  if (membership.org_id !== orgId) return false;
  const status = membership.status || "active";
  return ["active", "owner", "approved"].includes(status);
}

function userAccessIsActive(grant) {
  if (!grant?.is_active && grant?.is_active !== undefined) return false;
  if (!grant?.expires_at) return true;
  return new Date(grant.expires_at).getTime() > Date.now();
}

function memberHasScopeAccess(membership, event, context) {
  const roleKey = normalizeNotificationRole(membership.role, membership);
  if ([ROLE_KEYS.ORG_OWNER, ROLE_KEYS.ORG_ADMIN].includes(roleKey)) return true;

  const scopeAccess = normalizeObject(normalizeObject(membership.capabilities).scope_access);
  if (scopeAccess.all_portfolios || scopeAccess.all_properties) return true;

  const assignedPortfolioIds = new Set([
    ...normalizeArray(membership.assigned_portfolios),
    ...normalizeArray(scopeAccess.portfolio_ids),
  ]);
  const assignedPropertyIds = new Set([
    ...normalizeArray(scopeAccess.property_ids),
  ]);

  if (event.portfolio_id && assignedPortfolioIds.has(event.portfolio_id)) return true;
  if (event.property_id && assignedPropertyIds.has(event.property_id)) return true;

  const grants = (context.userAccess || []).filter((grant) =>
    grant.user_id === membership.user_id &&
    grant.org_id === event.org_id &&
    userAccessIsActive(grant)
  );

  if (!event.portfolio_id && !event.property_id) return true;
  if (grants.length === 0 && [ROLE_KEYS.FINANCE, ROLE_KEYS.ACCOUNTING, ROLE_KEYS.AUDITOR].includes(roleKey)) return true;

  return grants.some((grant) => {
    if (grant.scope === "portfolio" && event.portfolio_id && grant.scope_id === event.portfolio_id) return true;
    if (grant.scope === "property" && event.property_id && grant.scope_id === event.property_id) return true;
    return false;
  });
}

function memberMatchesRole(membership, roleKey) {
  const capabilities = normalizeObject(membership.capabilities);
  const roleKeys = [
    normalizeNotificationRole(membership.role, membership),
    ...normalizeArray(capabilities.roles).map((role) => normalizeNotificationRole(role, membership)),
  ];
  return roleKeys.includes(roleKey);
}

function conditionMatches(rule, event) {
  if (rule.when === "audit_required") return Boolean(event.audit_required || event.metadata?.audit_required);
  if (rule.tenantConditional) return Boolean(event.tenant_id || event.metadata?.tenant_related);
  if (rule.tenantPublishedOnly) return Boolean(event.tenant_id && (event.published_to_tenant || event.metadata?.published_to_tenant));
  return true;
}

function requiredPermissionForRule(rule, policy) {
  if (rule.permission) return rule.permission;
  if (policy?.permission) return policy.permission;
  const action = PERMISSION_ACTION_BY_NOTIFICATION_TYPE[rule.notificationType] || "view";
  return policy?.module ? `${policy.module}.${action}` : null;
}

function getPreference(preferences, recipientKey) {
  return preferences.find((preference) =>
    preference.user_id === recipientKey ||
    preference.recipient_key === recipientKey ||
    preference.email === recipientKey
  ) || {};
}

function resolveChannels(recipient, preferences) {
  const preference = getPreference(preferences, recipient.preferenceKey || recipient.userId || recipient.email);
  const emailEnabled = preference.email_enabled !== false;
  const smsEnabled = preference.sms_enabled !== false;
  const channels = [];

  if (emailEnabled && recipient.email) channels.push(NOTIFICATION_CHANNELS.EMAIL);
  if (smsEnabled && recipient.phone) channels.push(NOTIFICATION_CHANNELS.SMS);
  return channels;
}

function notificationTitle(event, rule) {
  if (event.title) return event.title;
  const base = String(event.event_type || event.type || "Notification").replace(/\./g, " ");
  if (rule.notificationType === NOTIFICATION_TYPES.APPROVAL_REQUIRED) return `${base} requires approval`;
  if (rule.notificationType === NOTIFICATION_TYPES.ACTION_REQUIRED) return `${base} requires action`;
  return base.replace(/\b\w/g, (char) => char.toUpperCase());
}

function notificationMessage(event, rule) {
  if (event.message) return event.message;
  if (rule.notificationType === NOTIFICATION_TYPES.APPROVAL_REQUIRED) {
    return `${event.entity_label || event.entity_type || "This item"} requires your approval.`;
  }
  if (rule.notificationType === NOTIFICATION_TYPES.CORRECTION_REQUIRED) {
    return `${event.entity_label || event.entity_type || "This item"} requires correction before the workflow can continue.`;
  }
  return `${event.entity_label || event.entity_type || "A workflow item"} has an update.`;
}

function actionUrl(event) {
  return event.action_url || event.link || "";
}

function addRecipient(recipientsByKey, recipient, rule, policy, event, reason) {
  const key = recipient.userId ? `user:${recipient.userId}` : `external:${recipient.externalType || "contact"}:${recipient.id || recipient.email}`;
  const existing = recipientsByKey.get(key);
  const requiredPermission = requiredPermissionForRule(rule, policy);
  const matchingReason = {
    role: reason.role || rule.role || null,
    customRole: reason.customRole || null,
    permission: requiredPermission,
    scope: policy.scope,
    source: reason.source,
  };

  if (existing) {
    existing.matchingReasons.push(matchingReason);
    if (rule.requiresAction) existing.requiresAction = true;
    if (rule.notificationType === NOTIFICATION_TYPES.APPROVAL_REQUIRED) {
      existing.notificationType = NOTIFICATION_TYPES.APPROVAL_REQUIRED;
    }
    return;
  }

  recipientsByKey.set(key, {
    ...recipient,
    key,
    eventType: event.event_type || event.type,
    module: policy.module,
    entityType: event.entity_type || policy.entityType,
    entityId: event.entity_id || event.id || null,
    orgId: event.org_id,
    portfolioId: event.portfolio_id || null,
    propertyId: event.property_id || null,
    tenantId: event.tenant_id || null,
    notificationType: rule.notificationType,
    title: notificationTitle(event, rule),
    message: notificationMessage(event, rule),
    actionUrl: actionUrl(event),
    requiresAction: Boolean(rule.requiresAction),
    matchingReasons: [matchingReason],
  });
}

function resolveInternalRecipients(event, policy, rule, context, recipientsByKey) {
  if (!conditionMatches(rule, event)) return;
  const memberships = (context.memberships || []).filter((membership) => isActiveMembership(membership, event.org_id));
  const assignedUserIds = new Set([
    ...normalizeArray(event.assigned_user_ids),
    ...normalizeArray(event.responsible_user_ids),
    ...normalizeArray(event.participant_user_ids),
    event.assigned_user_id,
    event.created_by,
  ].filter(Boolean));

  memberships.forEach((membership) => {
    const isAssignedMatch = rule.assigned && assignedUserIds.has(membership.user_id);
    const isRoleMatch = rule.role ? memberMatchesRole(membership, rule.role) : false;
    const requiredPermission = requiredPermissionForRule(rule, policy);
    const capabilities = normalizeObject(membership.capabilities);
    const isCustomPermissionMatch = Boolean(capabilities.custom_role || normalizeArray(capabilities.roles).includes("custom")) &&
      Boolean(requiredPermission) &&
      hasNotificationPermission(membership, requiredPermission);

    if (!isAssignedMatch && !isRoleMatch && !isCustomPermissionMatch) return;
    if (requiredPermission && !hasNotificationPermission(membership, requiredPermission)) return;
    if (!memberHasScopeAccess(membership, event, context)) return;

    const profile = context.profilesByUserId?.[membership.user_id] || membership.profile || {};
    addRecipient(
      recipientsByKey,
      {
        userId: membership.user_id,
        email: membership.email || profile.email,
        phone: membership.phone || profile.phone,
        displayName: membership.full_name || profile.full_name || profile.name || membership.user_id,
        preferenceKey: membership.user_id,
      },
      rule,
      policy,
      event,
      {
        role: normalizeNotificationRole(membership.role, membership),
        customRole: capabilities.custom_role || membership.custom_role || null,
        source: isAssignedMatch ? "assignment" : (isCustomPermissionMatch ? "custom_permission" : "role"),
      }
    );
  });
}

function stakeholderMatchesExternalRule(stakeholder, event, roleKey) {
  const stakeholderRole = normalizeNotificationRole(stakeholder.role || stakeholder.type || stakeholder.stakeholder_type);
  if (roleKey === ROLE_KEYS.ASSET_OWNER && stakeholderRole !== ROLE_KEYS.ASSET_OWNER) return false;
  if (roleKey === ROLE_KEYS.TENANT && stakeholderRole !== ROLE_KEYS.TENANT) return false;
  if (stakeholder.org_id && stakeholder.org_id !== event.org_id) return false;
  if (roleKey === ROLE_KEYS.ASSET_OWNER && event.asset_owner_id && stakeholder.id !== event.asset_owner_id && stakeholder.user_id !== event.asset_owner_id) return false;
  if (roleKey === ROLE_KEYS.TENANT && event.tenant_id && stakeholder.tenant_id !== event.tenant_id && stakeholder.id !== event.tenant_id) return false;
  if (stakeholder.property_id && event.property_id && stakeholder.property_id !== event.property_id) return false;
  if (stakeholder.portfolio_id && event.portfolio_id && stakeholder.portfolio_id !== event.portfolio_id) return false;
  return true;
}

function resolveExternalRecipients(event, policy, rule, context, recipientsByKey) {
  if (!rule.external || !conditionMatches(rule, event)) return;

  (context.stakeholders || []).forEach((stakeholder) => {
    if (!stakeholderMatchesExternalRule(stakeholder, event, rule.role)) return;

    addRecipient(
      recipientsByKey,
      {
        id: stakeholder.id || stakeholder.user_id || stakeholder.email,
        externalType: rule.role,
        email: stakeholder.email,
        phone: stakeholder.phone || stakeholder.mobile,
        displayName: stakeholder.name || stakeholder.full_name || stakeholder.email,
        preferenceKey: stakeholder.user_id || stakeholder.id || stakeholder.email,
      },
      rule,
      policy,
      event,
      {
        role: rule.role,
        source: "external_scope",
      }
    );
  });
}

export function resolveNotificationRecipients(event, context = {}) {
  const normalizedEvent = {
    ...event,
    event_type: event?.event_type || event?.type,
    metadata: normalizeObject(event?.metadata),
  };
  const policy = getNotificationPolicy(normalizedEvent.event_type);
  if (!policy) {
    return {
      event: normalizedEvent,
      policy: null,
      recipients: [],
      skipped: [{ reason: "NO_POLICY", eventType: normalizedEvent.event_type }],
    };
  }

  const recipientsByKey = new Map();
  (policy.recipients || []).forEach((rule) => {
    resolveInternalRecipients(normalizedEvent, policy, rule, context, recipientsByKey);
    resolveExternalRecipients(normalizedEvent, policy, rule, context, recipientsByKey);
  });

  const preferences = context.notificationPreferences || context.preferences || [];
  const recipients = Array.from(recipientsByKey.values()).map((recipient) => ({
    ...recipient,
    channels: resolveChannels(recipient, preferences),
  }));

  return {
    event: normalizedEvent,
    policy,
    recipients,
    skipped: [],
  };
}

export function canApproveWorkflow({ userId, orgId, eventType, portfolioId, propertyId, context = {} }) {
  const policy = getNotificationPolicy(eventType);
  if (!policy) return { allowed: false, reason: "NO_POLICY" };

  const event = {
    org_id: orgId,
    event_type: eventType,
    portfolio_id: portfolioId || null,
    property_id: propertyId || null,
  };

  const membership = (context.memberships || []).find((item) =>
    item.user_id === userId && isActiveMembership(item, orgId)
  );
  if (!membership) return { allowed: false, reason: "NO_ACTIVE_MEMBERSHIP" };

  if (!hasNotificationPermission(membership, policy.permission)) {
    return { allowed: false, reason: "MISSING_PERMISSION", permission: policy.permission };
  }
  if (!memberHasScopeAccess(membership, event, context)) {
    return { allowed: false, reason: "OUT_OF_SCOPE" };
  }

  const roleKey = normalizeNotificationRole(membership.role, membership);
  if (policy.finalOrgOwnerApproval && roleKey !== ROLE_KEYS.ORG_OWNER) {
    return { allowed: false, reason: "ORG_OWNER_FINAL_APPROVAL_REQUIRED" };
  }

  return { allowed: true, permission: policy.permission };
}
