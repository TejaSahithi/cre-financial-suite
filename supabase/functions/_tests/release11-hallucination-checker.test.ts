import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkForHallucination } from "../_shared/copilot/hallucination-checker.ts";

Deno.test("Release 11 hallucination checker rejects unsupported numeric claims", () => {
  const result = checkForHallucination("The rent is $999.", [{ value: "$10", metadata: {} }]);
  assertEquals(result.passed, false);
  assertEquals(result.reasonCodes, ["unsupported_numeric_claim"]);
});