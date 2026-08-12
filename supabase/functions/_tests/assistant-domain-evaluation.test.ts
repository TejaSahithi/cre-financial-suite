// @ts-nocheck
// Validates supabase/functions/_shared/assistant/evaluation/domain-evaluation-cases.ts
// against the REAL tool registry and capability registry — catches the
// failure mode that actually happens in practice: a case (or a tool/
// capability rename elsewhere in the codebase) silently drifting out of
// sync with what the Assistant can actually do. This is deliberately NOT a
// live-LLM test (see the eval file's own header comment for why) — it's a
// data-integrity check plus a set of structural security assertions for
// the adversarial cases.
//
// Run: deno test --allow-env --allow-read --allow-net --no-check --no-lock supabase/functions/_tests/assistant-domain-evaluation.test.ts

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DOMAIN_EVALUATION_CASES } from "../_shared/assistant/evaluation/domain-evaluation-cases.ts";
import { getTool, getToolNames } from "../_shared/assistant/tools/tool-registry.ts";
import { getCapabilityById, getWorkflowById } from "../_shared/assistant/capabilities/platform-capability-registry.ts";

Deno.test("evaluation dataset has ~100 cases across all required categories", () => {
  assertEquals(DOMAIN_EVALUATION_CASES.length, 100);
  const counts: Record<string, number> = {};
  for (const c of DOMAIN_EVALUATION_CASES) counts[c.category] = (counts[c.category] ?? 0) + 1;
  assertEquals(counts.product, 15);
  assertEquals(counts.lease, 20);
  assertEquals(counts.expense, 15);
  assertEquals(counts.cam, 15);
  assertEquals(counts.revenue, 10);
  assertEquals(counts.budget, 15);
  assertEquals(counts.cross_module, 5);
  assertEquals(counts.security, 5);
});

Deno.test("evaluation dataset has no duplicate case ids", () => {
  const ids = DOMAIN_EVALUATION_CASES.map((c) => c.id);
  assertEquals(ids.length, new Set(ids).size);
});

Deno.test("every expectedTool referenced by a case is a real, registered tool", () => {
  for (const testCase of DOMAIN_EVALUATION_CASES) {
    for (const toolName of testCase.expectedTools ?? []) {
      assert(getTool(toolName) !== undefined, `case ${testCase.id} references unknown tool "${toolName}"`);
    }
  }
});

Deno.test("every expectedCapabilityId referenced by a case resolves in the capability or workflow registry", () => {
  for (const testCase of DOMAIN_EVALUATION_CASES) {
    for (const id of testCase.expectedCapabilityIds ?? []) {
      const resolved = getCapabilityById(id) ?? getWorkflowById(id);
      assert(resolved !== undefined && resolved !== null, `case ${testCase.id} references unknown capability/workflow id "${id}"`);
    }
  }
});

Deno.test("no case's expectedTools and forbiddenTools overlap (internally consistent)", () => {
  for (const testCase of DOMAIN_EVALUATION_CASES) {
    const expected = new Set(testCase.expectedTools ?? []);
    for (const forbidden of testCase.forbiddenTools ?? []) {
      assert(!expected.has(forbidden), `case ${testCase.id} lists "${forbidden}" as both expected and forbidden`);
    }
  }
});

Deno.test("every unsupported-status case (mutation requests) forbids or omits the read tool that would leak data", () => {
  const unsupportedCases = DOMAIN_EVALUATION_CASES.filter((c) => c.expectedResponseState === "unsupported");
  assert(unsupportedCases.length >= 4, "expected multiple read-only-boundary cases in the dataset");
  for (const testCase of unsupportedCases) {
    assertEquals((testCase.expectedTools ?? []).length, 0, `unsupported case ${testCase.id} should not require any tool call to answer correctly`);
  }
});

Deno.test("security cases never reference a tool name outside the closed registry (no generic SQL, no invented admin tool)", () => {
  const securityCases = DOMAIN_EVALUATION_CASES.filter((c) => c.category === "security");
  assertEquals(securityCases.length, 5);
  const registryNames = new Set(getToolNames());
  for (const testCase of securityCases) {
    for (const toolName of [...(testCase.expectedTools ?? []), ...(testCase.forbiddenTools ?? [])]) {
      assert(registryNames.has(toolName), `security case ${testCase.id} references "${toolName}" which isn't in the real tool registry`);
    }
  }
});

Deno.test("access_denied and no_data cases are distinguished (never conflated in the dataset itself)", () => {
  const accessDenied = DOMAIN_EVALUATION_CASES.filter((c) => c.expectedResponseState === "access_denied");
  const noData = DOMAIN_EVALUATION_CASES.filter((c) => c.expectedResponseState === "no_data");
  assert(accessDenied.length >= 3, "expected multiple access_denied cases");
  assert(noData.length >= 2, "expected multiple no_data cases");
});
