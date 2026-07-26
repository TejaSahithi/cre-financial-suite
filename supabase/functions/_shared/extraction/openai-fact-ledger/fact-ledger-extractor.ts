// @ts-nocheck
/**
 * OpenAI Fact Ledger — Fact Extraction
 *
 * Default path is TEXT-MODE: chunked via chunker.ts's existing chunkDocument()
 * against docIndex.doclingRaw, using callLLMJSON().
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

const CLAUSE_CATEGORY_VOCAB: string[] = CLAUSE_DEFINITIONS.map((def: any) => def.type);

function envFlagEnabled(name: string): boolean {
  try {
    return String(Deno.env.get(name) || "").toLowerCase() === "true";
  } catch {
    return false;
  }
}

function envOptionalPositiveInt(name: string): number | null {
  try {
    const parsed = Number(Deno.env.get(name));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
  } catch {
    return null;
  }
}

function buildSystemPrompt(moduleType: ModuleType): string {
  return `You are a commercial real estate (${moduleType}) fact extraction tool.
Extract every discrete, verifiable FACT stated in the provided document text.

A fact is one atomic assertion — a party name, a date, a dollar amount, a percentage,
a defined term, an obligation, or a clause provision — grounded in EXACT verbatim
source text from the document.

"value" and "source_text" serve DIFFERENT purposes and must NOT be the same run-on
sentence:
  - "value" is the SHORT, ATOMIC answer only — just the entity name, just the date,
    just the dollar figure, just the defined term. Never a full sentence. Never a
    clause fragment. Never boilerplate surrounding the answer.
    Good: "224 Partners, LLC"   Bad: "is made January 9, 2024 by and between 224 Partners, LLC"
    Good: "February 1, 2024"    Bad: "commencing with the Commencement Date, without regard to calendar years"
  - "source_text" is the grounding quote proving where "value" came from — a
    COMPLETE sentence, a complete table row, OR a single "Label: value" line,
    copied verbatim, start to end. Never start or end mid-sentence/mid-clause;
    if the fact comes from a row in a label/value summary table (or a labeled
    line in prose), quote the full row/line ("Landlord: 224 Partners, LLC"), not
    an unrelated adjacent sentence. A short labeled line or table row is
    first-class evidence on its own — it does not need to be embedded in a
    longer sentence.

PRIORITIZE structured label/value sections (e.g. a "Summary of Basic Lease
Information" block, a defined-terms table, an exhibit summary) as the single most
reliable source for core facts — party names, addresses, dates, rent, square
footage, security deposit, permitted use. When the same fact also appears restated
in body-text prose elsewhere in the document, still extract it from the summary
table first; only fall back to prose when no summary/table entry exists for it.

RENT FIGURES — MONTHLY vs. ANNUAL: leases frequently state both together in one
sentence (e.g. "the annual amount of $25,200, payable in monthly installments of
$2,100"). When this happens, extract this as TWO separate facts (both may cite the
same source_text sentence, since it proves both values): one fact with value = the
per-month figure only, one fact with value = the per-year figure only. Never let
the annual figure be recorded as a monthly value or vice versa — "per month" /
"monthly" / "per year" / "annually" / "annual" is often the only word that
distinguishes them; read it carefully. If a stepped rent schedule (multiple rows
for different periods) is shown, extract EVERY distinct non-free-rent row as ITS
OWN separate fact (do not collapse them into one row yourself) — each fact's
source_text must be that row's full text (period label + amount), so a reviewer
can see which period it covers. Skip $0/free-rent rows entirely (do not emit a
fact for them here). For confidence: give a row HIGHER confidence (0.85-0.95)
only when it is clearly the initial/regular term (e.g. explicitly labeled
"Initial Term", "Lease Year 1", "Months 1-X", or is the first non-free-rent row
under a plain "Base Rent Schedule" heading with no renewal/amendment/option/
additional-space language). Give a row LOWER confidence (0.4-0.6) if it is a
partial-month/stub period, or is labeled as a renewal, option, extension,
amendment, or additional-space rent — these are real facts worth capturing, but
must not outrank a genuine initial-term row. Do not artificially force one row
to a high confidence just to produce a single answer — if you cannot tell which
row is authoritative, give the competing rows similar (not artificially
separated) confidence and let each stand as its own fact; do not silently drop
any of them. If only ONE of monthly/annual is stated anywhere in the document,
extract only that one fact — never calculate or infer the other; the pipeline
derives it deterministically downstream.

LEASE TERM DATES — START vs. END: leases frequently state the term as one compound
sentence (e.g. "The lease term shall be from March 1, 2019 through December 31,
2023" or "...for an initial period from [DATE] to [DATE]"). Extract this as TWO
separate facts (both may cite the same source_text sentence): one fact with value =
the earlier/start/commencement date only, one fact with value = the later/end/
expiration date only. Do not merge them into one fact and do not omit either one
merely because the sentence doesn't use the words "commencement" or "expiration" —
"from X through Y" / "from X to Y" / "beginning X and ending Y" all describe a
start date and an end date just as much as an explicitly labeled "Commencement
Date:" / "Expiration Date:" line does.

Output ONLY a valid JSON object of this exact shape (this call is made with the
API's json_object response mode, which requires a top-level object, never a
bare array):
  { "facts": [ { "category": "<clause category>", "value": <extracted value>, "source_text": "<exact verbatim phrase>", "source_page": <page number or null>, "confidence": <0.0-1.0> } ] }
If there are no facts to report, return { "facts": [] } — never omit the "facts" key.

The "category" MUST be one of these clause categories, prefixed with "clause:":
${CLAUSE_CATEGORY_VOCAB.map((c) => `clause:${c}`).join(", ")}
Pick the closest matching category for each fact. If nothing fits, use "clause:default".

RULES:
1. source_text MUST be the exact verbatim text from the document — a complete
   sentence, a complete table row, or a single "Label: value" line (never
   truncated mid-sentence or mid-clause) — never paraphrase.
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

export function parseFactsResponse(raw: unknown): Fact[] {
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

function stableFactKey(fact: Fact): string {
  return [
    Number.isFinite(Number(fact.chunkIndex)) ? Number(fact.chunkIndex) : Number.MAX_SAFE_INTEGER,
    Number.isFinite(Number(fact.sourcePage)) ? Number(fact.sourcePage) : Number.MAX_SAFE_INTEGER,
    normalizeForPageMatch(fact.sourceText),
    fact.category,
  ].join("|");
}

function sortFactsDeterministically(facts: Fact[]): Fact[] {
  return [...facts].sort((a, b) => stableFactKey(a).localeCompare(stableFactKey(b)));
}

export function dedupeFacts(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  const result: Fact[] = [];
  for (const fact of sortFactsDeterministically(facts)) {
    // A single source sentence can prove multiple atomic facts. Lease term
    // dates are the important example: "from March 1, 2019 through December
    // 31, 2023" must survive as two same-category, same-source facts whose
    // only distinguishing feature is the value. Include page and source text
    // so overlapping chunks cannot inflate candidate scores with duplicates.
    const key = [
      fact.category,
      Number.isFinite(Number(fact.sourcePage)) ? Number(fact.sourcePage) : "unknown_page",
      normalizeForPageMatch(fact.sourceText),
      normalizeForPageMatch(String(fact.value ?? "")),
    ].join("|");
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


type SettledResult<R> =
  | { status: "fulfilled"; value: R }
  | { status: "rejected"; reason: unknown };

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<SettledResult<R>>> {
  const results: Array<SettledResult<R>> = new Array(items.length);
  let cursor = 0;

  async function runLane(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = { status: "fulfilled", value: await worker(items[idx], idx) };
      } catch (err) {
        results[idx] = { status: "rejected", reason: err };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => runLane()),
  );
  return results;
}

function envPositiveInt(name: string, fallback: number): number {
  try {
    const parsed = Number(Deno.env.get(name));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  } catch {
    return fallback;
  }
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
  maxChunks?: number;
  onProgress?: (progress: Record<string, unknown>) => Promise<void> | void;
  resume?: import("./types.ts").FactLedgerResumeState;
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

  const allChunks = chunkDocument(docIndex.doclingRaw as any);
  const configuredMaxChunks = args.maxChunks ?? envOptionalPositiveInt("OPENAI_FACT_LEDGER_EMERGENCY_MAX_CHUNKS");
  const chunks = configuredMaxChunks == null ? allChunks : allChunks.slice(0, configuredMaxChunks);
  const chunksTruncated = configuredMaxChunks != null && allChunks.length > chunks.length;
  if (chunksTruncated) {
    warnings.push(
      `OpenAI fact ledger processed ${chunks.length} of ${allChunks.length} chunks because OPENAI_FACT_LEDGER_EMERGENCY_MAX_CHUNKS is set; unset or increase it to cover the full document.`,
    );
  }
  const resumeStartChunkIndex = Math.max(
    0,
    Math.min(chunks.length, Math.floor(Number(args.resume?.startChunkIndex ?? 0)) || 0),
  );
  const priorFacts = Array.isArray(args.resume?.priorFacts) ? args.resume.priorFacts : [];
  const allFacts: Fact[] = priorFacts
    .filter((fact: any) => fact && typeof fact === "object" && typeof fact.category === "string" && typeof fact.sourceText === "string")
    .map((fact: any) => ({ ...fact }));
  let chunksProcessed = Math.max(Number(args.resume?.chunksProcessed ?? resumeStartChunkIndex) || 0, resumeStartChunkIndex);
  let successfulChunkCount = Math.max(Number(args.resume?.chunksSucceeded ?? resumeStartChunkIndex) || 0, 0);
  let failedChunkCount = Math.max(Number(args.resume?.chunksFailed ?? 0) || 0, 0);
  const chunkClassifications: Array<OpenAIFailureClassification | undefined> = [];
  let lastHttpStatus: number | undefined;
  let lastProviderErrorCode: string | undefined;
  let lastRequestId: string | undefined;
  let lastRequestUrl: string | undefined;

  // Chunks are independent OpenAI calls. Process every chunk, but pace the
  // fan-out so long leases don't overwhelm Edge compute or provider limits.
  // OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY controls throughput; it never reduces
  // document coverage.
  const chunkConcurrency = envPositiveInt("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY", 2);
  const deadlineReserveMs = envPositiveInt("OPENAI_FACT_LEDGER_DEADLINE_RESERVE_MS", 15_000);
  let peakConcurrency = 0;
  let partialResult = false;
  let continuationRequired = false;
  let continuationReason: string | null = null;
  let nextChunkIndex: number | null = null;
  const failedChunkIndexes: number[] = Array.isArray(args.resume?.failedChunkIndexes) ? [...args.resume!.failedChunkIndexes!] : [];

  async function emitProgress() {
    await args.onProgress?.({
      chunksTotal: allChunks.length,
      chunksScheduled: chunks.length,
      chunksProcessed,
      chunksSucceeded: successfulChunkCount,
      chunksFailed: failedChunkCount,
      chunksTruncated,
      failedChunkIndexes: [...failedChunkIndexes],
      partialResult,
      continuationRequired,
      continuationReason,
      nextChunkIndex,
      peakConcurrency,
      partialFacts: dedupeFacts(allFacts),
      resumedFromChunkIndex: resumeStartChunkIndex || null,
    });
  }

  for (let batchStart = resumeStartChunkIndex; batchStart < chunks.length; batchStart += chunkConcurrency) {
    if (deadlineAt && chunksProcessed > 0 && Date.now() + deadlineReserveMs >= deadlineAt) {
      partialResult = true;
      continuationRequired = true;
      continuationReason = "execution_budget";
      nextChunkIndex = batchStart;
      warnings.push(
        `OpenAI fact ledger paused after ${chunksProcessed} of ${chunks.length} scheduled chunks to avoid the Edge execution deadline; continuation is required from chunk ${batchStart}.`,
      );
      await emitProgress();
      break;
    }

    const batch = chunks.slice(batchStart, batchStart + chunkConcurrency);
    peakConcurrency = Math.max(peakConcurrency, batch.length);
    const settledChunkResults = await runWithConcurrency(
      batch,
      batch.length,
      (chunk, batchIndex) => extractFromChunk(chunk.text, moduleType, deadlineAt, provenance, batchStart + batchIndex),
    );

    settledChunkResults.forEach((settled, batchIndex) => {
      const index = batchStart + batchIndex;
      const chunk = chunks[index];
      const result: ChunkExtractionResult = settled.status === "fulfilled"
        ? settled.value
        : {
          facts: [],
          warning: `Fact ledger extraction failed for one chunk: ${(settled.reason as Error)?.message ?? settled.reason}`,
          classification: "unknown",
        };
      if (result.warning) warnings.push(result.warning);
      chunksProcessed += 1;

      const providerFailed = Boolean(result.warning);
      if (providerFailed) {
        failedChunkCount += 1;
        failedChunkIndexes.push(index);
        partialResult = true;
        continuationReason = continuationReason ?? "chunk_failure";
      } else {
        successfulChunkCount += 1;
      }
      if (result.facts.length === 0) {
        chunkClassifications.push(result.classification);
        if (result.httpStatus != null) lastHttpStatus = result.httpStatus;
        if (result.providerErrorCode != null) lastProviderErrorCode = result.providerErrorCode;
        if (result.requestId != null) lastRequestId = result.requestId;
        if (result.requestUrl != null) lastRequestUrl = result.requestUrl;
      }
      for (const fact of result.facts) {
        const sourceOffset = chunk.text.indexOf(fact.sourceText);
        allFacts.push({
          ...fact,
          chunkIndex: index,
          sourceOffset: sourceOffset >= 0 ? sourceOffset : null,
          sourcePage: fact.sourcePage ?? resolveVerifiedSourcePage(
            docIndex.doclingRaw as Record<string, unknown>,
            fact.sourceText,
            chunk.startPage ?? null,
          ),
        });
      }
    });

    await emitProgress();
  }

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
    chunksTotal: allChunks.length,
    chunksSucceeded: successfulChunkCount,
    chunksFailed: failedChunkCount,
    chunksTruncated,
    failedChunkIndexes,
    partialResult,
    peakConcurrency,
    continuationRequired,
    continuationReason,
    nextChunkIndex,
    partialFacts: dedupedFacts,
    resumedFromChunkIndex: resumeStartChunkIndex || null,
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
  dedupeFacts,
  parseFactsResponse,
};
