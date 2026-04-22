// User Management v2 — Permission System Constants & Helpers
// Role = default template, Access = override layer

import { canAccess, getAllowedPagesForRole, getPermissions, resolveRoleForAccess } from "@/lib/rbac";
import { MODULE_DEFINITIONS } from "@/lib/moduleConfig";

// ── 6 core roles (v1 lightweight) ────────────────────────────────────────────
export const ROLE_DEFINITIONS = [
  {
    value: "viewer",
    label: "Viewer",
    color: "bg-slate-100 text-slate-600",
    borderColor: "border-slate-300",
    description: "Read-only access to assigned modules",
    warning: false,
    defaultCapabilities: { export_data: false },
  },
  {
    value: "editor",
    label: "Editor",
    color: "bg-emerald-100 text-emerald-700",
    borderColor: "border-emerald-400",
    description: "Can create and modify data across assigned modules",
    warning: false,
    defaultCapabilities: { export_data: true, edit_leases: true, manage_vendors: true },
  },
  {
    value: "manager",
    label: "Manager",
    color: "bg-blue-100 text-blue-700",
    borderColor: "border-blue-400",
    description: "Manages properties, leases, and expenses",
    warning: false,
    defaultCapabilities: { export_data: true, edit_leases: true, manage_vendors: true, invite_users: false },
  },
  {
    value: "finance",
    label: "Finance",
    color: "bg-purple-100 text-purple-700",
    borderColor: "border-purple-400",
    description: "Full access to financial modules and reporting",
    warning: false,
    defaultCapabilities: { export_data: true, approve_budget: true, finalize_cam: true },
  },
  {
    value: "auditor",
    label: "Auditor",
    color: "bg-yellow-100 text-yellow-700",
    borderColor: "border-yellow-400",
    description: "Read-only financial and audit log access",
    warning: false,
    defaultCapabilities: { export_data: true },
  },
  {
    value: "org_admin",
    label: "Admin",
    color: "bg-amber-100 text-amber-700",
    borderColor: "border-amber-400",
    description: "Full organization control — all modules, settings, users",
    warning: true,
    warningText: "High privilege: grants full org control including user management",
    defaultCapabilities: { export_data: true, approve_budget: true, finalize_cam: true, invite_users: true, edit_leases: true, manage_vendors: true },
  },
];

// ── Capabilities (workflow-level permissions) ─────────────────────────────────
export const CAPABILITY_DEFINITIONS = [
  { key: "approve_budget",  label: "Approve Budget",    description: "Can approve or reject budget submissions" },
  { key: "finalize_cam",    label: "Finalize CAM",      description: "Can finalize CAM reconciliation reports" },
  { key: "export_data",     label: "Export Data",       description: "Can export reports and data to CSV/PDF" },
  { key: "invite_users",    label: "Invite Users",      description: "Can invite new team members to the organization" },
  { key: "edit_leases",     label: "Edit Leases",       description: "Can create and modify lease agreements" },
  { key: "manage_vendors",  label: "Manage Vendors",    description: "Can add, edit, and deactivate vendors" },
];

// ── Module domain grouping ────────────────────────────────────────────────────
export const MODULE_DOMAINS = {
  "Operations": ["properties", "tenants", "leases", "vendors"],
  "Finance":    ["expenses", "cam", "billing", "revenue", "budgets", "actuals_variance", "comparison", "reconciliation"],
  "Analytics":  ["analytics_reports", "portfolio"],
  "Platform":   ["dashboard", "documents", "workflows", "notifications", "integrations", "admin"],
};

// ── Access level definitions ──────────────────────────────────────────────────
export const ACCESS_LEVELS = [
  { value: "full",      label: "Full",      longLabel: "Full Access",  description: "Read + create + edit + delete",  chipClass: "bg-emerald-100 text-emerald-700 border-emerald-300" },
  { value: "read_only", label: "Read",      longLabel: "Read Only",    description: "View only — no modifications",    chipClass: "bg-blue-100 text-blue-700 border-blue-300" },
  { value: "none",      label: "None",      longLabel: "No Access",    description: "Hidden from nav, blocked on URL", chipClass: "bg-slate-100 text-slate-500 border-slate-200" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

export function parseRoles(roleStr) {
  if (!roleStr || roleStr === "__none__") return [];
  return String(roleStr).split(",").map(r => r.trim()).filter(Boolean);
}

/** Get default module permissions for a role (or multiple roles via comma-separated string) */
export function getRoleDefaultModulePerms(roleStr) {
  const roles = parseRoles(roleStr);
  
  if (roles.includes("org_admin") || roles.includes("super_admin") || roles.includes("admin")) {
    const all = {};
    Object.keys(MODULE_DEFINITIONS).forEach((k) => { all[k] = "full"; });
    return all;
  }

  const allowedPages = new Set();
  roles.forEach(role => {
    getAllowedPagesForRole(role).forEach((p) => allowedPages.add(p));
  });

  const perms = {};
  Object.entries(MODULE_DEFINITIONS).forEach(([key, mod]) => {
    if (!mod?.pages) return;
    const hasAny = mod.pages.some((p) => allowedPages.has(p));
    // Without full hierarchical merge, we just grant full if any page is allowed (v1 simplified logic)
    perms[key] = hasAny ? "full" : "none";
  });
  return perms;
}

/** Get diff: which modules changed from role default */
export function getPermDiff(roleDefaultPerms, modulePerms) {
  const diffs = [];
  Object.entries(modulePerms).forEach(([key, val]) => {
    const def = roleDefaultPerms[key] || "none";
    if (def !== val) {
      const mod = MODULE_DEFINITIONS[key];
      diffs.push({ key, label: mod?.label || key, from: def, to: val });
    }
  });
  return diffs;
}

export function getInitials(str) {
  return (str || "?").split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

export function getRoleDefinition(value) {
  return ROLE_DEFINITIONS.find((r) => r.value === value);
}

export function getStatusBadge(status) {
  const map = {
    active:  "bg-emerald-50 text-emerald-700 border border-emerald-200",
    pending: "bg-amber-50 text-amber-700 border border-amber-200",
    invited: "bg-blue-50 text-blue-700 border border-blue-200",
  };
  return map[status] || "bg-slate-100 text-slate-500";
}

/** Simulate what a user with given role(s) + overrides sees */
export function resolveEffectivePermissions(roleStr, modulePerms, pagePerms, capabilities) {
  const roleDefault = getRoleDefaultModulePerms(roleStr);
  const effectiveModule = { ...roleDefault, ...modulePerms };
  const effectivePage = { ...pagePerms };
  
  // Merge capabilities across all assigned roles
  const roles = parseRoles(roleStr);
  const baseCaps = {};
  roles.forEach(role => {
    const resolvedRole = resolveRoleForAccess(role);
    const def = getRoleDefinition(role) || getRoleDefinition(resolvedRole);
    const caps = def?.defaultCapabilities || {};
    Object.keys(caps).forEach(k => {
      if (caps[k]) baseCaps[k] = true;
    });
  });

  const effectiveCaps = { ...baseCaps, ...capabilities };
  return { effectiveModule, effectivePage, effectiveCaps };
}

export class PagePermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = "PagePermissionError";
    this.code = "PAGE_READ_ONLY";
  }
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch {
        /* ignore malformed permission payloads */
      }
    }
  }
  return {};
}

export function normalizeAccessLevel(value) {
  if (value === true) return "full";
  if (value === false || value == null) return "none";

  const normalized = String(value).trim().toLowerCase();
  if (["full", "write", "edit", "manage", "admin"].includes(normalized)) return "full";
  if (["read", "read_only", "readonly", "view", "viewer"].includes(normalized)) return "read";
  return "none";
}

export function getCurrentPageName(pathname = typeof window !== "undefined" ? window.location.pathname : "") {
  const [segment] = String(pathname || "")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean);
  return segment || "Dashboard";
}

export function getActiveMembershipForUser(user) {
  const memberships = Array.isArray(user?.memberships) ? user.memberships : [];
  if (memberships.length === 0) return null;
  return memberships.find((membership) => membership?.org_id === user?.org_id) || memberships[0];
}

export function getPageAccessLevel(user, pageName) {
  if (!user || !pageName) return "none";

  const rawRole = user._raw_role || user.role;
  const resolvedRole = resolveRoleForAccess(rawRole);
  if (["admin", "super_admin", "org_admin"].includes(resolvedRole)) return "full";

  const membership = getActiveMembershipForUser(user);
  const pagePermissions = parseObject(membership?.page_permissions);
  const hasExplicitPagePermissions = Object.keys(pagePermissions).length > 0;

  if (hasExplicitPagePermissions) {
    return normalizeAccessLevel(pagePermissions[pageName]);
  }

  if (!canAccess(rawRole, pageName)) return "none";
  return getPermissions(rawRole).canWrite ? "full" : "read";
}

export function canReadPage(user, pageName) {
  return getPageAccessLevel(user, pageName) !== "none";
}

export function canWritePage(user, pageName) {
  return getPageAccessLevel(user, pageName) === "full";
}

export function assertCanWritePage(user, pageName, action = "modify this page") {
  if (canWritePage(user, pageName)) return;
  throw new PagePermissionError(`You have read-only access to ${pageName}. Ask an admin for full access to ${action}.`);
}

export function isPagePermissionError(error) {
  return error?.code === "PAGE_READ_ONLY" || error instanceof PagePermissionError;
}
