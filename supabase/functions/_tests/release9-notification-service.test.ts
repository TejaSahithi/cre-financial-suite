import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildNotification } from "../_shared/integrations/notification-service.ts";

Deno.test("Release 9 notification service builds template notifications", () => {
  const notification = buildNotification({ organizationId: "org", templateKey: "risk_alert", channel: "email", recipientType: "role", recipientKey: "portfolio_manager", payload: { severity: "high" } });
  assertEquals(notification.notificationStatus, "queued");
  assertEquals(notification.notificationPayload.title, "Portfolio risk alert");
});

Deno.test("Release 9 notification service rejects unsupported channel", () => {
  assertThrows(() => buildNotification({ organizationId: "org", templateKey: "export_complete", channel: "slack", recipientType: "user", recipientKey: "u1", payload: {} }), Error, "unsupported_channel");
});
