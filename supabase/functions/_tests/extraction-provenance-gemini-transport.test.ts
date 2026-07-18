// @ts-nocheck
// P1.4 — mocked-call tests for the Gemini API-key provenance transport
// wrapper. Shares vertex-ai.ts's error/response shapes with the Vertex
// wrapper (already exhaustively tested), so this file focuses on the
// provider-identity distinction (provider='gemini_api_key', a separate
// invocation_key namespace) rather than re-proving the shared classifier.

import { assert, assertEquals, assertRejects, assertStrictEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { callGeminiWithAPIKeyAndProvenance } from "../_shared/extraction/provenance/transport/gemini.ts";
import { ProvenancePersistenceError } from "../_shared/extraction/provenance/recorder.ts";
import { VertexProviderError } from "../_shared/vertex-ai.ts";

const BASE_CONTEXT = {
  orgId: "org-1",
  uploadedFileId: "file-1",
  generationId: "gen-1",
  extractionRunId: "run-1",
  stageRunId: "stage-run-1",
  stageAttempt: 1,
  operation: "document_profile_classification",
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

Deno.test("callGeminiWithAPIKeyAndProvenance: flag disabled makes zero RPC calls", async () => {
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
  const supabaseAdmin = makeMockSupabase({});
  const mockCallFn = async () => ({ content: "ok", model: "gemini-flash", inputTokens: 10, outputTokens: 5 });
  const result = await callGeminiWithAPIKeyAndProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn);
  assertEquals(result.content, "ok");
  assertEquals(supabaseAdmin.calls.length, 0);
});

Deno.test("callGeminiWithAPIKeyAndProvenance: start_provider_invocation records provider='gemini_api_key' (distinct from vertex_ai)", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-1", created: true, status: "running" }, error: null }],
    settle_provider_invocation: [{ data: { settled_by_this_call: true, status: "completed" }, error: null }],
  });
  const mockCallFn = async () => ({ content: "ok", model: "gemini-flash", inputTokens: 10, outputTokens: 5 });
  await callGeminiWithAPIKeyAndProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn);

  const startCall = supabaseAdmin.calls.find((c) => c.fn === "start_provider_invocation");
  assertEquals(startCall.args.p_provider, "gemini_api_key");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callGeminiWithAPIKeyAndProvenance: start failure fails closed, never calls the provider", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_provider_invocation: [{ data: null, error: { message: "boom" } }],
  });
  let called = false;
  const mockCallFn = async () => { called = true; return {} as any; };
  await assertRejects(
    () => callGeminiWithAPIKeyAndProvenance(supabaseAdmin, BASE_CONTEXT, { userPrompt: "test" }, mockCallFn),
    ProvenancePersistenceError,
  );
  assertEquals(called, false);
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("callGeminiWithAPIKeyAndProvenance: success settles tokens/latency, failure re-throws the original error unchanged", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdminOk = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-1", created: true, status: "running" }, error: null }],
    settle_provider_invocation: [{ data: { settled_by_this_call: true, status: "completed" }, error: null }],
  });
  const okResult = await callGeminiWithAPIKeyAndProvenance(
    supabaseAdminOk, BASE_CONTEXT, { userPrompt: "test" },
    async () => ({ content: "ok", model: "gemini-flash", inputTokens: 7, outputTokens: 3 }),
  );
  assertEquals(okResult.content, "ok");
  const settleOk = supabaseAdminOk.calls.find((c) => c.fn === "settle_provider_invocation");
  assertEquals(settleOk.args.p_input_tokens, 7);
  assertEquals(settleOk.args.p_output_tokens, 3);

  const supabaseAdminFail = makeMockSupabase({
    start_provider_invocation: [{ data: { invocation_id: "inv-2", created: true, status: "running" }, error: null }],
    settle_provider_invocation: [{ data: { settled_by_this_call: true, status: "failed" }, error: null }],
  });
  const originalError = new VertexProviderError("timed out", "timeout");
  const thrown = await assertRejects(() =>
    callGeminiWithAPIKeyAndProvenance(
      supabaseAdminFail, BASE_CONTEXT, { userPrompt: "test" },
      async () => { throw originalError; },
    )
  );
  assertStrictEquals(thrown, originalError);
  const settleFail = supabaseAdminFail.calls.find((c) => c.fn === "settle_provider_invocation");
  assertEquals(settleFail.args.p_failure_classification, "timeout");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});
