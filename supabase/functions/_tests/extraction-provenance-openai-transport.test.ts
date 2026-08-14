// @ts-nocheck
// P1.4 — mocked-call tests for the OpenAI provenance transport wrapper.
// Verifies the wrapper's OWN behavior (invocation lifecycle, classification
// mapping, error propagation, provider identity) without depending on
// llm.ts's real HTTP path: the no-op path (flag off), the fail-closed start
// path, the invocation_key-reuse guard, and callFn injection are all
// reachable without a real OpenAI call.

import { assert, assertEquals, assertRejects, assertStrictEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { callOpenAIWithProvenance, mapOpenAIFailureToGeneric } from "../_shared/extraction/provenance/transport/openai.ts";
import { ProvenancePersistenceError } from "../_shared/extraction/provenance/recorder.ts";
import { LLMProviderError } from "../_shared/llm.ts";

const BASE_CONTEXT = {
  orgId: "org-1",
  uploadedFileId: "file-1",
  generationId: "gen-1",
  extractionRunId: "run-1",
  stageRunId: "stage-run-1",
  stageAttempt: 1,
  operation: "fact_extraction_chunk",
};

// register_extraction_artifact defaults to a quiet success unless a test
// explicitly overrides it -- artifact capture is incidental to most of
// these tests (which validate invocation settlement), not their subject.
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
    // Chainable stub for markArtifactUnavailable's provider_invocations
    // update -- only reached on an artifact-capture failure path, which
    // these tests don't exercise by default; resolves as a harmless no-op.
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

Deno.test("callOpenAIWithProvenance: flag disabled calls callFn directly and makes zero RPC calls", async () => {
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
  const supabaseAdmin = makeMockSupabase({});
  const mockCallFn = async () => ({ content: "ok", model: "gpt-4o-mini", inputTokens: 10, outputTokens: 5 });
  const result = await callOpenAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn);
  assertEquals(result.content, "ok");
  assertEquals(supabaseAdmin.calls.length, 0);
});

Deno.test("callOpenAIWithProvenance: missing stageRunId makes zero RPC calls even with flag on", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({});
  const mockCallFn = async () => ({ content: "ok", model: "gpt-4o-mini", inputTokens: 10, outputTokens: 5 });
  const result = await callOpenAIWithProvenance(
    supabaseAdmin, { ...BASE_CONTEXT, stageRunId: null }, { userPrompt: "test" }, mockCallFn,
  );
  assertEquals(result.content, "ok");
  assertEquals(supabaseAdmin.calls.length, 0);
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callOpenAIWithProvenance: start_provider_invocation failure fails closed (PROVENANCE_PERSISTENCE_FAILED), never calls the provider", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: null, error: { message: "insert failed" } }],
  });
  let called = false;
  const mockCallFn = async () => { called = true; return {} as any; };
  const err = await assertRejects(
    () => callOpenAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn),
    ProvenancePersistenceError,
  );
  assertEquals((err as any).code, "PROVENANCE_PERSISTENCE_FAILED");
  assertEquals(called, false, "must not proceed to call the provider on a start-persistence failure");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callOpenAIWithProvenance: start_provider_invocation records provider='openai'", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-1", created: true, status: "running" }, error: null }],
    settle_provider_invocation: [{ data: { settled_by_this_call: true, status: "completed" }, error: null }],
  });
  const mockCallFn = async () => ({ content: "ok", model: "gpt-4o-mini", inputTokens: 10, outputTokens: 5 });
  await callOpenAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn);

  const startCall = supabaseAdmin.calls.find((c) => c.fn === "start_provider_invocation");
  assertEquals(startCall.args.p_provider, "openai");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callOpenAIWithProvenance: reused invocation_key already terminal throws PROVENANCE_INVOCATION_KEY_REUSED, never calls the provider", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-1", created: false, status: "completed" }, error: null }],
  });
  let called = false;
  const mockCallFn = async () => { called = true; return {} as any; };
  const err = await assertRejects(
    () => callOpenAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn),
    ProvenancePersistenceError,
  );
  assertEquals((err as any).code, "PROVENANCE_INVOCATION_KEY_REUSED");
  assertEquals(called, false, "must not proceed to call the provider on a reused terminal key");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callOpenAIWithProvenance: invocation_key includes providerAttempt so a caller-driven retry gets a distinct key", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [
      { data: null, error: { message: "boom" } },
      { data: null, error: { message: "boom" } },
    ],
  });
  const mockCallFn = async () => ({} as any);
  await assertRejects(() => callOpenAIWithProvenance(supabaseAdmin, { ...BASE_CONTEXT, providerAttempt: 1 }, { userPrompt: "test" }, mockCallFn));
  await assertRejects(() => callOpenAIWithProvenance(supabaseAdmin, { ...BASE_CONTEXT, providerAttempt: 2 }, { userPrompt: "test" }, mockCallFn));
  const keys = supabaseAdmin.calls.map((c) => c.args.p_invocation_key);
  assertEquals(new Set(keys).size, 2, "different providerAttempt values must produce different invocation_key values");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callOpenAIWithProvenance: providerAttempt defaults to stageAttempt for stage-level retries", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [
      { data: null, error: { message: "boom" } },
      { data: null, error: { message: "boom" } },
    ],
  });
  const mockCallFn = async () => ({} as any);
  await assertRejects(() => callOpenAIWithProvenance(supabaseAdmin, { ...BASE_CONTEXT, stageAttempt: 1 }, { userPrompt: "test" }, mockCallFn));
  await assertRejects(() => callOpenAIWithProvenance(supabaseAdmin, { ...BASE_CONTEXT, stageAttempt: 2 }, { userPrompt: "test" }, mockCallFn));

  const starts = supabaseAdmin.calls.filter((c) => c.fn === "start_provider_invocation");
  assertEquals(starts.map((c) => c.args.p_provider_attempt), [1, 2]);
  assertEquals(new Set(starts.map((c) => c.args.p_invocation_key)).size, 2);
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});
Deno.test("callOpenAIWithProvenance: a running invocation exists BEFORE the mocked call resolves", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-1", created: true, status: "running" }, error: null }],
    settle_provider_invocation: [{ data: { settled_by_this_call: true, status: "completed" }, error: null }],
  });
  let invocationStatusMidFlight: string | undefined;
  const mockCallFn = async () => {
    // Assert the invocation is already recorded as running while the
    // provider call is still "in flight" -- proving start happens BEFORE
    // the outbound call, not after.
    invocationStatusMidFlight = supabaseAdmin.calls.find((c) => c.fn === "start_provider_invocation") ? "running" : "missing";
    return { content: "ok", model: "gpt-4o-mini", inputTokens: 100, outputTokens: 50 };
  };
  const result = await callOpenAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn);
  assertEquals(invocationStatusMidFlight, "running");
  assertEquals(result.content, "ok");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callOpenAIWithProvenance: success terminalizes with tokens and latency", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-1", created: true, status: "running" }, error: null }],
    settle_provider_invocation: [{ data: { settled_by_this_call: true, status: "completed" }, error: null }],
  });
  const mockCallFn = async () => ({ content: "ok", model: "gpt-4o-mini", inputTokens: 123, outputTokens: 45 });
  await callOpenAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn);

  const settleCall = supabaseAdmin.calls.find((c) => c.fn === "settle_provider_invocation");
  assert(settleCall, "settle_provider_invocation must have been called");
  assertEquals(settleCall.args.p_status, "completed");
  assertEquals(settleCall.args.p_success, true);
  assertEquals(settleCall.args.p_input_tokens, 123);
  assertEquals(settleCall.args.p_output_tokens, 45);
  assert(typeof settleCall.args.p_latency_ms === "number" && settleCall.args.p_latency_ms >= 0);
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callOpenAIWithProvenance: failure terminalizes with classification, then re-throws the original error unchanged", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-1", created: true, status: "running" }, error: null }],
    settle_provider_invocation: [{ data: { settled_by_this_call: true, status: "failed" }, error: null }],
  });
  const originalError = new LLMProviderError("rate limited by OpenAI", "rate_limit", 429);
  const mockCallFn = async () => { throw originalError; };

  const thrown = await assertRejects(
    () => callOpenAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn),
  );
  // Re-thrown completely unchanged: same instance, same classification,
  // same message -- proving this wrapper never alters caller-visible error behavior.
  assertStrictEquals(thrown, originalError);
  assertEquals((thrown as LLMProviderError).classification, "rate_limit");

  const settleCall = supabaseAdmin.calls.find((c) => c.fn === "settle_provider_invocation");
  assertEquals(settleCall.args.p_status, "failed");
  assertEquals(settleCall.args.p_success, false);
  assertEquals(settleCall.args.p_failure_classification, "rate_limit");
  assertEquals(settleCall.args.p_provider_error_code, "rate_limit");
  assertEquals(settleCall.args.p_http_status, 429);
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callOpenAIWithProvenance: flag-on success result is deep-equal to the flag-off passthrough result (compatibility)", async () => {
  const mockCallFn = async () => ({ content: "same content", model: "gpt-4o-mini", inputTokens: 10, outputTokens: 5 });

  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
  const flagOffResult = await callOpenAIWithProvenance(makeMockSupabase({}), BASE_CONTEXT, { userPrompt: "test" }, mockCallFn);

  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-1", created: true, status: "running" }, error: null }],
    settle_provider_invocation: [{ data: { settled_by_this_call: true, status: "completed" }, error: null }],
  });
  const flagOnResult = await callOpenAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn);

  assertEquals(flagOnResult, flagOffResult, "provenance must never alter the caller-visible provider result");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("mapOpenAIFailureToGeneric: passes through a classification already in the generic taxonomy, and defaults to unknown", () => {
  const ALLOWED = new Set([
    "authentication", "authorization", "quota", "rate_limit", "resource_exhausted", "timeout",
    "transport", "provider_client_error", "provider_server_error", "invalid_response",
    "schema_validation", "cancelled", "superseded", "unknown",
  ]);
  const cases: Array<[any, string]> = [
    ["timeout", "timeout"],
    ["rate_limit", "rate_limit"],
    ["provider_server_error", "provider_server_error"],
    ["authentication", "authentication"],
    ["transport", "transport"],
    ["unknown", "unknown"],
    [undefined, "unknown"],
  ];
  for (const [input, expected] of cases) {
    const mapped = mapOpenAIFailureToGeneric(input);
    assertStrictEquals(mapped, expected);
    assert(ALLOWED.has(mapped), `${mapped} must be one of the schema's allowed failure_classification values`);
  }
});
