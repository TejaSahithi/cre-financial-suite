// @ts-nocheck

export async function signWebhookPayload(args: { secret: string; timestamp: string; payload: unknown }) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(args.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const body = typeof args.payload === "string" ? args.payload : JSON.stringify(args.payload);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${args.timestamp}.${body}`));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildSignedWebhookDelivery(args: { endpointUrl: string; secret: string; event: any; timestamp?: string }) {
  const timestamp = args.timestamp ?? new Date(0).toISOString();
  const signature = await signWebhookPayload({ secret: args.secret, timestamp, payload: args.event });
  return {
    url: args.endpointUrl,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CRE-Event-Id": args.event.eventId,
      "X-CRE-Event-Key": args.event.eventKey,
      "X-CRE-Timestamp": timestamp,
      "X-CRE-Signature": `sha256=${signature}`,
    },
    body: args.event,
  };
}

export function isReplayTimestampAccepted(timestamp: string, now: string, toleranceSeconds = 300) {
  const diff = Math.abs(new Date(now).getTime() - new Date(timestamp).getTime()) / 1000;
  return Number.isFinite(diff) && diff <= toleranceSeconds;
}
