// @ts-nocheck
// v4 — lease_date in dates group; monthly_rent min=1; lease_type enum description
/**
 * normalize-pdf-output — Step 3 of the canonical pipeline
 *
 * Input:  uploaded_files row in status='pdf_parsed' with `docling_raw`
 * Output: uploaded_files row in status='review_required' or 'validated',
 *         with `normalized_output`, `ui_review_payload`, and `parsed_data`
 *         populated so store-data / the reviewer can pick up from here.
 *
 * This function is now a THIN orchestrator over `runExtractionPipeline()`
 * — it no longer owns any extraction logic of its own. All rule/table/LLM
 * work happens inside `_shared/extraction/pipeline.ts`, which is the one
 * and only extraction engine in the system.
 *
 * Review gate:
 *   - If uploaded_files.review_required = TRUE  → status := 'review_required'
 *     (the reviewer will call review-approve which flips to 'approved' and
 *      fires validate-data / store-data).
 *   - Otherwise                                  → status := 'validated'
 *     (validate-data / store-data run automatically via the existing chain).
 */

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isInternalCall } from "../_shared/internal-auth.ts";
import { runExtractionPipeline } from "../_shared/extraction/pipeline.ts";
import { runVertexFactLedgerPipeline } from "../_shared/extraction/vertex-fact-ledger/orchestrator.ts";
import { runBusinessExtraction } from "../_shared/extraction/business-extraction-orchestrator.ts";
import { isAzureLayoutOutput } from "../_shared/extraction/extraction-provider.ts";
import { getFieldGroups, getSchema } from "../_shared/extraction/schemas.ts";
import { buildLeaseWorkflowAbstraction } from "../_shared/extraction/lease-workflow.ts";
import { cleanEvidenceSnippet, findPageForSnippet, resolveVerifiedSourcePage } from "../_shared/extraction/evidence-index.ts";
import { detectFileMagic } from "../_shared/file-magic.ts";
import { setStatus, setFailed } from "../_shared/pipeline-status.ts";
import { createLogger } from "../_shared/logger.ts";
import { computeCoreReady, uploadedFileRowHasMeaningfulValues } from "../_shared/extraction/payload-guard.ts";
import { enqueueEnrichmentJob } from "../_shared/extraction/enrichment-dispatch.ts";
import { runDocumentIntelligenceV3SideWrite } from "../_shared/extraction/document-intelligence-v3/side-write.ts";
import type { ModuleType as ExtractionModuleType } from "../_shared/extraction/types.ts";
import {
  buildBlockedReviewPayload,
  buildPipelineMetadata,
  countTextChars,
  mergePipelineIntoNormalizedOutput,
  MIN_LEASE_TEXT_CHARS,
  NORMALIZE_STATUSES,
  PARSER_STATUSES,
  REVIEW_STATUSES,
} from "../_shared/extraction/pipeline-contract.ts";

// Base64 expands PDFs by about 33%, and the intermediate binary string can
// double memory again. Keep inline Vision fallback below Edge compute limits.
// 20 MB matches the parser.ts MAX_INLINE_VISION_PDF_BYTES — Gemini's documented
// inline data limit — so any file small enough for parse to have processed inline
// can also be processed inline here if Vision is needed as a fallback.
const MAX_INLINE_VISION_BYTES = 20 * 1024 * 1024;

const AZURE_PAGE_MARKER_RE = /\[\[\s*PAGE\s+\d+\s*\]\]/i;

/**
 * Build the exact minimal object handed to runExtractionPipeline — no
 * top-level `markdown` duplicate (a 1:1 copy of full_text that rides through
 * every downstream copy for zero benefit), and for azure_layout records
 * persisted before the adapter started emitting [[PAGE n]] markers, repair
 * full_text at read time by rebuilding it from the persisted pages array.
 *
 * This repair matters because Re-extract re-enters at normalize, not parse —
 * a page-marker fix in the Azure adapter alone can never reach a record whose
 * docling_raw was already persisted by the old adapter. Without markers the
 * LLM extraction prompt's page-anchoring rule never fires, every field comes
 * back with source_page=null, and normalize is forced into an expensive
 * brute-force page-matching scan for every field.
 *
 * Never mutates the input — the caller still needs the original doclingRaw
 * (pages/text_blocks arrays are marker-independent) for evidence lookups.
 */
function buildPipelineLayoutInput(
  doclingRaw: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!doclingRaw) return doclingRaw;

  let fullText = String((doclingRaw as any)?.full_text ?? "");
  let repairStrategy: string | null = null;
  const pages = Array.isArray((doclingRaw as any)?.pages) ? (doclingRaw as any).pages : [];

  if (isAzureLayoutOutput(doclingRaw) && !AZURE_PAGE_MARKER_RE.test(fullText) && pages.length > 0) {
    fullText = pages
      .map((page: any, index: number) => {
        const pageNumber = Number.isFinite(Number(page?.page)) && Number(page.page) > 0 ? Number(page.page) : index + 1;
        return `[[PAGE ${pageNumber}]]\n${page?.text ?? ""}`;
      })
      .join("\n\n");
    repairStrategy = "page_lines";
    console.log(
      `[normalize-pdf-output] azure_page_marker_repair strategy=${repairStrategy} ` +
      `pages=${pages.length} chars=${fullText.length}`,
    );
  }

  return {
    extraction_method: (doclingRaw as any)?.extraction_method,
    full_text: fullText,
    page_count: (doclingRaw as any)?.page_count,
    pages: (doclingRaw as any)?.pages,
    text_blocks: (doclingRaw as any)?.text_blocks,
    tables: (doclingRaw as any)?.tables,
    fields: (doclingRaw as any)?.fields,
    warnings: (doclingRaw as any)?.warnings,
    _metadata: (doclingRaw as any)?._metadata,
  };
}

/**
 * Resolve which extraction/reasoning provider runs the pipeline.
 * Default is "legacy_hybrid" (runExtractionPipeline, unchanged) whenever
 * BUSINESS_EXTRACTION_PROVIDER is unset or any value other than the exact
 * string "vertex_fact_ledger" — vertex_fact_ledger is strictly opt-in.
 *
 * `internalDebugOverride` lets a scoped, single request pick the provider
 * without touching the BUSINESS_EXTRACTION_PROVIDER project secret — the
 * caller must only pass a value here when the request has already passed
 * isInternalCall(req) (service-role/worker auth), so a normal browser/user
 * request can never set it. Used for one-off live provider comparisons
 * without making vertex_fact_ledger the project's live default.
 */
// Azure+Vertex Phase 4E (local implementation): adds vertex_primary_legacy_fallback
// as a new, opt-in-only mode. The project default is unchanged -- an unset
// or unrecognized BUSINESS_EXTRACTION_PROVIDER still resolves to legacy_hybrid.
function resolveBusinessExtractionProvider(
  internalDebugOverride?: string | null,
): "legacy_hybrid" | "vertex_fact_ledger" | "vertex_primary_legacy_fallback" {
  const RECOGNIZED = new Set(["legacy_hybrid", "vertex_fact_ledger", "vertex_primary_legacy_fallback"]);
  const override = String(internalDebugOverride ?? "").trim().toLowerCase();
  if (RECOGNIZED.has(override)) {
    return override as "legacy_hybrid" | "vertex_fact_ledger" | "vertex_primary_legacy_fallback";
  }
  const raw = String(Deno.env.get("BUSINESS_EXTRACTION_PROVIDER") ?? "").trim().toLowerCase();
  return RECOGNIZED.has(raw) ? (raw as "legacy_hybrid" | "vertex_fact_ledger" | "vertex_primary_legacy_fallback") : "legacy_hybrid";
}

/**
 * Azure+Vertex Phase 4E (local implementation): local-only, test-only mock
 * injection for the business-extraction orchestrator's Vertex call. Never a
 * production capability. Requires all gates simultaneously:
 *   (a) isInternalCall(req) -- existing internal-auth check
 *   (b) ENABLE_LOCAL_PROVIDER_MOCKS=true -- explicit opt-in env var
 *   (c) DISABLE_EXTERNAL_PROVIDER_CALLS=true -- provider kill switch
 *   (d) SUPABASE_URL is loopback/localhost, or it is the local Supabase Docker
 *       hostname kong:8000 plus LOCAL_SUPABASE_RUNTIME=true
 * `kong` alone is not proof of locality: a remote self-hosted stack could use
 * the same internal hostname. If mocks are requested/enabled without the full
 * gate, the request is rejected rather than silently making a real call.
 */
function envFlagEnabled(name: string): boolean {
  return String(Deno.env.get(name) ?? "").toLowerCase() === "true";
}

function externalProviderCallsDisabled(): boolean {
  return envFlagEnabled("DISABLE_EXTERNAL_PROVIDER_CALLS");
}

function localProviderMocksEnabled(): boolean {
  return envFlagEnabled("ENABLE_LOCAL_PROVIDER_MOCKS");
}

function explicitLocalRuntimeMarkerEnabled(): boolean {
  return envFlagEnabled("LOCAL_SUPABASE_RUNTIME");
}

function isLocalSupabaseUrl(): boolean {
  const raw = String(Deno.env.get("SUPABASE_URL") ?? "").trim();
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" ||
      (host === "kong" && explicitLocalRuntimeMarkerEnabled());
  } catch {
    return false;
  }
}
function resolveMockVertexScenario(req: Request, body: Record<string, unknown>, requestedProvider?: string): string | undefined {
  const mocksEnabled = localProviderMocksEnabled();
  const requestedScenario = isInternalCall(req) ? String((body as any)?.debug_vertex_mock_scenario ?? "").trim() : "";

  if (!mocksEnabled) {
    if (requestedScenario) {
      // A caller asked for a mock but mocks are not enabled -- fail loudly
      // rather than silently making a real call with an ignored parameter.
      throw new Error("debug_vertex_mock_scenario was provided but ENABLE_LOCAL_PROVIDER_MOCKS is not set to true");
    }
    return undefined;
  }

  if (!externalProviderCallsDisabled()) {
    throw new Error("ENABLE_LOCAL_PROVIDER_MOCKS=true also requires DISABLE_EXTERNAL_PROVIDER_CALLS=true");
  }

  if (!isLocalSupabaseUrl()) {
    // Fail-closed: mocks requested/enabled in a configuration that is not
    // provably local. Never silently proceed with a real provider call.
    throw new Error("ENABLE_LOCAL_PROVIDER_MOCKS=true is only permitted against a verified local Supabase runtime (127.0.0.1, localhost, or kong:8000 with LOCAL_SUPABASE_RUNTIME=true)");
  }

  const disableExternalCalls = true;
  if (!requestedScenario) {
    if (disableExternalCalls && requestedProvider !== "legacy_hybrid") {
      throw new Error("DISABLE_EXTERNAL_PROVIDER_CALLS=true requires a valid debug_vertex_mock_scenario on every internal call");
    }
    return undefined;
  }

  const VALID_SCENARIOS = new Set([
    "success", "timeout", "rate_limited", "server_error", "malformed_response",
    "empty_extraction", "auth_error", "low_evidence", "conflicting_facts",
  ]);
  if (!VALID_SCENARIOS.has(requestedScenario)) {
    throw new Error(`Unrecognized debug_vertex_mock_scenario: ${requestedScenario}`);
  }
  return requestedScenario;
}

function resolveLocalDebugDelayMs(req: Request, body: Record<string, unknown>, key: string): number {
  if (!isInternalCall(req) || !localProviderMocksEnabled() || !externalProviderCallsDisabled() || !isLocalSupabaseUrl()) return 0;
  const raw = Number((body as any)?.[key] ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.floor(raw), 5000);
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stampBusinessExtractionPersistedAt(result: { metadata?: Record<string, unknown> }, persistedAt: string): void {
  const metadata = (result.metadata ?? {}) as Record<string, unknown>;
  const provenance = (metadata as any).provenance;
  if (!provenance || typeof provenance !== "object") return;
  result.metadata = {
    ...metadata,
    provenance: {
      ...provenance,
      result_persisted_at: persistedAt,
    },
  };
}

function readBusinessExtractionProvenance(value: unknown): Record<string, unknown> | null {
  const provenance = (value as any)?.metadata?.provenance;
  return provenance && typeof provenance === "object" ? provenance as Record<string, unknown> : null;
}

function readDurableBusinessExtractionProvenance(row: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  return readBusinessExtractionProvenance((row as any)?.normalized_output) ?? readBusinessExtractionProvenance((row as any)?.ui_review_payload);
}

function compareRaceWinnerMetadata(current: Record<string, unknown> | null, winner: Record<string, unknown> | null): {
  compatible: boolean;
  reason: string;
  currentAttemptId: string | null;
  winnerAttemptId: string | null;
} {
  const currentAttemptId = current?.attempt_id != null ? String(current.attempt_id) : null;
  const winnerAttemptId = winner?.attempt_id != null ? String(winner.attempt_id) : null;
  if (!current || !winner) {
    return { compatible: false, reason: "missing_provenance", currentAttemptId, winnerAttemptId };
  }
  if (!currentAttemptId || !winnerAttemptId) {
    return { compatible: false, reason: "missing_attempt_id", currentAttemptId, winnerAttemptId };
  }
  const keys = [
    "correlation_id",
    "requested_provider",
    "semantic_schema_version",
    "canonical_layout_schema_version",
    "source_content_hash",
  ];
  for (const key of keys) {
    const currentValue = current[key];
    const winnerValue = winner[key];
    if (currentValue == null || winnerValue == null || String(currentValue) !== String(winnerValue)) {
      return { compatible: false, reason: `mismatch_${key}`, currentAttemptId, winnerAttemptId };
    }
  }
  return { compatible: true, reason: "compatible_attempt_schema_hash", currentAttemptId, winnerAttemptId };
}
function toExtractionModuleType(moduleType: string): ExtractionModuleType {
  switch (moduleType) {
    case "leases": return "lease";
    case "expenses": return "expense";
    case "invoices": return "expense";
    case "properties": return "property";
    case "revenue": return "revenue";
    case "building":
    case "buildings": return "building";
    case "unit":
    case "units": return "unit";
    case "tenant":
    case "tenants": return "tenant";
    case "gl_account":
    case "gl_accounts": return "gl_account";
    default: return "property";
  }
}

function buildFallbackReviewRow(moduleType: string): Record<string, unknown> {
  switch (moduleType) {
    case "lease":
    case "leases":
      return {
        tenant_name: null,
        landlord_name: null,
        property_name: null,
        property_address: null,
        assignor_name: null,
        assignee_name: null,
        assignment_effective_date: null,
        landlord_consent: null,
        assumption_scope: null,
        assignee_notice_address: null,
        unit_number: null,
        start_date: null,
        end_date: null,
        monthly_rent: null,
        annual_rent: null,
        lease_term_months: null,
        rent_per_sf: null,
        square_footage: null,
        lease_type: null,
        security_deposit: null,
        cam_amount: null,
        escalation_rate: null,
        renewal_options: null,
        ti_allowance: null,
        free_rent_months: null,
        status: null,
        notes: null,
      };
    case "expenses":
    case "invoices":
      return {
        vendor: null,
        invoice_number: null,
        date: null,
        amount: null,
        category: null,
        classification: null,
        description: null,
      };
    case "properties":
      return { name: null, address: null, city: null, state: null, zip: null, total_sqft: null };
    default:
      return { notes: null };
  }
}

// Cache for buildEvidenceSearchBlocks() below — unrelated to EvidenceIndex's
// own internal cache in evidence-index.ts (different candidate shape: this
// one is used by the fallback needle-in-haystack search, not page scoring).
const _evidenceSearchBlocksCache = new WeakMap<object, Array<{ text: string; lowered: string; page: number | null; source: string }>>();

function isGenericSourceText(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  if (/^(llm extracted|extracted|manual_review|not found|unknown|n\/a|na|null)$/i.test(text)) return true;
  if (lower.includes("derived from")) return true;
  // Lease preamble / boilerplate headers — never useful as field-level source text
  if (/^\[?PAGE\s+\d+\]?\s*SUMMARY\s+OF\s+BASIC\s+LEASE\s+INFORMATION/i.test(text)) return true;
  if (/^SUMMARY\s+OF\s+BASIC\s+LEASE\s+INFORMATION/i.test(text)) return true;
  if (/^This\s+Summary\s+\(the\s+[""']?Summary[""']?\)\s+is\s+hereby\s+incorporated/i.test(text)) return true;
  // Numbered-summary line whose value part is only 1–3 digits — the digit is the next
  // item's number leaked in, not a real field value (e.g. "2. Landlord: 3")
  if (/^\d+[.)]\s+\w[\w\s]{0,40}[:\-]\s*\d{1,3}\s*$/.test(text)) return true;
  const structuredFieldMatch = text.match(/^[a-z][a-z0-9_]*_[a-z0-9_]*\s*:\s*(.+)$/i);
  if (structuredFieldMatch) {
    const valuePart = structuredFieldMatch[1].trim();
    if (!valuePart || /^(unknown|n\/a|na|null|not found|not specified)$/i.test(valuePart)) return true;
    return false;
  }
  if (/^[a-z][a-z0-9_]{2,60}$/.test(text)) return true;
  return false;
}

function isLlmSourceTextRelevantToField(fieldKey: string, sourceText: string | null): boolean {
  if (!sourceText) return true;
  // Insurance fields must contain insurance-domain language
  if (["tenant_insurance_required", "general_liability_min", "property_insurance",
    "responsibility_insurance", "insurance_responsibility"].includes(fieldKey)) {
    return /\b(insurance|insure|insured|coverage|carrier|policy|certificate|liability limit)\b/i.test(sourceText);
  }
  // Party name fields: reject source text from assignment/transfer clauses
  if (["landlord_name", "tenant_name"].includes(fieldKey)) {
    if (/\b(closely held|voting shares|reorganization|merger|consolidation|assignee|permitted transfer)\b/i.test(sourceText)) return false;
  }
  return true;
}

function usableSourceText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return isGenericSourceText(text) ? null : text;
}

function capSourceText(text: string | null | undefined, maxChars = 350): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxChars) return cleaned;
  const slice = cleaned.slice(0, maxChars);
  // Prefer a sentence boundary before the limit
  const lastPeriod = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(".\n"));
  if (lastPeriod > maxChars * 0.55) {
    return slice.slice(0, lastPeriod + 1).trimEnd();
  }
  // No good backward boundary — look forward up to 120 chars to complete the sentence
  const extended = cleaned.slice(0, maxChars + 120);
  const forwardPeriod = extended.indexOf(". ", maxChars - 20);
  if (forwardPeriod > -1 && forwardPeriod < maxChars + 100) {
    return extended.slice(0, forwardPeriod + 1).trimEnd();
  }
  // Hard truncation as last resort
  return slice.trimEnd() + "…";
}

const SOURCE_SNIPPET_MAX_CHARS = 900;
const SOURCE_SNIPPET_LOOKBACK = 450;
const SOURCE_SNIPPET_LOOKAHEAD = 650;
const SOURCE_ABBREVIATIONS = new Set([
  "co", "corp", "inc", "ltd", "llc", "lp", "llp", "mr", "mrs", "ms", "dr",
  "jr", "sr", "st", "ave", "blvd", "rd", "ste", "suite", "no", "jan", "feb",
  "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

function skipSourceBoundaryPadding(text: string, index: number) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function isSourceSentenceEnd(text: string, index: number) {
  const char = text[index];
  if (!".!?".includes(char)) return false;

  if (char === ".") {
    const before = text[index - 1] || "";
    const after = text[index + 1] || "";
    if (/\d/.test(before) && /\d/.test(after)) return false;

    const wordMatch = text.slice(Math.max(0, index - 16), index).match(/([A-Za-z]+)$/);
    if (wordMatch && SOURCE_ABBREVIATIONS.has(wordMatch[1].toLowerCase())) return false;
  }

  let cursor = index + 1;
  while (cursor < text.length && /["')\]]/.test(text[cursor])) cursor += 1;
  return cursor >= text.length || /\s/.test(text[cursor]);
}

function isCleanSnippetStart(snippet: string) {
  return (
    /^[A-Za-z][^:]{0,90}:\s\S/.test(snippet) ||
    /^\d+(?:\.\d+)*[.)]?\s+[A-Z]/.test(snippet) ||
    /^[A-Z0-9"'(]/.test(snippet) ||
    /^(approximately|suite|unit|space|monthly|annual|base rent|rent|permitted use|broker|address|landlord|tenant)\b/i.test(snippet)
  );
}

function isShortCompleteSourceRow(snippet: string) {
  if (!snippet || snippet.length > 260) return false;
  if (/\.{3}|…/.test(snippet)) return false;
  const isLabeledRow = /^[A-Za-z][^:]{0,90}:\s\S/.test(snippet);
  const isNumberedRow = /^\d+(?:\.\d+)*[.)]?\s+[A-Z]/.test(snippet);
  const isShortValueRow =
    /^(suite|unit|space|monthly|annual|base rent|rent|permitted use|broker|address|landlord|tenant)\b/i.test(snippet) &&
    !/[.!?]\s+\S/.test(snippet);
  if (!isLabeledRow && !isNumberedRow && !isShortValueRow) return false;
  const partyMarkerCount = (snippet.match(/\b(?:landlord|tenant|lessee|lessor|address of landlord|address of tenant)\b/gi) || []).length;
  return partyMarkerCount <= 2;
}

function boundedSourceSnippet(text: string, matchStart: number, matchLength: number) {
  const source = cleanEvidenceSnippet(text);
  if (!source) return "";

  const singleLine = source;
  if (isShortCompleteSourceRow(singleLine)) {
    return singleLine;
  }
  if (singleLine.length <= SOURCE_SNIPPET_MAX_CHARS && /^[A-Za-z][^:]{0,90}:\s\S/.test(singleLine)) {
    return singleLine;
  }
  if (singleLine.length <= SOURCE_SNIPPET_MAX_CHARS && /^\d+(?:\.\d+)*[.)]?\s+[A-Z]/.test(singleLine)) {
    return singleLine;
  }

  const safeMatchStart = Math.max(0, Math.min(matchStart, source.length));
  const safeMatchEnd = Math.max(safeMatchStart, Math.min(source.length, safeMatchStart + matchLength));
  const searchStart = Math.max(0, safeMatchStart - SOURCE_SNIPPET_LOOKBACK);
  const searchEnd = Math.min(source.length, safeMatchEnd + SOURCE_SNIPPET_LOOKAHEAD);

  let start: number | null = safeMatchStart === 0 ? 0 : null;
  for (let i = safeMatchStart - 1; i >= searchStart; i -= 1) {
    if (isSourceSentenceEnd(source, i)) {
      start = skipSourceBoundaryPadding(source, i + 1);
      break;
    }
  }
  if (start == null && searchStart === 0) start = 0;
  if (start == null) return "";

  let end: number | null = null;
  for (let i = safeMatchEnd; i < searchEnd; i += 1) {
    if (isSourceSentenceEnd(source, i)) {
      end = i + 1;
      break;
    }
  }
  if (end == null && searchEnd === source.length) end = source.length;
  if (end == null) return "";

  const snippet = cleanEvidenceSnippet(source.slice(start, end));
  if (!snippet || snippet.length > SOURCE_SNIPPET_MAX_CHARS || !isCleanSnippetStart(snippet)) return "";
  if (!/[.!?]["')\]]?$/.test(snippet) && !/^[A-Za-z][^:]{0,90}:\s\S/.test(snippet)) return "";
  return snippet;
}

function cleanPartyAddressValue(fieldKey: string, value: unknown) {
  if (!["landlord_address", "tenant_address"].includes(fieldKey)) return value;
  let text = cleanEvidenceSnippet(value);
  if (!text) return value;

  const ownLabel = fieldKey === "landlord_address"
    ? /(?:^|\b)(?:\d+\.\s*)?(?:address\s+of\s+landlord|landlord(?:'s)?\s+address)\s*[:;-]?\s*/i
    : /(?:^|\b)(?:\d+\.\s*)?(?:address\s+of\s+tenant|tenant(?:'s)?\s+address)\s*[:;-]?\s*/i;
  const ownMatch = text.match(ownLabel);
  if (ownMatch?.index != null) {
    text = text.slice(ownMatch.index + ownMatch[0].length).trim();
  }

  const stopPatterns = fieldKey === "landlord_address"
    ? [
      /\b\d+\.\s*(?:tenant|lessee)\b\s*[:;-]?/i,
      /\b(?:tenant|lessee)\b\s*[:;-]/i,
      /\b(?:address\s+of\s+tenant|tenant(?:'s)?\s+address)\b/i,
      /\btenant_contact_/i,
    ]
    : [
      /\b\d+\.\s*(?:landlord|lessor)\b\s*[:;-]?/i,
      /\b(?:landlord|lessor)\b\s*[:;-]/i,
      /\b(?:address\s+of\s+landlord|landlord(?:'s)?\s+address)\b/i,
      /\blandlord_contact_/i,
    ];

  let stopAt = text.length;
  for (const pattern of stopPatterns) {
    const match = text.match(pattern);
    if (match?.index != null && match.index > 4) stopAt = Math.min(stopAt, match.index);
  }
  text = text.slice(0, stopAt).trim();
  text = text
    .replace(/^(?:\d+\.\s*)?(?:address\s+of\s+(?:landlord|tenant)|landlord(?:'s)?\s+address|tenant(?:'s)?\s+address)\s*[:;-]?\s*/i, "")
    .replace(/\s+\d+\.\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[;,\s]+$/g, "")
    .trim();

  // Strip leading phone-number suffix that got concatenated with street address.
  // e.g. "9700 1240 Bentley Park lane" → "1240 Bentley Park lane"
  // Pattern: 3-4 digit token at start followed by another numeric token (the real street number)
  text = text.replace(/^\d{3,4}\s+(?=\d{1,6}\s+\S)/, "").trim();

  // Too short → reject completely (covers single-digit leakage like "4")
  if (text.length < 8) return null;
  return text;
}

function buildEvidenceSearchBlocks(doclingRaw: Record<string, unknown> | null | undefined) {
  if (doclingRaw && _evidenceSearchBlocksCache.has(doclingRaw)) {
    return _evidenceSearchBlocksCache.get(doclingRaw)!;
  }
  const blocks: Array<{ text: string; lowered: string; page: number | null; source: string }> = [];
  const push = (value: unknown, page: unknown, source: string) => {
    const text = cleanEvidenceSnippet(value);
    if (!text) return;
    const pageNumber = Number(page);
    blocks.push({
      text,
      lowered: text.toLowerCase(),
      page: Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : null,
      source,
    });
  };

  for (const block of Array.isArray((doclingRaw as any)?.text_blocks) ? (doclingRaw as any).text_blocks : []) {
    push(block?.text, block?.page ?? block?.page_number ?? block?.source_page, "text_block");
  }
  for (const page of Array.isArray((doclingRaw as any)?.pages) ? (doclingRaw as any).pages : []) {
    push(page?.text ?? page?.content ?? page?.markdown ?? page?.full_text, page?.page ?? page?.page_number ?? page?.number, "page");
  }
  for (const field of Array.isArray((doclingRaw as any)?.fields) ? (doclingRaw as any).fields : []) {
    const key = cleanEvidenceSnippet(field?.key ?? field?.label);
    const value = cleanEvidenceSnippet(field?.value ?? field?.text);
    if (value) push(key ? `${key}: ${value}` : value, field?.page ?? field?.page_number ?? field?.source_page, "docling_field");
  }
  if (blocks.length === 0) {
    push((doclingRaw as any)?.full_text ?? (doclingRaw as any)?.raw_text ?? (doclingRaw as any)?.text, null, "full_text");
  }

  const seen = new Set<string>();
  const result = blocks.filter((block) => {
    const key = `${block.page ?? ""}|${block.text.slice(0, 240)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (doclingRaw) _evidenceSearchBlocksCache.set(doclingRaw, result);
  return result;
}

function fieldSourceKeywords(fieldKey: string): string[] {
  const keywords: Record<string, string[]> = {
    tenant_name: ["tenant", "lessee", "occupant", "assignee"],
    tenant_signatory_name: ["tenant", "lessee", "signatory", "by:", "signed", "authorized"],
    tenant_contact_name: ["tenant", "contact", "person", "representative"],
    tenant_contact_phone: ["tenant", "phone", "telephone", "contact"],
    tenant_address: ["tenant", "address", "notice"],
    landlord_address: ["landlord", "lessor", "address", "notice"],
    landlord_name: ["landlord", "lessor", "owner", "licensor"],
    landlord_signatory_name: ["landlord", "lessor", "signatory", "by:", "signed"],
    tenant_signature_date: ["tenant", "date", "signature", "signed"],
    landlord_signature_date: ["landlord", "date", "signature", "signed"],
    broker_name: ["broker", "brokerage", "real estate broker", "agent"],
    property_name: ["property", "building", "premises", "project"],
    property_address: ["property", "building", "premises", "address", "located"],
    premises_address: ["property", "building", "premises", "address", "suite", "located"],
    suite_number: ["suite", "unit", "premises"],
    unit_number: ["suite", "unit", "premises"],
    square_footage: ["square feet", "sq ft", "sf", "rsf", "rentable", "premises"],
    rentable_area_sqft: ["square feet", "sq ft", "sf", "rsf", "rentable", "premises"],
    tenant_rsf: ["square feet", "sq ft", "sf", "rsf", "rentable", "tenant"],
    monthly_rent: ["rent", "base rent", "monthly", "per month"],
    base_rent_monthly: ["rent", "base rent", "monthly", "per month"],
    annual_rent: ["rent", "annual", "year"],
    base_rent_annual: ["rent", "annual", "year"],
    rent_per_sf: ["rent", "per square", "per sf", "per rsf", "$/sf"],
    permitted_use: ["use", "permitted use", "purpose"],
    security_deposit: ["security deposit", "deposit"],
    cam_amount: ["cam", "common area maintenance", "operating expenses", "additional rent"],
    fixed_cam_amount: ["fixed cam", "cam", "common area maintenance"],
    cam_cap_pct: ["cam", "cap", "common area maintenance", "operating expenses", "controllable"],
    responsibility_insurance: ["insurance", "property insurance", "liability", "coverage"],
    insurance_responsibility: ["insurance", "property insurance", "liability", "coverage"],
    property_insurance: ["insurance", "property insurance", "premium", "coverage"],
    tenant_insurance_required: ["insurance", "tenant", "liability", "coverage"],
    general_liability_min: ["insurance", "liability", "coverage"],
    commencement_date: ["commencement", "start", "term"],
    start_date: ["commencement", "start", "term"],
    expiration_date: ["expiration", "expiry", "expire", "end", "term"],
    end_date: ["expiration", "expiry", "expire", "end", "term"],
    admin_fee_pct: ["admin", "administrative fee", "management fee", "recoverable", "cam"],
    admin_fee_percent: ["admin", "administrative fee", "management fee", "recoverable", "cam"],
    cam_cap_pct: ["cam", "cap", "controllable", "operating expense", "common area"],
    cam_cap_percent: ["cam", "cap", "controllable", "operating expense", "common area"],
    default_interest_rate_formula: ["default", "interest", "overdue", "delinquent", "late payment"],
    late_fee_percent: ["late", "late fee", "late charge", "delinquent"],
    late_fee_grace_days: ["late", "grace", "late fee", "delinquent"],
    rent_payment_timing: ["rent", "payable", "due", "advance"],
    rent_due_day: ["rent", "due", "payable", "day of"],
    rent_frequency: ["rent", "payable", "monthly", "quarterly", "annually"],
    escalation_rate: ["escalation", "increase", "annual increase", "cpi", "percent"],
    free_rent_months: ["free rent", "abatement", "rent abatement", "rent-free"],
    renewal_notice_months: ["renewal", "notice", "option", "extend"],
    termination_notice_months: ["termination", "notice", "cancel"],
    hvac_responsibility: ["hvac", "heating", "cooling", "air conditioning", "mechanical"],
    gross_up_threshold: ["gross up", "gross-up", "occupancy"],
  };
  return keywords[fieldKey] || [];
}

function sourceNeedlesForValue(value: unknown, fieldKey: string, fieldType?: string) {
  const needles: string[] = [];
  const push = (candidate: unknown) => {
    const text = cleanEvidenceSnippet(candidate);
    if (!text) return;
    const lower = text.toLowerCase();
    if (/^(unknown|n\/a|na|none|null|tbd|not specified|not applicable)$/.test(lower)) return;
    if (/^[a-z]+(?:_[a-z]+)+$/.test(lower)) return;
    if (!needles.includes(text)) needles.push(text);
  };

  const raw = cleanEvidenceSnippet(value);
  push(raw);

  const numeric = Number(raw.replace(/[$,%\s,]/g, ""));
  if (Number.isFinite(numeric) && numeric > 0) {
    const allowSmallNumber =
      ["square_footage", "rentable_area_sqft", "tenant_rsf", "suite_number", "unit_number"].includes(fieldKey) ||
      /(rent|amount|deposit|fee|percent|pct|rate|cap|share|rsf|sqft|sf)/i.test(fieldKey);
    if (numeric >= 1000 || allowSmallNumber) {
      push(String(numeric));
      push(numeric.toLocaleString("en-US"));
      push(`$${numeric.toLocaleString("en-US")}`);
      push(`$${numeric.toFixed(2)}`);
      push(`${numeric.toLocaleString("en-US")}.00`);
    }
  }

  if ((fieldType === "date" || /date$/.test(fieldKey)) && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T00:00:00Z`);
    if (!Number.isNaN(date.getTime())) {
      const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const month = date.getUTCMonth();
      const day = date.getUTCDate();
      const year = date.getUTCFullYear();
      push(`${months[month]} ${day}, ${year}`);
      push(`${months[month].slice(0, 3)} ${day}, ${year}`);
      push(`${month + 1}/${day}/${year}`);
      push(`${String(month + 1).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`);
    }
  }

  if (typeof value === "string") {
    push(raw.replace(/[,.]+$/, ""));
  }

  return needles;
}

function sourceTextSupportsValue(sourceText: unknown, value: unknown, fieldKey: string, fieldType?: string) {
  const haystack = cleanEvidenceSnippet(sourceText).toLowerCase();
  if (!haystack || isBlank(value)) return false;
  return sourceNeedlesForValue(value, fieldKey, fieldType).some((needle) =>
    haystack.includes(needle.toLowerCase()),
  );
}

function expandEvidenceSnippet(text: string, matchStart: number, matchLength: number) {
  const snippet = boundedSourceSnippet(text, matchStart, matchLength);
  if (snippet) return { snippet, quality: "exact" as const };
  // Fallback: return just the line that contains the matched value. This covers
  // signature blocks, parties sections, and other label:value rows that don't
  // end in sentence-boundary punctuation but are still valid source evidence.
  const lineStart = text.lastIndexOf("\n", matchStart) + 1;
  const lineEnd = text.indexOf("\n", matchStart + matchLength);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim();
  if (line && line.length >= 2 && line.length <= 300 && !line.includes("________________")) {
    return { snippet: line, quality: "partial" as const };
  }
  return { snippet: "", quality: "partial" as const };
}

function findSourceEvidenceForField(
  doclingRaw: Record<string, unknown> | null | undefined,
  fieldKey: string,
  value: unknown,
  fieldDef?: Record<string, unknown>,
) {
  if (isBlank(value)) return null;
  const needles = sourceNeedlesForValue(value, fieldKey, String(fieldDef?.type ?? ""));
  if (needles.length === 0) return null;
  const blocks = buildEvidenceSearchBlocks(doclingRaw);
  const keywords = fieldSourceKeywords(fieldKey);
  let best: any = null;

  for (const needle of needles) {
    const loweredNeedle = needle.toLowerCase();
    for (const block of blocks) {
      const hit = block.lowered.indexOf(loweredNeedle);
      if (hit < 0) continue;
      const before = hit === 0 ? "" : block.lowered[hit - 1];
      const after = block.lowered[hit + loweredNeedle.length] || "";
      const isWordChar = (char: string) => /[a-z0-9]/.test(char);
      if (isWordChar(before) && isWordChar(after)) continue;

      const { snippet, quality } = expandEvidenceSnippet(block.text, hit, needle.length);
      if (!snippet || isGenericSourceText(snippet)) continue;

      const loweredSnippet = snippet.toLowerCase();
      const hasKeyword = keywords.length === 0 || keywords.some((keyword) => loweredSnippet.includes(keyword));
      const needleIsBroadNumber = /^\d{1,4}$/.test(loweredNeedle);
      if (needleIsBroadNumber && !hasKeyword) continue;
      const verifiedPage = findPageForSnippet(doclingRaw, snippet);

      const score =
        needle.length +
        (quality === "exact" ? 30 : 10) +
        (hasKeyword ? 25 : 0) +
        (verifiedPage != null ? 18 : 0) +
        (block.source === "page" ? 12 : block.source === "text_block" ? 10 : 0) +
        (block.source === "docling_field" ? -8 : 0);
      if (!best || score > best.score) {
        best = {
          source_page: verifiedPage,
          source_clause: snippet.slice(0, 700),
          source_quality: quality,
          matched_needle: needle,
          score,
        };
      }
    }
  }

  return best
    ? {
      source_page: best.source_page,
      source_clause: best.source_clause,
      source_quality: best.source_quality,
      matched_needle: best.matched_needle,
    }
    : null;
}

function workflowFieldFor(fieldKey: string, leaseFields: Record<string, any> = {}) {
  const aliases: Record<string, string[]> = {
    property_address: ["property_address", "premises_address"],
    square_footage: ["square_footage", "rentable_area_sqft", "tenant_rsf"],
    tenant_name: ["tenant_name", "assignee_name"],
    commencement_date: ["commencement_date", "start_date"],
    start_date: ["start_date", "commencement_date"],
    annual_rent: ["annual_rent", "amended_base_rent_for_additional_year"],
    monthly_rent: ["monthly_rent", "base_rent_monthly"],
    billing_frequency: ["billing_frequency", "rent_frequency"],
    expiration_date: ["expiration_date", "end_date", "amended_expiration_date"],
    end_date: ["end_date", "expiration_date", "amended_expiration_date"],
    admin_fee_pct: ["admin_fee_pct", "admin_fee_percent"],
    gross_up_threshold: ["gross_up_threshold", "gross_up_percent", "gross_up_target_occupancy_pct"],
    cam_cap_pct: ["cam_cap_pct", "cam_cap_percent", "cap_percent"],
    responsibility_taxes: ["responsibility_taxes", "tax_responsibility"],
    responsibility_insurance: ["responsibility_insurance", "insurance_responsibility"],
    responsibility_utilities: ["responsibility_utilities", "utilities_responsibility"],
    responsibility_repairs: ["responsibility_repairs", "maintenance_responsibility"],
  };
  for (const key of aliases[fieldKey] || [fieldKey]) {
    if (leaseFields?.[key]) return leaseFields[key];
  }
  return leaseFields?.[fieldKey] ?? null;
}

function expectedAliasesForTrace(fieldKey: string): string[] {
  const aliases: Record<string, string[]> = {
    base_rent_per_sf_year: ["rent_per_sf", "base_rent_per_sf_year", "tenant_rent_per_rsf"],
    rent_per_sf: ["rent_per_sf", "base_rent_per_sf_year", "tenant_rent_per_rsf"],
    responsibility_taxes: ["responsibility_taxes", "tax_responsibility", "taxes_responsibility"],
    taxes_responsibility: ["responsibility_taxes", "tax_responsibility", "taxes_responsibility"],
    responsibility_insurance: ["responsibility_insurance", "insurance_responsibility"],
    insurance_responsibility: ["responsibility_insurance", "insurance_responsibility"],
    responsibility_utilities: ["responsibility_utilities", "utilities_responsibility"],
    utilities_responsibility: ["responsibility_utilities", "utilities_responsibility"],
    responsibility_repairs: ["responsibility_repairs", "maintenance_responsibility", "repairs_maintenance_responsibility"],
    repairs_maintenance_responsibility: ["responsibility_repairs", "maintenance_responsibility", "repairs_maintenance_responsibility"],
    monthly_rent: ["monthly_rent", "base_rent_monthly"],
    annual_rent: ["annual_rent", "base_rent_annual", "amended_base_rent_for_additional_year"],
    billing_frequency: ["billing_frequency", "rent_frequency"],
    lease_type: ["lease_type", "expense_structure", "lease_structure"],
    cam_cap_pct: ["cam_cap_pct", "cam_cap_percent", "cap_percent"],
    admin_fee_pct: ["admin_fee_pct", "admin_fee_percent"],
    gross_up_enabled: ["gross_up_enabled", "gross_up_applicable", "gross_up_allowed"],
    gross_up_threshold: ["gross_up_threshold", "gross_up_percent", "gross_up_target_occupancy_pct"],
  };
  return [...new Set([fieldKey, ...(aliases[fieldKey] || [])])];
}

function groupForTrace(fieldKey: string, moduleType: string): string | null {
  const normalized = toExtractionModuleType(moduleType);
  for (const group of getFieldGroups(normalized)) {
    if (group.fields.includes(fieldKey)) return group.name;
    if (expectedAliasesForTrace(fieldKey).some((alias) => group.fields.includes(alias))) return group.name;
  }
  return null;
}

function getByAliases(map: Record<string, any> | null | undefined, aliases: string[]) {
  if (!map || typeof map !== "object") return { key: null, value: null };
  for (const alias of aliases) {
    if (map[alias] !== undefined && map[alias] !== null) return { key: alias, value: map[alias] };
  }
  return { key: null, value: null };
}

function deriveTraceBlankReason(trace: Record<string, any>) {
  if (!trace.rendered_in_tab) return "dynamic_row_filter_hidden";
  if (trace.resolver_found_value) {
    if (trace.resolver_status === "missing_source_evidence") return "missing_source_evidence";
    if (trace.resolver_status === "calculated") return "calculated_but_not_allowed";
    return null;
  }
  if (!trace.requested_from_llm) return "not_requested_from_llm";
  if (!trace.llm_returned_aliases?.length) return "llm_did_not_return";
  if (trace.validator_status === "rejected") return "validator_rejected";
  if (trace.llm_returned_aliases?.length && !trace.mapped_to_workflow_field) return "returned_under_unmapped_alias";
  if (trace.mapped_to_workflow_field && !trace.persisted_to_extraction_data) return "persisted_under_wrong_key";
  if (trace.persisted_to_extraction_data && !trace.resolver_found_value) return "resolver_alias_missing";
  return "unknown";
}

function buildFieldTraceForRecord({
  standardFields,
  workflowOutput,
  pipelineDebug,
  moduleType,
}: {
  standardFields: any[];
  workflowOutput: any;
  pipelineDebug: Record<string, any>;
  moduleType: string;
}) {
  const requested = new Set(pipelineDebug.llm_requested_fields || []);
  const llmDetails = pipelineDebug.llm_returned_field_details || {};
  const validatorStatus = pipelineDebug.validator_field_status || {};
  const validatorReasons = pipelineDebug.validator_rejection_reasons || {};
  const leaseFields = workflowOutput?.lease_fields || {};
  const persistedFields = Object.fromEntries((standardFields || []).map((field) => [field.field_key, field]));

  return (standardFields || []).map((field) => {
    const aliases = expectedAliasesForTrace(field.field_key);
    const llmMatches = aliases.filter((alias) => llmDetails[alias] && llmDetails[alias].value != null);
    const llmFirst = llmMatches.length ? llmDetails[llmMatches[0]] : null;
    const workflowMatch = getByAliases(leaseFields, aliases);
    const persistedMatch = getByAliases(persistedFields, aliases);
    const persistedField = persistedMatch.value;
    const trace = {
      field_key: field.field_key,
      display_label: field.label || humanizeFieldName(field.field_key),
      group: groupForTrace(field.field_key, moduleType),
      expected_aliases: aliases,
      requested_from_llm: aliases.some((alias) => requested.has(alias)),
      llm_returned_aliases: llmMatches,
      llm_raw_value: llmFirst?.value ?? null,
      llm_source_text: llmFirst?.source_text ?? null,
      llm_source_page: llmFirst?.source_page ?? null,
      validator_status: getByAliases(validatorStatus, aliases).value || "not_seen",
      validator_rejection_reason: getByAliases(validatorReasons, aliases).value || null,
      mapped_to_workflow_field: Boolean(workflowMatch.value && workflowMatch.value.value != null),
      workflow_value: workflowMatch.value?.value ?? null,
      workflow_source_text: workflowMatch.value?.source_clause ?? workflowMatch.value?.source_text ?? null,
      workflow_source_page: workflowMatch.value?.source_page ?? null,
      persisted_to_extraction_data: Boolean(persistedField && persistedField.value != null),
      persisted_value: persistedField?.value ?? null,
      resolver_found_value: Boolean(field.value != null && field.value !== ""),
      resolver_value: field.value ?? null,
      resolver_status: field.status ?? field.extraction_status ?? null,
      rendered_in_tab: true,
      final_blank_reason: null,
    };
    trace.final_blank_reason = deriveTraceBlankReason(trace);
    return trace;
  });
}

function summarizeFieldTrace(fieldTrace: any[]) {
  const missing = fieldTrace.filter((trace) => trace.final_blank_reason);
  const missingByReason = missing.reduce((acc: Record<string, number>, trace) => {
    acc[trace.final_blank_reason] = (acc[trace.final_blank_reason] || 0) + 1;
    return acc;
  }, {});
  return {
    field_trace: fieldTrace,
    missing_fields_count: missing.length,
    missing_by_reason: missingByReason,
    top_20_missing_fields: missing.slice(0, 20).map((trace) => ({
      field_key: trace.field_key,
      display_label: trace.display_label,
      reason: trace.final_blank_reason,
    })),
  };
}

/**
 * Fast, low-cost payload built directly from rule/table/LLM values — no
 * workflow abstraction (buildLeaseWorkflowAbstraction), no clause records,
 * no per-field evidence-page verification. Persisted immediately after
 * runExtractionPipeline succeeds, before the expensive buildReviewPayload()
 * call below (which runs the full workflow/clause/evidence pass for every
 * field — the measured hotspot behind "not enough compute resources" on long
 * Azure-parsed leases). If the process dies anywhere between here and the
 * final full-payload persist, this durable payload already has real
 * extracted values and is visible in the UI instead of being lost with the
 * whole request — the worker's reconciliation logic finds a non-fallback
 * payload already exists and completes the job rather than parking it as
 * manual_review_fallback.
 */
function buildMinimalReviewPayload(opts: {
  fileId: string;
  fileName: string;
  moduleType: string;
  documentSubtype: string | null;
  extractionMethod: string | null;
  reviewRequired: boolean;
  result: {
    rows: Record<string, unknown>[];
    method: string;
    warnings: string[];
    validationErrors: unknown[];
    metadata: Record<string, unknown>;
  };
}) {
  const { fileId, fileName, moduleType, documentSubtype, extractionMethod, reviewRequired, result } = opts;
  const extractionModuleType = toExtractionModuleType(moduleType);
  const schema = getSchema(extractionModuleType);
  const schemaEntries = Object.entries(schema).filter(([, def]) => !def.derived);
  const requiredFields = schemaEntries.filter(([, def]) => def.required).map(([key]) => key);
  const avgConfidence = normalizeConfidence(result.metadata?.avgConfidence);
  const source = sourceFromMethod(extractionMethod ?? result.method);

  // P0.2: evidence-index resolution (buildReviewPayload's expensive pass)
  // hasn't run yet at this point, but the pipeline already computed a cheap,
  // pre-validation snapshot of per-field source_page/source_text/confidence
  // during runExtractionPipeline() itself — merged_field_sources (post-merge,
  // pre-validation) and llm_returned_field_details (raw LLM output) are both
  // always present by the time this function runs. Hydrate from them instead
  // of hard-coding evidence: null, so the minimal (fast, durable) payload is
  // already useful for review before the deferred "enrich" pass ever runs.
  const extractionDebug = (result.metadata as any)?.extractionDebug ?? {};
  const mergedFieldSources = (extractionDebug.merged_field_sources ?? {}) as Record<string, any>;
  const llmReturnedFieldDetails = (extractionDebug.llm_returned_field_details ?? {}) as Record<string, any>;

  const rows = result.rows.map((r, index) => {
    const values = stripInternalKeys(r);
    const fieldConfidences = (r._field_confidences ?? {}) as Record<string, number>;
    const fieldSources = (r._field_sources ?? {}) as Record<string, string>;
    const rowConfidence = normalizeConfidence(r.confidence_score ?? result.metadata?.avgConfidence) ?? avgConfidence;

    const standardFields = schemaEntries.map(([fieldKey, def]) => {
      const value = cleanPartyAddressValue(fieldKey, values[fieldKey] ?? null);
      const debugEvidence = mergedFieldSources[fieldKey] ?? llmReturnedFieldDetails[fieldKey] ?? null;
      const sourceText = debugEvidence?.source_text ?? null;
      const sourcePage = debugEvidence?.source_page ?? null;
      const hasEvidence = !!(sourceText || sourcePage != null);
      const effectiveConfidence =
        normalizeConfidence(fieldConfidences[fieldKey]) ??
        normalizeConfidence(debugEvidence?.confidence) ??
        rowConfidence;

      let status: string;
      if (value == null || value === "") {
        status = "missing";
      } else if (hasEvidence && typeof effectiveConfidence === "number" && effectiveConfidence >= 0.9) {
        // System-computed suggestion only — buildReviewField always sets
        // accepted:false; acceptance is a separate, reviewer-driven action
        // (guarantee 6), never implied by this status.
        status = "auto_populated";
      } else if (!hasEvidence) {
        status = "needs_review";
      } else {
        status = "pending_enrichment";
      }

      return buildReviewField({
        recordIndex: index,
        fieldKey,
        value,
        confidence: effectiveConfidence,
        source: fieldSources[fieldKey] ?? debugEvidence?.source ?? source,
        isStandard: true,
        required: !!def.required,
        fieldType: def.type ?? "string",
        description: def.description,
        evidence: hasEvidence ? { source_text: sourceText, source_page: sourcePage, source_quality: "pending_enrichment" } : null,
        status,
        editable: true,
      });
    });

    const missingRequired = requiredFields.filter((field) => isBlank(values[field]));

    return {
      row_index: index,
      record_index: index,
      values,
      fields: Object.fromEntries(
        standardFields.map((field) => [field.field_key, {
          value: field.value,
          confidence: field.confidence,
          source: field.source,
          evidence: field.evidence,
          status: field.status,
        }]),
      ),
      standard_fields: standardFields,
      custom_fields: [],
      missing_required: missingRequired,
      rejected_fields: [],
      warnings: missingRequired.length > 0
        ? [`Missing required fields: ${missingRequired.join(", ")}`]
        : [],
      confidence: rowConfidence,
      notes: (r.extraction_notes as string | undefined) ?? null,
      workflow_output: null,
    };
  });

  const userWarnings = filterUserWarnings(result.warnings, result.rows.length);
  const coreReady = computeCoreReady(rows[0]?.standard_fields ?? []);

  return {
    schema_version: 2,
    file_id: fileId,
    file_name: fileName,
    module_type: moduleType,
    document_subtype: documentSubtype,
    extraction_method: extractionMethod ?? result.method,
    pipeline_method: result.method,
    avg_confidence: avgConfidence,
    review_required: reviewRequired,
    review_status: "pending",
    enrichment_status: "pending",
    // P0.2 guarantees 4 & 5: the backend, not the frontend, is the source of
    // truth for whether this file is ready to open for review, and the
    // minimal payload stamps its own contract version directly rather than
    // relying solely on the (also-present, unconditional) nested
    // metadata.extractionDebug.extraction_contract_version.
    core_ready: coreReady,
    records: rows,
    rows,
    global_warnings: userWarnings,
    warnings: userWarnings,
    validation_errors: result.validationErrors,
    metadata: {
      ...(result.metadata ?? {}),
      extraction_contract_version: "lease-review-evidence-v3",
    },
    built_at: new Date().toISOString(),
  };
}

/**
 * Build the review payload consumed by the frontend review screen.
 * Structured so the UI can render a field-by-field grid with source and
 * confidence badges, and so we can diff it after the reviewer edits.
 */
function buildReviewPayload(opts: {
  fileId: string;
  fileName: string;
  moduleType: string;
  documentSubtype: string | null;
  extractionMethod: string | null;
  reviewRequired: boolean;
  doclingRaw?: Record<string, unknown> | null;
  result: {
    rows: Record<string, unknown>[];
    method: string;
    warnings: string[];
    validationErrors: unknown[];
    metadata: Record<string, unknown>;
  };
}) {
  const { fileId, fileName, moduleType, documentSubtype, extractionMethod, reviewRequired, doclingRaw, result } = opts;
  const extractionModuleType = toExtractionModuleType(moduleType);
  const schema = getSchema(extractionModuleType);
  const schemaEntries = Object.entries(schema)
    .filter(([, def]) => !def.derived);
  const schemaKeys = new Set(schemaEntries.map(([key]) => key));
  const standardAliases = buildStandardAliases(schema);
  const requiredFields = schemaEntries
    .filter(([, def]) => def.required)
    .map(([key]) => key);
  const avgConfidence = normalizeConfidence(result.metadata?.avgConfidence);
  const source = sourceFromMethod(extractionMethod ?? result.method);
  // §7: genuinely unmapped-but-valued LLM keys, built once from the flat/
  // global pipeline diagnostics (not per-row — a pre-existing limitation of
  // these two debug fields) and passed only for the first/only row.
  const reviewExtractionDebug = (result.metadata as any)?.extractionDebug ?? {};
  const unmappedLlmKeys: string[] = Array.isArray(reviewExtractionDebug.unmapped_llm_keys)
    ? reviewExtractionDebug.unmapped_llm_keys
    : [];
  const llmReturnedFieldDetailsForUnmapped = (reviewExtractionDebug.llm_returned_field_details ?? {}) as Record<string, any>;
  const unmappedLlmFields = unmappedLlmKeys
    .map((key) => {
      const detail = llmReturnedFieldDetailsForUnmapped[key];
      return {
        key,
        value: detail?.value ?? null,
        sourceText: detail?.source_text ?? null,
        sourcePage: detail?.source_page ?? null,
        confidence: detail?.confidence ?? null,
      };
    })
    .filter((f) => f.value != null && f.value !== "");
  // vertex_fact_ledger diagnostics (undefined for legacy_hybrid — both
  // spreads below become no-ops, preserving existing behavior exactly).
  const vertexFactLedgerDebug = (reviewExtractionDebug as any)?.vertex_fact_ledger ?? null;
  const workflowOutputs = extractionModuleType === "lease"
    ? result.rows.map((row, rowIndex) =>
      buildLeaseWorkflowAbstraction({
        row,
        doclingRaw: doclingRaw ?? null,
        documentSubtype,
        ...(rowIndex === 0 ? { unmappedLlmFields } : {}),
        ...(vertexFactLedgerDebug?.document_profile ? { documentProfileOverride: vertexFactLedgerDebug.document_profile } : {}),
        ...(rowIndex === 0 && Array.isArray(vertexFactLedgerDebug?.dynamic_items)
          ? { factLedgerDynamicItems: vertexFactLedgerDebug.dynamic_items }
          : {}),
      })
    )
    : [];
  const rows = result.rows.map((r, index) => {
    const values = stripInternalKeys(r);
    if ((moduleType === "leases" || moduleType === "lease") && isBlank(values.notes)) {
      const camNote = extractCamNoteFromText(doclingRaw);
      if (camNote) values.notes = camNote;
    }
    const fieldConfidences = (r._field_confidences ?? {}) as Record<string, number>;
    const fieldSources = (r._field_sources ?? {}) as Record<string, string>;
    const fieldEvidence = (r._field_evidence ?? {}) as Record<string, { source_text?: string | null; source_page?: number | null }>;
    const rowConfidence = normalizeConfidence(
      r.confidence_score ?? result.metadata?.avgConfidence,
    ) ?? avgConfidence;
    const workflowOutput = workflowOutputs[index] ?? null;
    const standardFields = schemaEntries.map(([fieldKey, def]) => {
      const workflowField = workflowFieldFor(fieldKey, workflowOutput?.lease_fields ?? {});
      const rawValue = values[fieldKey] ?? workflowField?.value ?? null;
      let value = cleanPartyAddressValue(fieldKey, rawValue);
      // Guard: reject month names extracted as person contact names
      if (typeof value === "string" && fieldKey.endsWith("_name")) {
        const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
        if (MONTH_NAMES.includes(value.trim().toLowerCase())) value = null;
      }
      // Guard: reject property_name values that are clause fragments containing "tenant"
      if (typeof value === "string" && fieldKey === "property_name" && /\btenant\b/i.test(value)) {
        value = null;
        // Clear LLM evidence so the rejected extraction's garbage source text
        // doesn't appear in the UI for a null field. fieldEvidence is read at
        // line 963, after this guard, so the reassignment takes effect.
        if (fieldEvidence[fieldKey]) {
          fieldEvidence[fieldKey] = { source_text: null, source_page: null };
        }
        // Clear the workflow review_reason so the UI doesn't show a validation
        // message for a field whose value we are actively nulling out.
        const wfField = workflowOutput?.lease_fields?.[fieldKey];
        if (wfField) {
          wfField.review_reason = null;
          wfField.requires_review = false;
          wfField.approval_blocking_reason = null;
        }
      }
      // Numbered-list / parties-clause fallback: when LLM misses a party identity
      // field, scan docling text directly with multiple patterns in priority order.
      // Pattern A: "2. Landlord: VALUE"  (numbered summary)
      // Pattern B: "by and between VALUE ("Landlord")"  (parties clause — quote-agnostic)
      // Pattern C: "Landlord: VALUE"  (simple label)
      // tenant_name Pattern B captures the name between (Landlord) and (Tenant).
      if (value == null && doclingRaw && (fieldKey === "landlord_name" || fieldKey === "tenant_name")) {
        const PARTY_PATTERNS: Record<string, RegExp[]> = {
          landlord_name: [
            /(?:^|\n)\s*\d+[.)]\s*Landlord\s*[:\-]\s*(.+?)(?=\s*\n\s*\d+[.)]|\n\s*\n|$)/im,
            /by\s+and\s+between\s+(.+?)\s*\([^)]*Landlord[^)]*\)/i,
            /^Landlord\s*[:\-]\s*(.+?)$/im,
          ],
          tenant_name: [
            /(?:^|\n)\s*\d+[.)]\s*Tenant\s*[:\-]\s*(.+?)(?=\s*\n\s*\d+[.)]|\n\s*\n|$)/im,
            /\([^)]*Landlord[^)]*\)\s+and\s+(.+?)\s*\([^)]*Tenant[^)]*\)/i,
            /^Tenant\s*[:\-]\s*(.+?)$/im,
          ],
        };
        const blocks = buildEvidenceSearchBlocks(doclingRaw);
        const fullText = blocks.map((b: { text: string }) => b.text).join("\n");
        for (const pattern of PARTY_PATTERNS[fieldKey] ?? []) {
          const match = fullText.match(pattern);
          if (match?.[1]) {
            const candidate = match[1].trim().replace(/\s*\d+[.)]\s*$/, "").trim();
            if (candidate.length >= 2 && candidate.length < 120) { value = candidate; break; }
          }
        }
      }
      // Prefer evidence produced by the LLM/rule extractor; fall back to the
      // workflow's snippet match. This is what makes Raw Extracted / Source
      // Page / Exact Source Text light up in the Lease Review table.
      const llmEvidence = fieldEvidence[fieldKey];
      // Reject LLM source text that is irrelevant to this field's domain
      const rawLlmSourceText = usableSourceText(llmEvidence?.source_text);
      const llmSourceText = isLlmSourceTextRelevantToField(fieldKey, rawLlmSourceText)
        ? rawLlmSourceText
        : null;
      const workflowSourceText = usableSourceText(workflowField?.source_clause);
      const fallbackEvidence = !isBlank(value)
        ? findSourceEvidenceForField(doclingRaw, fieldKey, value, def)
        : null;
      const fallbackSourceText = usableSourceText(fallbackEvidence?.source_clause);
      // Workflow and LLM source texts are already selected from the actual lease
      // document (clause extraction / LLM verbatim quote), so trust them directly.
      // The fallback path uses strict needle-in-haystack search, so it already
      // verifies relevance. Applying sourceTextSupportsValue to workflow/llm was
      // discarding valid source snippets whenever the extracted value appeared in
      // a slightly different form (e.g. "Triple Net" vs "NNN", "five percent" vs "5").
      const evidenceCandidates = [
        { source: "fallback", sourceText: fallbackSourceText, sourcePage: fallbackEvidence?.source_page, supportsValue: !!fallbackSourceText },
        { source: "workflow", sourceText: workflowSourceText, sourcePage: workflowField?.source_page, supportsValue: !!workflowSourceText },
        { source: "llm", sourceText: llmSourceText, sourcePage: llmEvidence?.source_page, supportsValue: !!llmSourceText },
      ]
        .filter((candidate) => candidate.sourceText && candidate.supportsValue)
        .map((candidate) => ({
          ...candidate,
          verifiedPage: resolveVerifiedSourcePage(doclingRaw, candidate.sourceText, candidate.sourcePage),
        }))
        .filter((candidate) => candidate.verifiedPage != null)
        .sort((a, b) => {
          // Prefer LLM verbatim quotes first — the LLM was instructed to copy
          // exact text from the document. The fallback (findSourceEvidenceForField)
          // searches for the raw value anywhere in the doc and can land on a
          // semantically unrelated section (e.g. finding "5" in a signage clause
          // when looking for a 5% admin fee). LLM evidence is therefore more
          // trustworthy; fallback is the last resort.
          const score = (candidate: any) =>
            (candidate.verifiedPage != null ? 100 : 0) +
            (candidate.source === "llm" ? 20 : candidate.source === "workflow" ? 10 : 0) +
            Math.min(String(candidate.sourceText ?? "").length, 240) / 240;
          return score(b) - score(a);
        });
      const selectedEvidence = evidenceCandidates[0] ?? null;
      const rawSourceText = selectedEvidence?.sourceText ?? null;
      const mergedSourceText = capSourceText(rawSourceText);
      const mergedSourcePage = selectedEvidence?.verifiedPage ?? null;
      const hasEvidence = typeof mergedSourceText === "string" && mergedSourceText.length > 0 && mergedSourcePage != null;
      const effectiveConfidence = normalizeConfidence(fieldConfidences[fieldKey]) ?? rowConfidence;
      let inferredStatus = value == null || value === ""
        ? "missing"
        : workflowField?.extraction_status === "calculated"
          ? "calculated"
          : hasEvidence
            ? "extracted"
            : "missing_source_evidence";
      // Low-confidence gate: never present a low-confidence value as a
      // confirmed extraction. Downgrade to needs_review so the UI shows the
      // value as a reviewer candidate, not a green Extracted badge.
      if (
        (inferredStatus === "extracted" || workflowField?.extraction_status === "extracted") &&
        typeof effectiveConfidence === "number" &&
        effectiveConfidence < 0.55
      ) {
        inferredStatus = "needs_review";
      }
      const workflowStatus = String(workflowField?.extraction_status ?? "").toLowerCase();
      const finalStatus =
        inferredStatus === "needs_review"
          ? "needs_review"
          : workflowStatus === "calculated"
            ? "calculated"
            : workflowStatus === "manual_required"
              ? "manual_required"
              : inferredStatus;
      return buildReviewField({
        recordIndex: index,
        fieldKey,
        value,
        confidence: effectiveConfidence,
        source: fieldSources[fieldKey] ?? source,
        isStandard: true,
        required: !!def.required,
        fieldType: def.type ?? "string",
        description: def.description,
        evidence: {
          page_number: mergedSourcePage,
          source_clause: mergedSourceText,
          source_quality: selectedEvidence?.source === "fallback" ? fallbackEvidence?.source_quality ?? null : null,
          matched_needle: selectedEvidence?.source === "fallback" ? fallbackEvidence?.matched_needle ?? null : null,
        },
        status: finalStatus,
        editable: workflowField?.editable ?? true,
        validationErrors: Array.isArray(workflowField?.validation_errors) ? workflowField.validation_errors : [],
      });
    });
    const customFieldsFromRows = Object.entries(values)
      .filter(([key, val]) => {
        if (schemaKeys.has(key)) return false;
        if (isInternalReviewKey(key)) return false;
        const normalized = normalizeKey(key);
        if (standardAliases.has(normalized)) return false;
        if (duplicatesStandardValue(key, val, values)) return false;
        if (looksLikeNoise(key, val)) return false;
        return true;
      })
      .map(([fieldKey, rawValue]) => {
        const value = tryNormalizeDateString(rawValue, fieldKey);
        return buildReviewField({
          recordIndex: index,
          fieldKey,
          value,
          confidence: normalizeConfidence(fieldConfidences[fieldKey]) ?? rowConfidence,
          source: fieldSources[fieldKey] ?? source,
          isStandard: false,
          required: false,
          fieldType: inferFieldType(value),
          description: "Useful extracted content that does not map to a standard field.",
        });
      });
    const customFieldsFromDocument = buildCustomFieldsFromDocument({
      doclingRaw,
      schema,
      schemaKeys,
      recordIndex: index,
      existingKeys: new Set(customFieldsFromRows.map((field) => normalizeKey(field.field_key))),
      standardValues: values,
    });
    const customFields = [...customFieldsFromRows, ...customFieldsFromDocument];
    const missingRequired = requiredFields.filter((field) => isBlank(values[field]));

    return {
      row_index: index,
      record_index: index,
      values,
      fields: Object.fromEntries(
        [...standardFields, ...customFields].map((field) => [
          field.field_key,
          {
            value: field.value,
            confidence: field.confidence,
            source: field.source,
            evidence: field.evidence,
            status: field.status,
          },
        ]),
      ),
      standard_fields: standardFields,
      custom_fields: customFields,
      missing_required: missingRequired,
      rejected_fields: [],
      warnings: missingRequired.length > 0
        ? [`Missing required fields: ${missingRequired.join(", ")}`]
        : [],
      confidence: rowConfidence,
      notes: (r.extraction_notes as string | undefined) ?? null,
      workflow_output: workflowOutput,
    };
  });

  const workflowSummary = extractionModuleType === "lease"
    ? {
      records: workflowOutputs,
      summary: {
        extracted_field_count: workflowOutputs.reduce((sum, item) => sum + (item?.summary?.extracted_field_count ?? 0), 0),
        calculated_field_count: workflowOutputs.reduce((sum, item) => sum + (item?.summary?.calculated_field_count ?? 0), 0),
        manual_required_count: workflowOutputs.reduce((sum, item) => sum + (item?.summary?.manual_required_count ?? 0), 0),
        conflict_count: workflowOutputs.reduce((sum, item) => sum + (item?.summary?.conflict_count ?? 0), 0),
        clause_count: workflowOutputs.reduce((sum, item) => sum + (item?.summary?.clause_count ?? 0), 0),
        extracted_document_item_count: workflowOutputs.reduce((sum, item) => sum + (item?.summary?.extracted_document_item_count ?? 0), 0),
        expense_rule_count: workflowOutputs.reduce((sum, item) => sum + (item?.summary?.expense_rule_count ?? 0), 0),
      },
    }
    : null;

  const userWarnings = filterUserWarnings(result.warnings, result.rows.length);

  return {
    schema_version: 2,
    file_id: fileId,
    file_name: fileName,
    module_type: moduleType,
    document_subtype: documentSubtype,
    extraction_method: extractionMethod ?? result.method,
    pipeline_method: result.method,
    avg_confidence: avgConfidence,
    review_required: reviewRequired,
    review_status: "pending",
    records: rows,
    rows,
    global_warnings: userWarnings,
    warnings: userWarnings,
    validation_errors: result.validationErrors,
    metadata: {
      ...(result.metadata ?? {}),
      workflow_output: workflowSummary,
    },
    built_at: new Date().toISOString(),
  };
}

function filterUserWarnings(warnings: string[] = [], rowCount = 0): string[] {
  const out: string[] = [];
  for (const warning of warnings) {
    const text = String(warning || "");
    if (rowCount > 0 && /no tables found/i.test(text)) continue;
    if (rowCount > 0 && /GOOGLE_SERVICE_ACCOUNT_KEY|VERTEX_PROJECT_ID|service account|private_key|JWT|Vertex AI|AI fallback|ANTHROPIC_API_KEY|GEMINI_API_KEY|Claude|No LLM configured/i.test(text)) {
      continue;
    }
    if (/GOOGLE_SERVICE_ACCOUNT_KEY|VERTEX_PROJECT_ID|service account|private_key|JWT|ANTHROPIC_API_KEY|GEMINI_API_KEY|No LLM configured/i.test(text)) {
      const sanitized = "AI fallback extraction is unavailable because Google Vertex AI is not fully configured. Deterministic document parsing still ran.";
      if (!out.includes(sanitized)) out.push(sanitized);
      continue;
    }
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

// HTML/markup fragments occasionally leak into extracted values (e.g. a
// table-cell dump misrouted into a field's plain-text value). No lease field
// is legitimately an HTML tag — reject rather than publish as a confident
// extraction. Applied once, centrally, in buildReviewField() so it covers
// every field shape (minimal fast-path payload, standard fields, custom
// fields) without touching each call site.
const MARKUP_VALUE_RE = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/i;

function rejectMarkupValue(value: unknown): boolean {
  return typeof value === "string" && MARKUP_VALUE_RE.test(value);
}

function buildReviewField(opts: {
  recordIndex: number;
  fieldKey: string;
  value: unknown;
  confidence: number | null;
  source: string;
  isStandard: boolean;
  required: boolean;
  fieldType: string;
  description?: string;
  evidence?: Record<string, unknown> | null;
  status?: string;
  editable?: boolean;
  validationErrors?: string[];
}) {
  const hasMarkup = rejectMarkupValue(opts.value);
  const effectiveValue = hasMarkup ? null : (opts.value ?? null);
  const blank = isBlank(effectiveValue);
  const status = hasMarkup ? "needs_review" : opts.status;
  const baseValidationErrors = Array.isArray(opts.validationErrors) ? opts.validationErrors : [];
  const validationErrors = hasMarkup
    ? [...baseValidationErrors, "Rejected: extracted value contained HTML/markup fragments"]
    : baseValidationErrors;
  return {
    id: `${opts.recordIndex}:${opts.isStandard ? "standard" : "custom"}:${opts.fieldKey}`,
    field_key: opts.fieldKey,
    label: humanizeFieldName(opts.fieldKey),
    value: effectiveValue,
    original_value: effectiveValue,
    field_type: opts.fieldType,
    description: opts.description ?? null,
    required: opts.required,
    is_standard: opts.isStandard,
    confidence: hasMarkup ? 0 : opts.confidence,
    source: blank ? "system" : opts.source,
    evidence: hasMarkup ? null : (opts.evidence ?? null),
    editable: opts.editable ?? true,
    extraction_status: status ?? (blank ? "not_found" : "extracted"),
    status: status ?? (blank ? "missing" : "pending"),
    validation_errors: validationErrors,
    accepted: false,
    rejected: false,
    user_edit: null,
  };
}

function stripInternalKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}

function isInternalReviewKey(key: string): boolean {
  return [
    "confidence_score",
    "extraction_notes",
    "_field_confidences",
    "_field_sources",
    "source",
    "warnings",
    "validation_errors",
  ].includes(key);
}

function buildCustomFieldsFromDocument(args: {
  doclingRaw?: Record<string, unknown> | null;
  schema: Record<string, any>;
  schemaKeys: Set<string>;
  recordIndex: number;
  existingKeys: Set<string>;
  standardValues: Record<string, unknown>;
}) {
  const { doclingRaw, schema, schemaKeys, recordIndex, existingKeys, standardValues } = args;
  if (!doclingRaw) return [];

  const standardAliases = buildStandardAliases(schema);
  const candidates: Array<{ key: string; value: unknown; confidence: number; source: string; sourceText?: string }> = [];

  for (const field of Array.isArray((doclingRaw as any).fields) ? (doclingRaw as any).fields : []) {
    const key = String(field?.key ?? field?.label ?? "").trim();
    const value = field?.value ?? field?.text ?? null;
    if (!key || isBlank(value)) continue;
    candidates.push({
      key,
      value,
      confidence: normalizeConfidence(field?.confidence) ?? 0.72,
      source: "document",
      sourceText: key && value != null ? `${key}: ${String(value)}` : undefined,
    });
  }

  const fullText = String((doclingRaw as any).full_text ?? "");
  for (const line of fullText.split(/\n/).slice(0, 300)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9 /&().#-]{2,48})\s*[:\-]\s*(.{2,160})\s*$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (!key || isBlank(value)) continue;
    candidates.push({ key, value, confidence: 0.6, source: "document_text", sourceText: line.trim() });
  }

  const out = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeKey(candidate.key);
    if (!normalized || schemaKeys.has(normalized)) continue;
    if (existingKeys.has(normalized) || seen.has(normalized)) continue;
    if (standardAliases.has(normalized)) continue;
    const normalizedValue = tryNormalizeDateString(candidate.value, candidate.key);
    if (duplicatesStandardValue(candidate.key, normalizedValue, standardValues)) continue;
    if (looksLikeNoise(candidate.key, normalizedValue)) continue;

    seen.add(normalized);
    out.push(
      buildReviewField({
        recordIndex,
        fieldKey: normalized,
        value: normalizedValue,
        confidence: candidate.confidence,
        source: candidate.source,
        isStandard: false,
        required: false,
        fieldType: inferFieldType(normalizedValue),
        description: "Extra field interpreted from the document and available for user approval.",
        evidence: candidate.sourceText
          ? { page_number: null, source_clause: candidate.sourceText }
          : null,
      }),
    );
    if (out.length >= 20) break;
  }

  return out;
}

function duplicatesStandardValue(key: string, value: unknown, standardValues: Record<string, unknown>) {
  const normalizedKey = normalizeKey(key);
  const normalizedValue = normalizeComparableValue(value);
  if (!normalizedValue) return false;

  if (/_(day|month|year)$/.test(normalizedKey)) {
    const baseKey = normalizedKey.replace(/_(day|month|year)$/, "");
    const candidateStandardKeys = [baseKey, `${baseKey}_date`];
    if (candidateStandardKeys.some((candidate) => !isBlank(standardValues[candidate]))) {
      return true;
    }
  }

  for (const standardValue of Object.values(standardValues)) {
    if (isBlank(standardValue)) continue;
    const comparable = normalizeComparableValue(standardValue);
    if (!comparable) continue;
    if (normalizedValue === comparable) return true;
    if (
      normalizedValue.length > 8 &&
      comparable.length > 8 &&
      (normalizedValue.includes(comparable) || comparable.includes(normalizedValue))
    ) {
      return true;
    }
  }

  return false;
}

function buildStandardAliases(schema: Record<string, any>) {
  const aliases = new Set<string>();
  for (const [fieldKey, def] of Object.entries(schema)) {
    aliases.add(normalizeKey(fieldKey));
    for (const label of def?.labels ?? []) aliases.add(normalizeKey(label));
    for (const header of def?.tableHeaders ?? []) aliases.add(normalizeKey(header));
  }
  return aliases;
}

function normalizeKey(key: string): string {
  return String(key)
    .trim()
    .toLowerCase()
    .replace(/[#%]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function normalizeComparableValue(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.;:]$/g, "");
}

function looksLikeNoise(key: string, value: unknown): boolean {
  // Arrays and objects cannot be meaningfully displayed as scalar custom fields
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) return true;
  const normalized = normalizeKey(key);
  if (!normalized || normalized.length < 4) return true;
  if (/\$[0-9]/.test(key)) return true;
  if (/(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec).*?\d{4}/i.test(key)) return true;
  if (/[0-9]+\.[0-9]+\s*\/?sf/i.test(key)) return true;
  if (/^https?$/.test(normalized)) return true;
  if (/^(before|after|the|and|or|with|without)_/.test(normalized)) return true;
  if (/^(signature|name|date)_[a-z0-9_]+$/.test(normalized)) return true;
  if (/^(move_in|inspection|checklist|instructions|terms|fixed_term_lease|tenant_initials|landlord_initials)/.test(normalized)) {
    return true;
  }
  if (["page", "date", "signature", "initials"].includes(normalized)) return false;
  if (/^(the|and|or|of|to|from|for|in|on|with)$/.test(normalized)) return true;
  const stringValue = String(value ?? "").trim();
  if (stringValue.length < 2) return true;
  if (stringValue.length > 240) return true;
  if (stringValue.includes("________________")) return true;
  if (/^(pro|cam|nnn|sf|psf)$/.test(normalized)) return true;
  if (/(common area maintenance|\bcam\b|pro[\s-]?rata)/i.test(`${key} ${stringValue}`)) return true;
  if (
    normalized.split("_").length >= 4 &&
    !/(tenant|landlord|property|address|rent|lease|deposit|cam|nnn|utility|water|sewer|electric|parking|pet|fee|reimbursement|insurance|tax)/i.test(normalized)
  ) {
    return true;
  }
  if (/^[a-z]/.test(stringValue) && normalized.length <= 10) return true;
  return false;
}

function extractCamNoteFromText(doclingRaw?: Record<string, unknown> | null): string | null {
  const text = String((doclingRaw as any)?.full_text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  const patterns = [
    /(?:pro[\s-]?rata[^.]{0,220}(?:common area maintenance|\bcam\b)[^.]{0,220}\.)/i,
    /(?:(?:common area maintenance|\bcam\b)[^.]{0,260}\.)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) {
      return match[0].replace(/\s+/g, " ").trim().slice(0, 300);
    }
  }

  return null;
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value <= 1) return Math.max(0, Math.min(1, value));
  return Math.max(0, Math.min(1, value / 100));
}

function sourceFromMethod(method: string | null): string {
  const lower = String(method ?? "").toLowerCase();
  if (lower.includes("vision") || lower.includes("ocr")) return "vision";
  if (lower.includes("llm") || lower.includes("gemini") || lower.includes("vertex")) return "llm";
  if (lower.includes("table")) return "table";
  return "rule";
}

function inferFieldType(value: unknown): string {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  return "string";
}

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, oct: 10, nov: 11, dec: 12,
};

function tryNormalizeDateString(value: unknown, fieldKey: string): unknown {
  if (typeof value !== "string") return value;
  if (!/(date|deadline|effective|expir|commence|start|sign)/i.test(fieldKey)) return value;
  const str = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return value;

  // "Month DD, YYYY" or "Month DD YYYY"
  const namedMonth = str.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (namedMonth) {
    const m = MONTH_NAMES[namedMonth[1].toLowerCase()];
    if (m) {
      const y = parseInt(namedMonth[3]);
      const d = parseInt(namedMonth[2]);
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  // "MM/DD/YYYY" or "MM/DD/YY" (US format)
  const usDate = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (usDate) {
    let y = parseInt(usDate[3]);
    if (y < 100) y += 2000;
    const m = parseInt(usDate[1]);
    const d = parseInt(usDate[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  return value;
}

function humanizeFieldName(fieldName: string): string {
  return fieldName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function countMeaningfulRowValues(rows: Array<Record<string, unknown>> | undefined | null): number {
  if (!Array.isArray(rows)) return 0;
  let count = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith("_")) continue;
      if (isInternalReviewKey(key)) continue;
      if (isBlank(value)) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      if (typeof value === "object" && value !== null) continue;
      count += 1;
    }
  }
  return count;
}

const ENRICH_READY_STATUSES = new Set(["review_required", "validated", "approved"]);

/**
 * §3 / P0.1: run the deferred evidence + clause pass (buildReviewPayload)
 * against an already-persisted normalized_output, without re-running
 * runExtractionPipeline (no re-parse, no re-LLM-call — guarantee 8) and
 * without ever touching uploaded_files.status or clobbering the core
 * standard_fields values on failure (guarantee 7).
 */
async function handleEnrichMode(args: {
  supabaseAdmin: any;
  orgId: string;
  fileId: string;
  pipelineJobId?: string | null;
  jsonResponse: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  const { supabaseAdmin, orgId, fileId, pipelineJobId, jsonResponse } = args;
  const logger = createLogger(supabaseAdmin, fileId, orgId);

  const { data: fileRecord, error: fetchError } = await supabaseAdmin
    .from("uploaded_files")
    .select(
      "id, org_id, file_name, module_type, status, review_required, document_subtype, " +
      "extraction_method, docling_raw, normalized_output, ui_review_payload, active_generation_id",
    )
    .eq("id", fileId)
    .eq("org_id", orgId)
    .single();

  if (fetchError || !fileRecord) {
    return jsonResponse(
      { error: true, message: `File not found: ${fetchError?.message ?? "Invalid file_id"}`, error_code: "FILE_NOT_FOUND" },
      404,
    );
  }

  // P0.3: generation fencing. This job may have been superseded by a newer
  // explicit re-extraction generation while it was queued/running — a stale
  // worker finishing this expensive pass late must not clobber a newer
  // generation's state. jobGenerationId is resolved once here; the actual
  // staleness check is re-done with a FRESH read right before each write
  // below (isEnrichGenerationStale), since the LLM call in between can take
  // minutes, during which a new generation can start. If pipelineJobId is
  // absent (older/legacy caller), the job's generation can't be resolved —
  // skip the check entirely rather than newly failing a call that never
  // provided the information needed to make it.
  let jobGenerationId: string | null = null;
  if (pipelineJobId) {
    const { data: jobRow } = await supabaseAdmin
      .from("pipeline_jobs")
      .select("generation_id")
      .eq("id", pipelineJobId)
      .maybeSingle();
    jobGenerationId = jobRow?.generation_id ?? null;
  }

  async function isEnrichGenerationStale(): Promise<boolean> {
    if (!jobGenerationId) return false;
    const { data: freshFile } = await supabaseAdmin
      .from("uploaded_files")
      .select("active_generation_id")
      .eq("id", fileId)
      .maybeSingle();
    return !!freshFile && freshFile.active_generation_id !== jobGenerationId;
  }

  if (!ENRICH_READY_STATUSES.has(fileRecord.status)) {
    return jsonResponse(
      {
        error: true,
        message: `File status must be one of review_required/validated/approved for enrichment. Current: '${fileRecord.status}'`,
        error_code: "INVALID_STATUS_FOR_ENRICH",
      },
      422,
    );
  }

  const currentPayload = (fileRecord.ui_review_payload ?? {}) as Record<string, unknown>;
  if (currentPayload.enrichment_status === "completed") {
    // Idempotent no-op — a duplicate/racing enrich dispatch should never
    // re-run the expensive pass twice.
    return jsonResponse({ error: false, file_id: fileId, enrichment_status: "completed", already_enriched: true });
  }

  const result = fileRecord.normalized_output as {
    rows: Record<string, unknown>[];
    method: string;
    warnings: string[];
    validationErrors: unknown[];
    metadata: Record<string, unknown>;
  } | null;
  if (!result || !Array.isArray(result.rows)) {
    return jsonResponse(
      { error: true, message: "No normalized_output found to enrich — run normalize first.", error_code: "NO_NORMALIZED_OUTPUT" },
      422,
    );
  }

  if (await isEnrichGenerationStale()) {
    console.log(`[normalize-pdf-output] enrich_stale_generation_skipped file_id=${fileId} job_id=${pipelineJobId} — superseded before starting`);
    return jsonResponse({ error: false, file_id: fileId, stale_generation: true });
  }

  console.log(`[normalize-pdf-output] enrichment_started file_id=${fileId}`);
  await supabaseAdmin
    .from("uploaded_files")
    .update({
      ui_review_payload: { ...currentPayload, enrichment_status: "running" },
      updated_at: new Date().toISOString(),
    })
    .eq("id", fileId);
  await logger.event("enrich", "running", {});

  try {
    const moduleType = fileRecord.module_type ?? "unknown";
    const fileName = fileRecord.file_name ?? "document";

    const enrichedPayload = buildReviewPayload({
      fileId,
      fileName,
      moduleType,
      documentSubtype: fileRecord.document_subtype ?? null,
      extractionMethod: fileRecord.extraction_method ?? null,
      reviewRequired: !!fileRecord.review_required,
      doclingRaw: fileRecord.docling_raw ?? null,
      result,
    }) as Record<string, any>;

    enrichedPayload.enrichment_status = "completed";
    enrichedPayload.core_ready =
      currentPayload.core_ready ?? computeCoreReady(enrichedPayload.records?.[0]?.standard_fields ?? []);
    if (enrichedPayload.metadata && typeof enrichedPayload.metadata === "object") {
      enrichedPayload.metadata.extraction_contract_version = "lease-review-evidence-v3";
    }

    const clauseCount = enrichedPayload.records?.[0]?.workflow_output?.lease_clauses?.length ?? 0;
    const sourceBackedCount = (enrichedPayload.records?.[0]?.standard_fields ?? []).filter(
      (f: any) => f?.evidence?.source_text || f?.evidence?.source_page != null,
    ).length;

    if (await isEnrichGenerationStale()) {
      console.log(`[normalize-pdf-output] enrich_stale_generation_skipped file_id=${fileId} job_id=${pipelineJobId} — superseded before persisting result, discarding stale output`);
      return jsonResponse({ error: false, file_id: fileId, stale_generation: true });
    }

    const { error: persistError } = await supabaseAdmin
      .from("uploaded_files")
      .update({ ui_review_payload: enrichedPayload, updated_at: new Date().toISOString() })
      .eq("id", fileId);
    if (persistError) {
      throw new Error(`Could not persist enriched payload: ${persistError.message}`);
    }

    console.log(
      `[normalize-pdf-output] enrichment_completed file_id=${fileId} clauses=${clauseCount} source_backed=${sourceBackedCount}`,
    );
    await logger.event("enrich", "completed", { metadata: { clauses: clauseCount, source_backed: sourceBackedCount } });

    // P0.5: re-evaluate and persist review_readiness now that enrichment
    // concluded — best-effort; a failure here must not fail the enrich
    // response itself (the enrichment result is already durably persisted
    // above). finalize_lease_extraction_for_review is safely re-callable
    // from any other terminal event, so this is not the only place it runs.
    try {
      await supabaseAdmin.rpc("finalize_lease_extraction_for_review", {
        p_org_id: orgId,
        p_uploaded_file_id: fileId,
        p_generation_id: jobGenerationId,
      });
    } catch (finalizeError: any) {
      console.warn(`[normalize-pdf-output] finalize_lease_extraction_for_review call failed file_id=${fileId}:`, finalizeError?.message ?? finalizeError);
    }

    return jsonResponse({
      error: false,
      file_id: fileId,
      enrichment_status: "completed",
      clauses: clauseCount,
      source_backed: sourceBackedCount,
    });
  } catch (enrichError: any) {
    const message = enrichError?.message ?? String(enrichError);
    console.error(`[normalize-pdf-output] enrichment_failed_preserved_core_payload file_id=${fileId}: ${message}`);
    // Never call setFailed()/touch uploaded_files.status and never overwrite
    // the core standard_fields — only patch enrichment_status, so the
    // minimal payload's real values stay fully visible (guarantee 7).
    if (await isEnrichGenerationStale()) {
      console.log(`[normalize-pdf-output] enrich_stale_generation_skipped file_id=${fileId} job_id=${pipelineJobId} — superseded before persisting failure, discarding stale write`);
      return jsonResponse({ error: false, file_id: fileId, stale_generation: true });
    }
    await supabaseAdmin
      .from("uploaded_files")
      .update({
        ui_review_payload: { ...currentPayload, enrichment_status: "failed", enrichment_error: message },
        updated_at: new Date().toISOString(),
      })
      .eq("id", fileId);
    await logger.event("enrich", "failed", { error_message: message });

    // P0.5: failed enrichment is a terminal event too — re-evaluate
    // readiness so review_readiness reflects ENRICHMENT_FAILED instead of
    // silently staying at whatever it was before this attempt.
    try {
      await supabaseAdmin.rpc("finalize_lease_extraction_for_review", {
        p_org_id: orgId,
        p_uploaded_file_id: fileId,
        p_generation_id: jobGenerationId,
      });
    } catch (finalizeError: any) {
      console.warn(`[normalize-pdf-output] finalize_lease_extraction_for_review call failed file_id=${fileId}:`, finalizeError?.message ?? finalizeError);
    }

    return jsonResponse({ error: true, message, error_code: "ENRICHMENT_FAILED" }, 500);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  // ── Auth guard ──────────────────────────────────────────────────────────────
  // Called from both browser (user JWT via ingest-file) and internally from
  // lease-extraction-worker (service-role Bearer + x-internal-service-key).
  // With verify_jwt=false the Supabase platform skips its own JWT check, so
  // we reject completely unauthenticated requests here before any DB work.
  const hasAnyAuth = Boolean(
    req.headers.get("Authorization") ||
    req.headers.get("x-worker-secret") ||
    req.headers.get("x-internal-service-key"),
  );
  if (!hasAnyAuth) {
    return jsonResponse(
      { ok: false, error_code: "UNAUTHORIZED_NORMALIZE_CALL", message: "Unauthorized normalization request" },
      401,
    );
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);

    const body = await req.json().catch(() => ({}));
    const { file_id, dry_run, sample_text, job_id, pipeline_job_id, worker_attempt, mode } = body;

    // dry_run=true: validate auth and optionally run extraction on sample_text.
    // No file_id required and no DB writes — used by pipeline-health-check.
    if (dry_run === true) {
      const hasVertex = !!(
        (Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID")) &&
        (Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || Deno.env.get("GOOGLE_PRIVATE_KEY"))
      );

      let extraction: Record<string, unknown> | null = null;
      if (typeof sample_text === "string" && sample_text.length > 0) {
        // Tier 1 (dry_run) live comparison support: an internal/service-role
        // caller may request vertex_fact_ledger for this one sample_text call
        // without touching the BUSINESS_EXTRACTION_PROVIDER project secret.
        // No uploaded_files row exists in this branch, so there is nothing to
        // write — this is the zero-DB-write comparison path.
        const dryRunProvider = resolveBusinessExtractionProvider(
          isInternalCall(req) ? (body as any)?.debug_business_extraction_provider : null,
        );
        try {
          const dryRunDocling = {
            full_text: sample_text,
            text_blocks: [],
            tables: [],
            fields: [],
            page_count: 1,
            extraction_method: "dry_run",
          };
          // Azure+Vertex Phase 4E: routed through the same orchestrator as the
          // real path so a dryRunProvider of vertex_primary_legacy_fallback
          // is handled correctly instead of silently falling to legacy (the
          // old two-branch ternary here had no third case).
          const result = await runBusinessExtraction({
            requestedProvider: dryRunProvider,
            moduleType: "lease",
            fileName: "dry_run_sample.txt",
            docling: dryRunDocling,
            documentSubtype: null,
            correlationId: "dry_run",
          });
      stampBusinessExtractionPersistedAt(result, new Date().toISOString());
          extraction = {
            rows: result.rows?.length ?? 0,
            method: result.method ?? "unknown",
            warnings: result.warnings ?? [],
            provider: dryRunProvider,
          };
        } catch (pipeErr: any) {
          extraction = { error: pipeErr?.message ?? String(pipeErr), provider: dryRunProvider };
        }
      }

      return jsonResponse({
        ok: true,
        dry_run: true,
        authenticated: true,
        llm: {
          vertex_configured: hasVertex,
        },
        ...(extraction !== null ? { extraction } : {}),
        message: "Auth verified. dry_run=true — no file processed, no DB writes.",
      });
    }

    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    if (!file_id) {
      return jsonResponse(
        { error: true, message: "file_id is required", error_code: "MISSING_FILE_ID" },
        400,
      );
    }

    // §3 / P0.1: the deferred evidence + clause pass. Deliberately handled as
    // an early, self-contained branch rather than threaded through the parse
    // flow below — it has different status requirements (review_required/
    // validated/approved, not pdf_parsed), reuses already-persisted
    // normalized_output instead of re-running runExtractionPipeline, and
    // must never call setFailed()/touch uploaded_files.status on error
    // (guarantee 7).
    if (mode === "enrich") {
      return await handleEnrichMode({ supabaseAdmin, orgId, fileId: file_id, pipelineJobId: pipeline_job_id || job_id, jsonResponse });
    }

    // Fetch only the columns this function actually uses.
    // SELECT * would also load ui_review_payload, normalized_output, parsed_data,
    // and reviewed_output from previous runs — each can be 1–3 MB — pushing the
    // Edge Function over the memory limit (546) before extraction even starts.
    const { data: fileRecord, error: fetchError } = await supabaseAdmin
      .from("uploaded_files")
      .select(
        "id, org_id, file_name, file_url, file_size, mime_type, module_type, " +
        "status, review_required, document_subtype, extraction_method, docling_raw",
      )
      .eq("id", file_id)
      .eq("org_id", orgId)
      .single();

    if (fetchError || !fileRecord) {
      return jsonResponse(
        {
          error: true,
          message: `File not found: ${fetchError?.message ?? "Invalid file_id"}`,
          error_code: "FILE_NOT_FOUND",
        },
        404,
      );
    }
    const logger = createLogger(supabaseAdmin, file_id, orgId);

    let finalPipelineJobId = pipeline_job_id || job_id;
    if (!finalPipelineJobId) {
      const { data: latestJob } = await supabaseAdmin
        .from("pipeline_jobs")
        .select("id")
        .eq("uploaded_file_id", file_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latestJob?.id) finalPipelineJobId = latestJob.id;
    }
    const extractionRunId = finalPipelineJobId || file_id;

    // Must be in pdf_parsed state
    if (fileRecord.status !== "pdf_parsed") {
      return jsonResponse(
        {
          error: true,
          message: `File status must be 'pdf_parsed'. Current: '${fileRecord.status}'`,
          error_code: "INVALID_STATUS",
        },
        422,
      );
    }

    if (!fileRecord.docling_raw) {
      return jsonResponse(
        {
          error: true,
          message: "No Docling output found. Run parse-pdf-docling first.",
          error_code: "NO_DOCLING_OUTPUT",
        },
        422,
      );
    }

    const moduleType = fileRecord.module_type ?? "unknown";
    const extractionModuleType = toExtractionModuleType(moduleType);
    const fileName = fileRecord.file_name ?? "document";
    const parserPipeline =
      (fileRecord.docling_raw as any)?._metadata?.pipeline ?? {};
    const doclingTextLength = countTextChars((fileRecord.docling_raw as any)?.full_text);
    const parserStatus =
      parserPipeline?.parser_status ??
      (fileRecord.docling_raw as any)?._metadata?.parser_status ??
      (doclingTextLength <= 0 ? PARSER_STATUSES.EMPTY_TEXT : null);
    const parseTextErrorCode = doclingTextLength <= 0
      ? "EMPTY_PARSE_TEXT"
      : doclingTextLength < MIN_LEASE_TEXT_CHARS
        ? "INSUFFICIENT_PARSE_TEXT"
        : null;

    if (parseTextErrorCode) {
      const message = parseTextErrorCode === "EMPTY_PARSE_TEXT"
        ? "The document could not be parsed into readable lease text."
        : `The document parser returned only ${doclingTextLength} readable characters; at least ${MIN_LEASE_TEXT_CHARS} are required for automatic lease extraction.`;
      const pipeline = buildPipelineMetadata({
        ...parserPipeline,
        parser_status: parserStatus ?? (parseTextErrorCode === "EMPTY_PARSE_TEXT"
          ? PARSER_STATUSES.EMPTY_TEXT
          : PARSER_STATUSES.INSUFFICIENT_TEXT),
        normalize_status: NORMALIZE_STATUSES.SKIPPED_EMPTY_PARSE,
        review_status: REVIEW_STATUSES.BLOCKED,
        error_code: parseTextErrorCode,
        error_message: message,
        full_text_chars: doclingTextLength,
        page_count: (fileRecord.docling_raw as any)?.page_count ?? parserPipeline?.page_count ?? null,
        stage: "normalize",
      });
      const payload = buildBlockedReviewPayload({
        fileId: file_id,
        fileName,
        moduleType,
        documentSubtype: fileRecord.document_subtype ?? null,
        extractionMethod: fileRecord.extraction_method ?? null,
        message: "The document could not be parsed into readable lease text.",
        pipeline,
      });
      await setStatus(supabaseAdmin, file_id, "failed", {
        review_required: false,
        review_status: REVIEW_STATUSES.BLOCKED,
        processing_status: pipeline.parser_status ?? pipeline.error_code,
        extraction_method: fileRecord.extraction_method ?? "none",
        ui_review_payload: payload,
        normalized_output: mergePipelineIntoNormalizedOutput(null, pipeline, {
          method: "blocked_pipeline_failure",
          rows: [],
          warnings: payload.global_warnings,
          validationErrors: [],
        }),
        parsed_data: [],
        row_count: 0,
        valid_count: 0,
        error_count: 1,
        error_message: message,
        failed_step: "normalize",
        processing_completed_at: new Date().toISOString(),
      });
      await logger.event("normalize", "blocked", {
        normalize_status: NORMALIZE_STATUSES.SKIPPED_EMPTY_PARSE,
        parser_status: pipeline.parser_status,
        error_code: parseTextErrorCode,
        full_text_chars: doclingTextLength,
        page_count: pipeline.page_count,
      });
      return jsonResponse({
        error: true,
        file_id,
        processing_status: "failed",
        normalize_status: NORMALIZE_STATUSES.SKIPPED_EMPTY_PARSE,
        error_code: parseTextErrorCode,
        message,
        ui_review_payload: payload,
      }, 422);
    }

    // When parse-pdf-docling stored an empty docling_raw because no backend was
    // configured AND the file was too large for native extraction, skip the
    // Vision-fallback download that would re-OOM this function for the same reason.
    const extractionSkipped =
      (fileRecord.docling_raw as any)?._metadata?.extraction_skipped_reason ||
      (fileRecord.docling_raw as any)?.extraction_method === "none";
    const hasLLM = !!(
      Deno.env.get("ANTHROPIC_API_KEY") ||
      ((Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID")) &&
        (Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || Deno.env.get("GOOGLE_PRIVATE_KEY")))
    );
    if (extractionSkipped && !hasLLM) {
      console.warn(
        `[normalize-pdf-output] file_id=${file_id} — parse-pdf-docling stored empty output ` +
        `and no LLM is configured. Transitioning to review_required with empty payload so the ` +
        `reviewer can fill fields manually.`,
      );
    }

    const fileSizeBytes = Number(fileRecord.file_size || 0);
    const fileSizeIsKnown = Number.isFinite(fileSizeBytes) && fileSizeBytes > 0;

    // Load file bytes from Supabase Storage ONLY when Docling text is too
    // weak for the LLM extractor to work from — i.e. for scanned / image-only
    // PDFs. For digital PDFs with sufficient extracted text the file bytes are
    // never used and downloading them wastes 3–8 MB of Edge Function RAM,
    // which is the primary cause of the 546 "compute resources" error.
    const doclingBlockCount = Array.isArray((fileRecord.docling_raw as any)?.text_blocks)
      ? (fileRecord.docling_raw as any).text_blocks.length
      : 0;
    // A document with ≥2 500 chars AND ≥5 text blocks has enough content
    // for rule/table/LLM extraction without Vision. These thresholds match
    // the MIN_NATIVE_PDF_TEXT_CHARS and MIN_DIGITAL_BLOCKS constants in
    // _shared/extraction/parser.ts.
    // A document with ≥2500 chars AND ≥5 text blocks has enough content for
    // rule/table/LLM extraction without Vision. The second condition catches
    // plain-text OCR fallback results (0 text_blocks but full_text ≥ 5000 chars)
    // — re-downloading the file in that case would be redundant and OOM the function.
    const doclingTextIsGood = doclingTextLength >= 2500 && (doclingBlockCount >= 5 || doclingTextLength >= 5000);
    const azureLayoutMode =
      Deno.env.get("EXTRACTION_PROVIDER") === "azure_document_intelligence" ||
      isAzureLayoutOutput(fileRecord.docling_raw as Record<string, unknown>);
    const fileTooLargeForInlineVision =
      fileSizeIsKnown && fileSizeBytes > MAX_INLINE_VISION_BYTES;

    console.log(
      `[normalize-pdf-output] STAGE docling_check file_id=${file_id} ` +
      `doclingTextLength=${doclingTextLength} doclingBlockCount=${doclingBlockCount} ` +
      `doclingTextIsGood=${doclingTextIsGood} azureLayoutMode=${azureLayoutMode} fileSizeBytes=${fileSizeBytes}`,
    );

    let fileBase64: string | null = null;
    let fileMimeType: string | null = fileRecord.mime_type
      ?? (fileRecord.file_name?.toLowerCase().endsWith(".pdf") ? "application/pdf" : null);
    let fileLoadStatus: string = azureLayoutMode ? "skipped_azure_layout" : doclingTextIsGood ? "skipped_good_docling" : "not_attempted";
    let fileLoadError: string | null = null;
    let fileBytesLength = 0;
    let detectedMagic: string | null = null;

    if (azureLayoutMode) {
      console.log(
        `[normalize-pdf-output] Azure layout output active for file_id=${file_id}; ` +
        `using docling_raw text only and skipping file bytes/fileBase64 fallback`,
      );
    } else if (doclingTextIsGood) {
      console.log(
        `[normalize-pdf-output] docling text is sufficient ` +
        `(${doclingTextLength} chars, ${doclingBlockCount} blocks) — ` +
        `skipping file bytes download to conserve memory`,
      );
    }

    // Detect what was actually downloaded by inspecting the first bytes.
    // If the download silently returned an HTML error page (expired signed
    // URL, RLS deny rendered as HTML, etc.) we must NOT send that to
    // Gemini Vision and pretend it's the lease PDF.
    const detectMagic = detectFileMagic;

    if (azureLayoutMode) {
      fileLoadStatus = "skipped_azure_layout";
    } else if (!doclingTextIsGood && extractionSkipped) {
      fileLoadStatus = "skipped_extraction_not_configured";
      fileLoadError =
        (fileRecord.docling_raw as any)?._metadata?.extraction_skipped_reason ??
        "Extraction was skipped because no parser backend is configured.";
      console.warn(
        `[normalize-pdf-output] file_id=${file_id} — extraction was skipped upstream; ` +
        `not re-downloading file. Reason: ${fileLoadError}`,
      );
    } else if (!doclingTextIsGood && fileTooLargeForInlineVision) {
      fileLoadStatus = "skipped_large_file";
      fileLoadError =
        `File is ${(fileSizeBytes / (1024 * 1024)).toFixed(1)} MB; ` +
        `skipping inline Vision fallback to avoid Edge compute limits.`;
      console.warn(
        `[normalize-pdf-output] ${fileLoadError} ` +
        `file_id=${file_id} max_inline_vision_mb=${(MAX_INLINE_VISION_BYTES / (1024 * 1024)).toFixed(1)}`,
      );
    } else if (!doclingTextIsGood && fileRecord.file_url) {
      try {
        const storagePath = String(fileRecord.file_url).replace(
          /^.*\/storage\/v1\/object\/public\/financial-uploads\//,
          "",
        );
        console.log(
          `[normalize-pdf-output] loading file bytes (weak docling: ${doclingTextLength} chars, ${doclingBlockCount} blocks) ` +
          `file_id=${file_id} file_name=${fileRecord.file_name ?? "?"} storage_path=${storagePath}`,
        );
        const { data: fileBlob, error: downloadError } = await supabaseAdmin
          .storage
          .from("financial-uploads")
          .download(storagePath);
        if (downloadError || !fileBlob) {
          fileLoadStatus = "download_failed";
          fileLoadError = downloadError?.message ?? "blob_missing";
          console.warn(
            `[normalize-pdf-output] file bytes unavailable for file_id=${file_id} — Vision fallback disabled. ${fileLoadError}`,
          );
        } else {
          const bytes = new Uint8Array(await fileBlob.arrayBuffer());
          fileBytesLength = bytes.length;

          if (bytes.length > MAX_INLINE_VISION_BYTES) {
            fileLoadStatus = "skipped_large_file_after_download";
            fileLoadError =
              `Downloaded file is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB; ` +
              `skipping inline Vision fallback to avoid Edge compute limits.`;
            console.warn(
              `[normalize-pdf-output] ${fileLoadError} file_id=${file_id}`,
            );
          } else {
            detectedMagic = detectMagic(bytes);

            if (!detectedMagic || detectedMagic === "html_or_xml") {
              // Don't send a non-document to Vision. Mark load as failed and
              // let extraction proceed with whatever Docling produced.
              fileLoadStatus = "unexpected_content_type";
              fileLoadError = `Downloaded bytes do not look like a PDF/image (magic=${detectedMagic ?? "unknown"}, first 16 bytes hex=${Array.from(bytes.subarray(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join("")
                })`;
              console.warn(
                `[normalize-pdf-output] file bytes failed magic check for file_id=${file_id} — Vision fallback disabled. ${fileLoadError}`,
              );
            } else {
              // Deno base64 encoder is available; encode incrementally if large.
              // For typical lease PDFs under the inline limit, conversion is fine.
              let binary = "";
              const CHUNK = 8 * 1024;
              for (let offset = 0; offset < bytes.length; offset += CHUNK) {
                const slice = bytes.subarray(offset, offset + CHUNK);
                // String.fromCharCode.apply rejects very large arrays; chunked
                // conversion keeps each call within the JS arg limit.
                binary += String.fromCharCode.apply(null, Array.from(slice));
              }
              fileBase64 = btoa(binary);
              // Resolve fileMimeType from magic when possible — this is more
              // reliable than the column value or blob.type, which can be
              // wrong for files re-uploaded via Storage REST.
              const magicMime =
                detectedMagic === "pdf" ? "application/pdf"
                  : detectedMagic === "jpeg" ? "image/jpeg"
                    : detectedMagic === "png" ? "image/png"
                      : detectedMagic === "gif" ? "image/gif"
                        : detectedMagic === "tiff" ? "image/tiff"
                          : detectedMagic === "webp_or_riff" ? "image/webp"
                            : null;
              fileMimeType = magicMime || fileMimeType || (fileBlob as any).type || "application/pdf";
              fileLoadStatus = "loaded";
              console.log(
                `[normalize-pdf-output] file bytes loaded for file_id=${file_id} ` +
                `(${bytes.length} bytes, magic=${detectedMagic}, mime=${fileMimeType}) ` +
                `— Vision fallback enabled if needed`,
              );
            }
          }
        }
      } catch (loadErr: any) {
        fileLoadStatus = "exception";
        fileLoadError = loadErr?.message ?? String(loadErr);
        console.warn(
          `[normalize-pdf-output] file bytes load exception for file_id=${file_id}: ${fileLoadError}`,
        );
      }
    } else if (!doclingTextIsGood) {
      fileLoadStatus = "no_file_url";
      console.warn(
        `[normalize-pdf-output] uploaded_files.file_url missing for file_id=${file_id} — Vision fallback disabled`,
      );
    }

    const beforeValidatingDelayMs = resolveLocalDebugDelayMs(req, body as Record<string, unknown>, "debug_before_validating_delay_ms");
    if (beforeValidatingDelayMs > 0) await delayMs(beforeValidatingDelayMs);

    // Transition to 'validating' while the pipeline runs.
    // (pdf_parsed → validating is allowed in the FSM.)
    const { error: validatingStatusError } = await setStatus(supabaseAdmin, file_id, "validating");
    if (validatingStatusError) {
      throw new Error(`Failed to transition file to validating: ${validatingStatusError.message}`);
    }

    try {
      const businessExtractionProvider = resolveBusinessExtractionProvider(
        isInternalCall(req) ? (body as any)?.debug_business_extraction_provider : null,
      );
      console.log(`[normalize-pdf-output] STAGE pipeline_start file_id=${file_id} fileBase64=${!!fileBase64} azureLayoutMode=${azureLayoutMode} provider=${businessExtractionProvider}`);
      // Run the canonical extraction pipeline.
      // Rule → Table → LLM(missing only) → Merge → Validate → Calculate.
      const pipelineDocling = buildPipelineLayoutInput(fileRecord.docling_raw as Record<string, unknown> | null);
      // Azure+Vertex Phase 4E (local implementation): single call through the
      // business-extraction orchestrator replaces the direct provider
      // ternary. Returns the exact same ExtractionPipelineResult shape both
      // providers already produced -- buildReviewPayload/buildLeaseWorkflowAbstraction/
      // persistence below are unmodified and unaware this replaced a ternary.
      const mockVertexScenario = resolveMockVertexScenario(req, body as Record<string, unknown>, businessExtractionProvider);
      const result = await runBusinessExtraction({
        requestedProvider: businessExtractionProvider,
        moduleType: extractionModuleType,
        fileName,
        docling: pipelineDocling,
        documentSubtype: fileRecord.document_subtype ?? null,
        ...(fileBase64 && !azureLayoutMode ? { fileBase64, fileMimeType: fileMimeType || "application/pdf" } : {}),
        correlationId: file_id,
        canonicalLayoutSchemaVersion: (fileRecord.docling_raw as any)?.layout_contract_version ?? null,
        ...(mockVertexScenario ? { mockVertexScenario } : {}),
      });
      stampBusinessExtractionPersistedAt(result, new Date().toISOString());
      console.log(`[normalize-pdf-output] STAGE pipeline_done file_id=${file_id} rows=${result.rows?.length ?? 0} method=${result.method} provider=${businessExtractionProvider}`);
      console.log(
        `[normalize-pdf-output] core_extraction_done file_id=${file_id} rows=${result.rows?.length ?? 0} ` +
        `fields=${(result.metadata as any)?.extractionDebug?.fields_returned_count ?? 0} ` +
        `source_backed=${(result.metadata as any)?.extractionDebug?.source_backed_fields_count ?? 0}`,
      );

      // Decide the next status based on the review gate decided at ingest.
      // Computed once here (not re-derived later) so the minimal early
      // persist below and the final full-payload persist land on
      // consistent, FSM-legal statuses.
      const reviewRequired = !!fileRecord.review_required;

      // Forward file-load status into the pipeline's extractionDebug so the
      // UI/debug panel can show why Vision did or didn't run.
      if (result.metadata && typeof result.metadata === "object") {
        (result.metadata as any).extractionDebug = {
          ...((result.metadata as any).extractionDebug || {}),
          file_load_status: fileLoadStatus,
          azure_layout_mode: azureLayoutMode,
          file_load_error: fileLoadError,
          file_url_present: !!fileRecord.file_url,
          file_size_bytes: fileSizeIsKnown ? fileSizeBytes : null,
          max_inline_vision_bytes: MAX_INLINE_VISION_BYTES,
          file_bytes_length: fileBytesLength,
          file_magic_detected: detectedMagic,
          file_name: fileRecord.file_name ?? null,
          file_mime_resolved: fileMimeType,
          file_id: file_id,
        };
      }

      const meaningfulValueCount = countMeaningfulRowValues(result.rows as Array<Record<string, unknown>>);
      if (!result.rows || result.rows.length === 0 || meaningfulValueCount === 0) {
        // P0.3 guarantee: this attempt produced nothing usable, but a prior
        // successful run may already have persisted real values for this
        // file (e.g. a re-extraction that regressed). Re-read before
        // injecting an empty fallback row over them.
        const { data: existingRow } = await supabaseAdmin
          .from("uploaded_files")
          .select("ui_review_payload, parsed_data, normalized_output")
          .eq("id", file_id)
          .maybeSingle();
        if (existingRow && uploadedFileRowHasMeaningfulValues(existingRow)) {
          console.log(
            `[normalize-pdf-output] fallback_aborted_existing_values_found file_id=${file_id} — ` +
            `this attempt found nothing, but existing row already has real values; leaving it untouched`,
          );
          await logger.event("normalize", "blocked_write_skipped", {
            reason: "existing_meaningful_values_found",
          });
          return jsonResponse({
            error: false,
            file_id,
            processing_status: fileRecord.status,
            module_type: moduleType,
            message: "This extraction attempt found no usable values; the file's existing extracted data was left unchanged.",
          });
        }

        // For review-required files (all leases), inject a fallback empty row instead of
        // failing. This lets the reviewer manually fill in fields rather than hitting a
        // dead-end "failed" status. Without an LLM backend, rule/table extraction often
        // finds nothing, but the document is still parseable and reviewable.
        if (fileRecord.review_required) {
          console.warn(
            `[normalize-pdf-output] file_id=${file_id} — extraction produced no usable values ` +
            `(LLM likely not configured). Injecting fallback empty row for manual review.`,
          );
          (result as any).rows = [buildFallbackReviewRow(moduleType)];
          if (!Array.isArray((result as any).warnings)) (result as any).warnings = [];
          (result as any).warnings.push(
            "No fields were auto-extracted (AI backend not configured or document could not be read). " +
            "Please fill in the required fields manually.",
          );
          if (!(result as any).method) (result as any).method = "manual_review_fallback";
          if (!(result as any).metadata) (result as any).metadata = {};
          (result as any).metadata.avgConfidence = 0;
          // fall through to the normal review_required path below
        } else {
          const reason =
            `Extraction produced no usable lease values. Warnings: ${(result.warnings ?? []).join("; ")}`;
          const pipeline = buildPipelineMetadata({
            parser_status: parserStatus ?? PARSER_STATUSES.COMPLETED,
            normalize_status: NORMALIZE_STATUSES.FAILED,
            ai_status: "ai_empty_output",
            review_status: REVIEW_STATUSES.BLOCKED,
            error_code: "FAILED_EMPTY_EXTRACTION",
            error_message: reason,
            full_text_chars: doclingTextLength,
            page_count: (fileRecord.docling_raw as any)?.page_count ?? parserPipeline?.page_count ?? null,
            mapped_fields_count: 0,
            dynamic_terms_count: 0,
            source_backed_count: 0,
            lease_clauses_count: 0,
            expense_terms_count: 0,
            cam_terms_count: 0,
            stage: "normalize",
          });
          const payload = buildBlockedReviewPayload({
            fileId: file_id,
            fileName,
            moduleType,
            documentSubtype: fileRecord.document_subtype ?? null,
            extractionMethod: fileRecord.extraction_method ?? result.method ?? null,
            message: "No usable lease values were extracted from the parsed document.",
            pipeline,
          });
          await setStatus(supabaseAdmin, file_id, "failed", {
            review_required: false,
            review_status: REVIEW_STATUSES.BLOCKED,
            processing_status: "failed_empty_extraction",
            extraction_method: fileRecord.extraction_method ?? result.method ?? "none",
            ui_review_payload: payload,
            normalized_output: mergePipelineIntoNormalizedOutput(result as Record<string, unknown>, pipeline, {
              method: "blocked_pipeline_failure",
              rows: [],
              warnings: payload.global_warnings,
              validationErrors: result.validationErrors ?? [],
            }),
            parsed_data: [],
            row_count: 0,
            valid_count: 0,
            error_count: 1,
            error_message: reason,
            failed_step: "normalize",
            processing_completed_at: new Date().toISOString(),
          });
          await logger.event("normalize", "blocked", {
            normalize_status: NORMALIZE_STATUSES.FAILED,
            ai_status: "ai_empty_output",
            error_code: "FAILED_EMPTY_EXTRACTION",
            full_text_chars: doclingTextLength,
            page_count: pipeline.page_count,
            mapped_fields_count: 0,
            dynamic_terms_count: 0,
            lease_clauses_count: 0,
          });
          return jsonResponse({
            error: true,
            file_id,
            processing_status: "failed",
            normalize_status: NORMALIZE_STATUSES.FAILED,
            error_code: "FAILED_EMPTY_EXTRACTION",
            message: reason,
            ui_review_payload: payload,
          }, 422);
        } // end else (non-review-required modules)
      }

      // ── Fast core-field persist ─────────────────────────────────────────
      // Persist a minimal, schema-versioned payload from the raw rule/table/
      // LLM values BEFORE buildReviewPayload() runs its expensive workflow
      // abstraction + clause records + per-field evidence-page verification
      // pass. If the Edge Function is OOM-killed or times out anywhere after
      // this point, real extracted field values are already durable and
      // visible in the UI — the worker's normalize reconciliation finds this
      // non-fallback payload and completes the job instead of overwriting it
      // with manual_review_fallback.
      console.log(`[normalize-pdf-output] STAGE minimal_payload_start file_id=${file_id}`);
      const beforeMinimalPersistDelayMs = resolveLocalDebugDelayMs(req, body as Record<string, unknown>, "debug_before_minimal_persist_delay_ms");
      if (beforeMinimalPersistDelayMs > 0) await delayMs(beforeMinimalPersistDelayMs);
      const minimalPayload = buildMinimalReviewPayload({
        fileId: file_id,
        fileName,
        moduleType,
        documentSubtype: fileRecord.document_subtype ?? null,
        extractionMethod: fileRecord.extraction_method ?? null,
        reviewRequired,
        result,
      });
      const { error: minimalPersistError } = await setStatus(
        supabaseAdmin,
        file_id,
        reviewRequired ? "review_required" : "validated",
        {
          parsed_data: result.rows,
          normalized_output: result,
          ui_review_payload: minimalPayload,
          row_count: result.rows.length,
          valid_count: result.rows.length - (result.validationErrors?.length ?? 0),
          error_count: result.validationErrors?.length ?? 0,
          validation_errors: result.validationErrors ?? [],
          error_message: null,
          ...(reviewRequired ? { review_status: "pending" } : {}),
        },
      );
      const minimalSourceBackedCount = (minimalPayload.records[0]?.standard_fields ?? [])
        .filter((f: any) => f.status === "auto_populated" || f.status === "pending_enrichment").length;
      const minimalValueCount = (minimalPayload.records[0]?.standard_fields ?? [])
        .filter((f: any) => f.value != null && f.value !== "").length;
      // Azure+Vertex Phase 4E (local implementation): CAS token-chaining.
      // The minimal persist above and the final persist below are BOTH in
      // this same invocation and both go through setStatus(), which
      // unconditionally sets updated_at -- so a CAS token captured once at
      // request-start would spuriously "lose" against this invocation's OWN
      // earlier write, a false-positive race, not a real one (confirmed by
      // reading setStatus()'s patch construction this session). Capture the
      // token freshly, right after the write whose result it will guard.
      let casExpectedUpdatedAt: string | null = null;
      if (!minimalPersistError) {
        const { data: freshRow } = await supabaseAdmin
          .from("uploaded_files")
          .select("updated_at")
          .eq("id", file_id)
          .maybeSingle();
        casExpectedUpdatedAt = freshRow?.updated_at ?? null;
      }
      const afterMinimalPersistDelayMs = resolveLocalDebugDelayMs(req, body as Record<string, unknown>, "debug_after_minimal_persist_delay_ms");
      if (afterMinimalPersistDelayMs > 0) await delayMs(afterMinimalPersistDelayMs);
      if (minimalPersistError) {
        // Non-fatal — log and continue to the full enrichment pass below.
        // Worst case this run loses the early-persist safety net; extraction
        // still proceeds normally.
        console.warn(
          `[normalize-pdf-output] Could not persist minimal core payload for file_id=${file_id}: ${minimalPersistError.message}`,
        );
      } else {
        console.log(
          `[normalize-pdf-output] minimal_payload_persisted file_id=${file_id} ` +
          `values=${minimalValueCount} source_backed=${minimalSourceBackedCount} core_ready=${minimalPayload.core_ready}`,
        );
      }

      // ── Document Intelligence v3 side-write (Phase 2, opt-in) ────────────
      // Runs only when ENABLE_DOCUMENT_INTELLIGENCE_V3=true (checked first
      // thing inside runDocumentIntelligenceV3SideWrite -- zero DB calls
      // when unset, matching current default behavior exactly). Placed
      // after the minimal ui_review_payload/normalized_output persist above
      // so the durable, UI-visible write this endpoint exists to make has
      // already happened before any v3-only side effect is attempted. Never
      // throws: a v3 side-write failure is caught and logged inside the
      // helper itself, and defensively caught again here, so it can never
      // change this request's outcome.
      try {
        await runDocumentIntelligenceV3SideWrite({
          supabaseAdmin,
          orgId,
          uploadedFileId: file_id,
          uploadedFile: fileRecord,
          leaseId: null,
          pipelineJobId: finalPipelineJobId ?? null,
          result,
          logger,
        });
      } catch (v3SideWriteError: any) {
        console.warn(
          `[normalize-pdf-output] document_intelligence_v3 side-write threw unexpectedly for file_id=${file_id}: ` +
          `${v3SideWriteError?.message ?? v3SideWriteError} — current normalize flow continues unaffected.`,
        );
      }

      // ── P0.1: defer the expensive evidence/clause pass ───────────────────
      // By default (NORMALIZE_INLINE_ENRICHMENT unset/false), return success
      // right here — the minimal payload above is already durable and
      // review-worthy (P0.2). The evidence/clause pass (buildReviewPayload,
      // the documented compute hotspot per evidence-index.ts) runs as a
      // separate, independently-retryable "enrich" job instead of inline in
      // this same request, so it can never again crash a request that
      // already contains good data. Setting NORMALIZE_INLINE_ENRICHMENT=true
      // restores the old synchronous behavior — local debugging only, never
      // set in a deployed environment.
      const inlineEnrichment = Deno.env.get("NORMALIZE_INLINE_ENRICHMENT") === "true";
      if (!inlineEnrichment) {
        await enqueueEnrichmentJob({
          supabaseAdmin,
          orgId,
          fileId: file_id,
          moduleType,
          logger,
        });
        console.log(`[normalize-pdf-output] normalize_returning_after_minimal_payload file_id=${file_id}`);
        await logger.event("normalize", "completed", {
          normalize_status: NORMALIZE_STATUSES.COMPLETED,
          row_count: result.rows.length,
          full_text_chars: doclingTextLength,
          page_count: (fileRecord.docling_raw as any)?.page_count ?? parserPipeline?.page_count ?? null,
          method: result.method,
          review_required: reviewRequired,
          metadata: { deferred_enrichment: true },
        });
        return jsonResponse({
          error: false,
          file_id,
          processing_status: reviewRequired ? "review_required" : "validated",
          module_type: moduleType,
          document_subtype: fileRecord.document_subtype,
          review_required: reviewRequired,
          method: result.method,
          row_count: result.rows.length,
          warnings: result.warnings,
          validation_errors: result.validationErrors,
          metadata: result.metadata,
          core_ready: minimalPayload.core_ready,
          enrichment_status: "pending",
        });
      }

      console.log(`[normalize-pdf-output] STAGE review_payload_start file_id=${file_id}`);
      const uiReviewPayload = buildReviewPayload({
        fileId: file_id,
        fileName,
        moduleType,
        documentSubtype: fileRecord.document_subtype ?? null,
        extractionMethod: fileRecord.extraction_method ?? null,
        reviewRequired: !!fileRecord.review_required,
        doclingRaw: fileRecord.docling_raw ?? null,
        result,
      });
      console.log(`[normalize-pdf-output] STAGE review_payload_done file_id=${file_id}`);
      if (uiReviewPayload?.metadata?.workflow_output) {
        result.metadata = {
          ...(result.metadata ?? {}),
          workflow_output: uiReviewPayload.metadata.workflow_output,
        };
        (result as Record<string, unknown>).workflow_output = uiReviewPayload.metadata.workflow_output;
      }

      // ── Consolidated extraction_debug ──────────────────────────────────
      // Merge the pipeline's parser/vision diagnostics with the workflow's
      // profile + mapping + expense-rule diagnostics into one object using
      // canonical key names, then surface mapping_failure_reason. The debug
      // panel and Lease Review read this from
      // uploaded_files.normalized_output.metadata.extractionDebug (and, after
      // approval, lease.extraction_data.extraction_debug).
      {
        const firstRecord = Array.isArray(uiReviewPayload?.records) ? uiReviewPayload.records[0] : null;
        const wf = (firstRecord as any)?.workflow_output ?? null;
        const wfSummary = (wf?.summary ?? {}) as Record<string, unknown>;
        const pipelineDebug = ((result.metadata as any)?.extractionDebug ?? {}) as Record<string, unknown>;
        const uiFieldsCount = firstRecord
          ? ((firstRecord as any).standard_fields?.length ?? 0) + ((firstRecord as any).custom_fields?.length ?? 0)
          : 0;
        const fullTextChars = Number(
          wfSummary.full_text_chars
          ?? pipelineDebug.embedded_text_chars_total
          ?? pipelineDebug.normalized_text_chars_total
          ?? 0,
        );
        const parsedPages = Number(wfSummary.docling_pages_parsed ?? 0);
        const totalPages = Number(wfSummary.pdf_page_count_total ?? 0);
        const partialDocumentTextDetected = Boolean(
          wfSummary.partial_document_text_detected
          || (
            extractionModuleType === "lease" &&
            totalPages > 1 &&
            parsedPages <= 1 &&
            fullTextChars > 0 &&
            fullTextChars < 2500
          )
          || (
            extractionModuleType === "lease" &&
            String(pipelineDebug.parsing_method || pipelineDebug.vision_parser_source || "").toLowerCase() === "pdf_text" &&
            totalPages > 1 &&
            fullTextChars > 0 &&
            fullTextChars < 2500
          )
        );
        // mapping_failure_reason precedence: an outright parse failure
        // (no text) and a partial-page parse trump the workflow's field-level reason.
        const mappingFailureReason =
          fullTextChars === 0
            ? "no_text_extracted"
            : partialDocumentTextDetected
              ? "partial_document_text_detected"
              : (wfSummary.mapping_failure_reason as string | null) ?? null;
        const coreMappingFailed = Boolean(wfSummary.core_mapping_failed) || mappingFailureReason != null;
        const fieldTrace = firstRecord
          ? buildFieldTraceForRecord({
            standardFields: (firstRecord as any).standard_fields || [],
            workflowOutput: wf,
            pipelineDebug,
            moduleType,
          })
          : [];
        const fieldTraceSummary = summarizeFieldTrace(fieldTrace);
        const consolidated = {
          ...pipelineDebug,
          ...fieldTraceSummary,
          extraction_contract_version: "lease-review-evidence-v3",
          extraction_build_version: "2026-06-22.1",
          extraction_run_id: extractionRunId,
          pipeline_job_id: finalPipelineJobId,
          source_file_id: file_id,
          normalized_at: new Date().toISOString(),
          worker_attempt: worker_attempt ?? 1,
          unmapped_llm_keys: pipelineDebug.unmapped_llm_keys ?? [],
          rejected_fields_with_reasons: pipelineDebug.rejected_fields_with_reasons ?? [],
          // Document classification
          document_profile: wf?.document_profile ?? wfSummary.document_profile ?? null,
          selected_document_profile: wf?.selected_document_profile ?? wfSummary.selected_document_profile ?? null,
          lease_structure: wf?.lease_structure ?? wfSummary.lease_structure ?? null,
          profile_detection_signals: wf?.profile_detection_signals ?? wfSummary.profile_detection_signals ?? null,
          // Text + parser provenance
          full_text_chars: fullTextChars,
          parser_source: pipelineDebug.vision_parser_source ?? pipelineDebug.parsing_method ?? null,
          vision_parser_used: pipelineDebug.vision_parser_used ?? false,
          vision_field_extraction_used: pipelineDebug.vision_field_extraction_used ?? pipelineDebug.vision_fallback_triggered ?? false,
          partial_document_text_detected: partialDocumentTextDetected,
          // Mapping counts
          fixed_fields_extracted: wfSummary.fixed_fields_extracted ?? 0,
          mapped_standard_fields_count: wfSummary.mapped_standard_fields_count ?? 0,
          lease_fields_count: wfSummary.lease_fields_count ?? 0,
          ui_review_payload_fields_count: uiFieldsCount,
          source_backed_fields_count: wfSummary.source_backed_fields_count ?? pipelineDebug.source_backed_fields_count ?? 0,
          value_only_fields_count: wfSummary.value_only_fields_count ?? 0,
          fields_rejected_missing_source_count: wfSummary.fields_rejected_missing_source_count ?? 0,
          fields_rejected_generic_source_count: wfSummary.fields_rejected_generic_source_count ?? pipelineDebug.rejected_generic_source_count ?? 0,
          persisted_but_not_rendered_fields: fieldTrace
            .filter((trace: any) => trace.persisted_to_extraction_data && !trace.rendered_in_tab)
            .map((trace: any) => trace.field_key),
          // Expense-rule generation
          expense_rules_generated_count: wfSummary.expense_rules_generated_count ?? wfSummary.expense_rule_count ?? 0,
          real_expense_rules_count: wfSummary.real_expense_rules_count ?? 0,
          coverage_gap_rules_count: wfSummary.coverage_gap_rules_count ?? 0,
          expense_rules_demoted_for_mapping_failure: wfSummary.expense_rules_demoted_for_mapping_failure ?? 0,
          // The headline
          mapping_failure_reason: mappingFailureReason,
          core_mapping_failed: coreMappingFailed,
        };
        result.metadata = {
          ...(result.metadata ?? {}),
          extractionDebug: consolidated,
          extraction_contract_version: "lease-review-evidence-v3",
          extraction_build_version: "2026-06-22.1",
          extraction_run_id: extractionRunId,
          pipeline_job_id: finalPipelineJobId,
          source_file_id: file_id,
          normalized_at: new Date().toISOString(),
          worker_attempt: worker_attempt ?? 1,
        };
        // Also expose it on the review payload metadata so the draft-creation
        // path (which only reads ui_review_payload) can persist it onto
        // lease.extraction_data.extraction_debug.
        if (uiReviewPayload?.metadata && typeof uiReviewPayload.metadata === "object") {
          (uiReviewPayload.metadata as Record<string, unknown>).extractionDebug = consolidated;
          (uiReviewPayload.metadata as Record<string, unknown>).extraction_debug = consolidated;
          (uiReviewPayload.metadata as Record<string, unknown>).extraction_contract_version = "lease-review-evidence-v3";
          (uiReviewPayload.metadata as Record<string, unknown>).extraction_build_version = "2026-06-22.1";
          (uiReviewPayload.metadata as Record<string, unknown>).extraction_run_id = extractionRunId;
          (uiReviewPayload.metadata as Record<string, unknown>).pipeline_job_id = finalPipelineJobId;
          (uiReviewPayload.metadata as Record<string, unknown>).source_file_id = file_id;
          (uiReviewPayload.metadata as Record<string, unknown>).normalized_at = new Date().toISOString();
          (uiReviewPayload.metadata as Record<string, unknown>).worker_attempt = worker_attempt ?? 1;
        }

        // Surface a user-facing warning so the Upload screen's
        // "did not return mapped values" banner reflects a real signal and
        // the Lease Review screen can show the honest message instead of a
        // misleading "N expense terms found" success.
        if (coreMappingFailed && extractionModuleType === "lease") {
          const msg =
            "Expense terms may have been detected, but core lease fields were not mapped. Manual review required.";
          uiReviewPayload.global_warnings = [
            ...(uiReviewPayload.global_warnings ?? []),
            msg,
          ];
          uiReviewPayload.warnings = [
            ...(uiReviewPayload.warnings ?? []),
            msg,
          ];
          (uiReviewPayload as Record<string, unknown>).mapping_failed = true;
          (uiReviewPayload as Record<string, unknown>).mapping_failure_reason = mappingFailureReason;
        }
      }

      // reviewRequired was already computed and used for the minimal early
      // persist above; status is currently review_required or validated
      // (whichever that persist landed on) — both transition legally to
      // 'validated' below (same-status is a no-op per isAllowedTransition,
      // and review_required → validated is an allowed FSM edge), then back
      // to 'review_required' if a human gate is required.
      const nextStatus = reviewRequired ? "review_required" : "validated";
      // Full payload replaces the minimal one — mark enrichment complete so
      // the UI can stop showing the "enriching evidence" affordance.
      (uiReviewPayload as Record<string, unknown>).enrichment_status = "completed";

      // Azure+Vertex Phase 4E (local implementation): conditional-write CAS
      // guard, chained from the minimal persist's own updated_at (not a
      // request-start value - see the capture site above). Zero affected rows
      // is always treated as a real race. A durable result is reused only when
      // it is meaningful and its attempt/correlation/provider/schema/hash
      // provenance matches this attempt; incompatible race winners are not
      // overwritten.
      if (casExpectedUpdatedAt) {
        const { data: casClaim, error: casClaimError } = await supabaseAdmin
          .from("uploaded_files")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", file_id)
          .eq("updated_at", casExpectedUpdatedAt)
          .select("id")
          .maybeSingle();
        if (casClaimError || !casClaim) {
          const { data: raceRow } = await supabaseAdmin
            .from("uploaded_files")
            .select("ui_review_payload, parsed_data, normalized_output")
            .eq("id", file_id)
            .maybeSingle();
          const currentProvenance = readBusinessExtractionProvenance(result);
          const winnerProvenance = readDurableBusinessExtractionProvenance(raceRow as Record<string, unknown> | null);
          const raceComparison = compareRaceWinnerMetadata(currentProvenance, winnerProvenance);
          const raceRowHasMeaningfulValues = raceRow ? uploadedFileRowHasMeaningfulValues(raceRow) : false;
          if (raceRowHasMeaningfulValues && raceComparison.compatible) {
            console.warn(
              `[normalize-pdf-output] cas_race_detected_reusing_compatible_durable_result file_id=${file_id} ` +
              `winner_attempt_id=${raceComparison.winnerAttemptId} current_attempt_id=${raceComparison.currentAttemptId} ` +
              `reason=${raceComparison.reason}`,
            );
            return jsonResponse({
              error: false,
              file_id,
              processing_status: fileRecord.status,
              module_type: moduleType,
              race_lost: true,
              race_winner_attempt_id: raceComparison.winnerAttemptId,
              current_attempt_id: raceComparison.currentAttemptId,
              race_compare_reason: raceComparison.reason,
              message: "A compatible concurrent normalization already completed for this file; this attempt's result was discarded to avoid overwriting it.",
            });
          }
          if (raceRowHasMeaningfulValues) {
            console.warn(
              `[normalize-pdf-output] cas_race_detected_incompatible_durable_result file_id=${file_id} ` +
              `reason=${raceComparison.reason} winner_attempt_id=${raceComparison.winnerAttemptId} ` +
              `current_attempt_id=${raceComparison.currentAttemptId}; refusing to overwrite`,
            );
            return jsonResponse({
              error: true,
              file_id,
              error_code: "CAS_RACE_INCOMPATIBLE_RESULT",
              race_lost: true,
              race_winner_attempt_id: raceComparison.winnerAttemptId,
              current_attempt_id: raceComparison.currentAttemptId,
              race_compare_reason: raceComparison.reason,
              message: "A concurrent normalization wrote a non-compatible result for this file; this attempt was discarded to avoid overwriting it.",
            }, 409);
          }
          console.warn(
            `[normalize-pdf-output] cas_race_detected_no_durable_result file_id=${file_id} reason=${raceComparison.reason} - ` +
            `proceeding with this attempt's own write (no meaningful compatible durable result found to reuse)`,
          );
        }
      }

      const { error: validatedErr } = await setStatus(
        supabaseAdmin,
        file_id,
        "validated",
        {
          parsed_data: result.rows,
          normalized_output: result,
          ui_review_payload: uiReviewPayload,
          row_count: result.rows.length,
          valid_count: result.rows.length - (result.validationErrors?.length ?? 0),
          error_count: result.validationErrors?.length ?? 0,
          validation_errors: result.validationErrors ?? [],
          error_message: null,
          processing_completed_at: new Date().toISOString(),
        },
      );

      if (validatedErr) {
        throw new Error(`Failed to save normalized output: ${validatedErr.message}`);
      }

      if (reviewRequired) {
        const { error: reviewErr } = await setStatus(
          supabaseAdmin,
          file_id,
          "review_required",
          {
            review_status: "pending",
          },
        );
        if (reviewErr) {
          // Not fatal — the row is still in 'validated'; we'll surface the
          // warning rather than rolling back the normalization work.
          console.warn(
            `[normalize-pdf-output] Could not transition to review_required: ${reviewErr.message}`,
          );
        }
      }

      console.log(
        `[normalize-pdf-output] OK file_id=${file_id} module=${moduleType} ` +
        `rows=${result.rows.length} method=${result.method} ` +
        `confidence=${result.metadata.avgConfidence}% nextStatus=${nextStatus}`,
      );
      await logger.event("normalize", "completed", {
        normalize_status: NORMALIZE_STATUSES.COMPLETED,
        row_count: result.rows.length,
        full_text_chars: doclingTextLength,
        page_count: (fileRecord.docling_raw as any)?.page_count ?? parserPipeline?.page_count ?? null,
        method: result.method,
        review_required: reviewRequired,
      });

      return jsonResponse({
        error: false,
        file_id,
        processing_status: nextStatus,
        module_type: moduleType,
        document_subtype: fileRecord.document_subtype,
        review_required: reviewRequired,
        method: result.method,
        row_count: result.rows.length,
        warnings: result.warnings,
        validation_errors: result.validationErrors,
        metadata: result.metadata,
      });
    } catch (normError) {
      console.error(
        `[normalize-pdf-output] Failed for file_id=${file_id}: ${normError.message}`,
      );
      await setFailed(
        supabaseAdmin,
        file_id,
        normError.message,
        "normalize",
        35,
      );
      throw normError;
    }
  } catch (err) {
    console.error("[normalize-pdf-output] Error:", err.message);
    const isAuthError = /unauthorized|missing authorization|invalid token|auth failed/i.test(
      String(err.message ?? ""),
    );
    return jsonResponse(
      {
        ok: false,
        error: true,
        message: err.message,
        error_code: isAuthError ? "UNAUTHORIZED_NORMALIZE_CALL" : "NORMALIZATION_FAILED",
      },
      isAuthError ? 401 : 400,
    );
  }
});

// Test hook (same pattern as _shared/extraction/parser.ts).
export const __test__ = {
  buildPipelineLayoutInput,
  buildMinimalReviewPayload,
  buildReviewPayload,
  rejectMarkupValue,
  buildReviewField,
  resolveBusinessExtractionProvider,
  resolveMockVertexScenario,
  isLocalSupabaseUrl,
  localProviderMocksEnabled,
  externalProviderCallsDisabled,
};
