// @ts-nocheck
import { EnterprisePermission } from "./enterprise-permissions.ts";

export type EnterpriseRole =
  | "platform_super_admin" | "organization_admin" | "security_admin" | "integration_admin"
  | "portfolio_admin" | "lease_reviewer" | "legal_reviewer" | "accounting_reviewer"
  | "workflow_manager" | "auditor" | "read_only_analyst" | "support_operator";

export const PLATFORM_ONLY_ROLES: EnterpriseRole[] = ["platform_super_admin", "support_operator"];

export const ENTERPRISE_ROLE_REGISTRY: Record<EnterpriseRole, EnterprisePermission[]> = {
  platform_super_admin: ["lease.read", "lease.review", "lease.approve", "lease.override", "portfolio.read", "portfolio.publish", "portfolio.export", "integration.manage", "workflow.manage", "audit.read", "security.manage", "retention.manage", "organization.manage", "support.impersonate", "legacy.enable", "exports.create", "events.read"],
  organization_admin: ["lease.read", "portfolio.read", "portfolio.export", "integration.manage", "workflow.manage", "audit.read", "organization.manage", "exports.create", "events.read"],
  security_admin: ["audit.read", "security.manage", "retention.manage", "organization.manage"],
  integration_admin: ["integration.manage", "events.read", "audit.read"],
  portfolio_admin: ["portfolio.read", "portfolio.publish", "portfolio.export", "exports.create"],
  lease_reviewer: ["lease.read", "lease.review", "lease.approve"],
  legal_reviewer: ["lease.read", "lease.review", "lease.override"],
  accounting_reviewer: ["lease.read", "lease.review", "portfolio.read"],
  workflow_manager: ["workflow.manage", "lease.read", "portfolio.read"],
  auditor: ["audit.read", "lease.read", "portfolio.read", "events.read"],
  read_only_analyst: ["lease.read", "portfolio.read"],
  support_operator: ["support.impersonate", "audit.read"],
};

export function permissionsForRoles(roles: EnterpriseRole[]): EnterprisePermission[] {
  return Array.from(new Set(roles.flatMap((role) => ENTERPRISE_ROLE_REGISTRY[role] || [])));
}