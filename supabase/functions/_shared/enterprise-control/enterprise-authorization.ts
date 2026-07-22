// @ts-nocheck
import { normalizePermissions } from "./enterprise-permissions.ts";
import { permissionsForRoles, PLATFORM_ONLY_ROLES } from "./enterprise-role-registry.ts";

export function decideEnterpriseAuthorization(input) {
  const reasonCodes = [];
  if (!input?.organizationId || !input?.actor?.organizationRoles?.[input.organizationId]) {
    return { allowed: false, reasonCodes: ["missing_organization_scope"], auditRequired: true };
  }
  if (input.explicitDeny?.includes(input.permission)) {
    return { allowed: false, reasonCodes: ["explicit_deny"], auditRequired: true };
  }
  if (input.targetOrganizationId && input.targetOrganizationId !== input.organizationId) {
    return { allowed: false, reasonCodes: ["cross_organization_access_denied"], auditRequired: true };
  }
  const orgRoles = input.actor.organizationRoles[input.organizationId] || [];
  if (orgRoles.some((role) => PLATFORM_ONLY_ROLES.includes(role)) && !input.actor.isPlatformActor) {
    return { allowed: false, reasonCodes: ["platform_role_not_org_assignable"], auditRequired: true };
  }
  const rolePermissions = permissionsForRoles(orgRoles);
  const temporaryPermissions = (input.temporaryAccess?.expiresAt && Date.parse(input.temporaryAccess.expiresAt) > Date.now()) ? input.temporaryAccess.permissions || [] : [];
  const permissions = normalizePermissions([...rolePermissions, ...temporaryPermissions, ...(input.directPermissions || [])]);
  if (!permissions.includes(input.permission)) reasonCodes.push("permission_missing");
  if (input.supportAccess && (!input.supportAccess.approved || Date.parse(input.supportAccess.expiresAt) <= Date.now())) reasonCodes.push("support_access_not_active");
  if (input.permission === "support.impersonate" && !input.supportAccess?.justification) reasonCodes.push("support_justification_required");
  const allowed = reasonCodes.length === 0;
  return { allowed, reasonCodes: allowed ? ["permission_granted"] : reasonCodes, auditRequired: true, effectivePermissions: permissions };
}

export function validateDelegatedRoleAssignment(input) {
  if (input.targetOrganizationId !== input.actorOrganizationId) return { allowed: false, reasonCodes: ["cross_organization_assignment_denied"] };
  if (PLATFORM_ONLY_ROLES.includes(input.role)) return { allowed: false, reasonCodes: ["platform_role_not_delegable"] };
  if (input.removesLastAdmin) return { allowed: false, reasonCodes: ["last_admin_removal_denied"] };
  if (input.actorUserId && input.targetUserId && input.actorUserId === input.targetUserId && input.role === "organization_admin") return { allowed: false, reasonCodes: ["self_escalation_denied"] };
  return { allowed: true, reasonCodes: ["delegated_assignment_allowed"] };
}