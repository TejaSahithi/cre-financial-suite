import { me } from "@/services/auth";
import { getStoredActingOrgId } from "@/lib/actingOrg";
import { getDataScope } from "@/lib/rbac";

export function resolveReadableOrgScopeForUser(user, options = {}) {
  if (!user) return { scope: "none", orgId: null };
  const currentOrgId = options.currentOrgId || getStoredActingOrgId() || null;
  return getDataScope(user, { currentOrgId });
}

export function resolveWritableOrgScopeForUser(user, options = {}) {
  if (!user) return { scope: "none", orgId: null };
  const currentOrgId = options.currentOrgId || getStoredActingOrgId() || null;
  return getDataScope(user, { currentOrgId });
}

export async function resolveReadableOrgScope(currentOrgId = null, options = {}) {
  try {
    const user = await me();
    return resolveReadableOrgScopeForUser(user, { ...options, currentOrgId });
  } catch (err) {
    console.warn("[orgUtils] Error resolving readable org scope:", err);
    return { scope: "none", orgId: null };
  }
}

export async function resolveWritableOrgScope(currentOrgId = null) {
  try {
    const user = await me();
    return resolveWritableOrgScopeForUser(user, { currentOrgId });
  } catch (err) {
    console.warn("[orgUtils] Error resolving writable org scope:", err);
    return { scope: "none", orgId: null };
  }
}

// ─── Legacy Wrappers for Feature Modules ──────────────────────────────────────

export function resolveReadableOrgIdForUser(user, options = {}) {
  const scopeObj = resolveReadableOrgScopeForUser(user, options);
  return scopeObj.scope === "none" ? "__none__" : scopeObj.orgId;
}

export function resolveWritableOrgIdForUser(user, options = {}) {
  const scopeObj = resolveWritableOrgScopeForUser(user, options);
  return scopeObj.scope === "org" ? scopeObj.orgId : null;
}

export async function resolveReadableOrgId(currentOrgId = null, options = {}) {
  const scopeObj = await resolveReadableOrgScope(currentOrgId, options);
  return scopeObj.scope === "none" ? "__none__" : scopeObj.orgId;
}

export async function resolveWritableOrgId(currentOrgId = null) {
  const scopeObj = await resolveWritableOrgScope(currentOrgId);
  return scopeObj.scope === "org" ? scopeObj.orgId : null;
}
