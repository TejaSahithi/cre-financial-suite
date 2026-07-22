// @ts-nocheck

export const INTEGRATION_EVENT_SCHEMA_VERSION = "integration-event-v1";
export const INTEGRATION_ALGORITHM_VERSION = "enterprise-integrations-release9-v1";

export type IntegrationEventKey =
  | "lease.approved"
  | "lease.rejected"
  | "lease.reviewed"
  | "lease-family.updated"
  | "lease-fact.published"
  | "portfolio-fact.updated"
  | "critical-date.created"
  | "critical-date.changed"
  | "obligation.created"
  | "obligation.completed"
  | "risk.created"
  | "risk.resolved"
  | "rent-roll-variance.detected"
  | "portfolio-snapshot.published";

export interface IntegrationEvent {
  organizationId: string;
  eventId: string;
  eventKey: IntegrationEventKey;
  aggregateId: string;
  aggregateType: string;
  generationId: string | null;
  contractVersion: string;
  schemaVersion: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  metadata: Record<string, unknown>;
}

export interface DeliveryAttemptResult {
  retryable: boolean;
  nextDelaySeconds: number | null;
  terminalStatus: "delivered" | "retry_scheduled" | "failed" | "dead_lettered";
  reasonCode: string;
}
