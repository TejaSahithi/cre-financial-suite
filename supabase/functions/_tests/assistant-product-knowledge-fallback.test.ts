// @ts-nocheck
// Regression: broad product/module questions should be answered from the
// platform capability registry without needing the LLM to choose a tool first.

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runAssistantOrchestrator } from "../_shared/assistant/assistant-orchestrator.ts";

Deno.test("runAssistantOrchestrator answers generic lease module questions from product knowledge", async () => {
  const result = await runAssistantOrchestrator(
    "Hello can you explain what is lease module doing",
    {},
    { req: new Request("https://example.test"), orgId: "org", userId: "user", supabaseAdmin: {} },
  );

  assertEquals(result.status, "answered");
  assertStringIncludes(result.answer, "The Leases module");
  assertStringIncludes(result.answer, "Lease Upload");
  assertStringIncludes(result.answer, "Lease Review");
  assertEquals(result.toolRuns.length, 0);
  assertEquals(result.citations.some((citation) => citation.label === "Platform capability: Leases"), true);
});
Deno.test("runAssistantOrchestrator answers current-page product questions from UI context", async () => {
  const result = await runAssistantOrchestrator(
    "What does this page do?",
    { currentPage: "LeaseReview" },
    { req: new Request("https://example.test"), orgId: "org", userId: "user", supabaseAdmin: {} },
  );

  assertEquals(result.status, "answered");
  assertStringIncludes(result.answer, "Lease Review");
  assertStringIncludes(result.answer, "canonical");
  assertEquals(result.toolRuns.length, 0);
  assertEquals(result.citations.some((citation) => citation.label === "Platform capability: Lease Review"), true);
});
Deno.test("runAssistantOrchestrator answers broad end-to-end business flow questions", async () => {
  const result = await runAssistantOrchestrator(
    "explain business flow end to end",
    {},
    { req: new Request("https://example.test"), orgId: "org", userId: "user", supabaseAdmin: {} },
  );

  assertEquals(result.status, "answered");
  assertStringIncludes(result.answer, "End to end");
  assertStringIncludes(result.answer, "upload and review leases");
  assertStringIncludes(result.answer, "CAM");
  assertEquals(result.toolRuns.length, 0);
});
Deno.test("runAssistantOrchestrator answers short lease approval workflow phrases", async () => {
  const result = await runAssistantOrchestrator(
    "lease module approval workflow",
    {},
    { req: new Request("https://example.test"), orgId: "org", userId: "user", supabaseAdmin: {} },
  );

  assertEquals(result.status, "answered");
  assertStringIncludes(result.answer, "Lease approval to CAM-ready");
  assertStringIncludes(result.answer, "Reviewer approves the abstract");
  assertEquals(result.toolRuns.length, 0);
});