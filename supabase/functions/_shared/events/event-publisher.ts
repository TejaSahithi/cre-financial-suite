// @ts-nocheck

import { buildIntegrationEvent } from "./event-bus.ts";
import { persistIntegrationEvent } from "./event-store.ts";

export async function publishIntegrationEvent(args: { supabaseAdmin?: any; organizationId: string; eventKey: string; aggregateId: string; aggregateType?: string; generationId?: string | null; payload: Record<string, unknown>; metadata?: Record<string, unknown> }) {
  const event = await buildIntegrationEvent(args);
  if (!args.supabaseAdmin) return { event, persisted: false, error: null };
  const persisted = await persistIntegrationEvent({ supabaseAdmin: args.supabaseAdmin, event });
  return { event, persisted: persisted.error === null, error: persisted.error };
}
