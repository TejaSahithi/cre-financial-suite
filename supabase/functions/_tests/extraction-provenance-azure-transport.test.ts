// @ts-nocheck
// P1.4 — mocked-call tests for the Azure Document Intelligence provenance
// transport wrapper. Mirrors extraction-provenance-vertex-transport.test.ts.

import { assert, assertEquals, assertRejects, assertStrictEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  analyzeWithAzureLayoutAndProvenance,
  classifyAzureFailure,
} from "../_shared/extraction/provenance/transport/azure.ts";
import { ProvenancePersistenceError } from "../_shared/extraction/provenance/recorder.ts";

const BASE_CONTEXT = {
  orgId: "org-1",
  uploadedFileId: "file-1",
  generationId: "gen-1",
  extractionRunId: "run-1",
  stageRunId: "stage-run-1",
  stageAttempt: 1,
  operation: "layout_analysis",
};

const DEFAULT_RPC_SUCCESS: Record<string, { data: any; error: any }> = {
  register_extraction_artifact: { data: { artifact_id: "artifact-mock-1" }, error: null },
};

function makeMockSupabase(rpcResponses: Record<string, Array<{ data: any; error: any }>>) {
  const calls: Array<{ fn: string; args: any }> = [];
  return {
    calls,
    rpc(fn: string, args: any) {
      calls.push({ fn, args });
      const queue = rpcResponses[fn];
      if (queue && queue.length > 0) return Promise.resolve(queue.shift());
      if (DEFAULT_RPC_SUCCESS[fn]) return Promise.resolve(DEFAULT_RPC_SUCCESS[fn]);
      return Promise.resolve({ data: null, error: { message: `no mock response for ${fn}` } });
    },
    from(_table: string) {
      const builder: any = {
        update: (_patch: any) => builder,
        eq: (_col: string, _val: any) => builder,
        then: (resolve: any) => resolve({ error: null }),
      };
      return builder;
    },
  };
}

Deno.test("analyzeWithAzureLayoutAndProvenance: flag disabled calls straight through with zero RPC calls", async () => {
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
  const supabaseAdmin = makeMockSupabase({});
  const mockCallFn = async () => ({ content: "layout" });
  const result = await analyzeWithAzureLayoutAndProvenance(supabaseAdmin, BASE_CONTEXT, {}, mockCallFn);
  assertEquals(result.content, "layout");
  assertEquals(supabaseAdmin.calls.length, 0);
});

Deno.test("analyzeWithAzureLayoutAndProvenance: missing stageRunId makes zero RPC calls even with flag on", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({});
  const mockCallFn = async () => ({ content: "layout" });
  await analyzeWithAzureLayoutAndProvenance(supabaseAdmin, { ...BASE_CONTEXT, stageRunId: null }, {}, mockCallFn);
  assertEquals(supabaseAdmin.calls.length, 0);
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("analyzeWithAzureLayoutAndProvenance: start_provider_invocation failure fails closed, never calls the provider", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: null, error: { message: "insert failed" } }],
  });
  let callFnInvoked = false;
  const mockCallFn = async () => { callFnInvoked = true; return {}; };
  const err = await assertRejects(
    () => analyzeWithAzureLayoutAndProvenance(supabaseAdmin, BASE_CONTEXT, {}, mockCallFn),
    ProvenancePersistenceError,
  );
  assertEquals((err as any).code, "PROVENANCE_PERSISTENCE_FAILED");
  assertEquals(callFnInvoked, false, "the provider must never be called when start fails");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("analyzeWithAzureLayoutAndProvenance: a running invocation exists before the mocked call resolves, success terminalizes with latency (no tokens)", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-1", created: true, status: "running" }, error: null }],
    settle_provider_invocation: [{ data: { settled_by_this_call: true, status: "completed" }, error: null }],
  });
  let sawRunningMidFlight = false;
  const mockCallFn = async () => {
    sawRunningMidFlight = supabaseAdmin.calls.some((c) => c.fn === "start_provider_invocation");
    return { content: "layout" };
  };
  await analyzeWithAzureLayoutAndProvenance(supabaseAdmin, BASE_CONTEXT, {}, mockCallFn);
  assert(sawRunningMidFlight);

  const settleCall = supabaseAdmin.calls.find((c) => c.fn === "settle_provider_invocation");
  assertEquals(settleCall.args.p_status, "completed");
  assertEquals(settleCall.args.p_success, true);
  assertEquals(settleCall.args.p_input_tokens, null);
  assert(typeof settleCall.args.p_latency_ms === "number" && settleCall.args.p_latency_ms >= 0);
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("analyzeWithAzureLayoutAndProvenance: failure terminalizes with extracted HTTP status and classification, re-throws unchanged", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-1", created: true, status: "running" }, error: null }],
    settle_provider_invocation: [{ data: { settled_by_this_call: true, status: "failed" }, error: null }],
  });
  const originalError = new Error("Azure Document Intelligence submit failed (429): rate limited");
  const mockCallFn = async () => { throw originalError; };

  const thrown = await assertRejects(
    () => analyzeWithAzureLayoutAndProvenance(supabaseAdmin, BASE_CONTEXT, {}, mockCallFn),
  );
  assertStrictEquals(thrown, originalError);

  const settleCall = supabaseAdmin.calls.find((c) => c.fn === "settle_provider_invocation");
  assertEquals(settleCall.args.p_status, "failed");
  assertEquals(settleCall.args.p_failure_classification, "rate_limit");
  assertEquals(settleCall.args.p_http_status, 429);
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("classifyAzureFailure: extracts HTTP status and maps to the generic taxonomy", () => {
  const ALLOWED = new Set([
    "authentication", "authorization", "quota", "rate_limit", "resource_exhausted", "timeout",
    "transport", "provider_client_error", "provider_server_error", "invalid_response",
    "schema_validation", "cancelled", "superseded", "unknown",
  ]);
  const cases: Array<[string, string, number | null]> = [
    ["Azure Document Intelligence endpoint is not configured", "authentication", null],
    ["Azure Document Intelligence key is not configured", "authentication", null],
    ["Azure Document Intelligence analysis timed out after 120s", "timeout", null],
    ["Azure Document Intelligence submit failed (429): too many requests", "rate_limit", 429],
    ["Azure Document Intelligence submit failed (500): internal error", "provider_server_error", 500],
    ["Azure Document Intelligence polling failed (400): bad request", "provider_client_error", 400],
    ["Azure Document Intelligence analysis failed: {\"code\":\"InternalError\"}", "provider_server_error", null],
    ["Azure Document Intelligence succeeded but analyzeResult was missing", "invalid_response", null],
    ["Azure Document Intelligence submit succeeded but Operation-Location header was missing", "invalid_response", null],
    ["some totally unexpected message", "unknown", null],
  ];
  for (const [message, expectedGeneric, expectedStatus] of cases) {
    const { generic, httpStatus } = classifyAzureFailure(message);
    assertStrictEquals(generic, expectedGeneric, `message: ${message}`);
    assertStrictEquals(httpStatus, expectedStatus, `message: ${message}`);
    assert(ALLOWED.has(generic));
  }
});
