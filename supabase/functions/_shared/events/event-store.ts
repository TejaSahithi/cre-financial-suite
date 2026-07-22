// @ts-nocheck

import { eventToDatabaseRow } from "./event-bus.ts";

export async function persistIntegrationEvent(args: { supabaseAdmin: any; event: any }) {
  const row = eventToDatabaseRow(args.event);
  const { data, error } = await args.supabaseAdmin.from("integration_events").insert(row).select("id").maybeSingle();
  if (error && !String(error.message ?? "").toLowerCase().includes("duplicate")) return { eventRowId: null, error: error.message };
  return { eventRowId: data?.id ?? null, error: null };
}

export function appendOnlyEventGuard(existingEvent: any, nextEvent: any) {
  if (!existingEvent) return { allowed: true, reason: "new_event" };
  return existingEvent.payloadHash === nextEvent.payloadHash
    ? { allowed: false, reason: "duplicate_event" }
    : { allowed: false, reason: "immutable_event_conflict" };
}
