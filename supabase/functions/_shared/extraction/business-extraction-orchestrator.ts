// @ts-nocheck
/**
 * Azure Document Intelligence + OpenAI (local implementation) — business-extraction
 * orchestrator. Drop-in replacement for the direct provider-selection
 * ternary in normalize-pdf-output/index.ts — returns the SAME
 * ExtractionPipelineResult shape both providers already produce, with
 * additive metadata.provenance. Does not restructure buildReviewPayload,
 * buildLeaseWorkflowAbstraction, or persistence — those stay exactly as
 * they are, consuming whichever result this module produces.
 *
 * legacy_hybrid            -> legacy pipeline only (unchanged behavior)
 * openai_fact_ledger       -> OpenAI pipeline only (legacy vertex_fact_ledger aliases accepted;
 *                             acceptance evaluated for provenance/reporting
 *                             ONLY -- never triggers legacy fallback here)
 * openai_primary_legacy_fallback -> OpenAI once (bounded by an absolute
 *                             deadline, no outer retry loop) -> acceptance
 *                             evaluation -> controlled, one-time legacy
 *                             fallback when eligible -> whole-result
 *                             selection, never field-level blending.
 */

import { runExtractionPipeline } from "./pipeline.ts";
import { runOpenAIFactLedgerPipeline } from "./openai-fact-ledger/orchestrator.ts";
import type { ExtractionPipelineResult, DoclingOutput } from "./types.ts";
import { evaluateExtractionAcceptance } from "./business-extraction-acceptance.ts";
import { buildProvenance, attachProvenance, normalizeBusinessExtractionMode, type BusinessExtractionMode } from "./business-extraction-provenance.ts";

export type { BusinessExtractionMode } from "./business-extraction-provenance.ts";

// Round-2/3 corrections: one orchestrator-level OpenAI invocation only (no
// outer retry loop around the existing, effectively-uncancellable 32-combo
// sweep) -- bounded instead by an absolute deadline threaded into
// the OpenAI fact-ledger provider loop and per-request timeout clamp.
const OPENAI_TOTAL_BUDGET_MS = 100_000; // ~90-120s target, mid-point default
/** @deprecated Compatibility alias for old tests/imports. */
const VERTEX_TOTAL_BUDGET_MS = OPENAI_TOTAL_BUDGET_MS;

export interface MockOpenAIScenario {
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

export type MockVertexScenario = MockOpenAIScenario;

export interface RunBusinessExtractionOptions {
  requestedProvider: BusinessExtractionMode;
  moduleType: string;
  fileName: string;
  document?: DoclingOutput;
  /** @deprecated Use document. */
  docling: DoclingOutput;
  documentSubtype: string | null;
  fileBase64?: string;
  fileMimeType?: string;
  correlationId: string;
  canonicalLayoutSchemaVersion?: number | null;
  canonicalLayout?: import("./document-intelligence-v3/canonical-layout.ts").CanonicalDocumentLayout | null;
  // Test-only injection seam. Both default to the real pipelines; never
  // used outside tests / the triple-gated local mock path.
  openaiRunner?: typeof runOpenAIFactLedgerPipeline;
  vertexRunner?: typeof runOpenAIFactLedgerPipeline;
  legacyRunner?: typeof runExtractionPipeline;
  // Local-integration-test-only: when set (and already validated by the
  // caller's triple gate -- internal auth + ENABLE_LOCAL_PROVIDER_MOCKS=true
  // + localhost Supabase URL -- this module does not re-check those gates,
  // the HTTP layer does), a canned fixture is used instead of vertexRunner.
  mockOpenAIScenario?: MockOpenAIScenario["scenario"];
  /** @deprecated Use mockOpenAIScenario. */
  mockVertexScenario?: MockOpenAIScenario["scenario"];
  /** P1.4: optional extraction-provenance identity, forwarded unchanged to
   * whichever runner actually makes the OpenAI call (legacyRunner via
   * ExtractionInput.provenance). Undefined for callers without stage/run
   * provenance -- extraction behavior is identical either way. */
  provenance?: {
    supabaseAdmin: any;
    context: import("./provenance/types.ts").ProvenanceContext;
  };
}

function factLedgerDebug(debug: Record<string, unknown>): Record<string, unknown> {
  return {
    openai_fact_ledger: debug,
    /** @deprecated Compatibility mirror for existing consumers. */
    vertex_fact_ledger: debug,
  };
}

function buildMockOpenAIResult(scenario: MockOpenAIScenario["scenario"], startTime: number): ExtractionPipelineResult {
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
          extractionDebug: factLedgerDebug({ evidence_anchors: [{ category: "tenant_name", source_text: "Mock Tenant LLC", source_page: 1 }] }),
        },
      };
    case "low_evidence":
      return {
        ...base,
        rows: [{ tenant_name: "Mock Tenant LLC" }],
        method: "llm_only",
        warnings: [],
        metadata: { ...base.metadata, llmFieldsExtracted: 1, totalRecords: 1, avgConfidence: 60, extractionDebug: factLedgerDebug({ evidence_anchors: [] }) },
      };
    case "conflicting_facts":
      return {
        ...base,
        rows: [{ tenant_name: "Mock Tenant LLC" }],
        method: "llm_only",
        warnings: [],
        validationErrors: [{ field: "monthly_rent", message: "Conflicting values found: $5000 vs $5500" }],
        metadata: { ...base.metadata, llmFieldsExtracted: 1, totalRecords: 1, avgConfidence: 70, extractionDebug: factLedgerDebug({ evidence_anchors: [{ category: "tenant_name", source_text: "x", source_page: 1 }] }) },
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
        warnings: [`Mock OpenAI scenario: ${scenario}`],
        metadata: { ...base.metadata, extractionDebug: factLedgerDebug({ failure_classification: classification, failure_http_status: failureHttpStatus }) },
      };
    }
  }
}

/** @deprecated Compatibility alias for old tests. */
const buildMockVertexResult = buildMockOpenAIResult;

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
        docling: opts.document ?? opts.docling,
        ...(opts.fileBase64 ? { fileBase64: opts.fileBase64, fileMimeType: opts.fileMimeType || "application/pdf" } : {}),
        ...(opts.provenance ? { provenance: opts.provenance } : {}),
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
  const requestedProvider = normalizeBusinessExtractionMode(opts.requestedProvider);
  const document = opts.document ?? opts.docling;
  const sourceContentHash = await sha256Hex(contentForHash(document));
  const openaiRunner = opts.openaiRunner ?? opts.vertexRunner ?? runOpenAIFactLedgerPipeline;
  const legacyRunner = opts.legacyRunner ?? runExtractionPipeline;
  const mockOpenAIScenario = opts.mockOpenAIScenario ?? opts.mockVertexScenario ?? null;
  const providerMocked = mockOpenAIScenario != null;

  async function runOpenAIOnce(): Promise<ExtractionPipelineResult> {
    if (mockOpenAIScenario) {
      return buildMockOpenAIResult(mockOpenAIScenario, startTime);
    }
    return await openaiRunner(
      {
        moduleType: opts.moduleType,
        fileName: opts.fileName,
        docling: opts.document ?? opts.docling,
        documentSubtype: opts.documentSubtype,
        canonicalLayout: opts.canonicalLayout ?? null,
        ...(opts.fileBase64 ? { fileBase64: opts.fileBase64, fileMimeType: opts.fileMimeType || "application/pdf" } : {}),
      },
      {
        deadlineAt: startTime + OPENAI_TOTAL_BUDGET_MS,
        ...(opts.provenance ? { provenance: opts.provenance } : {}),
      },
    );
  }

  if (requestedProvider === "legacy_hybrid") {
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
        openaiAttemptCount: 0,
        canonicalLayoutSchemaVersion: opts.canonicalLayoutSchemaVersion,
        sourceContentHash,
        correlationId: opts.correlationId,
        providerMocked,
      }),
    );
  }

  if (requestedProvider === "openai_fact_ledger") {
    // Direct OpenAI mode: preserve existing behavior exactly -- acceptance
    // is evaluated and recorded in provenance ONLY, it never triggers
    // legacy fallback and never changes this mode's output semantics.
    const result = await runOpenAIOnce();
    const acceptance = evaluateExtractionAcceptance(result, { provider: "openai_fact_ledger", documentProfile: opts.documentSubtype });
    return attachProvenance(
      result,
      buildProvenance({
        attemptId,
        requestedProvider: "openai_fact_ledger",
        effectiveProvider: "openai_fact_ledger",
        acceptanceState: acceptance.state,
        fallbackUsed: false,
        openaiAttemptCount: 1,
        canonicalLayoutSchemaVersion: opts.canonicalLayoutSchemaVersion,
        sourceContentHash,
        correlationId: opts.correlationId,
        providerMocked,
        mockScenario: mockOpenAIScenario,
      }),
    );
  }

  // openai_primary_legacy_fallback
  const openaiResult = await runOpenAIOnce();
  const openaiAcceptance = evaluateExtractionAcceptance(openaiResult, { provider: "openai_fact_ledger", documentProfile: opts.documentSubtype });

  if (openaiAcceptance.state === "accepted" || openaiAcceptance.state === "accepted_needs_review") {
    return attachProvenance(
      openaiResult,
      buildProvenance({
        attemptId,
        requestedProvider: "openai_primary_legacy_fallback",
        effectiveProvider: "openai_fact_ledger",
        acceptanceState: openaiAcceptance.state,
        fallbackUsed: false,
        openaiAttemptCount: 1,
        canonicalLayoutSchemaVersion: opts.canonicalLayoutSchemaVersion,
        sourceContentHash,
        correlationId: opts.correlationId,
        providerMocked,
        mockScenario: mockOpenAIScenario,
      }),
    );
  }

  if (openaiAcceptance.state === "rejected") {
    // Non-fallback-eligible failure (e.g. auth_error) -- explicit failure,
    // never silently degrade to legacy for a configuration defect.
    return attachProvenance(
      openaiResult,
      buildProvenance({
        attemptId,
        requestedProvider: "openai_primary_legacy_fallback",
        effectiveProvider: "openai_fact_ledger",
        acceptanceState: "extraction_failed_manual_review",
        fallbackUsed: false,
        fallbackReason: openaiAcceptance.reason,
        openaiAttemptCount: 1,
        canonicalLayoutSchemaVersion: opts.canonicalLayoutSchemaVersion,
        sourceContentHash,
        correlationId: opts.correlationId,
        providerMocked,
        mockScenario: mockOpenAIScenario,
      }),
    );
  }

  // fallback_eligible -- run legacy exactly once. No recursion: if legacy
  // also fails, that is terminal, never re-attempts OpenAI.
  const legacyResult = await runLegacySafely(legacyRunner, opts);
  const legacyAcceptance = evaluateExtractionAcceptance(legacyResult, { provider: "legacy_hybrid", documentProfile: opts.documentSubtype });

  if (legacyAcceptance.state === "accepted" || legacyAcceptance.state === "accepted_needs_review") {
    return attachProvenance(
      legacyResult,
      buildProvenance({
        attemptId,
        requestedProvider: "openai_primary_legacy_fallback",
        effectiveProvider: "legacy_hybrid",
        acceptanceState: legacyAcceptance.state,
        fallbackUsed: true,
        fallbackReason: openaiAcceptance.reason,
        openaiAttemptCount: 1,
        canonicalLayoutSchemaVersion: opts.canonicalLayoutSchemaVersion,
        sourceContentHash,
        correlationId: opts.correlationId,
        providerMocked,
        mockScenario: mockOpenAIScenario,
      }),
    );
  }

  // Both rejected -- explicit extraction_failed_manual_review, never a
  // review-ready payload built from an empty/invalid result.
  return attachProvenance(
    legacyResult,
    buildProvenance({
      attemptId,
      requestedProvider: "openai_primary_legacy_fallback",
      effectiveProvider: "legacy_hybrid",
      acceptanceState: "extraction_failed_manual_review",
      fallbackUsed: true,
      fallbackReason: `openai:${openaiAcceptance.reason};legacy:${legacyAcceptance.reason}`,
      openaiAttemptCount: 1,
      canonicalLayoutSchemaVersion: opts.canonicalLayoutSchemaVersion,
      sourceContentHash,
      correlationId: opts.correlationId,
      providerMocked,
      mockScenario: mockOpenAIScenario,
    }),
  );
}

// Test hook.
export const __test__ = {
  buildMockOpenAIResult,
  buildMockVertexResult,
  runLegacySafely,
  OPENAI_TOTAL_BUDGET_MS,
  VERTEX_TOTAL_BUDGET_MS,
  contentForHash,
};
