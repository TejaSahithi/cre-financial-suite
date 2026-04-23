import { me } from "@/services/auth";
import { getStoredActingOrgId } from "@/lib/actingOrg";

const ACTIVE_MEMBERSHIP_STATUSES = new Set(["active", "owner"]);

function getActiveMemberships(user) {
  const memberships = Array.isArray(user?.memberships) ? user.memberships : [];
  return memberships.filter((membership) =>
    ACTIVE_MEMBERSHIP_STATUSES.has(membership?.status || "active")
  );
}

function getUniqueOrgIds(memberships) {
  return [...new Set(memberships.map((membership) => membership?.org_id).filter(Boolean))];
}

function isSuperAdminUser(user, memberships = getActiveMemberships(user)) {
  return user?._raw_role === "super_admin" || memberships.some((membership) => membership?.role === "super_admin");
}

function normalizeRequestedOrgId(currentOrgId, user, isSuperAdmin = false) {
  if (currentOrgId && currentOrgId !== "__none__") return currentOrgId;
  const storedActingOrgId = getStoredActingOrgId();
  if (storedActingOrgId) return storedActingOrgId;
  if (isSuperAdmin) return null;
  return user?.activeOrg?.id || user?.org_id || null;
}

export function resolveReadableOrgIdForUser(user, options = {}) {
  if (!user) return "__none__";

  const memberships = getActiveMemberships(user);
  const activeOrgIds = getUniqueOrgIds(memberships);
  const isSuperAdmin = isSuperAdminUser(user, memberships);
  const requestedOrgId = normalizeRequestedOrgId(options.currentOrgId, user, isSuperAdmin);

  if (requestedOrgId) {
    if (isSuperAdmin || activeOrgIds.includes(requestedOrgId)) {
      return requestedOrgId;
    }
    return "__none__";
  }

  if (isSuperAdmin) {
    return options.allowSuperAdminGlobal === true ? null : "__none__";
  }

  if (activeOrgIds.length === 1) {
    return activeOrgIds[0];
  }

  return "__none__";
}

export function resolveWritableOrgIdForUser(user, options = {}) {
  if (!user) return null;

  const memberships = getActiveMemberships(user);
  const activeOrgIds = getUniqueOrgIds(memberships);
  const isSuperAdmin = isSuperAdminUser(user, memberships);
  const requestedOrgId = normalizeRequestedOrgId(options.currentOrgId, user, isSuperAdmin);

  if (requestedOrgId) {
    if (isSuperAdmin || activeOrgIds.includes(requestedOrgId)) {
      return requestedOrgId;
    }
    return null;
  }

  if (isSuperAdmin) return null;

  if (activeOrgIds.length === 1) {
    return activeOrgIds[0];
  }

  return null;
}

export async function resolveReadableOrgId(currentOrgId = null, options = {}) {
  try {
    const user = await me();
    return resolveReadableOrgIdForUser(user, {
      ...options,
      currentOrgId,
    });
  } catch (err) {
    console.warn("[orgUtils] Error resolving readable org ID:", err);
    return "__none__";
  }
}

/**
 * Resolve an org_id safe to write into.
 *
 * Returns null for super-admins with no explicit context — the caller MUST
 * surface an error in that case rather than silently pick an org. The previous
 * "first org in the system" fallback caused cross-tenant data contamination
 * (see audit finding S3).
 */
export async function resolveWritableOrgId(currentOrgId = null) {
  try {
    const user = await me();
    return resolveWritableOrgIdForUser(user, { currentOrgId });
  } catch (err) {
    console.warn("[orgUtils] Error resolving writable org ID:", err);
    return null;
  }
}
