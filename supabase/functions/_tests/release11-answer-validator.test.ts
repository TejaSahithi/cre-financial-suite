import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validateCopilotAnswer } from "../_shared/copilot/answer-validator.ts";

Deno.test("Release 11 answer validator requires evidence citations", () => {
  const result = validateCopilotAnswer({ answer: "Rent is $10.", nodes: [{ id: "n1", nodeType: "canonical_field", key: "base_rent", value: "$10", status: "approved", confidence: 0.9, evidence: [] }] });
  assertEquals(result.supported, false);
  assertEquals(result.limitations, ["missing_evidence_citations"]);
});

Deno.test("Release 11 answer validator rejects stale generations", () => {
  const result = validateCopilotAnswer({ answer: "Rent is $10.", nodes: [{ id: "n1", nodeType: "canonical_field", key: "base_rent", value: "$10", status: "stale", evidence: [{ id: "e1", documentId: "d1" }] }] });
  assertEquals(result.supported, false);
  assertEquals(result.limitations, ["stale_generation_rejected"]);
});