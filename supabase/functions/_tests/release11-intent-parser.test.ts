import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseCopilotIntent } from "../_shared/copilot/intent-parser.ts";

Deno.test("Release 11 intent parser detects lease and portfolio questions", () => {
  assertEquals(parseCopilotIntent("Which leases expire next year?", "portfolio").intent, "lease_expiration_search");
  assertEquals(parseCopilotIntent("Generate an executive summary", "lease").intent, "executive_summary");
});

Deno.test("Release 11 intent parser marks unsupported questions transparently", () => {
  const result = parseCopilotIntent("What color should the lobby be?", "lease");
  assertEquals(result.intent, "unsupported");
  assertEquals(result.reasonCodes, ["unsupported_question"]);
});