// @ts-nocheck
/**
 * OpenAI Fact Ledger — Fact Extraction
 *
 * Default path is TEXT-MODE: chunked via chunker.ts's existing chunkDocument()
 * (capped at 4 chunks/calls) against docIndex.doclingRaw, using callLLMJSON().
 *
 * File-mode inline-PDF is deprecated; Azure Document Intelligence handles parsing. The old file-mode flag is still accepted as an alias
 * for OPENAI_FACT_LEDGER_FILE_MODE (default false/unset) — mirrors the
 * NORMALIZE_INLINE_ENRICHMENT opt-in-flag convention already used in this
 * codebase. Per guardrail, OpenAI file-mode PDF extraction must never be the
 * default.
 *
 * Facts are grouped using the same 34-category clause vocabulary
 * CLAUSE_DEFINITIONS (lease-workflow.ts) already uses, as "clause:<type>".
 * A fact with no real source_text is dropped — facts must be grounded.
 * Dedup via evidence-index.ts's existing normalizeForPageMatch().
 */

import { callLLMJSON, LLMProviderError } from "../../llm.ts";
import { callLLMJSONWithProvenance } from "../provenance/transport/openai.ts";

import { chunkDocument } from "../chunker.ts";
import { normalizeForPageMatch, resolveVerifiedSourcePage } from "../evidence-index.ts";
import { CLAUSE_DEFINITIONS } from "../lease-workflow.ts";
import type { ModuleType } from "../types.ts";
import type { CanonicalDocumentIndex, DocumentProfileClassification, Fact, FactLedgerResult } from "./types.ts";

type OpenAIFailureClassification = string;

const MAX_CHUNKS = 4;
const CLAUSE_CATEGORY_VOCAB: string[] = CLAUSE_DEFINITIONS.map((def: any) => def.type);

function envFlagEnabled(name: string): boolean {
  try {
    return String(Deno.env.get(name) || "").toLowerCase() === "true";
  } catch {
    return false;
  }
}

function buildSystemPrompt(moduleType: ModuleType): string {
  return `You are a commercial real estate (${moduleType}) fact extraction tool.
Extract every discrete, verifiable FACT stated in the provided document text.

A fact is one atomic assertion — a party name, a date, a dollar amount, a percentage,
a defined term, an obligation, or a clause provision — grounded in EXACT verbatim
source text from the document.

Output ONLY a valid JSON object of this exact shape (this call is made with the
API's json_object response mode, which requires a top-level object, never a
bare array):
  { "facts": [ { "category": "<clause category>", "value": <extracted value>, "source_text": "<exact verbatim phrase>", "source_page": <page number or null>, "confidence": <0.0-1.0> } ] }
If there are no facts to report, return { "facts": [] } — never omit the "facts" key.

The "category" MUST be one of these clause categories, prefixed with "clause:":
${CLAUSE_CATEGORY_VOCAB.map((c) => `clause:${c}`).join(", ")}
Pick the closest matching category for each fact. If nothing fits, use "clause:default".

RULES:
1. source_text MUST be the exact verbatim text from the document — never paraphrase.
2. If you cannot provide exact source_text for a fact, DO NOT include it.
3. NEVER guess, infer, or calculate values not explicitly stated.
4. Extract as many distinct facts as the text supports, not just a summary.`;
}

function isRealSourceText(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text || text.length < 3) return false;
  if (/^(llm extracted|extracted|manual_review|unknown|n\/?a|null)$/i.test(text)) return false;
  return true;
}

function coerceCategory(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  const type = raw.startsWith("clause:") ? raw.slice("clause:".length) : raw;
  return CLAUSE_CATEGORY_VOCAB.includes(type) ? `clause:${type}` : "clause:default";
}

function parseFactsResponse(raw: unknown): Fact[] {
  const arr = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.facts) ? (raw as any).facts : [];
  const facts: Fact[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const sourceText = (entry as any).source_text ?? (entry as any).sourceText;
    if (!isRealSourceText(sourceText)) continue;
    const value = (entry as any).value;
    if (value == null || value === "") continue;
    const confidence = Number((entry as any).confidence);
    facts.push({
      category: coerceCategory((entry as any).category),
      value,
      sourceText: String(sourceText).trim(),
      sourcePage: Number.isFinite(Number((entry as any).source_page ?? (entry as any).sourcePage))
        ? Number((entry as any).source_page ?? (entry as any).sourcePage)
        : null,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.6,
    });
  }
  return facts;
}

function dedupeFacts(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  const result: Fact[] = [];
  for (const fact of facts) {
    const key = `${fact.category}|${normalizeForPageMatch(fact.sourceText)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  return result;
}

interface ChunkExtractionResult {
  facts: Fact[];
  warning: string | null;
  classification?: string;
  httpStatus?: number;
  providerErrorCode?: string;
  requestId?: string;
  requestUrl?: string;
}


async function extractFromChunk(
  chunkText: string,
  moduleType: ModuleType,
  _deadlineAt?: number,
  provenance?: { supabaseAdmin: any; context: import("../provenance/types.ts").ProvenanceContext },
  chunkIndex?: number,
): Promise<ChunkExtractionResult> {
  try {
    const callOpts = {
      systemPrompt: buildSystemPrompt(moduleType),
      userPrompt: chunkText,
      temperature: 0,
    };
    const response = provenance
      ? await callLLMJSONWithProvenance(
        provenance.supabaseAdmin,
        { ...provenance.context, operation: "openai_fact_ledger_chunk", chunkIndex },
        callOpts,
      )
      : await callLLMJSON(callOpts);
    if (response.data == null) {
      return {
        facts: [],
        warning: "Fact ledger extraction returned no parseable JSON for one chunk",
        classification: "malformed_response",
      };
    }
    const facts = parseFactsResponse(response.data);
    if (facts.length === 0) {
      return { facts, warning: null, classification: "empty_extraction" };
    }
    return { facts, warning: null };
  } catch (error) {
    const classification = error instanceof LLMProviderError ? error.classification : "unknown";
    const httpStatus = error instanceof LLMProviderError ? error.httpStatus : undefined;
    const providerErrorCode = error instanceof LLMProviderError ? error.providerErrorCode : undefined;
    const requestId = error instanceof LLMProviderError ? error.requestId : undefined;
    const requestUrl = error instanceof LLMProviderError ? error.requestUrl : undefined;
    return {
      facts: [],
      warning: `Fact ledger extraction failed for one chunk: ${(error as Error)?.message ?? error}`,
      classification,
      httpStatus,
      providerErrorCode,
      requestId,
      requestUrl,
    };
  }
}

// File-mode is deprecated — Azure Document Intelligence handles parsing.
// This function is kept as a no-op stub so the orchestrator call site compiles.
async function extractFromFile(
  _fileBase64: string,
  _fileMimeType: string,
  _moduleType: ModuleType,
  _deadlineAt?: number,
): Promise<ChunkExtractionResult> {
  console.warn("[fact-ledger] extractFromFile: file-mode is deprecated. Azure Document Intelligence handles parsing.");
  return {
    facts: [],
    warning: "File-mode fact extraction is deprecated. Use text-mode chunking via Azure Document Intelligence output.",
    classification: "unknown",
  };
}


// Round-3 correction: fixed priority order for picking the DOMINANT failure
// classification across multiple chunks -- authentication always wins (a bad
// credential must never be masked by an unrelated chunk's timeout), then
// roughly most-to-least "this run is unlikely to succeed on retry".
//
// These values must match the LLMFailureClassification strings llm.ts's
// classifyOpenAIError() actually emits ("authentication", "rate_limit",
// "provider_server_error", "transport", "timeout", "unknown") plus the two
// classifications this module sets itself ("malformed_response",
// "empty_extraction"). A prior version of this list used "auth_error" /
// "rate_limited" / "server_error" / "network_error", which never matched any
// real classification llm.ts produces -- every LLM-provider failure fell
// through to the "unknown"-shaped branch in business-extraction-acceptance.ts
// instead of being recognized as an auth failure or a fallback-eligible one.
const CLASSIFICATION_PRIORITY: OpenAIFailureClassification[] = [
  "authentication",
  "rate_limit",
  "provider_server_error",
  "model_unavailable" as OpenAIFailureClassification,
  "transport",
  "budget_exhausted",
  "malformed_response",
  "empty_extraction" as OpenAIFailureClassification,
  "timeout",
  "unknown",
];

function dominantClassification(classifications: Array<OpenAIFailureClassification | undefined>): OpenAIFailureClassification | undefined {
  const present = classifications.filter((c): c is OpenAIFailureClassification => !!c);
  if (present.length === 0) return undefined;
  for (const candidate of CLASSIFICATION_PRIORITY) {
    if (present.includes(candidate)) return candidate;
  }
  return present[0];
}

/**
 * Extract the fact ledger for a document. Text-mode by default; file-mode
 * only when OPENAI_FACT_LEDGER_FILE_MODE=true, or the legacy VERTEX_FACT_LEDGER_FILE_MODE=true alias, AND fileBase64 is provided.
 */
export async function extractFactLedger(args: {
  docIndex: CanonicalDocumentIndex;
  profile: DocumentProfileClassification;
  moduleType: ModuleType;
  fileBase64?: string | null;
  fileMimeType?: string | null;
  /** Explicit override for the VERTEX_FACT_LEDGER_FILE_MODE env flag — used
   *  by tests and by the orchestrator's OpenAIFactLedgerOptions.fileMode.
   *  Undefined defers to the env flag (default false). */
  fileModeOverride?: boolean;
  /** Absolute epoch-ms deadline forwarded to every OpenAI call this
   *  extraction makes. See OpenAI request deadline handling. */
  deadlineAt?: number;
  /** See OpenAIFactLedgerOptions.provenance. */
  provenance?: { supabaseAdmin: any; context: import("../provenance/types.ts").ProvenanceContext };
}): Promise<FactLedgerResult> {
  const { docIndex, moduleType, fileBase64, fileMimeType, fileModeOverride, deadlineAt, provenance } = args;
  const warnings: string[] = [];

  const fileModeEnabled = fileModeOverride ?? (envFlagEnabled("OPENAI_FACT_LEDGER_FILE_MODE") || envFlagEnabled("VERTEX_FACT_LEDGER_FILE_MODE"));
  if (fileModeEnabled && fileBase64 && fileMimeType) {
    const result = await extractFromFile(fileBase64, fileMimeType, moduleType, deadlineAt);
    if (result.warning) warnings.push(result.warning);
    const grounded = dedupeFacts(result.facts).map((fact) => ({
      ...fact,
      sourcePage: resolveVerifiedSourcePage(docIndex.doclingRaw as Record<string, unknown>, fact.sourceText, fact.sourcePage),
    }));
    // Single "chunk" (the whole file) — dominant-classification logic still
    // applies: only surface a classification when nothing usable came out.
    return {
      facts: grounded,
      warnings,
      chunksProcessed: 1,
      ...(grounded.length === 0
        ? {
          failureClassification: result.classification,
          failureHttpStatus: result.httpStatus,
          failureProviderErrorCode: result.providerErrorCode,
          failureRequestId: result.requestId,
          failureRequestUrl: result.requestUrl,
        }
        : {}),
    };
  }

  if (!docIndex.fullText || docIndex.fullText.trim().length < 10) {
    return { facts: [], warnings: ["Document text is too short for fact ledger extraction"], chunksProcessed: 0 };
  }

  const chunks = chunkDocument(docIndex.doclingRaw as any).slice(0, MAX_CHUNKS);
  const allFacts: Fact[] = [];
  let chunksProcessed = 0;
  let successfulChunkCount = 0;
  let failedChunkCount = 0;
  const chunkClassifications: Array<OpenAIFailureClassification | undefined> = [];
  let lastHttpStatus: number | undefined;
  let lastProviderErrorCode: string | undefined;
  let lastRequestId: string | undefined;
  let lastRequestUrl: string | undefined;

  // Chunks are independent OpenAI calls -- run them concurrently, not one
  // after another. Serial execution made this stage's wall-clock time grow
  // with MAX_CHUNKS (up to 4 x up to 120s each = up to 480s), which routinely
  // exceeded both this worker's own NORMALIZE_TIMEOUT_MS and the platform's
  // 150s Edge Function hard wall (see ingest-file/index.ts's callEdgeFunction
  // doc comment) -- the invocation got hard-killed by the platform mid-await,
  // silently, before any of this module's own timeout/error handling ever
  // ran. Concurrent execution bounds normalize's realistic wall-clock time by
  // the SLOWEST single chunk instead of their sum.
  const chunkResults = await Promise.all(
    chunks.map((chunk, index) => extractFromChunk(chunk.text, moduleType, deadlineAt, provenance, index)),
  );

  chunks.forEach((chunk, index) => {
    const result = chunkResults[index];
    if (result.warning) warnings.push(result.warning);
    chunksProcessed += 1;
    if (result.facts.length > 0) {
      successfulChunkCount += 1;
    } else {
      failedChunkCount += 1;
      chunkClassifications.push(result.classification);
      if (result.httpStatus != null) lastHttpStatus = result.httpStatus;
      if (result.providerErrorCode != null) lastProviderErrorCode = result.providerErrorCode;
      if (result.requestId != null) lastRequestId = result.requestId;
      if (result.requestUrl != null) lastRequestUrl = result.requestUrl;
    }
    for (const fact of result.facts) {
      allFacts.push({
        ...fact,
        sourcePage: fact.sourcePage ?? resolveVerifiedSourcePage(
          docIndex.doclingRaw as Record<string, unknown>,
          fact.sourceText,
          chunk.startPage ?? null,
        ),
      });
    }
  });

  const dedupedFacts = dedupeFacts(allFacts);
  // Round-3 correction (item 1): some chunks failing while meaningful facts
  // remain overall must NOT surface a failure classification -- that would
  // let the business-extraction acceptance layer treat a partially-degraded
  // but genuinely usable extraction as fallback-eligible. A classification
  // is only ever surfaced when the WHOLE document produced nothing usable.
  const overallFailed = dedupedFacts.length === 0 && failedChunkCount > 0;

  return {
    facts: dedupedFacts,
    warnings,
    chunksProcessed,
    ...(overallFailed
      ? {
        failureClassification: dominantClassification(chunkClassifications),
        failureHttpStatus: lastHttpStatus,
        failureProviderErrorCode: lastProviderErrorCode,
        failureRequestId: lastRequestId,
        failureRequestUrl: lastRequestUrl,
      }
      : {}),
  };
}

// Test hook (same pattern as other _shared/extraction modules).
export const __test__ = {
  dominantClassification,
  CLASSIFICATION_PRIORITY,
};
