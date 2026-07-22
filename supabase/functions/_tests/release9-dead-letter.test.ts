import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createDeadLetter, replayDeadLetter } from "../_shared/integrations/dead-letter.ts";

Deno.test("Release 9 dead-letter records failure payload and retry history", () => {
  const dead = createDeadLetter({ delivery: { id: "d1", endpointId: "e1" }, event: { id: "event-row", organizationId: "org" }, failedPayload: { hello: "world" }, failureReason: "max_attempts_exhausted", attempts: [{ attemptNumber: 1, status: 503, retryable: true }] });
  assertEquals(dead.replayStatus, "not_replayed");
  assertEquals(dead.retryHistory[0].retryable, true);
  assertEquals(replayDeadLetter(dead).replayQueued, true);
});
