// @ts-nocheck
// P1.3 — unit tests for the extraction-stage recorder module
// (_shared/extraction/provenance/recorder.ts). Mirrors the chainable
// mock-Supabase-client convention already used in
// lease-extraction-worker-reconciliation.test.ts.

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  ProvenancePersistenceError,
  sanitizeErrorMessage,
  sanitizeOutputSummary,
  withExtractionStage,
} from "../_shared/extraction/provenance/recorder.ts";

const BASE_CONTEXT = {
  orgId: "org-1",
  uploadedFileId: "file-1",
  generationId: "gen-1",
  extractionRunId: "run-1",
  pipelineJobId: "job-1",
  stage: "normalize" as const,
  attempt: 1,
};

// ---------------------------------------------------------------------------
// Mock Supabase client -- records every rpc() call, lets a test script
// canned {data, error} responses per RPC name in call order.
// ---------------------------------------------------------------------------
function makeMockSupabase(rpcResponses: Record<string, Array<{ data: any; error: any }>>) {
  const calls: Array<{ fn: string; args: any }> = [];
  return {
    calls,
    rpc(fn: string, args: any) {
      calls.push({ fn, args });
      const queue = rpcResponses[fn];
      const next = queue && queue.length > 0 ? queue.shift() : { data: null, error: { message: `no mock response for ${fn}` } };
      return Promise.resolve(next);
    },
  };
}

Deno.test("withExtractionStage: flag disabled returns an inert no-op handle", async () => {
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
  const supabaseAdmin = makeMockSupabase({});
  const stage = await withExtractionStage(supabaseAdmin, BASE_CONTEXT);

  assertEquals(stage.enabled, false);
  assertEquals(stage.stageRunId, null);
  await stage.complete({ outcome: "completed" });
  await stage.fail("SOME_CODE", "some message");
  await stage.ensureSettled();

  assertEquals(supabaseAdmin.calls.length, 0, "flag off must never call the database");
});

Deno.test("withExtractionStage: start failure throws ProvenancePersistenceError", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_extraction_stage_run: [{ data: null, error: { message: "insert failed" } }],
  });

  await assertRejects(
    () => withExtractionStage(supabaseAdmin, BASE_CONTEXT),
    ProvenancePersistenceError,
  );
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("withExtractionStage: missing extractionRunId while flag is on throws ProvenancePersistenceError", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({});
  await assertRejects(
    () => withExtractionStage(supabaseAdmin, { ...BASE_CONTEXT, extractionRunId: null }),
    ProvenancePersistenceError,
  );
  assertEquals(supabaseAdmin.calls.length, 0, "must not call the RPC without a run id");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

function makeHappyMock() {
  return makeMockSupabase({
    start_extraction_stage_run: [{ data: { stage_run_id: "stage-run-1", attempt: 1 }, error: null }],
    settle_extraction_stage_run: [
      { data: { settled_by_this_call: true, status: "completed" }, error: null },
      { data: { settled_by_this_call: true, status: "failed" }, error: null },
    ],
  });
}

Deno.test("withExtractionStage: complete() settles once and calls the RPC exactly once", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_extraction_stage_run: [{ data: { stage_run_id: "stage-run-1", attempt: 1 }, error: null }],
    settle_extraction_stage_run: [{ data: { settled_by_this_call: true, status: "completed" }, error: null }],
  });
  const stage = await withExtractionStage(supabaseAdmin, BASE_CONTEXT);
  assert(stage.enabled);
  assertEquals(stage.stageRunId, "stage-run-1");

  await stage.complete({ outcome: "completed" });
  const settleCalls = supabaseAdmin.calls.filter((c) => c.fn === "settle_extraction_stage_run");
  assertEquals(settleCalls.length, 1);
  assertEquals(settleCalls[0].args.p_status, "completed");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("withExtractionStage: repeated complete() is an idempotent no-op (no second RPC call)", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_extraction_stage_run: [{ data: { stage_run_id: "stage-run-1", attempt: 1 }, error: null }],
    settle_extraction_stage_run: [{ data: { settled_by_this_call: true, status: "completed" }, error: null }],
  });
  const stage = await withExtractionStage(supabaseAdmin, BASE_CONTEXT);
  await stage.complete({ outcome: "completed" });
  await stage.complete({ outcome: "completed" }); // second call must not hit the RPC again

  const settleCalls = supabaseAdmin.calls.filter((c) => c.fn === "settle_extraction_stage_run");
  assertEquals(settleCalls.length, 1, "a repeated same-status settlement must not re-call the RPC");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("withExtractionStage: fail() after complete() is rejected as a conflict", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeHappyMock();
  const stage = await withExtractionStage(supabaseAdmin, BASE_CONTEXT);
  await stage.complete({ outcome: "completed" });

  await assertRejects(
    () => stage.fail("SOME_CODE", "some message"),
    ProvenancePersistenceError,
  );
  const settleCalls = supabaseAdmin.calls.filter((c) => c.fn === "settle_extraction_stage_run");
  assertEquals(settleCalls.length, 1, "the rejected conflicting call must not reach the RPC");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("withExtractionStage: complete() after fail() is rejected as a conflict", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_extraction_stage_run: [{ data: { stage_run_id: "stage-run-1", attempt: 1 }, error: null }],
    settle_extraction_stage_run: [{ data: { settled_by_this_call: true, status: "failed" }, error: null }],
  });
  const stage = await withExtractionStage(supabaseAdmin, BASE_CONTEXT);
  await stage.fail("SOME_CODE", "some message");

  await assertRejects(
    () => stage.complete({ outcome: "completed" }),
    ProvenancePersistenceError,
  );
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("withExtractionStage: ensureSettled() fails an unsettled stage with STAGE_EXITED_WITHOUT_OUTCOME", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeMockSupabase({
    start_extraction_stage_run: [{ data: { stage_run_id: "stage-run-1", attempt: 1 }, error: null }],
    settle_extraction_stage_run: [{ data: { settled_by_this_call: true, status: "failed" }, error: null }],
  });
  const stage = await withExtractionStage(supabaseAdmin, BASE_CONTEXT);
  await stage.ensureSettled();

  const settleCalls = supabaseAdmin.calls.filter((c) => c.fn === "settle_extraction_stage_run");
  assertEquals(settleCalls.length, 1);
  assertEquals(settleCalls[0].args.p_status, "failed");
  assertEquals(settleCalls[0].args.p_error_code, "STAGE_EXITED_WITHOUT_OUTCOME");
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("withExtractionStage: ensureSettled() is a no-op after settlement (either status)", async () => {
  Deno.env.set("ENABLE_EXTRACTION_PROVENANCE", "true");
  const supabaseAdmin = makeHappyMock();
  const stage = await withExtractionStage(supabaseAdmin, BASE_CONTEXT);
  await stage.complete({ outcome: "completed" });
  await stage.ensureSettled(); // must be a no-op, not a conflict, not a second RPC call

  const settleCalls = supabaseAdmin.calls.filter((c) => c.fn === "settle_extraction_stage_run");
  assertEquals(settleCalls.length, 1);
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
});

Deno.test("sanitizeErrorMessage: redacts bearer tokens and private key material", () => {
  const raw = 'Authorization failed: Bearer abc123.def456 "private_key": "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----"';
  const sanitized = sanitizeErrorMessage(raw);
  assert(!sanitized.includes("abc123.def456"));
  assert(!sanitized.includes("BEGIN PRIVATE KEY-----abc"));
  assert(sanitized.includes("[REDACTED]"));
});

Deno.test("sanitizeErrorMessage: bounds length", () => {
  const raw = "x".repeat(10_000);
  const sanitized = sanitizeErrorMessage(raw);
  assert(sanitized.length <= 500);
});

Deno.test("sanitizeOutputSummary: passes through small summaries unchanged", () => {
  const summary = { outcome: "completed" as const, pageCount: 12 };
  assertEquals(sanitizeOutputSummary(summary), summary);
});

Deno.test("sanitizeOutputSummary: replaces oversized summaries with a truncation marker", () => {
  const summary = { outcome: "completed" as const, blob: "x".repeat(50_000) };
  const result = sanitizeOutputSummary(summary);
  assertEquals(result._truncated, true);
  assert(!("blob" in result));
  assertEquals(result.outcome, "completed");
});

Deno.test("sanitizeOutputSummary: empty/undefined summary returns an empty object", () => {
  assertEquals(sanitizeOutputSummary(undefined), {});
});
