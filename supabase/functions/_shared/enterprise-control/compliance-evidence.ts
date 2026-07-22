// @ts-nocheck
const SENSITIVE_KEYS = ["text", "fullText", "leaseText", "credential", "token", "secret", "signedUrl", "password"];
export function sanitizeAuditMetadata(metadata = {}) {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !SENSITIVE_KEYS.some((s) => key.toLowerCase().includes(s.toLowerCase()))));
}
export function buildEnterpriseAuditEvent(args) {
  return { id: args.id, organizationId: args.organizationId ?? null, actorType: args.actorType, actorId: args.actorId ?? null, action: args.action, resourceType: args.resourceType, resourceId: args.resourceId ?? null, outcome: args.outcome, reasonCodes: args.reasonCodes || [], requestId: args.requestId ?? null, correlationId: args.correlationId ?? null, metadata: sanitizeAuditMetadata(args.metadata), occurredAt: args.occurredAt, schemaVersion: "enterprise-audit-event-v1" };
}