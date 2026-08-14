import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildCopilotPrompt } from "../_shared/copilot/prompt-builder.ts";

Deno.test("Release 11 prompt builder uses selected facts and no full document", () => {
  const node = { id: "n1", nodeType: "canonical_field", key: "base_rent", value: "$10", status: "approved", confidence: 0.98, generationId: "g1", evidence: [{ id: "e1", documentId: "d1", page: 4, text: "Base rent is $10" }] };
  const result = buildCopilotPrompt({ question: "What is current base rent?", intent: "current_field_value", nodes: [node] });
  assert(result.prompt !== null);
  assert(result.prompt.includes("Answer only from provided facts"));
  assert(result.prompt.includes("base_rent"));
  assertEquals(result.reasonCodes, ["prompt_built_from_grounded_facts"]);
});