// @ts-nocheck

import { INTEGRATION_EVENT_SCHEMA_VERSION } from "./event-contracts.ts";
import { assertSupportedEvent } from "./event-registry.ts";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export async function hashPayload(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildIntegrationEvent(args: { organizationId: string; eventKey: string; aggregateId: string; aggregateType?: string; generationId?: string | null; payload: Record<string, unknown>; occurredAt?: string; metadata?: Record<string, unknown> }) {
  const definition = assertSupportedEvent(args.eventKey);
  const payloadHash = await hashPayload(args.payload);
  const occurredAt = args.occurredAt ?? new Date(0).toISOString();
  return {
    organizationId: args.organizationId,
    eventId: `${args.eventKey}:${args.aggregateId}:${args.generationId ?? "none"}:${payloadHash}`,
    eventKey: args.eventKey,
    aggregateId: args.aggregateId,
    aggregateType: args.aggregateType ?? definition.aggregateType,
    generationId: args.generationId ?? null,
    contractVersion: definition.contractVersion,
    schemaVersion: INTEGRATION_EVENT_SCHEMA_VERSION,
    occurredAt,
    payload: args.payload,
    payloadHash,
    metadata: args.metadata ?? {},
  };
}

export function eventToDatabaseRow(event: any) {
  return {
    organization_id: event.organizationId,
    event_key: event.eventKey,
    event_id: event.eventId,
    aggregate_id: event.aggregateId,
    aggregate_type: event.aggregateType,
    generation_id: event.generationId,
    contract_version: event.contractVersion,
    schema_version: event.schemaVersion,
    occurred_at: event.occurredAt,
    payload: event.payload,
    payload_hash: event.payloadHash,
    metadata: event.metadata ?? {},
  };
}
