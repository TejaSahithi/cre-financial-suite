import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildSignedWebhookDelivery, isReplayTimestampAccepted, signWebhookPayload } from "../_shared/integrations/webhook-delivery.ts";

Deno.test("Release 9 webhook delivery signs payloads with HMAC", async () => {
  const event = { eventId: "event-1", eventKey: "lease.approved" };
  const delivery = await buildSignedWebhookDelivery({ endpointUrl: "https://example.com/webhook", secret: "secret", event, timestamp: "2030-01-01T00:00:00.000Z" });
  const signature = await signWebhookPayload({ secret: "secret", timestamp: "2030-01-01T00:00:00.000Z", payload: event });
  assertEquals(delivery.headers["X-CRE-Signature"], `sha256=${signature}`);
});

Deno.test("Release 9 webhook delivery enforces replay timestamp window", () => {
  assertEquals(isReplayTimestampAccepted("2030-01-01T00:00:00.000Z", "2030-01-01T00:04:00.000Z"), true);
  assertEquals(isReplayTimestampAccepted("2030-01-01T00:00:00.000Z", "2030-01-01T00:10:00.000Z"), false);
});
