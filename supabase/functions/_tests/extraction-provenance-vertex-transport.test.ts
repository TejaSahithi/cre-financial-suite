// @ts-nocheck
// P1.4 — mocked-call tests for the Vertex AI provenance transport wrapper.
// Mocks callVertexAI itself (not the network) so these tests assert the
// wrapper's OWN behavior (invocation lifecycle, classification mapping,
// error propagation) without depending on vertex-ai.ts's real HTTP path.

import { assert, assertEquals, assertRejects, assertStrictEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// vertex-ai.ts's callVertexAI is imported by the wrapper at module load
// time, so we stub it via Deno's module mocking is not available here --
// instead the wrapper module is re-imported per test isn't feasible either
// (Deno caches modules). Given that, we test through the same seam the
// wrapper actually calls: we monkey-patch the exported callVertexAI symbol
// is not possible from outside (ES module bindings are read-only), so
// these tests instead verify the wrapper's provenance bookkeeping using
// its OWN control flow guarantees that don't require intercepting
// callVertexAI: the no-op path (flag off), the fail-closed start path, and
// the invocation_key-reuse guard -- all reachable without a real Vertex
// call. Success/failure settlement content is covered structurally by the
// recorder module's own settlement tests (identical RPC shape) plus the
// classification-mapping unit test below (pure function, no I/O).

import { ProvenancePersistenceError } from "../_shared/extraction/provenance/recorder.ts";
import { callVertexAIWithProvenance, mapVertexFailureToGeneric } from "../_shared/extraction/provenance/transport/vertex.ts";
import { VertexProviderError } from "../_shared/vertex-ai.ts";

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

Deno.test("callVertexAIWithProvenance: flag disabled makes zero RPC calls", async () => {
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
  // Belt-and-suspenders: this is the one path in this file where the
  // wrapper calls through to the REAL callVertexAI. Setting this (the same
  // guard vertex-ai.ts's own call sites already check via
  // assertExternalProviderCallsAllowed) makes it throw deterministically
  // and immediately -- no live network attempt is possible here, matching
  // the "no live Vertex calls" policy for local tests.
  Deno.env.set("DISABLE_EXTERNAL_PROVIDER_CALLS", "true");
  const supabaseAdmin = makeMockSupabase({});
  await assertRejects(() => callVertexAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }));
  assertEquals(supabaseAdmin.calls.length, 0);
  Deno.env.delete("DISABLE_EXTERNAL_PROVIDER_CALLS");
});

Deno.test("callVertexAIWithProvenance: missing stageRunId makes zero RPC calls even with flag on", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({});
  await assertRejects(() =>
    callVertexAIWithProvenance(supabaseAdmin, { ...BASE_CONTEXT, stageRunId: null }, { userPrompt: "test" })
  );
  assertEquals(supabaseAdmin.calls.length, 0);
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callVertexAIWithProvenance: start_provider_invocation failure fails closed (PROVENANCE_PERSISTENCE_FAILED), never calls the provider", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: null, error: { message: "insert failed" } }],
  });
  const err = await assertRejects(
    () => callVertexAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }),
    ProvenancePersistenceError,
  );
  assertEquals((err as any).code, "PROVENANCE_PERSISTENCE_FAILED");
  // Exactly one call (the start attempt) -- proves the real provider call
  // (which would need network access and fail loudly/slowly) was never reached.
  assertEquals(supabaseAdmin.calls.length, 1);
  assertEquals(supabaseAdmin.calls[0].fn, "start_provider_invocation");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callVertexAIWithProvenance: reused invocation_key already terminal throws PROVENANCE_INVOCATION_KEY_REUSED, never calls the provider", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-1", created: false, status: "completed" }, error: null }],
  });
  const err = await assertRejects(
    () => callVertexAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }),
    ProvenancePersistenceError,
  );
  assertEquals((err as any).code, "PROVENANCE_INVOCATION_KEY_REUSED");
  assertEquals(supabaseAdmin.calls.length, 1, "must not proceed to call the provider on a reused terminal key");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callVertexAIWithProvenance: invocation_key includes providerAttempt so a caller-driven retry gets a distinct key", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [
      { data: null, error: { message: "boom" } },
      { data: null, error: { message: "boom" } },
    ],
  });
  await assertRejects(() => callVertexAIWithProvenance(supabaseAdmin, { ...BASE_CONTEXT, providerAttempt: 1 }, { userPrompt: "test" }));
  await assertRejects(() => callVertexAIWithProvenance(supabaseAdmin, { ...BASE_CONTEXT, providerAttempt: 2 }, { userPrompt: "test" }));
  const keys = supabaseAdmin.calls.map((c) => c.args.p_invocation_key);
  assertEquals(new Set(keys).size, 2, "different providerAttempt values must produce different invocation_key values");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callVertexAIWithProvenance: a running invocation exists BEFORE the mocked call resolves", async () => {
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
    return { content: "ok", model: "gemini-test", inputTokens: 100, outputTokens: 50 };
  };
  const result = await callVertexAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn);
  assertEquals(invocationStatusMidFlight, "running");
  assertEquals(result.content, "ok");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callVertexAIWithProvenance: success terminalizes with tokens and latency", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-1", created: true, status: "running" }, error: null }],
    settle_provider_invocation: [{ data: { settled_by_this_call: true, status: "completed" }, error: null }],
  });
  const mockCallFn = async () => ({ content: "ok", model: "gemini-test", inputTokens: 123, outputTokens: 45 });
  await callVertexAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn);

  const settleCall = supabaseAdmin.calls.find((c) => c.fn === "settle_provider_invocation");
  assert(settleCall, "settle_provider_invocation must have been called");
  assertEquals(settleCall.args.p_status, "completed");
  assertEquals(settleCall.args.p_success, true);
  assertEquals(settleCall.args.p_input_tokens, 123);
  assertEquals(settleCall.args.p_output_tokens, 45);
  assert(typeof settleCall.args.p_latency_ms === "number" && settleCall.args.p_latency_ms >= 0);
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callVertexAIWithProvenance: failure terminalizes with generic AND provider-specific classification, then re-throws the original error unchanged", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-1", created: true, status: "running" }, error: null }],
    settle_provider_invocation: [{ data: { settled_by_this_call: true, status: "failed" }, error: null }],
  });
  const originalError = new VertexProviderError("rate limited by Vertex", "rate_limited", 429);
  const mockCallFn = async () => { throw originalError; };

  const thrown = await assertRejects(
    () => callVertexAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn),
  );
  // Re-thrown completely unchanged: same instance, same classification,
  // same message -- proving this wrapper never alters caller-visible error behavior.
  assertStrictEquals(thrown, originalError);
  assertEquals((thrown as VertexProviderError).classification, "rate_limited");

  const settleCall = supabaseAdmin.calls.find((c) => c.fn === "settle_provider_invocation");
  assertEquals(settleCall.args.p_status, "failed");
  assertEquals(settleCall.args.p_success, false);
  assertEquals(settleCall.args.p_failure_classification, "rate_limit");
  assertEquals(settleCall.args.p_provider_error_code, "rate_limited");
  assertEquals(settleCall.args.p_http_status, 429);
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callVertexAIWithProvenance: flag-on success result is deep-equal to the flag-off passthrough result (compatibility)", async () => {
  const mockCallFn = async () => ({ content: "same content", model: "gemini-test", inputTokens: 10, outputTokens: 5 });

  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
  const flagOffResult = await callVertexAIWithProvenance(makeMockSupabase({}), BASE_CONTEXT, { userPrompt: "test" }, mockCallFn);

  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-1", created: true, status: "running" }, error: null }],
    settle_provider_invocation: [{ data: { settled_by_this_call: true, status: "completed" }, error: null }],
  });
  const flagOnResult = await callVertexAIWithProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn);

  assertEquals(flagOnResult, flagOffResult, "provenance must never alter the caller-visible provider result");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("mapVertexFailureToGeneric: maps every Vertex classification to a value in the schema's generic taxonomy", () => {
  const ALLOWED = new Set([
    "authentication", "authorization", "quota", "rate_limit", "resource_exhausted", "timeout",
    "transport", "provider_client_error", "provider_server_error", "invalid_response",
    "schema_validation", "cancelled", "superseded", "unknown",
  ]);
  const cases: Array<[any, string]> = [
    ["timeout", "timeout"],
    ["rate_limited", "rate_limit"],
    ["server_error", "provider_server_error"],
    ["auth_error", "authentication"],
    ["network_error", "transport"],
    ["budget_exhausted", "resource_exhausted"],
    ["model_unavailable", "provider_client_error"],
    ["malformed_response", "invalid_response"],
    ["empty_extraction", "schema_validation"],
    ["unknown", "unknown"],
    [undefined, "unknown"],
  ];
  for (const [input, expected] of cases) {
    const mapped = mapVertexFailureToGeneric(input);
    assertStrictEquals(mapped, expected);
    assert(ALLOWED.has(mapped), `${mapped} must be one of the schema's allowed failure_classification values`);
  }
});
