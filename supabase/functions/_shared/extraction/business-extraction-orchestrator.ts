// @ts-nocheck
/**
 * Azure + Vertex Phase 4E (local implementation) — business-extraction
 * orchestrator. Drop-in replacement for the direct provider-selection
 * ternary in normalize-pdf-output/index.ts — returns the SAME
 * ExtractionPipelineResult shape both providers already produce, with
 * additive metadata.provenance. Does not restructure buildReviewPayload,
 * buildLeaseWorkflowAbstraction, or persistence — those stay exactly as
 * they are, consuming whichever result this module produces.
 *
 * legacy_hybrid            -> legacy pipeline only (unchanged behavior)
 * vertex_fact_ledger       -> Vertex pipeline only (unchanged behavior;
 *                             acceptance evaluated for provenance/reporting
 *                             ONLY -- never triggers legacy fallback here)
 * vertex_primary_legacy_fallback -> Vertex once (bounded by an absolute
 *                             deadline, no outer retry loop) -> acceptance
 *                             evaluation -> controlled, one-time legacy
 *                             fallback when eligible -> whole-result
 *                             selection, never field-level blending.
 */

import { runExtractionPipeline } from "./pipeline.ts";
import { runVertexFactLedgerPipeline } from "./vertex-fact-ledger/orchestrator.ts";
import type { ExtractionPipelineResult, DoclingOutput } from "./types.ts";
import { evaluateExtractionAcceptance } from "./business-extraction-acceptance.ts";
import { buildProvenance, attachProvenance, type BusinessExtractionMode } from "./business-extraction-provenance.ts";

export type { BusinessExtractionMode } from "./business-extraction-provenance.ts";

// Round-2/3 corrections: one orchestrator-level Vertex invocation only (no
// outer retry loop around the existing, effectively-uncancellable 32-combo
// sweep) -- bounded instead by an absolute deadline threaded into
// callVertexAI's own combo loop and per-request timeout clamp.
const VERTEX_TOTAL_BUDGET_MS = 100_000; // ~90-120s target, mid-point default

export interface MockVertexScenario {
  scenario:
    | "success"
    | "timeout"
    | "rate_limited"
    | "server_error"
    | "malformed_response"
    | "empty_extraction"
    | "auth_error"
    | "low_evidence"
    | "conflicting_facts";
}

export interface RunBusinessExtractionOptions {
  requestedProvider: BusinessExtractionMode;
  moduleType: string;
  fileName: string;
  docling: DoclingOutput;
  documentSubtype: string | null;
  fileBase64?: string;
  fileMimeType?: string;
  correlationId: string;
  canonicalLayoutSchemaVersion?: number | null;
  // Test-only injection seam. Both default to the real pipelines; never
  // used outside tests / the triple-gated local mock path.
  vertexRunner?: typeof runVertexFactLedgerPipeline;
  legacyRunner?: typeof runExtractionPipeline;
  // Local-integration-test-only: when set (and already validated by the
  // caller's triple gate -- internal auth + ENABLE_LOCAL_PROVIDER_MOCKS=true
  // + localhost Supabase URL -- this module does not re-check those gates,
  // the HTTP layer does), a canned fixture is used instead of vertexRunner.
  mockVertexScenario?: MockVertexScenario["scenario"];
}

function buildMockVertexResult(scenario: MockVertexScenario["scenario"], startTime: number): ExtractionPipelineResult {
  const base = {
    validationErrors: [] as unknown[],
    metadata: {
      ruleFieldsExtracted: 0,
      tableFieldsExtracted: 0,
      llmFieldsExtracted: 0,
      totalRecords: 0,
      avgConfidence: 0,
      chunksProcessed: 1,
      processingTimeMs: Date.now() - startTime,
      extractionDebug: {} as Record<string, unknown>,
    },
  };
  switch (scenario) {
    case "success":
      return {
        ...base,
        rows: [{ tenant_name: "Mock Tenant LLC", monthly_rent: 5000 }],
        method: "llm_only",
        warnings: [],
        metadata: {
          ...base.metadata,
          llmFieldsExtracted: 2,
          totalRecords: 1,
          avgConfidence: 90,
          extractionDebug: { vertex_fact_ledger: { evidence_anchors: [{ category: "tenant_name", source_text: "Mock Tenant LLC", source_page: 1 }] } },
        },
      };
    case "low_evidence":
      return {
        ...base,
        rows: [{ tenant_name: "Mock Tenant LLC" }],
        method: "llm_only",
        warnings: [],
        metadata: { ...base.metadata, llmFieldsExtracted: 1, totalRecords: 1, avgConfidence: 60, extractionDebug: { vertex_fact_ledger: { evidence_anchors: [] } } },
      };
    case "conflicting_facts":
      return {
        ...base,
        rows: [{ tenant_name: "Mock Tenant LLC" }],
        method: "llm_only",
        warnings: [],
        validationErrors: [{ field: "monthly_rent", message: "Conflicting values found: $5000 vs $5500" }],
        metadata: { ...base.metadata, llmFieldsExtracted: 1, totalRecords: 1, avgConfidence: 70, extractionDebug: { vertex_fact_ledger: { evidence_anchors: [{ category: "tenant_name", source_text: "x", source_page: 1 }] } } },
      };
    case "timeout":
    case "rate_limited":
    case "server_error":
    case "malformed_response":
    case "empty_extraction":
    case "auth_error":
    default: {
      const classification = scenario === "auth_error" ? "auth_error" : scenario;
      const failureHttpStatus =
        scenario === "rate_limited" ? 429
          : scenario === "server_error" ? 500
          : null;
      return {
        ...base,
        rows: [],
        method: "fallback",
        warnings: [`Mock Vertex scenario: ${scenario}`],
        metadata: { ...base.metadata, extractionDebug: { vertex_fact_ledger: { failure_classification: classification, failure_http_status: failureHttpStatus } } },
      };
    }
  }
}

async function runLegacySafely(
  legacyRunner: typeof runExtractionPipeline,
  opts: RunBusinessExtractionOptions,
): Promise<ExtractionPipelineResult> {
  // runExtractionPipeline() has NO blanket try/catch of its own (confirmed:
  // zero `try {` in pipeline.ts) -- only its imported LLM sub-step is
  // internally defensive. The orchestrator must guard this call itself.
  try {
    return await legacyRunner(
      {
        moduleType: opts.moduleType,
        fileName: opts.fileName,
        docling: opts.docling,
        ...(opts.fileBase64 ? { fileBase64: opts.fileBase64, fileMimeType: opts.fileMimeType || "application/pdf" } : {}),
      },
      { maxLLMChunks: 50, chunkSize: 3000, llmTemperature: 0 },
    );
  } catch (error) {
    return {
      rows: [],
      method: "fallback",
      warnings: [`Legacy extraction pipeline threw: ${(error as Error)?.message ?? error}`],
      validationErrors: [],
      metadata: {
        ruleFieldsExtracted: 0,
        tableFieldsExtracted: 0,
        llmFieldsExtracted: 0,
        totalRecords: 0,
        avgConfidence: 0,
        chunksProcessed: 0,
        processingTimeMs: 0,
      },
    };
  }
}

function contentForHash(docling: DoclingOutput): string {
  const fullText = String((docling as any)?.full_text ?? "").trim();
  if (fullText) return fullText;
  const blockText = Array.isArray((docling as any)?.text_blocks)
    ? (docling as any).text_blocks.map((block: any) => String(block?.text ?? "")).join("\n")
    : "";
  if (blockText.trim()) return blockText;
  return JSON.stringify({
    page_count: (docling as any)?.page_count ?? null,
    fields: (docling as any)?.fields ?? [],
    tables: (docling as any)?.tables ?? [],
  });
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function runBusinessExtraction(opts: RunBusinessExtractionOptions): Promise<ExtractionPipelineResult> {
  const startTime = Date.now();
  const attemptId = `${opts.correlationId}:${startTime}`;
  const sourceContentHash = await sha256Hex(contentForHash(opts.docling));
  const vertexRunner = opts.vertexRunner ?? runVertexFactLedgerPipeline;
  const legacyRunner = opts.legacyRunner ?? runExtractionPipeline;
  const providerMocked = opts.mockVertexScenario != null;

  async function runVertexOnce(): Promise<ExtractionPipelineResult> {
    if (opts.mockVertexScenario) {
      return buildMockVertexResult(opts.mockVertexScenario, startTime);
    }
    return await vertexRunner(
      {
        moduleType: opts.moduleType,
        fileName: opts.fileName,
        docling: opts.docling,
        documentSubtype: opts.documentSubtype,
        ...(opts.fileBase64 ? { fileBase64: opts.fileBase64, fileMimeType: opts.fileMimeType || "application/pdf" } : {}),
      },
      { deadlineAt: startTime + VERTEX_TOTAL_BUDGET_MS },
    );
  }

  if (opts.requestedProvider === "legacy_hybrid") {
    const result = await runLegacySafely(legacyRunner, opts);
    const acceptance = evaluateExtractionAcceptance(result, { provider: "legacy_hybrid", documentProfile: opts.documentSubtype });
    return attachProvenance(
      result,
      buildProvenance({
        attemptId,
        requestedProvider: "legacy_hybrid",
        effectiveProvider: "legacy_hybrid",
        acceptanceState: acceptance.state,
        fallbackUsed: false,
        vertexAttemptCount: 0,
        canonicalLayoutSchemaVersion: opts.canonicalLayoutSchemaVersion,
        sourceContentHash,
        correlationId: opts.correlationId,
        providerMocked,
      }),
    );
  }

  if (opts.requestedProvider === "vertex_fact_ledger") {
    // Direct Vertex mode: preserve existing behavior exactly -- acceptance
    // is evaluated and recorded in provenance ONLY, it never triggers
    // legacy fallback and never changes this mode's output semantics.
    const result = await runVertexOnce();
    const acceptance = evaluateExtractionAcceptance(result, { provider: "vertex_fact_ledger", documentProfile: opts.documentSubtype });
    return attachProvenance(
      result,
      buildProvenance({
        attemptId,
        requestedProvider: "vertex_fact_ledger",
        effectiveProvider: "vertex_fact_ledger",
        acceptanceState: acceptance.state,
        fallbackUsed: false,
        vertexAttemptCount: 1,
        canonicalLayoutSchemaVersion: opts.canonicalLayoutSchemaVersion,
        sourceContentHash,
        correlationId: opts.correlationId,
        providerMocked,
        mockScenario: opts.mockVertexScenario ?? null,
      }),
    );
  }

  // vertex_primary_legacy_fallback
  const vertexResult = await runVertexOnce();
  const vertexAcceptance = evaluateExtractionAcceptance(vertexResult, { provider: "vertex_fact_ledger", documentProfile: opts.documentSubtype });

  if (vertexAcceptance.state === "accepted" || vertexAcceptance.state === "accepted_needs_review") {
    return attachProvenance(
      vertexResult,
      buildProvenance({
        attemptId,
        requestedProvider: "vertex_primary_legacy_fallback",
        effectiveProvider: "vertex_fact_ledger",
        acceptanceState: vertexAcceptance.state,
        fallbackUsed: false,
        vertexAttemptCount: 1,
        canonicalLayoutSchemaVersion: opts.canonicalLayoutSchemaVersion,
        sourceContentHash,
        correlationId: opts.correlationId,
        providerMocked,
        mockScenario: opts.mockVertexScenario ?? null,
      }),
    );
  }

  if (vertexAcceptance.state === "rejected") {
    // Non-fallback-eligible failure (e.g. auth_error) -- explicit failure,
    // never silently degrade to legacy for a configuration defect.
    return attachProvenance(
      vertexResult,
      buildProvenance({
        attemptId,
        requestedProvider: "vertex_primary_legacy_fallback",
        effectiveProvider: "vertex_fact_ledger",
        acceptanceState: "extraction_failed_manual_review",
        fallbackUsed: false,
        fallbackReason: vertexAcceptance.reason,
        vertexAttemptCount: 1,
        canonicalLayoutSchemaVersion: opts.canonicalLayoutSchemaVersion,
        sourceContentHash,
        correlationId: opts.correlationId,
        providerMocked,
        mockScenario: opts.mockVertexScenario ?? null,
      }),
    );
  }

  // fallback_eligible -- run legacy exactly once. No recursion: if legacy
  // also fails, that is terminal, never re-attempts Vertex.
  const legacyResult = await runLegacySafely(legacyRunner, opts);
  const legacyAcceptance = evaluateExtractionAcceptance(legacyResult, { provider: "legacy_hybrid", documentProfile: opts.documentSubtype });

  if (legacyAcceptance.state === "accepted" || legacyAcceptance.state === "accepted_needs_review") {
    return attachProvenance(
      legacyResult,
      buildProvenance({
        attemptId,
        requestedProvider: "vertex_primary_legacy_fallback",
        effectiveProvider: "legacy_hybrid",
        acceptanceState: legacyAcceptance.state,
        fallbackUsed: true,
        fallbackReason: vertexAcceptance.reason,
        vertexAttemptCount: 1,
        canonicalLayoutSchemaVersion: opts.canonicalLayoutSchemaVersion,
        sourceContentHash,
        correlationId: opts.correlationId,
        providerMocked,
        mockScenario: opts.mockVertexScenario ?? null,
      }),
    );
  }

  // Both rejected -- explicit extraction_failed_manual_review, never a
  // review-ready payload built from an empty/invalid result.
  return attachProvenance(
    legacyResult,
    buildProvenance({
      attemptId,
      requestedProvider: "vertex_primary_legacy_fallback",
      effectiveProvider: "legacy_hybrid",
      acceptanceState: "extraction_failed_manual_review",
      fallbackUsed: true,
      fallbackReason: `vertex:${vertexAcceptance.reason};legacy:${legacyAcceptance.reason}`,
      vertexAttemptCount: 1,
      canonicalLayoutSchemaVersion: opts.canonicalLayoutSchemaVersion,
      sourceContentHash,
      correlationId: opts.correlationId,
      providerMocked,
      mockScenario: opts.mockVertexScenario ?? null,
    }),
  );
}

// Test hook.
export const __test__ = {
  buildMockVertexResult,
  runLegacySafely,
  VERTEX_TOTAL_BUDGET_MS,
  contentForHash,
};
