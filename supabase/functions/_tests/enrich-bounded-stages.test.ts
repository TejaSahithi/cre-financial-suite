// @ts-nocheck
// Bounded Per-Domain Enrich Refactor -- orchestration tests (see
// docs/lease-extraction-architecture-audit-2026-07-29.md and the "Bounded Per-Domain Enrich
// Refactor" plan). Covers the shared stage-orchestration modules
// (stage-sequence/dispatch/completion/generation-fence/stage-persistence/
// enrich-stage-limits) directly, and handleBoundedEnrichStage
// (normalize-pdf-output/index.ts) end to end via the same Deno.serve-stub
// import pattern used elsewhere in this test suite.

import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  ENRICH_EVIDENCE_DOMAIN_STAGES,
  ENRICH_STAGE_SEQUENCE,
  EXPENSES_AND_CAM_EVIDENCE_SUBSTAGES,
  firstEnrichBoundedStage,
  isEnrichBoundedStageName,
  isFinalEnrichBoundedStage,
  nextEnrichBoundedStage,
} from "../_shared/extraction/enrich-bounded-stage/stage-sequence.ts";
import { getEnrichBoundedStageMode } from "../_shared/extraction/enrich-bounded-stage/feature-mode.ts";
import { checkGenerationStillActive } from "../_shared/extraction/generation-fence.ts";
import {
  checkStageInputAgainstLimits,
  getEnrichStageLimits,
} from "../_shared/extraction/enrich-stage-limits.ts";
import {
  isStageAlreadyCompleted,
  mergeBoundedStageResult,
  readBoundedStageResults,
  STAGE_RESULT_VERSION,
} from "../_shared/extraction/enrich-bounded-stage/stage-persistence.ts";
import { enqueueBoundedEnrichStage } from "../_shared/extraction/enrich-bounded-stage/dispatch.ts";
import { completeBoundedEnrichStage } from "../_shared/extraction/enrich-bounded-stage/completion.ts";
import {
  __test__ as leaseWorkflowTest,
  buildLeaseWorkflowAbstraction,
} from "../_shared/extraction/lease-workflow.ts";
import { getSchema } from "../_shared/extraction/schemas.ts";
import {
  getSchemaEntriesForDomain,
  getSchemaEntriesForFieldGroups,
  getSchemaEntriesWithNoDomain,
  reorderStandardFieldsBySchema,
} from "../_shared/extraction/enrich-bounded-stage/domain-fields.ts";
import {
  assembleCanonicalFields,
  publishIdFor,
} from "../_shared/extraction/lease-truth-assembly.ts";
import { getDomainForEnrichStage } from "../_shared/extraction/domains/domain-stage-registry.ts";

const {
  runLeaseWorkflowStage1Clauses,
  runLeaseWorkflowStage2Fields,
  runLeaseWorkflowStage3Items,
  runLeaseWorkflowStage4Derivation,
} = leaseWorkflowTest;

const realServe = Deno.serve;
(Deno as any).serve = (..._args: unknown[]) => ({
  finished: Promise.resolve(),
  shutdown: () => {},
});
const { __test__: normalizeTest } = await import(
  "../normalize-pdf-output/index.ts"
);
(Deno as any).serve = realServe;

const {
  buildStandardFieldsForEntries,
  buildReviewPayload,
  handleBoundedEnrichStage,
  handleEnrichEvidenceDomainStage,
  extractCamNoteFromText,
  isBlank,
} = normalizeTest;

const ORG_ID = "org-1";
const FILE_ID = "file-1";
const GEN_ID = "gen-1";
const JOB_ID = "job-1";

// ---------------------------------------------------------------------------
// Shared mock Supabase client (same shape/conventions as
// lease-extraction-worker-reconciliation.test.ts's makeMockSupabase).
// ---------------------------------------------------------------------------
function makeMockSupabase(
  { rows, rpcResults = {}, activeGenerationOverride = null }: {
    rows: Record<string, any>;
    rpcResults?: Record<string, { data: any; error: any }>;
    /** Function returning the CURRENT active_generation_id, called fresh on every read -- lets a test simulate the generation changing mid-flight (between the pre- and post-fence checks). */
    activeGenerationOverride?: (() => string | null) | null;
  },
) {
  const updates: Array<{ table: string; patch: any }> = [];
  const rpcCalls: Array<{ name: string; args: any }> = [];

  function from(table: string) {
    const builder: any = {
      _filters: {} as Record<string, any>,
      _patch: null,
      _isUpdate: false,
      select() {
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
      maybeSingle() {
        return runQuery();
      },
      single() {
        return runQuery();
      },
    };
    function runQuery() {
      if (builder._isUpdate) {
        updates.push({ table, patch: builder._patch });
        rows[table] = { ...(rows[table] || {}), ...builder._patch };
        return Promise.resolve({ data: rows[table], error: null });
      }
      let data = rows[table] ?? null;
      if (table === "uploaded_files" && activeGenerationOverride && data) {
        data = { ...data, active_generation_id: activeGenerationOverride() };
      }
      return Promise.resolve({ data, error: null });
    }
    builder.then = (resolve: any) => runQuery().then(resolve);
    return builder;
  }

  async function rpc(name: string, args: any) {
    rpcCalls.push({ name, args });
    if (rpcResults[name]) return rpcResults[name];
    return { data: null, error: null };
  }

  return { from, rpc, __rows: rows, __updates: updates, __rpcCalls: rpcCalls };
}

// ===========================================================================
// 1. Exact stage order
// ===========================================================================
Deno.test("enrich-bounded-stages: exact stage order -- Expenses/CAM is split into sub-stages, then reduced back to the canonical domain", () => {
  assertEquals(ENRICH_STAGE_SEQUENCE, [
    "enrich_clauses",
    "enrich_fields",
    "enrich_items",
    "enrich_derivation",
    "enrich_evidence_core_terms",
    "enrich_evidence_rent_and_charges",
    "enrich_evidence_expenses_recoveries",
    "enrich_evidence_cam_rules",
    "enrich_evidence_taxes",
    "enrich_evidence_insurance",
    "enrich_evidence_utilities",
    "enrich_evidence_expenses_and_cam",
    "enrich_evidence_operating_obligations",
    "enrich_evidence_legal_rights_and_dates",
    "enrich_truth_assembly",
  ]);
  assertEquals(EXPENSES_AND_CAM_EVIDENCE_SUBSTAGES.length, 5);
  assertEquals(firstEnrichBoundedStage(), "enrich_clauses");
  assertEquals(nextEnrichBoundedStage("enrich_clauses"), "enrich_fields");
  assertEquals(
    nextEnrichBoundedStage("enrich_derivation"),
    "enrich_evidence_core_terms",
  );
  assertEquals(
    nextEnrichBoundedStage("enrich_evidence_rent_and_charges"),
    "enrich_evidence_expenses_recoveries",
  );
  assertEquals(
    nextEnrichBoundedStage("enrich_evidence_utilities"),
    "enrich_evidence_expenses_and_cam",
  );
  assertEquals(
    nextEnrichBoundedStage("enrich_evidence_expenses_and_cam"),
    "enrich_evidence_operating_obligations",
  );
  assertEquals(
    nextEnrichBoundedStage("enrich_evidence_legal_rights_and_dates"),
    "enrich_truth_assembly",
  );
  assertEquals(nextEnrichBoundedStage("enrich_truth_assembly"), null);
  assertEquals(isFinalEnrichBoundedStage("enrich_truth_assembly"), true);
  assertEquals(isFinalEnrichBoundedStage("enrich_derivation"), false);
  assertEquals(ENRICH_EVIDENCE_DOMAIN_STAGES.length, 5);
});

// ===========================================================================
// 2. Only one stage runs per invocation (completeBoundedEnrichStage never
//    advances more than one step)
// ===========================================================================
Deno.test("enrich-bounded-stages: a successful non-final stage enqueues EXACTLY the next stage, never more", async () => {
  const supabaseAdmin = makeMockSupabase({
    rows: {
      uploaded_files: { active_generation_id: GEN_ID },
      pipeline_jobs: { id: JOB_ID, status: "running" },
    },
    rpcResults: {
      enqueue_pipeline_job: {
        data: { created: true, job_id: "job-2" },
        error: null,
      },
    },
  });
  const job = { id: JOB_ID, generation_id: GEN_ID, metadata: {} };
  const result = await completeBoundedEnrichStage({
    supabaseAdmin,
    job,
    fileId: FILE_ID,
    orgId: ORG_ID,
    stage: "enrich_clauses",
    outcome: { ok: true },
  });
  assertEquals(result.nextStage, "enrich_fields");
  const enqueueCalls = supabaseAdmin.__rpcCalls.filter((c: any) =>
    c.name === "enqueue_pipeline_job"
  );
  assertEquals(enqueueCalls.length, 1);
  assertEquals(enqueueCalls[0].args.p_stage, "enrich_fields");
});

// ===========================================================================
// 3. Completed stage is idempotently reused (no recompute)
// ===========================================================================
Deno.test("enrich-bounded-stages: isStageAlreadyCompleted reuses a matching completed entry, rejects mismatched generation/version", () => {
  const normalizedOutput = mergeBoundedStageResult({
    normalizedOutput: {},
    stage: "enrich_clauses",
    generationId: GEN_ID,
    status: "completed",
    data: { clauses: [] },
  });
  assertEquals(
    isStageAlreadyCompleted({
      normalizedOutput,
      stage: "enrich_clauses",
      generationId: GEN_ID,
    }).reusable,
    true,
  );
  assertEquals(
    isStageAlreadyCompleted({
      normalizedOutput,
      stage: "enrich_clauses",
      generationId: "other-gen",
    }).reusable,
    false,
  );
  assertEquals(
    isStageAlreadyCompleted({
      normalizedOutput,
      stage: "enrich_fields",
      generationId: GEN_ID,
    }).reusable,
    false,
  );

  // A stage_version mismatch (simulating a stage-logic change since this
  // result was persisted) must also be treated as not reusable.
  const staleVersionOutput = {
    metadata: {
      extractionDebug: {
        bounded_stage_results: {
          enrich_clauses: {
            status: "completed",
            generation_id: GEN_ID,
            stage_version: "v0-stale",
            data: {},
          },
        },
      },
    },
  };
  assertEquals(
    isStageAlreadyCompleted({
      normalizedOutput: staleVersionOutput,
      stage: "enrich_clauses",
      generationId: GEN_ID,
    }).reusable,
    false,
  );
});

Deno.test("enrich-bounded-stages: handleBoundedEnrichStage returns reused_from_cache=true and does NOT recompute for an already-completed stage", async () => {
  const priorNormalizedOutput = mergeBoundedStageResult({
    normalizedOutput: {
      rows: [{ tenant_name: "Acme" }],
      method: "llm_only",
      warnings: [],
      validationErrors: [],
      metadata: {},
    },
    stage: "enrich_clauses",
    generationId: GEN_ID,
    status: "completed",
    data: { clauses: [] },
  });
  const supabaseAdmin = makeMockSupabase({
    rows: {
      uploaded_files: {
        id: FILE_ID,
        org_id: ORG_ID,
        active_generation_id: GEN_ID,
        module_type: "lease",
        docling_raw: { full_text: "", text_blocks: [] },
        normalized_output: priorNormalizedOutput,
      },
    },
  });
  const response = await handleBoundedEnrichStage({
    supabaseAdmin,
    orgId: ORG_ID,
    fileId: FILE_ID,
    pipelineJobId: JOB_ID,
    generationId: GEN_ID,
    stage: "enrich_clauses",
    jsonResponse: (body: any, status = 200) =>
      new Response(JSON.stringify(body), { status }),
  });
  const body = await response.json();
  assertEquals(body.reused_from_cache, true);
  // No update to uploaded_files should have happened for a reused stage.
  assertEquals(
    supabaseAdmin.__updates.filter((u: any) => u.table === "uploaded_files")
      .length,
    0,
  );
});

// ===========================================================================
// 4. Resume after interruption -- a later stage runs correctly using an
//    EARLIER stage's already-persisted result, without redoing it
// ===========================================================================
Deno.test("enrich-bounded-stages: enrich_fields resumes from a persisted enrich_clauses result without recomputing clauses", async () => {
  const clausesResult = runLeaseWorkflowStage1Clauses({
    doclingRaw: {
      full_text: "Tenant shall pay rent.",
      text_blocks: [{ text: "Tenant shall pay rent.", page: 1 }],
    },
  });
  let normalizedOutput = mergeBoundedStageResult({
    normalizedOutput: {
      rows: [{}],
      method: "llm_only",
      warnings: [],
      validationErrors: [],
      metadata: {},
    },
    stage: "enrich_clauses",
    generationId: GEN_ID,
    status: "completed",
    data: clausesResult,
  });
  const supabaseAdmin = makeMockSupabase({
    rows: {
      uploaded_files: {
        id: FILE_ID,
        org_id: ORG_ID,
        active_generation_id: GEN_ID,
        module_type: "lease",
        docling_raw: {
          full_text: "Tenant shall pay rent.",
          text_blocks: [{ text: "Tenant shall pay rent.", page: 1 }],
        },
        normalized_output: normalizedOutput,
      },
    },
  });
  const response = await handleBoundedEnrichStage({
    supabaseAdmin,
    orgId: ORG_ID,
    fileId: FILE_ID,
    pipelineJobId: JOB_ID,
    generationId: GEN_ID,
    stage: "enrich_fields",
    jsonResponse: (body: any, status = 200) =>
      new Response(JSON.stringify(body), { status }),
  });
  const body = await response.json();
  assertEquals(body.status, "completed");
  const results = readBoundedStageResults(
    supabaseAdmin.__rows.uploaded_files.normalized_output,
  );
  assert(
    results.enrich_fields != null &&
      results.enrich_fields.status === "completed",
  );
  // enrich_clauses's own entry must survive untouched.
  assertEquals(results.enrich_clauses.data, clausesResult);
});

// ===========================================================================
// 5. Failure stops later stages
// ===========================================================================
Deno.test("enrich-bounded-stages: a terminal failure does NOT enqueue any further stage", async () => {
  const supabaseAdmin = makeMockSupabase({
    rows: {
      uploaded_files: { active_generation_id: GEN_ID, ui_review_payload: {} },
      pipeline_jobs: { id: JOB_ID, status: "running" },
    },
  });
  const job = { id: JOB_ID, generation_id: GEN_ID, metadata: {} };
  await completeBoundedEnrichStage({
    supabaseAdmin,
    job,
    fileId: FILE_ID,
    orgId: ORG_ID,
    stage: "enrich_fields",
    outcome: { ok: false, errorCode: "SOME_FAILURE", errorMessage: "boom" },
  });
  const enqueueCalls = supabaseAdmin.__rpcCalls.filter((c: any) =>
    c.name === "enqueue_pipeline_job"
  );
  assertEquals(enqueueCalls.length, 0);
  assertEquals(supabaseAdmin.__rows.pipeline_jobs.status, "failed");
});

// ===========================================================================
// 6. Stale generation cannot persist output
// ===========================================================================
Deno.test("enrich-bounded-stages: pre-fence stale generation returns immediately, loads no data, persists nothing", async () => {
  const supabaseAdmin = makeMockSupabase({
    rows: {
      uploaded_files: {
        id: FILE_ID,
        org_id: ORG_ID,
        active_generation_id: "a-newer-generation",
      },
    },
  });
  const response = await handleBoundedEnrichStage({
    supabaseAdmin,
    orgId: ORG_ID,
    fileId: FILE_ID,
    pipelineJobId: JOB_ID,
    generationId: GEN_ID,
    stage: "enrich_clauses",
    jsonResponse: (body: any, status = 200) =>
      new Response(JSON.stringify(body), { status }),
  });
  const body = await response.json();
  assertEquals(body.stale_generation, true);
  assertEquals(supabaseAdmin.__updates.length, 0);
});

Deno.test("enrich-bounded-stages: completeBoundedEnrichStage detects a stale generation and cancels the job instead of persisting/enqueueing", async () => {
  const supabaseAdmin = makeMockSupabase({
    rows: {
      uploaded_files: { active_generation_id: "a-newer-generation" },
      pipeline_jobs: { id: JOB_ID, status: "running" },
    },
  });
  const job = { id: JOB_ID, generation_id: GEN_ID, metadata: {} };
  const result = await completeBoundedEnrichStage({
    supabaseAdmin,
    job,
    fileId: FILE_ID,
    orgId: ORG_ID,
    stage: "enrich_clauses",
    outcome: { ok: true },
  });
  assertEquals(result.proceeded, false);
  assertEquals(result.reason, "stale_generation");
  assertEquals(supabaseAdmin.__rows.pipeline_jobs.status, "cancelled");
  assertEquals(
    supabaseAdmin.__rpcCalls.filter((c: any) =>
      c.name === "enqueue_pipeline_job"
    ).length,
    0,
  );
});

// ===========================================================================
// 7. Generation changes between execution and persistence are rejected
// ===========================================================================
Deno.test("enrich-bounded-stages: a generation change AFTER compute but BEFORE persist is caught by the post-fence check", async () => {
  let callCount = 0;
  // First read (pre-fence): still GEN_ID. Second read (post-fence, after
  // the stage's compute "happened"): a newer generation has taken over.
  const activeGenerationOverride = () => {
    callCount += 1;
    return callCount === 1 ? GEN_ID : "a-newer-generation";
  };
  const supabaseAdmin = makeMockSupabase({
    rows: {
      uploaded_files: {
        id: FILE_ID,
        org_id: ORG_ID,
        active_generation_id: GEN_ID,
        module_type: "lease",
        docling_raw: { full_text: "", text_blocks: [] },
        normalized_output: {
          rows: [{}],
          method: "llm_only",
          warnings: [],
          validationErrors: [],
          metadata: {},
        },
      },
    },
    activeGenerationOverride,
  });
  const response = await handleBoundedEnrichStage({
    supabaseAdmin,
    orgId: ORG_ID,
    fileId: FILE_ID,
    pipelineJobId: JOB_ID,
    generationId: GEN_ID,
    stage: "enrich_clauses",
    jsonResponse: (body: any, status = 200) =>
      new Response(JSON.stringify(body), { status }),
  });
  const body = await response.json();
  assertEquals(body.stale_generation, true);
  // The compute happened, but nothing must have been written.
  assertEquals(
    supabaseAdmin.__updates.filter((u: any) => u.table === "uploaded_files")
      .length,
    0,
  );
});

// ===========================================================================
// 8. Duplicate dispatch cannot complete twice
// ===========================================================================
Deno.test("enrich-bounded-stages: enqueueBoundedEnrichStage's duplicate call returns the SAME existing job, not a second row", async () => {
  const supabaseAdmin = makeMockSupabase({
    rows: {},
    rpcResults: {
      enqueue_pipeline_job: {
        data: { created: false, existing_job_id: "existing-job-77" },
        error: null,
      },
    },
  });
  const result = await enqueueBoundedEnrichStage({
    supabaseAdmin,
    orgId: ORG_ID,
    fileId: FILE_ID,
    stage: "enrich_fields",
    generationId: GEN_ID,
    dispatchWorker: () => {},
  });
  assertEquals(result, { id: "existing-job-77", existing: true });
});

// ===========================================================================
// 9. Oversized input splits or explicitly fails
// ===========================================================================
Deno.test("enrich-bounded-stages: an oversized stage input fails explicitly with BOUNDED_STAGE_LIMIT_EXCEEDED, never silently falls back to whole-document processing", async () => {
  const limits = getEnrichStageLimits("enrich_clauses");
  const hugeTextBlocks = Array.from(
    { length: limits.maxTextBlocks + 1 },
    (_, i) => ({ text: `block ${i}`, page: 1 }),
  );
  const check = checkStageInputAgainstLimits("enrich_clauses", {
    textBlockCount: hugeTextBlocks.length,
    fullTextChars: 0,
    pageCount: 0,
  });
  assertEquals(check.withinLimits, false);

  const supabaseAdmin = makeMockSupabase({
    rows: {
      uploaded_files: {
        id: FILE_ID,
        org_id: ORG_ID,
        active_generation_id: GEN_ID,
        module_type: "lease",
        docling_raw: { full_text: "", text_blocks: hugeTextBlocks },
        normalized_output: {
          rows: [{}],
          method: "llm_only",
          warnings: [],
          validationErrors: [],
          metadata: {},
        },
      },
    },
  });
  const response = await handleBoundedEnrichStage({
    supabaseAdmin,
    orgId: ORG_ID,
    fileId: FILE_ID,
    pipelineJobId: JOB_ID,
    generationId: GEN_ID,
    stage: "enrich_clauses",
    jsonResponse: (body: any, status = 200) =>
      new Response(JSON.stringify(body), { status }),
  });
  assertEquals(response.status, 422);
  const body = await response.json();
  assertEquals(body.error_code, "BOUNDED_STAGE_LIMIT_EXCEEDED");
  assertEquals(body.limit_exceeded, true);
  // No whole-document fallback attempt: nothing persisted.
  assertEquals(supabaseAdmin.__updates.length, 0);
});

// ===========================================================================
// 10. Bounded enrichment is mandatory
// ===========================================================================
Deno.test("enrich-bounded-stages: ENRICH_BOUNDED_STAGE_MODE stays active even when env is off", () => {
  const originalValue = Deno.env.get("ENRICH_BOUNDED_STAGE_MODE");
  try {
    Deno.env.delete("ENRICH_BOUNDED_STAGE_MODE");
    assertEquals(getEnrichBoundedStageMode(), "active");
    Deno.env.set("ENRICH_BOUNDED_STAGE_MODE", "bogus-value");
    assertEquals(getEnrichBoundedStageMode(), "active");
    Deno.env.set("ENRICH_BOUNDED_STAGE_MODE", "off");
    assertEquals(getEnrichBoundedStageMode(), "active");
    Deno.env.set("ENRICH_BOUNDED_STAGE_MODE", "active");
    assertEquals(getEnrichBoundedStageMode(), "active");
  } finally {
    if (originalValue == null) Deno.env.delete("ENRICH_BOUNDED_STAGE_MODE");
    else Deno.env.set("ENRICH_BOUNDED_STAGE_MODE", originalValue);
  }
});

// ===========================================================================
// 11. Final assembly runs exactly once (success path enqueues nothing further)
// ===========================================================================
Deno.test("enrich-bounded-stages: enrich_truth_assembly's own completion marks the chain complete and enqueues NOTHING further", async () => {
  const supabaseAdmin = makeMockSupabase({
    rows: {
      uploaded_files: { active_generation_id: GEN_ID },
      pipeline_jobs: { id: JOB_ID, status: "running" },
    },
  });
  const job = { id: JOB_ID, generation_id: GEN_ID, metadata: {} };
  const result = await completeBoundedEnrichStage({
    supabaseAdmin,
    job,
    fileId: FILE_ID,
    orgId: ORG_ID,
    stage: "enrich_truth_assembly",
    outcome: { ok: true },
  });
  assertEquals(result.chainComplete, true);
  assertEquals(
    supabaseAdmin.__rpcCalls.filter((c: any) =>
      c.name === "enqueue_pipeline_job"
    ).length,
    0,
  );
});

// ===========================================================================
// 12/13/14/18. Final assembly receives all 4 workflow + 5 evidence-domain
// outputs, and produces output byte-equivalent to the monolithic path,
// including truth-assembly markers -- the end-to-end correctness gate.
// ===========================================================================
const LEASE_TEXT = [
  "COMMERCIAL LEASE AGREEMENT",
  'This Lease is entered into between Markets at Choto, LLC ("Landlord") and Cress Family Restaurants, LLC ("Tenant").',
  "1. Premises. The Premises are located at 12350 South Northshore, Knoxville, TN 37922.",
  "2. Term. The Term of this Lease shall commence on February 1, 2024 and expire on January 31, 2029.",
  "3. Rent. Tenant shall pay Landlord Base Rent of $4,500.00 per month.",
  "4. Taxes. Tenant shall be responsible for paying all Real Estate Taxes, Insurance Premiums and Common Area Maintenance Expenses.",
  "5. Use. Tenant shall use the Premises solely for a full-service restaurant.",
].join("\n");
const LEASE_DOCLING_RAW = {
  full_text: LEASE_TEXT,
  text_blocks: [{ text: LEASE_TEXT, page: 1 }],
  tables: [],
  fields: [],
};
const LEASE_ROW = {
  tenant_name: "Cress Family Restaurants, LLC",
  landlord_name: "Markets at Choto, LLC",
  monthly_rent: 4500,
  _field_confidences: {
    tenant_name: 0.92,
    landlord_name: 0.92,
    monthly_rent: 0.9,
  },
};
const LEASE_RESULT = {
  rows: [LEASE_ROW],
  method: "llm_only",
  warnings: [],
  validationErrors: [],
  metadata: {},
};

function buildPooledStandardFieldsForRow(): any[] {
  const schema = getSchema("lease");
  const allSchemaEntries = Object.entries(schema).filter(([, def]) =>
    !(def as any).derived
  );

  // Matches exactly what handleBoundedEnrichStage's real handler does:
  // compute truthAssemblyCanonicalFields fresh via assembleCanonicalFields
  // (never hardcode {} -- even with no merged_field_sources, row0's own
  // field values alone can resolve real canonical results), then build the
  // "effective row" (Lease Truth Assembly overrides applied per field) --
  // buildLeaseWorkflowAbstraction / the workflow-abstraction stages must
  // receive THIS, not the raw row, or their output silently diverges from
  // the monolithic path (this was a real bug caught by this exact test).
  const truthAssemblyCanonicalFields = assembleCanonicalFields({
    rows: LEASE_RESULT.rows as Array<Record<string, unknown>>,
    extractionDebug: (LEASE_RESULT.metadata as any)?.extractionDebug ?? {},
    moduleType: "lease",
  }).canonicalFields;
  const effectiveRow: Record<string, unknown> = { ...LEASE_ROW };
  for (const [fieldKey] of allSchemaEntries) {
    const canonicalResult =
      truthAssemblyCanonicalFields[publishIdFor(fieldKey)];
    if (!canonicalResult || canonicalResult.status === "not_stated") continue;
    effectiveRow[fieldKey] = canonicalResult.status === "conflicting"
      ? null
      : canonicalResult.value;
  }

  const stage1 = runLeaseWorkflowStage1Clauses({
    doclingRaw: LEASE_DOCLING_RAW,
  });
  const stage2 = runLeaseWorkflowStage2Fields({
    row: effectiveRow,
    doclingRaw: LEASE_DOCLING_RAW,
    stage1,
  });
  const stage3 = runLeaseWorkflowStage3Items({
    row: effectiveRow,
    doclingRaw: LEASE_DOCLING_RAW,
    stage1,
    stage2,
  });
  const derivation = runLeaseWorkflowStage4Derivation({
    row: effectiveRow,
    doclingRaw: LEASE_DOCLING_RAW,
    stage1,
    stage2,
    stage3,
  });

  // The evidence-domain loop deliberately uses the RAW row (matching
  // buildReviewPayload's own evidence loop) -- strip internal `_`-prefixed
  // keys before use as `values`.
  const { _field_confidences, ...values } = LEASE_ROW as any;
  // Matches buildReviewPayload's own rows.map() exactly: a blank "notes"
  // field on a lease row falls back to a CAM sentence pulled from the
  // document text (extractCamNoteFromText) -- omitting this here would
  // make this test's "monolithic" comparison diverge from the real
  // production computation for the exact same reason handleBoundedEnrichStage
  // needed the identical fix (a real bug this test caught).
  if (isBlank(values.notes)) {
    const camNote = extractCamNoteFromText(LEASE_DOCLING_RAW);
    if (camNote) values.notes = camNote;
  }

  const baseArgs = {
    index: 0,
    values,
    workflowOutput: derivation,
    fieldConfidences: LEASE_ROW._field_confidences,
    fieldSources: {},
    fieldEvidence: {},
    calculatorDerivationTraces: {},
    calculatorDerivationSourceFields: {},
    doclingRaw: LEASE_DOCLING_RAW,
    extractionModuleType: "lease",
    truthAssemblyCanonicalFields,
    // Matches what the real production computation yields for this exact
    // fixture (no confidence_score on the row, no avgConfidence in
    // metadata) -- normalizeConfidence(undefined) -- rather than an
    // arbitrary hardcoded value that wouldn't match the monolithic path's
    // own fresh computation of the same formula.
    source: "llm",
    rowConfidence: null,
  };
  const evidenceByDomain = [
    "core_terms",
    "rent_and_charges",
    "expenses_and_cam",
    "operating_obligations",
    "legal_rights_and_dates",
  ]
    .flatMap((domain) =>
      buildStandardFieldsForEntries({
        ...baseArgs,
        schemaEntries: getSchemaEntriesForDomain(
          allSchemaEntries,
          domain as any,
        ),
      })
    );
  const remainder = buildStandardFieldsForEntries({
    ...baseArgs,
    schemaEntries: getSchemaEntriesWithNoDomain(allSchemaEntries),
  });
  // Matches handleBoundedEnrichStage's own enrich_truth_assembly pooling
  // exactly: dispatch-order concatenation must be restored to schema order
  // before use, or the pooled output silently diverges in field ORDER from
  // the monolithic single-pass loop (a real bug this exact test caught).
  const pooled = reorderStandardFieldsBySchema([
    ...evidenceByDomain,
    ...remainder,
  ], allSchemaEntries);
  return { derivation, pooled };
}

Deno.test("enrich-bounded-stages: pooling all 4 workflow stages + all 5 evidence domains + remainder into buildReviewPayload produces output byte-equivalent to the monolithic call", () => {
  const { derivation, pooled } = buildPooledStandardFieldsForRow();

  const boundedPayload = buildReviewPayload({
    fileId: FILE_ID,
    fileName: "lease.pdf",
    moduleType: "leases",
    documentSubtype: null,
    extractionMethod: "llm_only",
    reviewRequired: true,
    doclingRaw: LEASE_DOCLING_RAW,
    result: LEASE_RESULT,
    precomputedWorkflowOutputs: [derivation],
    precomputedStandardFieldsByRow: [pooled],
  });

  const monolithicPayload = buildReviewPayload({
    fileId: FILE_ID,
    fileName: "lease.pdf",
    moduleType: "leases",
    documentSubtype: null,
    extractionMethod: "llm_only",
    reviewRequired: true,
    doclingRaw: LEASE_DOCLING_RAW,
    result: LEASE_RESULT,
  });

  // built_at is a fresh Date.now()-based timestamp stamped independently by
  // EACH call -- the two calls here are milliseconds apart by construction
  // (two separate invocations in this test), so it never matches and isn't
  // a meaningful equivalence check; every other key must match exactly.
  assertEquals({ ...boundedPayload, built_at: null }, {
    ...monolithicPayload,
    built_at: null,
  });

  // 18. canonical payload contains truth-assembly markers.
  const tenantField = boundedPayload.records[0].standard_fields.find((f: any) =>
    f.field_key === "tenant_name"
  );
  assert(
    tenantField,
    "tenant_name must be present in the pooled standard_fields",
  );
  assert("truth_assembly_field_id" in tenantField);
  assert("truth_assembly_status" in tenantField);
  assert("truth_assembly_version" in tenantField);
});

Deno.test("enrich-bounded-stages: pooled evidence covers fields from all 5 domains, not just one", () => {
  const { pooled } = buildPooledStandardFieldsForRow();
  const keys = new Set(pooled.map((f: any) => f.field_key));
  assert(keys.has("tenant_name"), "core_terms field missing");
  assert(keys.has("monthly_rent"), "rent_and_charges field missing");
  assert(
    keys.has("responsibility_taxes") || keys.has("tax_responsibility"),
    "expenses_and_cam field missing",
  );
});

// ===========================================================================
// 15/16/17. Failure product-safety: partial payload not review-ready, 546 is
// terminal (not a warning), original error preserved.
// ===========================================================================
Deno.test("enrich-bounded-stages: a DOWNSTREAM_FUNCTION_FAILED (546-shaped) outcome is a plain terminal failure -- no soft/warning path exists in the bounded chain", async () => {
  const supabaseAdmin = makeMockSupabase({
    rows: {
      uploaded_files: {
        active_generation_id: GEN_ID,
        ui_review_payload: { records: [{ fields: {} }] },
      },
      pipeline_jobs: { id: JOB_ID, status: "running" },
    },
  });
  const job = { id: JOB_ID, generation_id: GEN_ID, metadata: {} };
  const originalMessage =
    "Function failed due to not having enough compute resources (please check logs)";
  await completeBoundedEnrichStage({
    supabaseAdmin,
    job,
    fileId: FILE_ID,
    orgId: ORG_ID,
    stage: "enrich_derivation",
    outcome: {
      ok: false,
      errorCode: "DOWNSTREAM_FUNCTION_FAILED",
      errorMessage: originalMessage,
    },
  });
  assertEquals(supabaseAdmin.__rows.pipeline_jobs.status, "failed");
  assertEquals(
    supabaseAdmin.__rows.pipeline_jobs.error_code,
    "DOWNSTREAM_FUNCTION_FAILED",
  );
  // 17. original downstream error remains persisted verbatim.
  assertEquals(
    supabaseAdmin.__rows.pipeline_jobs.error_message,
    originalMessage,
  );
  // 15. the payload is marked failed, never silently presented as ready.
  assertEquals(
    supabaseAdmin.__rows.uploaded_files.ui_review_payload.enrichment_status,
    "failed",
  );
  assertNotEquals(
    supabaseAdmin.__rows.uploaded_files.ui_review_payload.enrichment_status,
    "completed_with_warnings",
  );
});

// ===========================================================================
// 19. Canonical-only reconstruction performs zero Azure and zero OpenAI
// calls -- every bounded stage operates on already-extracted data.
// ===========================================================================
function countFetchCallsTo(pattern: RegExp) {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  (globalThis as any).fetch = (...args: any[]) => {
    const url = String(args[0]?.url ?? args[0] ?? "");
    if (pattern.test(url)) calls.push(url);
    return originalFetch(...args);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

Deno.test("enrich-bounded-stages: reconstructing the canonical payload from already-extracted data makes ZERO Azure and ZERO OpenAI calls", () => {
  const spy = countFetchCallsTo(/azure|openai/i);
  try {
    buildPooledStandardFieldsForRow();
  } finally {
    spy.restore();
  }
  assertEquals(spy.calls.length, 0);
});

// ===========================================================================
// 20. Phase 4.5: dynamic bounded-enrich dispatch. The 5 static
// `case "enrich_evidence_<domain>":` labels were replaced by a generic
// isEnrichEvidenceDomainStage()/handleEnrichEvidenceDomainStage() branch --
// these tests prove the replacement is behaviorally invisible: same
// stageData per domain, same idempotency/retry behavior, same rejection of
// stage names the registry doesn't recognize.
// ===========================================================================

Deno.test("enrich-bounded-stages (Phase 4.5): handleEnrichEvidenceDomainStage produces the SAME stageData as a direct buildStandardFieldsForEntries call, for every domain", () => {
  const schema = getSchema("lease");
  const allSchemaEntries = Object.entries(schema).filter(([, def]) =>
    !(def as any).derived
  );
  const truthAssemblyCanonicalFields = assembleCanonicalFields({
    rows: LEASE_RESULT.rows as Array<Record<string, unknown>>,
    extractionDebug: (LEASE_RESULT.metadata as any)?.extractionDebug ?? {},
    moduleType: "lease",
  }).canonicalFields;
  const effectiveRow: Record<string, unknown> = { ...LEASE_ROW };
  for (const [fieldKey] of allSchemaEntries) {
    const canonicalResult =
      truthAssemblyCanonicalFields[publishIdFor(fieldKey)];
    if (!canonicalResult || canonicalResult.status === "not_stated") continue;
    effectiveRow[fieldKey] = canonicalResult.status === "conflicting"
      ? null
      : canonicalResult.value;
  }
  const stage1 = runLeaseWorkflowStage1Clauses({
    doclingRaw: LEASE_DOCLING_RAW,
  });
  const stage2 = runLeaseWorkflowStage2Fields({
    row: effectiveRow,
    doclingRaw: LEASE_DOCLING_RAW,
    stage1,
  });
  const stage3 = runLeaseWorkflowStage3Items({
    row: effectiveRow,
    doclingRaw: LEASE_DOCLING_RAW,
    stage1,
    stage2,
  });
  const derivation = runLeaseWorkflowStage4Derivation({
    row: effectiveRow,
    doclingRaw: LEASE_DOCLING_RAW,
    stage1,
    stage2,
    stage3,
  });

  const { _field_confidences, ...values } = LEASE_ROW as any;
  if (isBlank(values.notes)) {
    const camNote = extractCamNoteFromText(LEASE_DOCLING_RAW);
    if (camNote) values.notes = camNote;
  }
  const baseArgs = {
    index: 0,
    values,
    workflowOutput: derivation,
    fieldConfidences: LEASE_ROW._field_confidences,
    fieldSources: {},
    fieldEvidence: {},
    calculatorDerivationTraces: {},
    calculatorDerivationSourceFields: {},
    doclingRaw: LEASE_DOCLING_RAW,
    extractionModuleType: "lease",
    truthAssemblyCanonicalFields,
    source: "llm",
    rowConfidence: null,
  };

  for (const stage of ENRICH_EVIDENCE_DOMAIN_STAGES) {
    const domain = getDomainForEnrichStage(stage as any);
    const reference = buildStandardFieldsForEntries({
      ...baseArgs,
      schemaEntries: getSchemaEntriesForDomain(allSchemaEntries, domain as any),
    });
    const viaExtractedHandler = handleEnrichEvidenceDomainStage({
      domain,
      derivation,
      extractionModuleType: "lease",
      row: LEASE_ROW,
      moduleType: "leases",
      doclingRaw: LEASE_DOCLING_RAW,
      truthAssemblyCanonicalFields,
      fileRecord: { extraction_method: null },
      normalizedOutput: LEASE_RESULT,
    });
    assertEquals(
      viaExtractedHandler,
      reference,
      `mismatch for domain ${domain} (stage ${stage})`,
    );
  }
});

function seedNormalizedOutputThroughDerivation(): any {
  let normalizedOutput: any = {
    rows: [LEASE_ROW],
    method: "llm_only",
    warnings: [],
    validationErrors: [],
    metadata: {},
  };
  const stage1 = runLeaseWorkflowStage1Clauses({
    doclingRaw: LEASE_DOCLING_RAW,
  });
  normalizedOutput = mergeBoundedStageResult({
    normalizedOutput,
    stage: "enrich_clauses",
    generationId: GEN_ID,
    status: "completed",
    data: stage1,
  });
  const stage2 = runLeaseWorkflowStage2Fields({
    row: LEASE_ROW,
    doclingRaw: LEASE_DOCLING_RAW,
    stage1,
  });
  normalizedOutput = mergeBoundedStageResult({
    normalizedOutput,
    stage: "enrich_fields",
    generationId: GEN_ID,
    status: "completed",
    data: stage2,
  });
  const stage3 = runLeaseWorkflowStage3Items({
    row: LEASE_ROW,
    doclingRaw: LEASE_DOCLING_RAW,
    stage1,
    stage2,
  });
  normalizedOutput = mergeBoundedStageResult({
    normalizedOutput,
    stage: "enrich_items",
    generationId: GEN_ID,
    status: "completed",
    data: stage3,
  });
  const derivation = runLeaseWorkflowStage4Derivation({
    row: LEASE_ROW,
    doclingRaw: LEASE_DOCLING_RAW,
    stage1,
    stage2,
    stage3,
  });
  normalizedOutput = mergeBoundedStageResult({
    normalizedOutput,
    stage: "enrich_derivation",
    generationId: GEN_ID,
    status: "completed",
    data: derivation,
  });
  return normalizedOutput;
}

Deno.test("enrich-bounded-stages: Expenses/CAM reducer combines five smaller sub-stage outputs and does not run the heavy domain stage directly", async () => {
  const seeded = seedNormalizedOutputThroughDerivation();
  const supabaseAdmin = makeMockSupabase({
    rows: {
      uploaded_files: {
        id: FILE_ID,
        org_id: ORG_ID,
        active_generation_id: GEN_ID,
        module_type: "lease",
        docling_raw: LEASE_DOCLING_RAW,
        normalized_output: seeded,
      },
    },
  });
  const jsonResponse = (body: any, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const callStage = (stage: any) =>
    handleBoundedEnrichStage({
      supabaseAdmin,
      orgId: ORG_ID,
      fileId: FILE_ID,
      pipelineJobId: JOB_ID,
      generationId: GEN_ID,
      stage,
      jsonResponse,
    });

  const prematureReducer = await callStage("enrich_evidence_expenses_and_cam");
  assertEquals(prematureReducer.status, 422);
  assertEquals(
    (await prematureReducer.json()).error_code,
    "PRIOR_STAGE_MISSING",
  );

  const schema = getSchema("lease");
  const allSchemaEntries = Object.entries(schema).filter(([, def]) =>
    !(def as any).derived
  );
  const expectedByStage: Record<string, string[]> = {
    enrich_evidence_expenses_recoveries: getSchemaEntriesForFieldGroups(
      allSchemaEntries,
      ["expenses_recoveries"] as any,
    ).map(([key]) => key),
    enrich_evidence_cam_rules: getSchemaEntriesForFieldGroups(
      allSchemaEntries,
      ["cam_rules"] as any,
    ).map(([key]) => key),
    enrich_evidence_taxes: getSchemaEntriesForFieldGroups(
      allSchemaEntries,
      ["taxes"] as any,
    ).map(([key]) => key),
    enrich_evidence_insurance: getSchemaEntriesForFieldGroups(
      allSchemaEntries,
      ["insurance"] as any,
    ).map(([key]) => key),
    enrich_evidence_utilities: getSchemaEntriesForFieldGroups(
      allSchemaEntries,
      ["utilities"] as any,
    ).map(([key]) => key),
  };

  for (const stage of EXPENSES_AND_CAM_EVIDENCE_SUBSTAGES) {
    const response = await callStage(stage);
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.status, "completed");
    const data = readBoundedStageResults(
      supabaseAdmin.__rows.uploaded_files.normalized_output,
    )[stage].data as any[];
    assertEquals(data.map((field) => field.field_key), expectedByStage[stage]);
  }

  const reducer = await callStage("enrich_evidence_expenses_and_cam");
  assertEquals(reducer.status, 200);
  assertEquals((await reducer.json()).status, "completed");
  const reduced = readBoundedStageResults(
    supabaseAdmin.__rows.uploaded_files.normalized_output,
  ).enrich_evidence_expenses_and_cam.data as any[];
  const canonicalExpenseKeys = getSchemaEntriesForDomain(
    allSchemaEntries,
    "expenses_and_cam" as any,
  ).map(([key]) => key);
  assertEquals(reduced.map((field) => field.field_key), canonicalExpenseKeys);
});
Deno.test("enrich-bounded-stages (Phase 4.5): a domain-stage retry (same generation/version) is reused_from_cache via the new dispatch path, not recomputed", async () => {
  const seeded = seedNormalizedOutputThroughDerivation();
  const supabaseAdmin = makeMockSupabase({
    rows: {
      uploaded_files: {
        id: FILE_ID,
        org_id: ORG_ID,
        active_generation_id: GEN_ID,
        module_type: "lease",
        docling_raw: LEASE_DOCLING_RAW,
        normalized_output: seeded,
      },
    },
  });
  const call = () =>
    handleBoundedEnrichStage({
      supabaseAdmin,
      orgId: ORG_ID,
      fileId: FILE_ID,
      pipelineJobId: JOB_ID,
      generationId: GEN_ID,
      stage: "enrich_evidence_core_terms",
      jsonResponse: (body: any, status = 200) =>
        new Response(JSON.stringify(body), { status }),
    });

  const first = await (await call()).json();
  assertEquals(first.status, "completed");
  assert(!first.reused_from_cache);
  const updatesAfterFirst =
    supabaseAdmin.__updates.filter((u: any) => u.table === "uploaded_files")
      .length;
  assert(updatesAfterFirst >= 1, "the first call must persist a result");

  const second = await (await call()).json();
  assertEquals(second.reused_from_cache, true);
  const updatesAfterSecond =
    supabaseAdmin.__updates.filter((u: any) => u.table === "uploaded_files")
      .length;
  assertEquals(
    updatesAfterSecond,
    updatesAfterFirst,
    "a reused stage must not persist again",
  );
});

Deno.test("enrich-bounded-stages (Phase 4.5): a domain stage still returns PRIOR_STAGE_MISSING when enrich_derivation hasn't completed, via the new dispatch path", async () => {
  const supabaseAdmin = makeMockSupabase({
    rows: {
      uploaded_files: {
        id: FILE_ID,
        org_id: ORG_ID,
        active_generation_id: GEN_ID,
        module_type: "lease",
        docling_raw: LEASE_DOCLING_RAW,
        normalized_output: {
          rows: [LEASE_ROW],
          method: "llm_only",
          warnings: [],
          validationErrors: [],
          metadata: {},
        },
      },
    },
  });
  const response = await handleBoundedEnrichStage({
    supabaseAdmin,
    orgId: ORG_ID,
    fileId: FILE_ID,
    pipelineJobId: JOB_ID,
    generationId: GEN_ID,
    stage: "enrich_evidence_rent_and_charges",
    jsonResponse: (body: any, status = 200) =>
      new Response(JSON.stringify(body), { status }),
  });
  assertEquals(response.status, 422);
  const body = await response.json();
  assertEquals(body.error_code, "PRIOR_STAGE_MISSING");
});

Deno.test("enrich-bounded-stages (Phase 4.5): an unrecognized stage name is still rejected as UNKNOWN_BOUNDED_STAGE end to end", async () => {
  const supabaseAdmin = makeMockSupabase({
    rows: {
      uploaded_files: {
        id: FILE_ID,
        org_id: ORG_ID,
        active_generation_id: GEN_ID,
      },
    },
  });
  const response = await handleBoundedEnrichStage({
    supabaseAdmin,
    orgId: ORG_ID,
    fileId: FILE_ID,
    pipelineJobId: JOB_ID,
    generationId: GEN_ID,
    // One character off from the real "expenses_and_cam" -- the exact
    // typo danger the registry-membership dispatch check must reject.
    stage: "enrich_evidence_expense_and_cam" as any,
    jsonResponse: (body: any, status = 200) =>
      new Response(JSON.stringify(body), { status }),
  });
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error_code, "UNKNOWN_BOUNDED_STAGE");
});

Deno.test("enrich-bounded-stages (Phase 4.5): ENRICH_STAGE_SEQUENCE has no duplicate stage names", () => {
  assertEquals(
    new Set(ENRICH_STAGE_SEQUENCE).size,
    ENRICH_STAGE_SEQUENCE.length,
  );
});
