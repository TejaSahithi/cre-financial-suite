import { STANDARD_ROLE_DEFINITIONS } from "@/lib/authorizationEngine";
import { logAudit } from "@/services/audit";
import { supabase } from "@/services/supabaseClient";

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseObject(value) {
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

function normalizePermissionSet(value) {
  const normalized = {};
  Object.entries(parseObject(value)).forEach(([moduleKey, moduleValue]) => {
    if (Array.isArray(moduleValue)) {
      normalized[moduleKey] = Object.fromEntries(moduleValue.map((action) => [action, true]));
      return;
    }
    normalized[moduleKey] = parseObject(moduleValue);
  });
  return normalized;
}

function mergePermissionSets(base = {}, override = {}) {
  const next = { ...base };
  Object.entries(override).forEach(([moduleKey, actions]) => {
    next[moduleKey] = {
      ...parseObject(next[moduleKey]),
      ...parseObject(actions),
    };
  });
  return next;
}

export function buildCustomRolePayload({
  orgId,
  name,
  description = "",
  permissions = {},
  approvalLimits = {},
  notificationPreferences = {},
  cloneFromRole = null,
  roleKey = null,
}) {
  const cloned = cloneFromRole ? STANDARD_ROLE_DEFINITIONS[cloneFromRole] || {} : {};
  const clonedPermissions = normalizePermissionSet(cloned.permissions);
  const overridePermissions = normalizePermissionSet(permissions);
  const clonedApprovalLimits = parseObject(cloned.approvalLimits);
  const permissionSet = mergePermissionSets(clonedPermissions, overridePermissions);
  const resolvedRoleKey = normalizeKey(roleKey || name);

  if (!orgId) throw new Error("orgId is required");
  if (!resolvedRoleKey) throw new Error("custom role name is required");

  return {
    org_id: orgId,
    role_key: resolvedRoleKey,
    label: String(name || roleKey).trim(),
    description: description || cloned.description || null,
    role_type: "custom",
    permission_set: permissionSet,
    default_capabilities: {
      permissions: permissionSet,
      approval_limits: {
        ...clonedApprovalLimits,
        ...parseObject(approvalLimits),
      },
      notification_preferences: parseObject(notificationPreferences),
    },
    approval_limits: {
      ...clonedApprovalLimits,
      ...parseObject(approvalLimits),
    },
    notification_preferences: parseObject(notificationPreferences),
    is_system: false,
    is_active: true,
  };
}

export function mergeCustomRoleIntoMembershipCapabilities(capabilities = {}, roleDefinition = {}) {
  const defaultCapabilities = parseObject(roleDefinition.default_capabilities);
  return {
    ...parseObject(capabilities),
    roles: ["custom_role"],
    custom_role: roleDefinition.role_key,
    custom_role_label: roleDefinition.label,
    custom_permissions: {
      ...parseObject(defaultCapabilities.permissions),
      ...parseObject(capabilities.custom_permissions),
    },
    approval_limits: {
      ...parseObject(defaultCapabilities.approval_limits),
      ...parseObject(capabilities.approval_limits),
    },
    notification_preferences: {
      ...parseObject(defaultCapabilities.notification_preferences),
      ...parseObject(capabilities.notification_preferences),
    },
  };
}

export async function listCustomRoles(orgId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("role_definitions")
    .select("*")
    .eq("org_id", orgId)
    .eq("role_type", "custom")
    .order("label");
  if (error) throw error;
  return data || [];
}

export async function upsertCustomRole(input) {
  if (!supabase) return buildCustomRolePayload(input);
  const payload = buildCustomRolePayload(input);
  const { data, error } = await supabase
    .from("role_definitions")
    .upsert(payload, { onConflict: "org_id,role_key" })
    .select()
    .single();
  if (error) throw error;

  await logAudit({
    action: "custom_role_upserted",
    entityType: "RoleDefinition",
    entityId: data?.id,
    orgId: payload.org_id,
    details: {
      role_key: payload.role_key,
      label: payload.label,
      permission_modules: Object.keys(payload.permission_set || {}),
    },
  });

  return data;
}

export async function cloneStandardRoleAsCustomRole({ orgId, sourceRoleKey, name, description = "" }) {
  return upsertCustomRole({
    orgId,
    name,
    description,
    cloneFromRole: sourceRoleKey,
  });
}

export async function disableCustomRole({ orgId, roleKey }) {
  if (!supabase) return { org_id: orgId, role_key: roleKey, is_active: false };
  const { data, error } = await supabase
    .from("role_definitions")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("role_key", roleKey)
    .eq("role_type", "custom")
    .select()
    .single();
  if (error) throw error;

  await logAudit({
    action: "custom_role_disabled",
    entityType: "RoleDefinition",
    entityId: data?.id,
    orgId,
    details: { role_key: roleKey },
  });

  return data;
}

export async function ensureInlineCustomRoleDefinition({
  orgId,
  customRoleName,
  customRoleDescription = "",
  permissions = {},
  approvalLimits = {},
  notificationPreferences = {},
}) {
  if (!customRoleName) return null;
  return upsertCustomRole({
    orgId,
    name: customRoleName,
    description: customRoleDescription,
    permissions,
    approvalLimits,
    notificationPreferences,
  });
}
