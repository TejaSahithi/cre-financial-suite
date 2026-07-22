import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyDeliveryAttempt, nextRetryDelaySeconds, shouldRetryDelivery } from "../_shared/integrations/retry-policy.ts";

Deno.test("Release 9 retry policy retries temporary failures", () => {
  assertEquals(shouldRetryDelivery({ status: 429 }).retryable, true);
  assertEquals(nextRetryDelaySeconds(3, { baseDelaySeconds: 10 }), 40);
  assertEquals(classifyDeliveryAttempt({ attemptNumber: 1, status: 503 }).terminalStatus, "retry_scheduled");
});

Deno.test("Release 9 retry policy never retries validation or permission failures", () => {
  assertEquals(shouldRetryDelivery({ status: 400 }).retryable, false);
  assertEquals(shouldRetryDelivery({ errorCode: "permission" }).retryable, false);
  assertEquals(classifyDeliveryAttempt({ attemptNumber: 5, status: 503, policy: { maxAttempts: 5 } }).terminalStatus, "dead_lettered");
});
