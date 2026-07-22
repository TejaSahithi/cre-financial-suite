// @ts-nocheck
import { decideEnterpriseAuthorization } from "./enterprise-authorization.ts";
export function mayPerformAction(input) { return decideEnterpriseAuthorization(input); }
export function privilegedWriteRequiresAudit(action) { return ["lease.approve", "lease.override", "portfolio.publish", "security.manage", "support.impersonate", "legacy.enable"].includes(action); }
export function failClosedWhenAuditUnavailable(input) { return privilegedWriteRequiresAudit(input.action) && !input.auditAvailable ? { allowed: false, reasonCodes: ["audit_unavailable_fail_closed"] } : { allowed: true, reasonCodes: ["audit_available"] }; }