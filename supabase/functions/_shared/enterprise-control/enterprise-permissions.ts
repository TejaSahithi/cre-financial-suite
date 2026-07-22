// @ts-nocheck

export const ENTERPRISE_CONTROL_SCHEMA_VERSION = "enterprise-control-release10-v1";

export type EnterprisePermission =
  | "lease.read" | "lease.review" | "lease.approve" | "lease.override"
  | "portfolio.read" | "portfolio.publish" | "portfolio.export"
  | "integration.manage" | "workflow.manage" | "audit.read" | "security.manage"
  | "retention.manage" | "organization.manage" | "support.impersonate" | "legacy.enable"
  | "exports.create" | "events.read";

export const ENTERPRISE_PERMISSIONS: EnterprisePermission[] = [
  "lease.read", "lease.review", "lease.approve", "lease.override",
  "portfolio.read", "portfolio.publish", "portfolio.export",
  "integration.manage", "workflow.manage", "audit.read", "security.manage",
  "retention.manage", "organization.manage", "support.impersonate", "legacy.enable",
  "exports.create", "events.read",
];

export function normalizePermissions(values: unknown[]): EnterprisePermission[] {
  return Array.from(new Set((values || []).filter((value) => ENTERPRISE_PERMISSIONS.includes(value))));
}