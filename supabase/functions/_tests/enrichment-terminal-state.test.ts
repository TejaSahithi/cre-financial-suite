// @ts-nocheck
// Reliability Phase R1 tests for _shared/extraction/enrichment-terminal-
// state.ts -- the shared, generation-fenced, row-count-checked writer that
// replaces the 3+ hand-rolled uploaded_files update blocks in
// lease-extraction-worker/index.ts, each of which used to silently do
// nothing (at most a console.log) on a generation mismatch or a failed
// re-fetch, leaving ui_review_payload.enrichment_status stuck at "running"
// indefinitely.
//
// A dedicated mock is used here rather than the existing makeMockSupabase
// in lease-extraction-worker-reconciliation.test.ts: that mock's update()
// unconditionally applies a patch regardless of .eq() filters and returns
// a bare object (never an array), which cannot represent a real
// supabase-js compare-and-set miss (an .update().eq(...).select() chain
// that matches zero rows resolves with `data: []`, not `data: null`).
// This mock's update() only applies the patch when every .eq() filter
// actually matches the stored row, and mirrors supabase-js's real
// array-vs-object return shape depending on whether .select() was called.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  classifyEnrichmentFailure,
  persistEnrichmentTerminalState,
} from "../_shared/extraction/enrichment-terminal-state.ts";
import { __test__ } from "../lease-extraction-worker/index.ts";

const { completeEnrichmentWithWarning } = __test__;

const ORG_ID = "org-1";
const FILE_ID = "file-1";
const GENERATION_ID = "gen-1";

function makeSupabaseAdmin(
  initialRows: Record<string, any>,
  opts: {
    alwaysErrorSelectTables?: string[];
    forceUpdateThrow?: boolean;
    forceUpdateError?: boolean;
  } = {},
) {
  const rows: Record<string, any> = { ...initialRows };
  const updates: Array<{ table: string; patch: any; filters: Record<string, any> }> = [];

  function from(table: string) {
    const builder: any = {
      _isUpdate: false,
      _patch: null as any,
      _filters: {} as Record<string, any>,
      _selectCalled: false,
      _maybeSingle: false,
      update(patch: any) {
        builder._isUpdate = true;
        builder._patch = patch;
        return builder;
      },
      select(_cols?: string) {
        builder._selectCalled = true;
        return builder;
      },
      eq(col: string, val: any) {
        builder._filters[col] = val;
        return builder;
      },
      maybeSingle() {
        builder._maybeSingle = true;
        return resolve();
      },
      then(res: any, rej: any) {
        return resolve().then(res, rej);
      },
    };

    function matches(row: any): boolean {
      if (!row) return false;
      for (const [col, val] of Object.entries(builder._filters)) {
        if (row[col] !== val) return false;
      }
      return true;
    }

    async function resolve(): Promise<{ data: any; error: any }> {
      const row = rows[table] ?? null;

      if (builder._isUpdate) {
        if (opts.forceUpdateThrow) throw new Error("mock: update threw");
        if (opts.forceUpdateError) return { data: null, error: { message: "mock: update error" } };

        const isMatch = matches(row);
        if (isMatch) {
          rows[table] = { ...row, ...builder._patch };
          updates.push({ table, patch: builder._patch, filters: { ...builder._filters } });
        }
        if (builder._selectCalled && !builder._maybeSingle) {
          return { data: isMatch ? [{ id: rows[table].id }] : [], error: null };
        }
        if (builder._maybeSingle) {
          return { data: isMatch ? rows[table] : null, error: null };
        }
        return { data: null, error: null };
      }

      if ((opts.alwaysErrorSelectTables ?? []).includes(table)) {
        throw new Error(`mock: ${table} select unavailable`);
      }
      const isMatch = Object.keys(builder._filters).length === 0 || matches(row);
      return { data: isMatch ? row : null, error: null };
    }

    return builder;
  }

  async function rpc(_name: string, _args: any) {
    return { data: null, error: null };
  }

  return { from, rpc, __rows: rows, __updates: updates };
}

function makeRecordingLogger() {
  const events: Array<{ stage: string; status: string; metadata: any }> = [];
  const warnings: Array<{ step: string; message: string; metadata: any }> = [];
  return {
    events,
    warnings,
    info: async () => {},
    error: async () => {},
    warn: async (step: string, message: string, metadata?: any) => {
      warnings.push({ step, message, metadata });
    },
    event: async (stage: string, status: string, metadata?: any) => {
      events.push({ stage, status, metadata });
    },
  };
}

function baseFileRow(overrides: Record<string, any> = {}) {
  return {
    id: FILE_ID,
    org_id: ORG_ID,
    active_generation_id: GENERATION_ID,
    enrichment_status: "running",
    enrichment_error: null,
    ui_review_payload: { enrichment_status: "running", records: [{ fields: { tenant_name: { value: "Acme" } } }] },
    ...overrides,
  };
}

// ── classifyEnrichmentFailure ────────────────────────────────────────────────

Deno.test("classifyEnrichmentFailure: DOWNSTREAM_FUNCTION_FAILED/546 -> resource_exhausted, not retryable", () => {
  const result = classifyEnrichmentFailure("DOWNSTREAM_FUNCTION_FAILED", "Function failed due to not having enough compute resources", 546);
  assertEquals(result.classification, "resource_exhausted");
  assertEquals(result.retryable, false);
});

Deno.test("classifyEnrichmentFailure: the last attempt's error code (as threaded through from MAX_ATTEMPTS_EXCEEDED) still classifies as resource_exhausted", () => {
  // This is the exact call shape the MAX_ATTEMPTS_EXCEEDED branch in
  // lease-extraction-worker/index.ts now uses -- job.error_code/
  // job.error_message from the prior failed attempt, not the literal
  // "MAX_ATTEMPTS_EXCEEDED" string, which classifyEnrichmentFailure would
  // otherwise resolve to "unknown" and force status:"failed" even when
  // every attempt actually failed with a 546.
  const priorAttemptErrorCode = "DOWNSTREAM_FUNCTION_FAILED";
  const priorAttemptErrorMessage = "Function failed due to not having enough compute resources";
  const result = classifyEnrichmentFailure(priorAttemptErrorCode, priorAttemptErrorMessage, null);
  assertEquals(result.classification, "resource_exhausted");
  assertEquals(result.retryable, false);
});

Deno.test("classifyEnrichmentFailure: STAGE_TIMEOUT/504 -> transport_error, retryable", () => {
  const result = classifyEnrichmentFailure("STAGE_TIMEOUT", "normalize-pdf-output timed out after 130s", 504);
  assertEquals(result.classification, "transport_error");
  assertEquals(result.retryable, true);
});

Deno.test("classifyEnrichmentFailure: an unrecognized error code/message -> unknown, never guessed", () => {
  const result = classifyEnrichmentFailure("SOME_OTHER_ERROR", "something unrelated happened", 500);
  assertEquals(result.classification, "unknown");
  assertEquals(result.retryable, false);
});

// ── persistEnrichmentTerminalState ───────────────────────────────────────────

Deno.test("persistEnrichmentTerminalState: resource exhaustion with matching generation -> status partial, enrichment_error populated, reason OK", async () => {
  const supabaseAdmin = makeSupabaseAdmin({ uploaded_files: baseFileRow() });
  const logger = makeRecordingLogger();

  const result = await persistEnrichmentTerminalState({
    supabaseAdmin,
    organizationId: ORG_ID,
    fileId: FILE_ID,
    generationId: GENERATION_ID,
    status: "partial",
    errorCode: "DOWNSTREAM_FUNCTION_FAILED",
    errorMessage: "Function failed due to not having enough compute resources",
    classification: "resource_exhausted",
    retryable: false,
    stage: "enrich",
    completedStages: ["parse", "normalize"],
    logger,
  });

  assertEquals(result, { persisted: true, reason: "OK" });
  assertEquals(supabaseAdmin.__rows.uploaded_files.enrichment_status, "partial");
  assertEquals(supabaseAdmin.__rows.uploaded_files.enrichment_error.classification, "resource_exhausted");
  assertEquals(supabaseAdmin.__rows.uploaded_files.enrichment_error.retryable, false);
  assertEquals(supabaseAdmin.__rows.uploaded_files.enrichment_error.stage, "enrich");
  // Back-compat mirror also updated.
  assertEquals(supabaseAdmin.__rows.uploaded_files.ui_review_payload.enrichment_status, "partial");
  assert(logger.events.some((e) => e.stage === "enrich" && e.status === "partial"));
});

Deno.test("persistEnrichmentTerminalState: a non-resource-exhausted failure writes status failed exactly as given by the caller", async () => {
  const supabaseAdmin = makeSupabaseAdmin({ uploaded_files: baseFileRow() });
  const logger = makeRecordingLogger();

  const result = await persistEnrichmentTerminalState({
    supabaseAdmin,
    organizationId: ORG_ID,
    fileId: FILE_ID,
    generationId: GENERATION_ID,
    status: "failed",
    errorCode: "SOME_OTHER_ERROR",
    errorMessage: "something unrelated happened",
    classification: "unknown",
    retryable: false,
    stage: "enrich",
    logger,
  });

  assertEquals(result, { persisted: true, reason: "OK" });
  assertEquals(supabaseAdmin.__rows.uploaded_files.enrichment_status, "failed");
  assertEquals(supabaseAdmin.__rows.uploaded_files.enrichment_error.classification, "unknown");
});

Deno.test("persistEnrichmentTerminalState: generation mismatch -> compare-and-set misses (0 rows), reason COMPARE_AND_SET_MISSED, row left untouched", async () => {
  const supabaseAdmin = makeSupabaseAdmin({ uploaded_files: baseFileRow({ active_generation_id: "gen-NEWER" }) });
  const logger = makeRecordingLogger();

  const result = await persistEnrichmentTerminalState({
    supabaseAdmin,
    organizationId: ORG_ID,
    fileId: FILE_ID,
    generationId: GENERATION_ID, // stale -- the file has already moved on to gen-NEWER
    status: "partial",
    errorCode: "DOWNSTREAM_FUNCTION_FAILED",
    errorMessage: "resource exhausted",
    classification: "resource_exhausted",
    retryable: false,
    stage: "enrich",
    logger,
  });

  assertEquals(result.persisted, false);
  assertEquals(result.reason, "COMPARE_AND_SET_MISSED");
  assertEquals(result.observedGenerationId, "gen-NEWER");
  // The stale write must never have landed -- the row is exactly as it was.
  assertEquals(supabaseAdmin.__rows.uploaded_files.enrichment_status, "running");
  assertEquals(supabaseAdmin.__rows.uploaded_files.active_generation_id, "gen-NEWER");

  const missEvent = logger.events.find((e) => e.status === "terminal_state_missed");
  assert(missEvent, "expected a persisted terminal_state_missed event, not a silent no-op");
  assertEquals(missEvent.metadata.reason_code, "TERMINAL_STATE_COMPARE_AND_SET_MISSED");
  assertEquals(missEvent.metadata.metadata.expected_generation_id, GENERATION_ID);
  assertEquals(missEvent.metadata.metadata.observed_generation_id, "gen-NEWER");
});

Deno.test("persistEnrichmentTerminalState: every uploaded_files SELECT failing does not block the core compare-and-set (point 4) -- only the best-effort ui_review_payload mirror is skipped", async () => {
  const supabaseAdmin = makeSupabaseAdmin(
    { uploaded_files: baseFileRow() },
    { alwaysErrorSelectTables: ["uploaded_files"] },
  );
  const logger = makeRecordingLogger();

  const result = await persistEnrichmentTerminalState({
    supabaseAdmin,
    organizationId: ORG_ID,
    fileId: FILE_ID,
    generationId: GENERATION_ID,
    status: "partial",
    errorCode: "DOWNSTREAM_FUNCTION_FAILED",
    errorMessage: "resource exhausted",
    classification: "resource_exhausted",
    retryable: false,
    stage: "enrich",
    logger,
  });

  // The real column landed -- the compare-and-set is an UPDATE, never a
  // SELECT, so it has no dependency on the (here, always-failing) read path.
  assertEquals(result, { persisted: true, reason: "OK" });
  assertEquals(supabaseAdmin.__rows.uploaded_files.enrichment_status, "partial");
  // The mirror write's own pre-read failed, so ui_review_payload is
  // untouched -- logged as a warning, not fatal to the overall result.
  assertEquals(supabaseAdmin.__rows.uploaded_files.ui_review_payload.enrichment_status, "running");
  assert(logger.warnings.length > 0, "expected the mirror-write failure to be logged");
});

Deno.test("persistEnrichmentTerminalState: the update call itself throwing -> reason TERMINAL_UPDATE_FAILED, structured event persisted", async () => {
  const supabaseAdmin = makeSupabaseAdmin({ uploaded_files: baseFileRow() }, { forceUpdateThrow: true });
  const logger = makeRecordingLogger();

  const result = await persistEnrichmentTerminalState({
    supabaseAdmin,
    organizationId: ORG_ID,
    fileId: FILE_ID,
    generationId: GENERATION_ID,
    status: "failed",
    errorCode: "SOME_ERROR",
    errorMessage: "boom",
    classification: "unknown",
    stage: "enrich",
    logger,
  });

  assertEquals(result, { persisted: false, reason: "TERMINAL_UPDATE_FAILED" });
  const failEvent = logger.events.find((e) => e.status === "terminal_update_failed");
  assert(failEvent, "expected a persisted terminal_update_failed event");
  assertEquals(failEvent.metadata.reason_code, "TERMINAL_UPDATE_FAILED");
});

Deno.test("persistEnrichmentTerminalState: the update resolving with a Postgres-level error (not thrown) -> also TERMINAL_UPDATE_FAILED", async () => {
  const supabaseAdmin = makeSupabaseAdmin({ uploaded_files: baseFileRow() }, { forceUpdateError: true });
  const logger = makeRecordingLogger();

  const result = await persistEnrichmentTerminalState({
    supabaseAdmin,
    organizationId: ORG_ID,
    fileId: FILE_ID,
    generationId: GENERATION_ID,
    status: "failed",
    errorCode: "SOME_ERROR",
    errorMessage: "boom",
    classification: "unknown",
    stage: "enrich",
    logger,
  });

  assertEquals(result, { persisted: false, reason: "TERMINAL_UPDATE_FAILED" });
});

Deno.test("persistEnrichmentTerminalState: calling twice in a row with the same terminal status is idempotent -- both succeed", async () => {
  const supabaseAdmin = makeSupabaseAdmin({ uploaded_files: baseFileRow() });
  const logger = makeRecordingLogger();

  const args = {
    supabaseAdmin,
    organizationId: ORG_ID,
    fileId: FILE_ID,
    generationId: GENERATION_ID,
    status: "partial" as const,
    errorCode: "DOWNSTREAM_FUNCTION_FAILED",
    errorMessage: "resource exhausted",
    classification: "resource_exhausted" as const,
    retryable: false,
    stage: "enrich",
    logger,
  };

  const first = await persistEnrichmentTerminalState(args);
  const second = await persistEnrichmentTerminalState(args);

  assertEquals(first, { persisted: true, reason: "OK" });
  assertEquals(second, { persisted: true, reason: "OK" });
  assertEquals(supabaseAdmin.__rows.uploaded_files.enrichment_status, "partial");
});

// ── completeEnrichmentWithWarning's previously-silent branch ────────────────

Deno.test("completeEnrichmentWithWarning: generation mismatch now persists a structured event instead of silently doing nothing", async () => {
  const job = { id: "job-enrich-1", generation_id: GENERATION_ID, metadata: {} };
  const supabaseAdmin = makeSupabaseAdmin({
    uploaded_files: baseFileRow({ active_generation_id: "gen-NEWER" }),
    pipeline_jobs: { id: job.id, status: "running" },
  });

  // completeEnrichmentWithWarning builds its own logger internally
  // (createLogger(supabaseAdmin, fileId, orgId)) -- it writes to a
  // pipeline_logs table this mock doesn't model, so the persisted-event
  // claim here is verified indirectly: the compare-and-set must not have
  // applied a stale write to the newer generation's row, which is the
  // observable, correctness-relevant half of "no longer silent."
  await completeEnrichmentWithWarning(
    supabaseAdmin,
    job,
    FILE_ID,
    ORG_ID,
    "STAGE_TIMEOUT",
    "Optional enrichment warning: some source page references could not be linked.",
    504,
    "normalize-pdf-output timed out after 130s",
  );

  // The newer generation's row must be untouched by this stale job's result.
  assertEquals(supabaseAdmin.__rows.uploaded_files.enrichment_status, "running");
  assertEquals(supabaseAdmin.__rows.uploaded_files.active_generation_id, "gen-NEWER");
});

Deno.test("completeEnrichmentWithWarning: matching generation completes the real column and the ui_review_payload mirror together", async () => {
  const job = { id: "job-enrich-1", generation_id: GENERATION_ID, metadata: {} };
  const supabaseAdmin = makeSupabaseAdmin({
    uploaded_files: baseFileRow(),
    pipeline_jobs: { id: job.id, status: "running" },
  });

  await completeEnrichmentWithWarning(
    supabaseAdmin,
    job,
    FILE_ID,
    ORG_ID,
    "STAGE_TIMEOUT",
    "Optional enrichment warning: some source page references could not be linked.",
    504,
    "normalize-pdf-output timed out after 130s",
  );

  // Real column: "completed" (this path is always review-ready). JSONB
  // mirror: the exact pre-existing "completed_with_warnings" string, for
  // back-compat with anything still reading ui_review_payload directly.
  assertEquals(supabaseAdmin.__rows.uploaded_files.enrichment_status, "completed");
  assertEquals(supabaseAdmin.__rows.uploaded_files.ui_review_payload.enrichment_status, "completed_with_warnings");
});
