// @ts-nocheck
// Azure staging P0: durable-state reconciliation tests for
// lease-extraction-worker/index.ts. See docs/azure-staging-p0-parser-resource-reconciliation.md.
//
// Importing index.ts pulls in its top-level Deno.serve(...) registration
// (this file has no separate library module to import instead — the P0
// patch is deliberately scoped to this one file only). Each test disables
// resource/op sanitization for that reason; nothing here makes a network
// call of its own.
//
// A minimal chainable mock stands in for the Supabase client. It supports
// exactly the .from().select().eq().eq().maybeSingle() and
// .from().update().eq()[.eq()] shapes __test__'s functions actually use.

import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { __test__ } from "../lease-extraction-worker/index.ts";

const {
  reconcileDurableParse,
  reconcileDurableNormalize,
  parkLeaseForManualReview,
  repairStaleReconciledState,
  resetJobForRetryableReconciliation,
  selectWithRetry,
} = __test__;

const ORG_ID = "org-1";
const FILE_ID = "file-1";
const JOB = { id: "job-1", metadata: {} };

// ---------------------------------------------------------------------------
// Mock Supabase client builder
// ---------------------------------------------------------------------------

/**
 * `rows` maps table name -> current row object (single-row-per-table, which
 * is all these tests need: one uploaded_files row, one pipeline_jobs row).
 * `selectQueue` optionally supplies a queue of {data, error} results to
 * return in order for a given table's SELECT, letting a test simulate "first
 * read fails, retry succeeds" without needing real network flakiness.
 */
function makeMockSupabase({ rows, selectQueue = {}, alwaysErrorTables = [], updates = [] }: {
  rows: Record<string, any>;
  selectQueue?: Record<string, Array<{ data: any; error: any }>>;
  // Tables listed here return a query error on EVERY select, unconditionally
  // (not just a finite number of times) — used for tests proving a read
  // that never succeeds, however many internal fallback/retry queries the
  // production code issues, resolves to "unknown".
  alwaysErrorTables?: string[];
  updates?: Array<{ table: string; patch: any; filters: Record<string, any> }>;
}) {
  function from(table: string) {
    // update() is tracked independently of select() so a real Supabase-style
    // .update(patch).eq(...).select(...).maybeSingle() chain — which SPECIFIES
    // return columns via select(), it does not switch the operation back to
    // a read — still performs the write and returns the updated row.
    const builder: any = {
      _filters: {} as Record<string, any>,
      _patch: null as any,
      _isUpdate: false,

      select(_cols?: string) {
        return builder;
      },
      update(patch: any) {
        builder._isUpdate = true;
        builder._patch = patch;
        return builder;
      },
      eq(col: string, val: any) {
        builder._filters[col] = val;
        return builder;
      },
      is(_col: string, _val: any) {
        return builder;
      },
      maybeSingle() {
        return runQuery();
      },
    };

    function applyUpdateAndRecord() {
      updates.push({ table, patch: builder._patch, filters: { ...builder._filters } });
      rows[table] = { ...(rows[table] || {}), ...builder._patch };
      return { data: rows[table], error: null };
    }

    function runQuery(): Promise<{ data: any; error: any }> {
      if (builder._isUpdate) {
        return Promise.resolve(applyUpdateAndRecord());
      }
      if (alwaysErrorTables.includes(table)) {
        return Promise.resolve({ data: null, error: { message: `mock: ${table} unavailable` } });
      }
      const queue = selectQueue[table];
      if (queue && queue.length > 0) {
        return Promise.resolve(queue.shift());
      }
      return Promise.resolve({ data: rows[table] ?? null, error: null });
    }

    // update() calls in this codebase are frequently awaited directly
    // without a trailing .select()/.maybeSingle() — support `await builder`
    // by making the builder itself thenable.
    builder.then = (resolve: any) => {
      runQuery().then(resolve);
    };

    return builder;
  }

  return { from, __rows: rows, __updates: updates };
}

function baseUploadedFilesRow(overrides: Record<string, any> = {}) {
  return {
    id: FILE_ID,
    org_id: ORG_ID,
    status: "review_required",
    processing_status: "parse_failed_manual_review",
    failed_step: "parse",
    error_message: "Function failed due to not having enough compute resources",
    extraction_method: "manual_review_fallback",
    ...overrides,
  };
}

// The mock's `.select("a, b:c->>d, ...")` doesn't actually parse the alias
// string — it just returns whatever `rows[table]` is verbatim. So the "row"
// object stored in the mock must already carry the exact aliased field
// names reconcileDurableParse's projection expects.
function azureAliasedRow(overrides: Record<string, any> = {}) {
  return {
    id: FILE_ID,
    status: "review_required",
    processing_status: "parse_failed_manual_review",
    extraction_method: "manual_review_fallback",
    raw_extraction_method: "azure_layout",
    raw_provider: "azure_document_intelligence",
    metadata_full_text_chars: "71188",
    raw_page_count: "12",
    failed_step: "parse",
    error_message: "Function failed due to not having enough compute resources",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1-2: retry-once-then-unknown / retry-succeeds
// ---------------------------------------------------------------------------

Deno.test({
  name: "reconcileDurableParse: a reconciliation read that fails even after one retry resolves to unknown, never not_durable",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Every uploaded_files select fails unconditionally — the aliased
    // projection, its retry, the basic-columns fallback, its retry, and the
    // jsonPaths fallback all fail — proving the function bottoms out at
    // "unknown" rather than silently treating any of those failures as
    // proof the data is absent.
    const supabaseAdmin = makeMockSupabase({
      rows: { uploaded_files: azureAliasedRow() },
      alwaysErrorTables: ["uploaded_files"],
    });
    const result = await reconcileDurableParse(supabaseAdmin, FILE_ID, ORG_ID);
    assertEquals(result.state, "unknown");
  },
});

Deno.test({
  name: "reconcileDurableParse: a reconciliation read that fails once but succeeds on retry resolves normally (durable), not stuck at unknown",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supabaseAdmin = makeMockSupabase({
      rows: { uploaded_files: azureAliasedRow() },
      selectQueue: {
        uploaded_files: [
          { data: null, error: { message: "transient" } },
          { data: azureAliasedRow(), error: null },
        ],
      },
    });
    const result = await reconcileDurableParse(supabaseAdmin, FILE_ID, ORG_ID);
    assertEquals(result.state, "durable");
  },
});

// ---------------------------------------------------------------------------
// 3-5: stronger parse criteria
// ---------------------------------------------------------------------------

Deno.test({
  name: "reconcileDurableParse: substantial text but zero Azure page/block structure is not_durable (text length alone is insufficient)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supabaseAdmin = makeMockSupabase({
      rows: { uploaded_files: azureAliasedRow({ raw_page_count: "0", status: "parsing" }) },
    });
    const result = await reconcileDurableParse(supabaseAdmin, FILE_ID, ORG_ID);
    assertEquals(result.state, "not_durable");
  },
});

Deno.test({
  name: "reconcileDurableParse: valid Azure parse (method + text + page structure + provider metadata) is durable",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supabaseAdmin = makeMockSupabase({
      rows: { uploaded_files: azureAliasedRow() },
    });
    const result = await reconcileDurableParse(supabaseAdmin, FILE_ID, ORG_ID);
    assertEquals(result.state, "durable");
    assertEquals(result.rawMethod, "azure_layout");
  },
});

Deno.test({
  name: "reconcileDurableParse: rawMethod=manual_review_fallback is never reported durable, even with populated text/page fields",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supabaseAdmin = makeMockSupabase({
      rows: { uploaded_files: azureAliasedRow({
        raw_extraction_method: "manual_review_fallback",
        raw_provider: "",
        status: "review_required",
      }) },
    });
    const result = await reconcileDurableParse(supabaseAdmin, FILE_ID, ORG_ID);
    assertEquals(result.state, "not_durable");
  },
});

Deno.test({
  name: "reconcileDurableParse: non-Azure recognized methods (e.g. docling) are not held to the Azure-specific page/provider checks",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supabaseAdmin = makeMockSupabase({
      rows: { uploaded_files: azureAliasedRow({
        raw_extraction_method: "docling",
        raw_provider: "",
        raw_page_count: "0",
        status: "pdf_parsed",
      }) },
    });
    const result = await reconcileDurableParse(supabaseAdmin, FILE_ID, ORG_ID);
    assertEquals(result.state, "durable");
  },
});

// ---------------------------------------------------------------------------
// 6: stale-status repair
// ---------------------------------------------------------------------------

Deno.test({
  name: "repairStaleReconciledState: a row left with failed_step/processing_status from a prior bad attempt gets both status and processing_status repaired together",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supabaseAdmin = makeMockSupabase({
      rows: { uploaded_files: baseUploadedFilesRow() }, // status=review_required, failed_step=parse (stale)
    });
    await repairStaleReconciledState(supabaseAdmin, FILE_ID, ORG_ID, "pdf_parsed", "pdf_parsed");
    const row = supabaseAdmin.__rows.uploaded_files;
    assertEquals(row.status, "pdf_parsed");
    assertEquals(row.processing_status, "pdf_parsed");
    assertEquals(row.failed_step, null);
    assertEquals(row.error_message, null);
  },
});

// ---------------------------------------------------------------------------
// 7-8: empty-fallback rejection + sequenced repair
// ---------------------------------------------------------------------------

function fallbackShapedNormalizeRow(overrides: Record<string, any> = {}) {
  return {
    id: FILE_ID,
    status: "review_required",
    extraction_method: "manual_review_fallback",
    ui_review_payload: {
      extraction_method: "manual_review_fallback",
      records: [{ record_index: 0, values: {}, standard_fields: [], custom_fields: [] }],
    },
    parsed_data: [{}],
    normalized_output: { method: "parse_failed_manual_review", rows: [{}], warnings: [], validationErrors: [], metadata: {} },
    ...overrides,
  };
}

Deno.test({
  name: "reconcileDurableNormalize: rejects a fallback-shaped normalized_output/ui_review_payload as not_durable, even non-null",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supabaseAdmin = makeMockSupabase({ rows: { uploaded_files: fallbackShapedNormalizeRow() } });
    const result = await reconcileDurableNormalize(supabaseAdmin, FILE_ID, ORG_ID);
    assertEquals(result.state, "not_durable");
  },
});

Deno.test({
  name: "reconcileDurableNormalize: rejects a structurally-empty artifact as not_durable even when extraction_method is not literally manual_review_fallback",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supabaseAdmin = makeMockSupabase({
      rows: {
        uploaded_files: fallbackShapedNormalizeRow({
          extraction_method: "some_other_method_string",
          ui_review_payload: {
            extraction_method: "some_other_method_string",
            records: [{ record_index: 0, values: {}, standard_fields: [], custom_fields: [] }],
          },
        }),
      },
    });
    const result = await reconcileDurableNormalize(supabaseAdmin, FILE_ID, ORG_ID);
    assertEquals(result.state, "not_durable", "content shape (all-empty values), not just the method string, must drive the decision");
  },
});

Deno.test({
  name: "reconcileDurableNormalize: sequenced repair scenario — stale fallback normalize artifacts present after parse repair do not block re-running real normalization",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Simulates: parse-stage was just repaired (docling_raw now valid), but
    // normalized_output/ui_review_payload still carry the OLD fallback
    // artifacts from the earlier failed attempt. reconcileDurableNormalize
    // must say not_durable so the worker proceeds to re-run normalize for
    // real, rather than wrongly treating stale fallback junk as "already
    // durably normalized, skip re-running".
    const supabaseAdmin = makeMockSupabase({ rows: { uploaded_files: fallbackShapedNormalizeRow() } });
    const result = await reconcileDurableNormalize(supabaseAdmin, FILE_ID, ORG_ID);
    assertEquals(result.state, "not_durable");
  },
});

Deno.test({
  name: "reconcileDurableNormalize: meaningful durable normalization is correctly reported durable (positive case, not just rejection)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supabaseAdmin = makeMockSupabase({
      rows: {
        uploaded_files: {
          id: FILE_ID,
          status: "review_required",
          extraction_method: "llm_only",
          ui_review_payload: {
            extraction_method: "llm_only",
            records: [{ record_index: 0, values: { tenant_name: "Acme Corp" }, standard_fields: [{ field_key: "tenant_name", value: "Acme Corp" }], custom_fields: [] }],
          },
          parsed_data: [{ tenant_name: "Acme Corp" }],
          normalized_output: { method: "llm_only", rows: [{ tenant_name: "Acme Corp" }], warnings: [], validationErrors: [], metadata: {} },
        },
      },
    });
    const result = await reconcileDurableNormalize(supabaseAdmin, FILE_ID, ORG_ID);
    assertEquals(result.state, "durable");
  },
});

// ---------------------------------------------------------------------------
// 9-10: stage-aware, tri-state-aware parking guard; never calls failJob
// ---------------------------------------------------------------------------

Deno.test({
  name: "parkLeaseForManualReview: a parse-stage failure with valid durable docling_raw resumes (never reaches the destructive fallback write), regardless of ui_review_payload/normalized_output state",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supabaseAdmin = makeMockSupabase({
      rows: {
        uploaded_files: azureAliasedRow(), // valid durable parse; no normalize output yet
        pipeline_jobs: { id: JOB.id, status: "running" },
      },
    });
    const result = await parkLeaseForManualReview(
      supabaseAdmin, JOB, FILE_ID, ORG_ID, "lease.pdf", "leases", "base_lease",
      "PARSE_FAILED", "compute resources", "parse",
    );
    assertEquals(result.outcome, "resume_from_durable_parse");
    // The destructive fallback write must never have happened: status is
    // repaired to pdf_parsed (not left/re-set to review_required), and the
    // stale failed_step from the incident is cleared. (extraction_method is
    // deliberately not asserted here — parse-stage repair only owns
    // status/processing_status/failed_step/error_message; the top-level
    // extraction_method column is normalize's concern and gets overwritten
    // naturally once normalize completes for real.)
    assertEquals(supabaseAdmin.__rows.uploaded_files.status, "pdf_parsed");
    assertEquals(supabaseAdmin.__rows.uploaded_files.failed_step, null);
  },
});

Deno.test({
  name: "parkLeaseForManualReview: durable discovery never calls failJob — pipeline_jobs.status is not set to failed",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supabaseAdmin = makeMockSupabase({
      rows: {
        uploaded_files: azureAliasedRow(),
        pipeline_jobs: { id: JOB.id, status: "running" },
      },
    });
    await parkLeaseForManualReview(
      supabaseAdmin, JOB, FILE_ID, ORG_ID, "lease.pdf", "leases", "base_lease",
      "PARSE_FAILED", "compute resources", "parse",
    );
    const failJobWrite = supabaseAdmin.__updates.find((u) => u.table === "pipeline_jobs" && u.patch.status === "failed");
    assertEquals(failJobWrite, undefined, "durable discovery must never call failJob");
  },
});

Deno.test({
  name: "parkLeaseForManualReview: unknown state at the guard also aborts the fallback write and does not call failJob",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supabaseAdmin = makeMockSupabase({
      rows: {
        uploaded_files: azureAliasedRow(),
        pipeline_jobs: { id: JOB.id, status: "running" },
      },
      alwaysErrorTables: ["uploaded_files"],
    });
    const result = await parkLeaseForManualReview(
      supabaseAdmin, JOB, FILE_ID, ORG_ID, "lease.pdf", "leases", "base_lease",
      "PARSE_FAILED", "compute resources", "parse",
    );
    assertEquals(result.outcome, "reconciliation_unknown");
    // uploaded_files must never be written to on an unknown determination.
    const uploadedFilesWrite = supabaseAdmin.__updates.find((u) => u.table === "uploaded_files");
    assertEquals(uploadedFilesWrite, undefined, "unknown must leave uploaded_files completely untouched");
    const failJobWrite = supabaseAdmin.__updates.find((u) => u.table === "pipeline_jobs" && u.patch.status === "failed");
    assertEquals(failJobWrite, undefined);
    // Must leave the job genuinely retryable.
    assertEquals(supabaseAdmin.__rows.pipeline_jobs.status, "queued");
  },
});

Deno.test({
  name: "parkLeaseForManualReview: genuinely not_durable parse failure still parks for manual review (the true fallback path is preserved)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supabaseAdmin = makeMockSupabase({
      rows: {
        uploaded_files: { id: FILE_ID, status: "parsing", processing_status: "parsing", extraction_method: "" }, // nothing durable
        pipeline_jobs: { id: JOB.id, status: "running" },
      },
    });
    const result = await parkLeaseForManualReview(
      supabaseAdmin, JOB, FILE_ID, ORG_ID, "lease.pdf", "leases", "base_lease",
      "PARSE_FAILED", "compute resources", "parse",
    );
    assertEquals(result.outcome, "parked");
    assertEquals(supabaseAdmin.__rows.uploaded_files.extraction_method, "manual_review_fallback");
    assertEquals(supabaseAdmin.__rows.pipeline_jobs.status, "failed");
  },
});

// ---------------------------------------------------------------------------
// 11: tenant scoping
// ---------------------------------------------------------------------------

Deno.test({
  name: "reconcileDurableParse and reconcileDurableNormalize scope every read by both id and org_id",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    let capturedFilters: Record<string, any> = {};
    const supabaseAdmin = {
      from(table: string) {
        const builder: any = {
          _filters: {},
          select() { return builder; },
          eq(col: string, val: any) { builder._filters[col] = val; capturedFilters = { ...builder._filters }; return builder; },
          maybeSingle() { return Promise.resolve({ data: azureAliasedRow(), error: null }); },
        };
        return builder;
      },
    };
    await reconcileDurableParse(supabaseAdmin, FILE_ID, ORG_ID);
    assertEquals(capturedFilters.id, FILE_ID);
    assertEquals(capturedFilters.org_id, ORG_ID);
  },
});

// ---------------------------------------------------------------------------
// 12: retry idempotency at the reset-for-retry helper
// ---------------------------------------------------------------------------

Deno.test({
  name: "resetJobForRetryableReconciliation: leaves uploaded_files completely untouched and only requeues the job",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const originalUploadedFiles = azureAliasedRow();
    const supabaseAdmin = makeMockSupabase({
      rows: { uploaded_files: { ...originalUploadedFiles }, pipeline_jobs: { id: JOB.id, status: "running", attempt: 2 } },
    });
    await resetJobForRetryableReconciliation(supabaseAdmin, JOB, FILE_ID, "test");
    assertEquals(supabaseAdmin.__rows.uploaded_files, originalUploadedFiles, "uploaded_files must be completely unchanged");
    assertEquals(supabaseAdmin.__rows.pipeline_jobs.status, "queued");
    assertEquals(supabaseAdmin.__rows.pipeline_jobs.attempt, 2, "attempt is left as-is — already incremented once at claim time, so max_attempts stays correctly bounded");
    const uploadedFilesWrite = supabaseAdmin.__updates.find((u) => u.table === "uploaded_files");
    assertEquals(uploadedFilesWrite, undefined, "unknown must never write to uploaded_files");
  },
});

// ---------------------------------------------------------------------------
// selectWithRetry: exercised directly for a tight, isolated proof
// ---------------------------------------------------------------------------

Deno.test({
  name: "selectWithRetry: retries exactly once on error, then returns whatever the second attempt produced",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    let calls = 0;
    const queryFn = () => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ data: null, error: { message: "boom" } });
      return Promise.resolve({ data: { ok: true }, error: null });
    };
    const result = await selectWithRetry(queryFn);
    assertEquals(calls, 2);
    assertEquals(result.data, { ok: true });
  },
});

Deno.test({
  name: "selectWithRetry: a query that succeeds on the first try is not retried",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    let calls = 0;
    const queryFn = () => {
      calls += 1;
      return Promise.resolve({ data: { ok: true }, error: null });
    };
    await selectWithRetry(queryFn);
    assertEquals(calls, 1);
  },
});
