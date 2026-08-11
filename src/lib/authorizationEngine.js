import { getActiveMembership, getActiveOrgId, isSuperAdmin, resolveRoleForAccess } from "@/lib/rbac";

export const AUTHORIZATION_ACTIONS = [
  "view",
  "create",
  "edit",
  "upload",
  "submit",
  "review",
  "validate",
  "approve",
  "reject",
  "sign",
  "delete",
  "export",
  "assign",
  "configure",
  "comment",
];

export const STANDARD_ROLE_KEYS = [
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

export const DEFAULT_APPROVAL_THRESHOLDS = {
  expense: [
    { minAmount: 0, maxAmount: 5000, steps: [{ role: "property_manager", action: "approve" }] },
    {
      minAmount: 5000.01,
      maxAmount: 25000,
      steps: [
        { role: "property_manager", action: "review" },
        { role: "portfolio_manager", action: "approve" },
      ],
    },
    {
      minAmount: 25000.01,
      maxAmount: 100000,
      steps: [
        { role: "property_manager", action: "review" },
        { role: "portfolio_manager", action: "review" },
        { role: "finance", action: "validate" },
        { role: "org_owner", action: "approve" },
      ],
    },
    {
      minAmount: 100000.01,
      maxAmount: null,
      steps: [
        { role: "property_manager", action: "review" },
        { role: "portfolio_manager", action: "review" },
        { role: "finance", action: "validate" },
        { role: "org_owner", action: "approve" },
        { role: "property_owner", action: "approve" },
      ],
    },
  ],
  budget: [
    {
      minAmount: 0,
      maxAmount: null,
      steps: [
        { role: "portfolio_manager", action: "review" },
        { role: "finance", action: "validate" },
        { role: "org_owner", action: "approve" },
      ],
    },
  ],
  cam: [
    {
      minAmount: 0,
      maxAmount: null,
      steps: [
        { role: "finance", action: "validate" },
        { role: "property_manager", action: "review" },
        { role: "org_owner", action: "approve" },
      ],
    },
  ],
  lease: [
    {
      minAmount: 0,
      maxAmount: null,
      steps: [
        { role: "property_manager", action: "review" },
        { role: "org_owner", action: "approve" },
        { role: "authorized_signatory", action: "sign" },
      ],
    },
  ],
};

export const STANDARD_ROLE_DEFINITIONS = {
  org_owner: {
    label: "Organization Owner",
    permissions: {
      lease: ["view", "review", "approve", "reject", "sign", "comment"],
      expense: ["view", "review", "approve", "reject", "export", "comment"],
      budget: ["view", "review", "approve", "reject", "export", "comment"],
      cam: ["view", "review", "approve", "export", "comment"],
      revenue: ["view", "export", "adjust"],
      critical_dates: ["view", "comment"],
      rent_schedule: ["view", "review", "export"],
      reports: ["view", "export"],
      audit: ["view", "export"],
      user: ["view", "create", "edit", "assign"],
      role: ["view", "create", "edit", "assign"],
      workflow: ["configure"],
      approval_policy: ["configure"],
      delegation: ["create", "edit", "view"],
    },
    approvalLimits: { expense: null, budget: null, cam: null, lease: null },
    unrestrictedOrgScope: true,
  },
  org_admin: {
    label: "Organization Admin",
    permissions: {
      lease: ["view", "review", "comment"],
      expense: ["view", "review", "comment"],
      budget: ["view", "review", "comment"],
      cam: ["view", "review", "comment"],
      revenue: ["view", "export"],
      critical_dates: ["view", "comment"],
      rent_schedule: ["view", "review"],
      reports: ["view", "export"],
      audit: ["view"],
      user: ["view", "create", "edit", "assign"],
      role: ["view", "create", "edit", "assign"],
      workflow: ["configure"],
      approval_policy: ["configure"],
      delegation: ["view"],
    },
    approvalLimits: {},
    unrestrictedOrgScope: true,
  },
  portfolio_manager: {
    label: "Portfolio Manager",
    permissions: {
      lease: ["view", "review", "comment"],
      expense: ["view", "review", "approve", "reject", "comment"],
      budget: ["view", "review", "approve", "reject", "comment"],
      cam: ["view", "review", "approve", "comment"],
      revenue: ["view", "export"],
      critical_dates: ["view", "comment"],
      rent_schedule: ["view", "review"],
      reports: ["view", "export"],
    },
    approvalLimits: { expense: 25000, budget: 250000, cam: 250000 },
  },
  property_manager: {
    label: "Property Manager",
    permissions: {
      lease: ["view", "review", "comment"],
      expense: ["view", "create", "edit", "submit", "review", "approve", "reject", "comment"],
      budget: ["view", "create", "edit", "submit", "review", "approve", "reject", "comment"],
      cam: ["view", "review", "comment"],
      revenue: ["view"],
      critical_dates: ["view", "edit", "comment"],
      rent_schedule: ["view", "review"],
      reports: ["view"],
    },
    approvalLimits: { expense: 5000, budget: 50000 },
  },
  lease_admin: {
    label: "Lease Admin",
    permissions: {
      lease: ["view", "create", "edit", "upload", "submit", "comment"],
      critical_dates: ["view", "create", "edit"],
      rent_schedule: ["view", "create", "edit", "submit"],
      documents: ["view", "upload"],
    },
    approvalLimits: {},
  },
  leasing_agent: {
    label: "Leasing Agent",
    permissions: {
      lease: ["view", "create", "edit", "upload", "submit", "comment"],
      critical_dates: ["view", "create", "edit"],
      rent_schedule: ["view", "create", "edit", "submit"],
      documents: ["view", "upload"],
    },
    approvalLimits: {},
  },
  finance: {
    label: "Finance Team",
    permissions: {
      expense: ["view", "review", "validate", "reject", "comment", "export"],
      budget: ["view", "review", "validate", "reject", "comment", "export"],
      cam: ["view", "create", "edit", "review", "validate", "comment", "export"],
      revenue: ["view", "export", "reconcile", "adjust"],
      rent_schedule: ["view", "review", "validate"],
      reports: ["view", "export"],
    },
    approvalLimits: {},
  },
  property_owner: {
    label: "Property Owner",
    permissions: {
      lease: ["view", "approve", "reject", "comment"],
      expense: ["view", "approve", "reject", "comment"],
      budget: ["view", "approve", "reject", "comment"],
      cam: ["view", "approve", "comment"],
      revenue: ["view", "export"],
      critical_dates: ["view"],
      rent_schedule: ["view"],
      reports: ["view", "export"],
      documents: ["view"],
    },
    approvalLimits: { expense: null, budget: null, cam: null, lease: null },
  },
  auditor: {
    label: "Auditor",
    permissions: {
      lease: ["view", "export"],
      expense: ["view", "export"],
      budget: ["view", "export"],
      cam: ["view", "export"],
      revenue: ["view", "export"],
      critical_dates: ["view"],
      rent_schedule: ["view", "export"],
      reports: ["view", "export"],
      audit: ["view", "export"],
      documents: ["view"],
    },
    approvalLimits: {},
  },
  tenant: {
    label: "Tenant",
    permissions: {},
    approvalLimits: {},
    externalOnly: true,
  },
  custom_role: {
    label: "Custom Role",
    permissions: {},
    approvalLimits: {},
  },
};

const ROLE_ALIASES = {
  owner: "org_owner",
  admin: "org_admin",
  manager: "property_manager",
  editor: "lease_admin",
  viewer: "auditor",
  read_only: "auditor",
  asset_manager: "portfolio_manager",
  custom: "custom_role",
};

const SCOPE_RANK = {
  organization: 1,
  portfolio: 2,
  property: 3,
  building: 4,
  unit: 5,
  lease: 6,
};

function normalizeRole(role) {
  const locallyAliased = ROLE_ALIASES[role] || role;
  const resolved = resolveRoleForAccess(locallyAliased);
  return ROLE_ALIASES[resolved] || resolved || "auditor";
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function permissionParts(permission) {
  const [module, action] = String(permission || "").split(".");
  return { module, action };
}

function getMembership(user, options = {}) {
  return options.membership || getActiveMembership(user) || {};
}

function getMembershipPermissions(membership) {
  const capabilities = parseObject(membership?.capabilities);
  return {
    ...parseObject(capabilities.permissions),
    ...parseObject(capabilities.custom_permissions),
  };
}

function getCustomRoleDefinition(membership, options = {}) {
  const roleKey = membership?.custom_role || membership?.role;
  return (options.roleDefinitions || []).find((role) => role?.role_key === roleKey || role?.key === roleKey) || null;
}

function permissionSetAllows(permissions, permission) {
  const { module, action } = permissionParts(permission);
  if (!module || !action) return false;
  const rawModulePerms = permissions?.[module];
  if (Array.isArray(rawModulePerms)) return rawModulePerms.includes(action);
  const modulePerms = parseObject(rawModulePerms);
  if (Array.isArray(modulePerms)) return modulePerms.includes(action);
  return Boolean(modulePerms?.[action]);
}

export function roleAllowsPermission(role, permission, options = {}) {
  const roleKey = normalizeRole(role);
  const roleDefinition = options.roleDefinition || STANDARD_ROLE_DEFINITIONS[roleKey];
  return permissionSetAllows(roleDefinition?.permissions || {}, permission);
}

export function getUserPermissions(user, options = {}) {
  const membership = getMembership(user, options);
  const customRole = getCustomRoleDefinition(membership, options);
  const roleKey = normalizeRole(customRole?.role_key || membership?.role || user?.role);
  const standardPermissions = STANDARD_ROLE_DEFINITIONS[roleKey]?.permissions || {};
  return {
    ...standardPermissions,
    ...parseObject(customRole?.default_capabilities?.permissions),
    ...parseObject(customRole?.permissions),
    ...getMembershipPermissions(membership),
  };
}

function getScopeAccessPayload(membership) {
  return parseObject(parseObject(membership?.capabilities).scope_access);
}

function resourceOrgId(resource = {}, user) {
  return resource.organization_id || resource.org_id || getActiveOrgId(user);
}

function scopeGrantMatches(grant = {}, resource = {}) {
  const scope = String(grant.scope || grant.scope_type || "").toLowerCase();
  const scopeId = grant.scope_id || grant.id;
  if (!grant.is_active && grant.is_active !== undefined) return false;
  if (grant.expires_at && new Date(grant.expires_at).getTime() <= Date.now()) return false;
  if (scope === "organization") return scopeId === resourceOrgId(resource) || !scopeId;
  if (scope === "portfolio") return scopeId && scopeId === resource.portfolio_id;
  if (scope === "property") return scopeId && scopeId === resource.property_id;
  if (scope === "building") return scopeId && scopeId === resource.building_id;
  if (scope === "unit") return scopeId && scopeId === resource.unit_id;
  if (scope === "lease") return scopeId && scopeId === resource.lease_id;
  return false;
}

export function hasScope(user, resource = {}, options = {}) {
  if (!user) return false;
  if (isSuperAdmin(user)) return true;

  const membership = getMembership(user, options);
  const roleKey = normalizeRole(membership?.role || user?.role);
  const orgId = resourceOrgId(resource, user);
  if (!orgId || (membership?.org_id && membership.org_id !== orgId)) return false;

  const scopeAccess = getScopeAccessPayload(membership);
  const roleDefinition = STANDARD_ROLE_DEFINITIONS[roleKey] || {};
  if (roleDefinition.unrestrictedOrgScope || scopeAccess.all_portfolios || scopeAccess.all_properties) {
    return true;
  }

  if (!resource.portfolio_id && !resource.property_id && !resource.building_id && !resource.unit_id && !resource.lease_id) {
    return true;
  }

  const portfolioIds = [
    ...(Array.isArray(membership?.assigned_portfolios) ? membership.assigned_portfolios : []),
    ...(Array.isArray(scopeAccess.portfolios) ? scopeAccess.portfolios : []),
  ];
  if (resource.portfolio_id && portfolioIds.includes(resource.portfolio_id)) return true;

  const propertyIds = [
    ...(Array.isArray(membership?.assigned_properties) ? membership.assigned_properties : []),
    ...(Array.isArray(scopeAccess.properties) ? scopeAccess.properties : []),
    ...(Array.isArray(membership?.assigned_owners) ? membership.assigned_owners : []),
  ];
  if (resource.property_id && propertyIds.includes(resource.property_id)) return true;

  const explicitGrants = [
    ...(Array.isArray(options.scopeAssignments) ? options.scopeAssignments : []),
    ...(Array.isArray(membership?.scope_assignments) ? membership.scope_assignments : []),
    ...(Array.isArray(membership?.user_access) ? membership.user_access : []),
  ];
  return explicitGrants.some((grant) => scopeGrantMatches(grant, resource));
}

export function can(user, permission, resource = {}, options = {}) {
  if (!user) return false;
  if (isSuperAdmin(user)) return true;

  const membership = getMembership(user, options);
  const orgId = resourceOrgId(resource, user);
  if (!orgId || (membership?.org_id && membership.org_id !== orgId)) return false;
  if (!hasScope(user, resource, options)) return false;

  return permissionSetAllows(getUserPermissions(user, options), permission);
}

function getApprovalPayload(membership) {
  const capabilities = parseObject(membership?.capabilities);
  return {
    ...parseObject(capabilities.approval_limits),
    ...parseObject(membership?.approval_limits),
  };
}

function delegationMatches(delegation = {}, user, approvalType, resource = {}) {
  const now = Date.now();
  const permission = `${approvalType}.approve`;
  if (delegation.delegate_user_id && delegation.delegate_user_id !== user?.id) return false;
  if (delegation.permission && delegation.permission !== permission) return false;
  if (delegation.status && !["active", "approved"].includes(delegation.status)) return false;
  if (delegation.start_date && new Date(delegation.start_date).getTime() > now) return false;
  if (delegation.end_date && new Date(delegation.end_date).getTime() < now) return false;
  return !delegation.scope || scopeGrantMatches(delegation, resource);
}

export function getApprovalLimit(user, approvalType, resource = {}, options = {}) {
  if (!user) return 0;
  if (isSuperAdmin(user)) return Infinity;

  const membership = getMembership(user, options);
  const roleKey = normalizeRole(membership?.role || user?.role);
  const delegatedLimits = (options.delegations || [])
    .filter((delegation) => delegationMatches(delegation, user, approvalType, resource))
    .map((delegation) => delegation.maximum_approval_amount ?? delegation.max_amount ?? 0);

  const configured = getApprovalPayload(membership)[approvalType];
  const standard = STANDARD_ROLE_DEFINITIONS[roleKey]?.approvalLimits?.[approvalType];
  const limits = [configured, standard, ...delegatedLimits].filter((value) => value !== undefined);
  if (limits.some((value) => value === null)) return Infinity;
  return Math.max(0, ...limits.map((value) => Number(value) || 0));
}

export function canApprove(user, request = {}, options = {}) {
  const approvalType = request.approval_type || request.workflow_type || request.type || request.entity_type;
  if (!approvalType) return false;
  if (!can(user, `${approvalType}.approve`, request, options)) return false;

  const creatorId = request.created_by_user_id || request.created_by || request.submitter_user_id || request.requested_by;
  if (!options.allowSelfApproval && creatorId && creatorId === user?.id) return false;

  const limit = getApprovalLimit(user, approvalType, request, options);
  const amount = Number(request.amount ?? request.total_amount ?? 0);
  if (Number.isFinite(limit) && amount > limit) return false;

  if (request.current_step?.required_role) {
    const requiredRole = normalizeRole(request.current_step.required_role);
    const actualRole = normalizeRole(getMembership(user, options)?.role || user?.role);
    if (requiredRole !== actualRole && !request.current_step.approver_user_id) return false;
  }

  if (request.current_step?.approver_user_id && request.current_step.approver_user_id !== user?.id) {
    return false;
  }

  return true;
}

function policyScopeScore(policy = {}, resource = {}) {
  const scopeType = String(policy.scope_type || "system").toLowerCase();
  const scopeId = policy.scope_id;
  if (scopeType === "property" && scopeId === resource.property_id) return SCOPE_RANK.property;
  if (scopeType === "portfolio" && scopeId === resource.portfolio_id) return SCOPE_RANK.portfolio;
  if (scopeType === "organization" && (scopeId === resourceOrgId(resource) || policy.org_id === resourceOrgId(resource))) {
    return SCOPE_RANK.organization;
  }
  if (scopeType === "system") return 0;
  return -1;
}

export function resolveApprovalPolicy({ approvalType, resource = {}, policies = [] } = {}) {
  const candidates = policies
    .filter((policy) => !policy.workflow_type || policy.workflow_type === approvalType)
    .map((policy) => ({ policy, score: policyScopeScore(policy, resource) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.policy || {
    scope_type: "system",
    workflow_type: approvalType,
    thresholds: DEFAULT_APPROVAL_THRESHOLDS[approvalType] || [],
  };
}

export function getRequiredApprovalChain({ approvalType, amount = 0, resource = {}, policies = [] } = {}) {
  const policy = resolveApprovalPolicy({ approvalType, resource, policies });
  const thresholds = Array.isArray(policy.thresholds) ? policy.thresholds : parseObject(policy.thresholds).items || [];
  const numericAmount = Number(amount) || 0;
  const threshold = thresholds.find((row) => {
    const min = Number(row.minAmount ?? row.min_amount ?? 0);
    const max = row.maxAmount ?? row.max_amount;
    return numericAmount >= min && (max == null || numericAmount <= Number(max));
  });
  return {
    policy,
    steps: threshold?.steps || threshold?.approval_chain || [],
  };
}

export function validateRejectionAction({ reason, comments, rejectedBy, workflowStage, entityVersion } = {}) {
  const missing = [];
  if (!String(reason || "").trim()) missing.push("rejection reason");
  if (!String(comments || "").trim()) missing.push("comments");
  if (!rejectedBy) missing.push("rejected by");
  if (!workflowStage) missing.push("workflow stage");
  if (entityVersion == null) missing.push("entity version");
  return {
    valid: missing.length === 0,
    missing,
  };
}

export function getNotificationRecipients(event = {}, users = [], options = {}) {
  const permission = event.required_permission || `${event.module}.${event.action || "view"}`;
  return users.filter((user) => can(user, permission, event.resource || event, options));
}
