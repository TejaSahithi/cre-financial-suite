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
import { runBusinessExtraction } from "../_shared/extraction/business-extraction-orchestrator.ts";
import { isLLMProviderConfigured } from "../_shared/llm.ts";
import { isAzureLayoutOutput } from "../_shared/extraction/extraction-provider.ts";
import { getFieldGroups, getSchema, getEvidencePolicyCoverage } from "../_shared/extraction/schemas.ts";
import { evaluateCandidateForField } from "../_shared/extraction/candidate-decision.ts";
import { getAuthoritativeFieldValue, normalizeLeaseReviewFieldStatus, resolutionStateForStatus } from "../_shared/extraction/review-status.ts";
import {
  buildLeaseWorkflowAbstraction,
  runLeaseWorkflowStage1Clauses,
  runLeaseWorkflowStage2Fields,
  runLeaseWorkflowStage3Items,
  runLeaseWorkflowStage4Derivation,
} from "../_shared/extraction/lease-workflow.ts";
import { checkGenerationStillActive } from "../_shared/extraction/generation-fence.ts";
import { checkStageInputAgainstLimits } from "../_shared/extraction/enrich-stage-limits.ts";
import {
  ENRICH_EVIDENCE_DOMAIN_STAGES,
  isEnrichBoundedStageName,
  isFinalEnrichBoundedStage,
  firstEnrichBoundedStage,
  type EnrichBoundedStageName,
} from "../_shared/extraction/enrich-bounded-stage/stage-sequence.ts";
import {
  mergeBoundedStageResult,
  isStageAlreadyCompleted,
  readBoundedStageResults,
  STAGE_RESULT_VERSION,
  type BoundedStageResultEntry,
} from "../_shared/extraction/enrich-bounded-stage/stage-persistence.ts";
import { startBoundedStageTelemetry } from "../_shared/extraction/enrich-bounded-stage/telemetry.ts";
import { getSchemaEntriesForDomain, getSchemaEntriesWithNoDomain, reorderStandardFieldsBySchema, type LlmCallDomain } from "../_shared/extraction/enrich-bounded-stage/domain-fields.ts";
import { isEnrichEvidenceDomainStage, getDomainForEnrichStage } from "../_shared/extraction/domains/domain-stage-registry.ts";
import { cleanEvidenceSnippet, findPageForSnippet, resolveVerifiedSourcePage } from "../_shared/extraction/evidence-index.ts";
import { detectFileMagic } from "../_shared/file-magic.ts";
import { setStatus, setFailed } from "../_shared/pipeline-status.ts";
import { createLogger } from "../_shared/logger.ts";
import { computeCoreReady, uploadedFileRowHasMeaningfulValues } from "../_shared/extraction/payload-guard.ts";
import { enqueueEnrichmentJob } from "../_shared/extraction/enrichment-dispatch.ts";
import { getEnrichBoundedStageMode } from "../_shared/extraction/enrich-bounded-stage/feature-mode.ts";
import { enqueueBoundedEnrichStage } from "../_shared/extraction/enrich-bounded-stage/dispatch.ts";
import {
  monolithicEnrichGuardReasons,
  readEnrichInputSizeFromDocling,
  shouldUseBoundedEnrich,
} from "../_shared/extraction/enrich-monolithic-guard.ts";
import { runDocumentIntelligenceV3SideWrite } from "../_shared/extraction/document-intelligence-v3/side-write.ts";
import { getLeaseClaimsLedgerMode } from "../_shared/extraction/claims/feature-mode.ts";
import { maybeRunClaimsLedgerForStage } from "../_shared/extraction/claims/claims-pipeline-orchestrator.ts";
import { getLeaseDocumentPackageMode } from "../_shared/extraction/document-package/feature-mode.ts";
import { maybeRunLeaseDocumentPackagePipeline } from "../_shared/extraction/document-package/runtime/package-runtime-orchestrator.ts";
import { getLeaseFinancialScheduleMode } from "../_shared/extraction/lease-financial-schedule/feature-mode.ts";
import { maybeRunLeaseFinancialScheduleRuntime } from "../_shared/extraction/lease-financial-schedule/runtime/financial-runtime-orchestrator.ts";
import type { ModuleType as ExtractionModuleType } from "../_shared/extraction/types.ts";
import { resolveExtractionRunId, withExtractionStage } from "../_shared/extraction/provenance/recorder.ts";
import type { StageHandle } from "../_shared/extraction/provenance/types.ts";
import { EXTRACTION_CONTRACT_VERSION } from "../_shared/extraction/contract-version.ts";
import { isLeaseModuleType } from "../_shared/extraction/lease-module.ts";
import {
  SOURCE_SNIPPET_MAX_CHARS,
  expandSourceSnippetFromMatch,
  isShortCompleteSourceRow,
} from "../_shared/extraction/source-snippets.ts";
import {
  assertAuthoritativeLeaseExtractionResult,
  enforceLeaseExtractionArchitecture,
  resolveBusinessExtractionProvider,
  wholeDocumentExtractionMode,
} from "../_shared/extraction/lease-extraction-strategy.ts";
import { assembleCanonicalFields, publishIdFor, LEASE_TRUTH_ASSEMBLY_VERSION } from "../_shared/extraction/lease-truth-assembly.ts";
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
// double memory again. Keep inline file fallback below Edge compute limits.
// Default remains conservative, but deployments with larger Edge capacity can
// raise NORMALIZE_MAX_INLINE_FILE_BYTES without changing extraction code.
function envPositiveInt(name: string, fallback: number): number {
  try {
    const parsed = Number(Deno.env.get(name));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  } catch {
    return fallback;
  }
}
const DEFAULT_MAX_INLINE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_FILE_BYTES = envPositiveInt("NORMALIZE_MAX_INLINE_FILE_BYTES", DEFAULT_MAX_INLINE_FILE_BYTES);

const AZURE_PAGE_MARKER_RE = /\[\[\s*PAGE\s+\d+\s*\]\]/i;

// document_intelligence_v3 is a deliberately unpushed/flag-gated scaffold
// (see docs/database/migration-repair.md) -- its migrations are not applied
// on every environment. Selecting these columns unconditionally previously
// made every normalize call fail outright with "column ... does not exist"
// wherever the v3 migrations aren't deployed. Isolate them so a schema-cache
// miss degrades to nulls (the same as the feature being off) instead of
// blocking the entire pipeline.
const CANONICAL_LAYOUT_V3_COLUMNS =
  "canonical_layout_v3, canonical_layout_v3_hash, canonical_layout_v3_schema_version, canonical_layout_v3_adapter_version";
const CANONICAL_LAYOUT_V3_NULLS = {
  canonical_layout_v3: null,
  canonical_layout_v3_hash: null,
  canonical_layout_v3_schema_version: null,
  canonical_layout_v3_adapter_version: null,
};

function isMissingColumnError(error: any): boolean {
  const text = `${error?.code || ""} ${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return (
    text.includes("42703") ||
    text.includes("pgrst204") ||
    text.includes("schema cache") ||
    /column .* does not exist/i.test(text) ||
    /could not find .* column/i.test(text)
  );
}

/**
 * Select an uploaded_files row by id+org_id, appending the v3 canonical-layout
 * columns when available and degrading to nulls for them (not failing the
 * whole query) when they aren't -- see CANONICAL_LAYOUT_V3_COLUMNS above.
 */
async function selectUploadedFileWithV3Fallback(supabaseAdmin: any, baseColumns: string, fileId: string, orgId: string) {
  const withV3 = await supabaseAdmin
    .from("uploaded_files")
    .select(`${baseColumns}, ${CANONICAL_LAYOUT_V3_COLUMNS}`)
    .eq("id", fileId)
    .eq("org_id", orgId)
    .single();

  if (!withV3.error || !isMissingColumnError(withV3.error)) {
    return withV3;
  }

  const withoutV3 = await supabaseAdmin
    .from("uploaded_files")
    .select(baseColumns)
    .eq("id", fileId)
    .eq("org_id", orgId)
    .single();

  if (withoutV3.data) {
    withoutV3.data = { ...CANONICAL_LAYOUT_V3_NULLS, ...withoutV3.data };
  }
  return withoutV3;
}

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
    // Full, semantically compact Azure artifact for the whole-document LLM
    // experiment. Undefined for rows parsed before the experiment was
    // enabled; the extractor then uses the available capped layout and emits
    // an explicit diagnostic warning.
    _whole_document_llm_compact: (doclingRaw as any)?._whole_document_llm_compact,
  };
}

/**
 * Azure+OpenAI Phase 4E (local implementation): local-only, test-only mock
 * injection for the business-extraction orchestrator's OpenAI call. Never a
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
function resolveMockOpenAIScenario(req: Request, body: Record<string, unknown>, requestedProvider?: string): string | undefined {
  const mocksEnabled = localProviderMocksEnabled();
  const requestedScenario = isInternalCall(req) ? String((body as any)?.debug_openai_mock_scenario ?? "").trim() : "";

  if (!mocksEnabled) {
    if (requestedScenario) {
      // A caller asked for a mock but mocks are not enabled -- fail loudly
      // rather than silently making a real call with an ignored parameter.
      throw new Error("debug_openai_mock_scenario was provided but ENABLE_LOCAL_PROVIDER_MOCKS is not set to true");
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
      throw new Error("DISABLE_EXTERNAL_PROVIDER_CALLS=true requires a valid debug_openai_mock_scenario on every internal call");
    }
    return undefined;
  }

  const VALID_SCENARIOS = new Set([
    "success", "timeout", "rate_limited", "server_error", "malformed_response",
    "empty_extraction", "auth_error", "low_evidence", "conflicting_facts",
  ]);
  if (!VALID_SCENARIOS.has(requestedScenario)) {
    throw new Error(`Unrecognized debug_openai_mock_scenario: ${requestedScenario}`);
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

// Release 1: generalized to every field via candidate-decision.ts, schema-
// driven from FieldDef.rejectedEvidencePatterns/requiredEvidencePatterns —
// previously hardcoded to exactly 2 field families (insurance, landlord/
// tenant name). Those two families' old regexes now live as
// rejectedEvidencePatterns on their fields in schemas.ts (see landlord_name/
// tenant_name); insurance fields are not yet migrated to enforced (advisory
// only for Release 1 — see getEvidencePolicyCoverage), so this preserves
// current behavior for every field except the two that were already
// enforced under the old hardcoded logic.
function isLlmSourceTextRelevantToField(
  fieldKey: string,
  sourceText: string | null,
  moduleType,
  fieldDef,
): boolean {
  if (!sourceText || !fieldDef) return true;
  const result = evaluateCandidateForField({
    field: fieldDef,
    fieldKey,
    moduleType,
    sourceText,
    sourceType: "llm",
  });
  return result.decision !== "reject";
}

function usableSourceText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return isGenericSourceText(text) ? null : text;
}

function capSourceText(text: string | null | undefined, maxChars = 350): string | null {
  if (!text) return null;
  const cleaned = cleanEvidenceSnippet(text);
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

function boundedSourceSnippet(text: string, matchStart: number, matchLength: number) {
  const source = cleanEvidenceSnippet(text);
  if (!source) return "";

  const singleLine = source;
  if (isShortCompleteSourceRow(singleLine, { requireLabelOrNumbered: true })) {
    return singleLine;
  }
  if (singleLine.length <= SOURCE_SNIPPET_MAX_CHARS && /^[A-Za-z][^:]{0,90}:\s\S/.test(singleLine)) {
    return singleLine;
  }
  if (singleLine.length <= SOURCE_SNIPPET_MAX_CHARS && /^\d+(?:\.\d+)*[.)]?\s+[A-Z]/.test(singleLine)) {
    return singleLine;
  }

  return expandSourceSnippetFromMatch(source, matchStart, matchLength, {
    clean: cleanEvidenceSnippet,
    requireLabelOrNumberedShortRow: true,
  }) ?? "";
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

function sourceEvidenceMustContainValue(fieldKey: string, fieldType?: string) {
  return fieldType === "number" || fieldType === "date" ||
    /(?:rent|amount|deposit|fee|percent|pct|rate|cap|share|rsf|sqft|sf|months|days|date)$/i.test(fieldKey) ||
    /^(?:monthly_rent|annual_rent|rent_per_sf|security_deposit|square_footage|building_rsf|lease_term_months|renewal_notice_months|termination_notice_months|escalation_rate|cam_amount|cam_cap_pct|admin_fee_pct|gross_up_threshold)$/.test(fieldKey);
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
  // Lease Truth Assembly: the ONE canonical publication layer (see
  // lease-truth-assembly.ts). Consumes the exact same merged_field_sources
  // both pipelines already produce identically, resolves true aliases and
  // duplicate-concept pairs (e.g. start_date/commencement_date,
  // tax_responsibility/responsibility_taxes) into one canonical identity per
  // legal concept, validates obligation direction / term-date order / rent
  // arithmetic, and caps confidence by the weakest critical component. Its
  // result below OVERRIDES the per-field value/status/confidence this
  // function would otherwise compute independently for every schema field
  // that participates in a tracked canonical concept -- this is what makes
  // it authoritative rather than an ignored side artifact.
  const canonicalFields = assembleCanonicalFields({
    rows: result.rows as Array<Record<string, unknown>>,
    extractionDebug,
    moduleType: extractionModuleType,
  }).canonicalFields;
  const llmReturnedFieldDetails = (extractionDebug.llm_returned_field_details ?? {}) as Record<string, any>;
  const openaiFactLedgerDebug = (extractionDebug as any)?.openai_fact_ledger ?? (extractionDebug as any)?.vertex_fact_ledger ?? null;
  const factLedgerDynamicItems = Array.isArray(openaiFactLedgerDebug?.dynamic_items)
    ? openaiFactLedgerDebug.dynamic_items
    : [];
  const minimalWorkflowOutput = extractionModuleType === "lease" && factLedgerDynamicItems.length > 0
    ? {
      lease_fields: {},
      lease_clauses: [],
      clause_records: factLedgerDynamicItems,
      extracted_document_items: factLedgerDynamicItems,
      summary: {
        extracted_document_item_count: factLedgerDynamicItems.length,
        clause_count: 0,
        dynamic_fact_ledger_item_count: factLedgerDynamicItems.length,
        enrichment_status: "pending",
      },
    }
    : null;

  const rows = result.rows.map((r, index) => {
    const values = stripInternalKeys(r);
    const fieldConfidences = (r._field_confidences ?? {}) as Record<string, number>;
    const fieldSources = (r._field_sources ?? {}) as Record<string, string>;
    const rowConfidence = normalizeConfidence(r.confidence_score ?? result.metadata?.avgConfidence) ?? avgConfidence;

    const standardFields = schemaEntries.map(([fieldKey, def]) => {
      // Lease Truth Assembly override: when this field participates in a
      // tracked canonical concept, its reconciled value/status/confidence
      // takes precedence over this function's own independent per-field
      // computation below -- this is what makes Lease Truth Assembly the
      // authoritative publisher rather than a debug-only side artifact. A
      // "not_stated" canonical result (concept never had a candidate at all)
      // falls through to the existing logic unchanged.
      const canonicalPublishId = publishIdFor(fieldKey);
      const canonicalResult = canonicalFields[canonicalPublishId];
      const canonicalActive = !!canonicalResult && canonicalResult.status !== "not_stated";

      const rawValue = cleanPartyAddressValue(fieldKey, values[fieldKey] ?? null);
      const value = canonicalActive ? canonicalResult.value : rawValue;
      const debugEvidence = mergedFieldSources[fieldKey] ?? llmReturnedFieldDetails[fieldKey] ?? null;
      const sourceText = canonicalActive ? (canonicalResult.sourceText ?? null) : (debugEvidence?.source_text ?? null);
      const sourcePage = canonicalActive ? (canonicalResult.sourcePage ?? null) : (debugEvidence?.source_page ?? null);
      const hasEvidence = !!(sourceText || sourcePage != null);
      const serverExtractionStatus = String(debugEvidence?.canonical_status ?? debugEvidence?.extraction_status ?? "").toLowerCase();
      const serverCandidates = Array.isArray(debugEvidence?.candidates) ? debugEvidence.candidates : [];
      const serverConflictCandidates = Array.isArray(debugEvidence?.conflict_candidates) ? debugEvidence.conflict_candidates : [];
      const serverConflictCandidateIds = Array.isArray(debugEvidence?.conflict_candidate_ids) ? debugEvidence.conflict_candidate_ids : serverConflictCandidates;
      const effectiveConfidence =
        (canonicalActive ? normalizeConfidence(canonicalResult.confidenceComponents.final) : null) ??
        normalizeConfidence(fieldConfidences[fieldKey]) ??
        normalizeConfidence(debugEvidence?.confidence) ??
        rowConfidence;

      let status: string;
      if (canonicalActive && canonicalResult.status === "conflicting") {
        // A genuine, evidence-backed disagreement between duplicate-concept
        // candidates (e.g. start_date vs. commencement_date) -- never
        // silently picked, always surfaced for review.
        status = "conflict_detected";
      } else if (canonicalActive && canonicalResult.status === "needs_review") {
        // Semantic incompatibility, obligation-direction mismatch, or a
        // cross-field validation failure (term-date order, rent arithmetic)
        // -- this is the direct fix for values that used to display at
        // 95-99% confidence despite being semantically invalid.
        status = "needs_review";
      } else if (serverExtractionStatus === "conflict" || serverExtractionStatus === "conflict_detected") {
        status = "conflict_detected";
      } else if (
        serverExtractionStatus === "needs_review" ||
        serverExtractionStatus === "manual_review" ||
        serverExtractionStatus === "ambiguous" ||
        serverExtractionStatus === "illegible"
      ) {
        // Whole-document v2 deliberately publishes uncertain fixed claims
        // with value=null so they cannot masquerade as auto-filled facts.
        // Preserve the model's review state instead of collapsing the row to
        // a generic "missing" field merely because the safe value is null.
        status = "needs_review";
      } else if (value == null || value === "") {
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

      const reviewField = buildReviewField({
        recordIndex: index,
        fieldKey,
        value,
        confidence: effectiveConfidence,
        source: fieldSources[fieldKey] ?? debugEvidence?.source ?? source,
        isStandard: true,
        required: !!def.required,
        fieldType: def.type ?? "string",
        description: def.description,
        evidence: hasEvidence || serverCandidates.length || serverConflictCandidates.length ? { source_text: sourceText, source_page: sourcePage, source_quality: "pending_enrichment", candidates: serverCandidates, conflict_candidates: serverConflictCandidates, conflict_candidate_ids: serverConflictCandidateIds, selected_candidate_id: debugEvidence?.selected_candidate_id ?? null, decision: debugEvidence?.decision ?? null } : null,
        candidates: serverCandidates,
        conflictCandidates: serverConflictCandidates,
        selectedCandidateId: debugEvidence?.selected_candidate_id ?? null,
        conflictCandidateIds: serverConflictCandidateIds,
        canonicalStatus: debugEvidence?.canonical_status ?? null,
        resolutionState: debugEvidence?.resolution_state ?? null,
        requiresReview: canonicalActive && (canonicalResult.status === "needs_review" || canonicalResult.status === "conflicting")
          ? true
          : (debugEvidence?.requires_review ?? undefined),
        decision: debugEvidence?.decision ?? null,
        status,
        editable: true,
      });
      // Additive transparency fields -- new keys only, do not shadow any
      // existing field on reviewField -- so every downstream consumer that
      // doesn't yet know about Lease Truth Assembly keeps working unchanged.
      return {
        ...reviewField,
        truth_assembly_field_id: canonicalPublishId,
        truth_assembly_status: canonicalActive ? canonicalResult.status : null,
        truth_assembly_validation_results: canonicalActive ? canonicalResult.validationResults : [],
        truth_assembly_version: canonicalActive ? LEASE_TRUTH_ASSEMBLY_VERSION : null,
      };
    });

    const duplicateCanonicalFields = findDuplicateCanonicalReviewFields(standardFields);
    const missingRequired = requiredFields.filter((field) => isBlank(values[field]));
    const rowValidationErrors = duplicateCanonicalFields;
    const rowWarnings = [
      ...(missingRequired.length > 0 ? [`Missing required fields: ${missingRequired.join(", ")}`] : []),
      ...(duplicateCanonicalFields.length > 0 ? [`Duplicate canonical fields: ${duplicateCanonicalFields.map((item) => item.field_key).join(", ")}`] : []),
    ];

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
      validation_errors: rowValidationErrors,
      warnings: rowWarnings,
      confidence: rowConfidence,
      notes: (r.extraction_notes as string | undefined) ?? null,
      workflow_output: minimalWorkflowOutput,
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
      ...(minimalWorkflowOutput ? {
        workflow_output: {
          records: [minimalWorkflowOutput],
          summary: minimalWorkflowOutput.summary,
        },
      } : {}),
      extraction_contract_version: EXTRACTION_CONTRACT_VERSION,
    },
    built_at: new Date().toISOString(),
  };
}

/**
 * Build the review payload consumed by the frontend review screen.
 * Structured so the UI can render a field-by-field grid with source and
 * confidence badges, and so we can diff it after the reviewer edits.
 */
/**
 * Bounded-enrich-refactor extraction of buildReviewPayload's per-field
 * evidence-verification loop (see docs/lease-extraction-architecture-audit-2026-07-29.md and the
 * "Bounded Per-Domain Enrich Refactor" plan). Unlike buildLeaseWorkflowAbstraction,
 * this loop is genuinely a per-field-independent schemaEntries.map(...) --
 * each iteration only reads fieldKey/def plus row-level closures, never
 * another field's result -- so it can be restricted to a subset of
 * schemaEntries (one domain's fields, via field-contract.ts's FieldGroup ->
 * LlmCallDomain mapping) and still produce identical per-field output to
 * running it unrestricted. buildReviewPayload below still calls this with
 * the FULL schemaEntries list, in one invocation, for every existing
 * caller -- behavior is unchanged. Only the new enrich_evidence_<domain>
 * bounded-stage handlers call this with a domain-restricted subset.
 */
function buildStandardFieldsForEntries(args: {
  schemaEntries: Array<[string, any]>;
  index: number;
  values: Record<string, unknown>;
  workflowOutput: any;
  fieldConfidences: Record<string, number>;
  fieldSources: Record<string, string>;
  fieldEvidence: Record<string, { source_text?: string | null; source_page?: number | null; extraction_status?: string | null; candidates?: unknown[]; conflict_candidates?: unknown[]; selected_candidate_id?: string | null }>;
  calculatorDerivationTraces: Record<string, string>;
  calculatorDerivationSourceFields: Record<string, string[]>;
  doclingRaw: Record<string, unknown> | null | undefined;
  extractionModuleType: string;
  truthAssemblyCanonicalFields: Record<string, any>;
  source: string;
  rowConfidence: number | null;
}) {
  const {
    schemaEntries, index, values, workflowOutput, fieldConfidences, fieldSources, fieldEvidence,
    calculatorDerivationTraces, calculatorDerivationSourceFields, doclingRaw, extractionModuleType,
    truthAssemblyCanonicalFields, source, rowConfidence,
  } = args;
  return schemaEntries.map(([fieldKey, def]) => {
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
      const llmSourceText = isLlmSourceTextRelevantToField(fieldKey, rawLlmSourceText, extractionModuleType, def)
        ? rawLlmSourceText
        : null;
      const workflowSourceText = usableSourceText(workflowField?.source_clause);
      const fallbackEvidence = !isBlank(value)
        ? findSourceEvidenceForField(doclingRaw, fieldKey, value, def)
        : null;
      const fallbackSourceText = usableSourceText(fallbackEvidence?.source_clause);
      const fieldType = def.type ?? "string";
      const strictSourceValueSupport = sourceEvidenceMustContainValue(fieldKey, fieldType);
      const supportsSelectedValue = (sourceText: unknown) => !strictSourceValueSupport || sourceTextSupportsValue(sourceText, value, fieldKey, fieldType);
      // Workflow and LLM source texts are already selected from the actual lease
      // document (clause extraction / LLM verbatim quote), so trust them directly.
      // The fallback path uses strict needle-in-haystack search, so it already
      // verifies relevance. Applying sourceTextSupportsValue to workflow/llm was
      // discarding valid source snippets whenever the extracted value appeared in
      // a slightly different form (e.g. "Triple Net" vs "NNN", "five percent" vs "5").
      const evidenceCandidates = [
        { source: "fallback", sourceText: fallbackSourceText, sourcePage: fallbackEvidence?.source_page, supportsValue: !!fallbackSourceText && supportsSelectedValue(fallbackSourceText) },
        { source: "workflow", sourceText: workflowSourceText, sourcePage: workflowField?.source_page, supportsValue: !!workflowSourceText && supportsSelectedValue(workflowSourceText) },
        { source: "llm", sourceText: llmSourceText, sourcePage: llmEvidence?.source_page, supportsValue: !!llmSourceText && supportsSelectedValue(llmSourceText) },
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
      const serverExtractionStatus = String(llmEvidence?.canonical_status ?? llmEvidence?.extraction_status ?? "").toLowerCase();
      const serverCandidates = Array.isArray(llmEvidence?.candidates) ? llmEvidence.candidates : [];
      const serverConflictCandidates = Array.isArray(llmEvidence?.conflict_candidates) ? llmEvidence.conflict_candidates : [];
      const serverConflictCandidateIds = Array.isArray(llmEvidence?.conflict_candidate_ids) ? llmEvidence.conflict_candidate_ids : serverConflictCandidates;
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
        serverExtractionStatus === "conflict" || serverExtractionStatus === "conflict_detected"
          ? "conflict_detected"
          : inferredStatus === "needs_review"
          ? "needs_review"
          : workflowStatus === "calculated"
            ? "calculated"
            : workflowStatus === "manual_required"
              ? "manual_required"
              : inferredStatus;

      // Lease Truth Assembly override -- applied LAST, after every existing
      // fallback/recovery heuristic above has already computed its own best
      // value/status/confidence, exactly mirroring the override in
      // buildMinimalReviewPayload. A "not_stated" canonical result (this
      // concept never had ANY candidate) leaves all of the above untouched.
      const truthAssemblyPublishId = publishIdFor(fieldKey);
      const truthAssemblyResult = truthAssemblyCanonicalFields[truthAssemblyPublishId];
      const truthAssemblyActive = !!truthAssemblyResult && truthAssemblyResult.status !== "not_stated";
      const effectiveValue = truthAssemblyActive ? truthAssemblyResult.value : value;
      const effectiveSourceText = truthAssemblyActive && truthAssemblyResult.sourceText != null ? truthAssemblyResult.sourceText : mergedSourceText;
      const effectiveSourcePage = truthAssemblyActive && truthAssemblyResult.sourcePage != null ? truthAssemblyResult.sourcePage : mergedSourcePage;
      const effectiveFieldConfidence = truthAssemblyActive
        ? (normalizeConfidence(truthAssemblyResult.confidenceComponents.final) ?? effectiveConfidence)
        : effectiveConfidence;
      const truthAssemblyHasOwnEvidence = truthAssemblyActive && (truthAssemblyResult.sourceText != null || truthAssemblyResult.sourcePage != null);
      const effectiveStatus =
        truthAssemblyActive && truthAssemblyResult.status === "conflicting" ? "conflict_detected"
        : truthAssemblyActive && truthAssemblyResult.status === "needs_review" ? "needs_review"
        // A canonical "verified"/"derived_verified" result with its OWN
        // evidence is authoritative on its own terms -- it must not be
        // downgraded to missing_source_evidence merely because THIS
        // function's separate, row-internal (_field_evidence-based) evidence
        // lookup happens to disagree with what Lease Truth Assembly already
        // resolved from the shared merged_field_sources evidence.
        : truthAssemblyHasOwnEvidence && truthAssemblyResult.status === "derived_verified" ? "calculated"
        : truthAssemblyHasOwnEvidence && truthAssemblyResult.status === "verified" ? "extracted"
        : finalStatus;

      const truthAssemblyReviewField = buildReviewField({
        recordIndex: index,
        fieldKey,
        value: effectiveValue,
        confidence: effectiveFieldConfidence,
        source: fieldSources[fieldKey] ?? source,
        isStandard: true,
        required: !!def.required,
        fieldType,
        description: def.description,
        evidence: {
          page_number: effectiveSourcePage,
          source_clause: effectiveSourceText,
          source_quality: selectedEvidence?.source === "fallback" ? fallbackEvidence?.source_quality ?? null : null,
          matched_needle: selectedEvidence?.source === "fallback" ? fallbackEvidence?.matched_needle ?? null : null,
          // Release 1: prefer lease-workflow.ts's derivation_trace (richer,
          // field-specific business logic already reaching the UI for
          // annual_rent/rent_per_sf/lease_term/etc.) and fall back to
          // calculator.ts's trace for the fields only it derives
          // (monthly_rent, square_footage, lease_term_months) that
          // previously had no UI-visible provenance at all.
          derivation_trace: workflowField?.derivation_trace ?? calculatorDerivationTraces?.[fieldKey] ?? null,
          source_field_keys: workflowField?.source_field_keys ?? calculatorDerivationSourceFields?.[fieldKey] ?? undefined,
          candidates: serverCandidates,
          conflict_candidates: serverConflictCandidates,
          conflict_candidate_ids: serverConflictCandidateIds,
          selected_candidate_id: llmEvidence?.selected_candidate_id ?? null,
          decision: llmEvidence?.decision ?? null,
        },
        candidates: serverCandidates,
        conflictCandidates: serverConflictCandidates,
        selectedCandidateId: llmEvidence?.selected_candidate_id ?? null,
        conflictCandidateIds: serverConflictCandidateIds,
        canonicalStatus: llmEvidence?.canonical_status ?? null,
        resolutionState: llmEvidence?.resolution_state ?? null,
        requiresReview: truthAssemblyActive && (truthAssemblyResult.status === "needs_review" || truthAssemblyResult.status === "conflicting")
          ? true
          : (llmEvidence?.requires_review ?? undefined),
        decision: llmEvidence?.decision ?? null,
        status: effectiveStatus,
        editable: workflowField?.editable ?? true,
        validationErrors: Array.isArray(workflowField?.validation_errors) ? workflowField.validation_errors : [],
      });
      // Additive transparency fields -- new keys only, mirrors
      // buildMinimalReviewPayload's own equivalent addition.
      return {
        ...truthAssemblyReviewField,
        truth_assembly_field_id: truthAssemblyPublishId,
        truth_assembly_status: truthAssemblyActive ? truthAssemblyResult.status : null,
        truth_assembly_validation_results: truthAssemblyActive ? truthAssemblyResult.validationResults : [],
        truth_assembly_version: truthAssemblyActive ? LEASE_TRUTH_ASSEMBLY_VERSION : null,
      };
  });
}

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
  /**
   * Bounded-enrich-refactor hook (see docs/lease-extraction-architecture-audit-2026-07-29.md and the
   * "Bounded Per-Domain Enrich Refactor" plan). When provided, buildReviewPayload
   * uses this ALREADY-COMPUTED per-row workflow abstraction (pooled from
   * enrich_clauses/enrich_fields/enrich_items/enrich_derivation's separate,
   * bounded invocations via runLeaseWorkflowStage4Derivation) instead of
   * calling buildLeaseWorkflowAbstraction() fresh in this invocation. This is
   * the ONE integration point that lets enrich_truth_assembly reuse this
   * entire function (and its ~150-line final-assembly tail) verbatim instead
   * of duplicating it -- every existing caller that omits this parameter
   * gets IDENTICAL behavior to before (computes workflowOutputs fresh, as
   * always). Index-aligned with result.rows.
   */
  precomputedWorkflowOutputs?: Array<Record<string, any>> | null;
  /**
   * Bounded-enrich-refactor hook, symmetric to precomputedWorkflowOutputs
   * above. When provided, buildReviewPayload uses this ALREADY-COMPUTED,
   * per-row standardFields array (pooled from the 5 enrich_evidence_<domain>
   * stages' separate, bounded invocations of buildStandardFieldsForEntries)
   * instead of calling buildStandardFieldsForEntries() fresh, unrestricted,
   * in this invocation. Without this hook, enrich_truth_assembly reusing
   * buildReviewPayload would silently re-pay the ENTIRE evidence-verification
   * cost the 5 domain stages were specifically built to bound -- this is
   * what actually avoids that. Every existing caller that omits this
   * parameter gets IDENTICAL behavior to before. Index-aligned with result.rows.
   */
  precomputedStandardFieldsByRow?: Array<Array<Record<string, any>>> | null;
}) {
  const { fileId, fileName, moduleType, documentSubtype, extractionMethod, reviewRequired, doclingRaw, result, precomputedWorkflowOutputs, precomputedStandardFieldsByRow } = opts;
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
  // openai_fact_ledger diagnostics (undefined for legacy_hybrid — both
  // spreads below become no-ops, preserving existing behavior exactly).
  const openaiFactLedgerDebug = (reviewExtractionDebug as any)?.openai_fact_ledger ?? (reviewExtractionDebug as any)?.vertex_fact_ledger ?? null;
  // Lease Truth Assembly: the ONE canonical publication layer (see
  // lease-truth-assembly.ts). Computed HERE, before buildLeaseWorkflowAbstraction
  // runs, and used to build "effective rows" below -- buildLeaseWorkflowAbstraction's
  // own leaseFields (workflow_output.lease_fields) independently re-derives
  // values from the raw row via buildLeaseFieldMap(), and the frontend's
  // display-mode fallback hierarchy checks workflow_output.lease_fields
  // BEFORE standard_fields/fields -- so overriding only standard_fields
  // (below) would leave this earlier, higher-priority fallback source
  // showing an un-reconciled value whenever it has its own evidence,
  // silently defeating the whole point of a single canonical publisher.
  // Feeding buildLeaseWorkflowAbstraction an already-reconciled row is what
  // makes Lease Truth Assembly authoritative for BOTH payload shapes from
  // one computation, rather than needing a second copy of its logic inside
  // lease-workflow.ts.
  const truthAssemblyCanonicalFields = assembleCanonicalFields({
    rows: result.rows as Array<Record<string, unknown>>,
    extractionDebug: reviewExtractionDebug,
    moduleType: extractionModuleType,
  }).canonicalFields;
  const truthAssemblyEffectiveRows = result.rows.map((row) => {
    const effective: Record<string, unknown> = { ...row };
    for (const [fieldKey] of schemaEntries) {
      const publishId = publishIdFor(fieldKey);
      const canonicalResult = truthAssemblyCanonicalFields[publishId];
      if (!canonicalResult || canonicalResult.status === "not_stated") continue;
      effective[fieldKey] = canonicalResult.status === "conflicting" ? null : canonicalResult.value;
    }
    return effective;
  });
  const workflowOutputs = precomputedWorkflowOutputs
    ? precomputedWorkflowOutputs
    : extractionModuleType === "lease"
    ? truthAssemblyEffectiveRows.map((row, rowIndex) =>
      buildLeaseWorkflowAbstraction({
        row,
        doclingRaw: doclingRaw ?? null,
        documentSubtype,
        ...(rowIndex === 0 ? { unmappedLlmFields } : {}),
        ...(openaiFactLedgerDebug?.document_profile ? { documentProfileOverride: openaiFactLedgerDebug.document_profile } : {}),
        ...(rowIndex === 0 && Array.isArray(openaiFactLedgerDebug?.dynamic_items)
          ? { factLedgerDynamicItems: openaiFactLedgerDebug.dynamic_items }
          : {}),
      })
    )
    : [];
  const rows = result.rows.map((r, index) => {
    const values = stripInternalKeys(r);
    if (isLeaseModuleType(moduleType) && isBlank(values.notes)) {
      const camNote = extractCamNoteFromText(doclingRaw);
      if (camNote) values.notes = camNote;
    }
    const fieldConfidences = (r._field_confidences ?? {}) as Record<string, number>;
    const fieldSources = (r._field_sources ?? {}) as Record<string, string>;
    const fieldEvidence = (r._field_evidence ?? {}) as Record<string, { source_text?: string | null; source_page?: number | null; extraction_status?: string | null; candidates?: unknown[]; conflict_candidates?: unknown[]; selected_candidate_id?: string | null }>;
    // Release 1: calculator.ts's Step6 (_shared/extraction/calculator.ts)
    // computes a real derivation trace for every field it derives (e.g.
    // "monthly_rent(1470) x 12" for annual_rent), but this was previously
    // never read here — stripInternalKeys() above only strips `_`-prefixed
    // keys from `values`, it doesn't delete them from `r`, so the trace was
    // silently discarded rather than actually lost. Read directly off the
    // raw row `r`, same pattern as fieldConfidences/fieldSources above.
    const calculatorDerivationTraces = (r._derivation_traces ?? {}) as Record<string, string>;
    // Same rationale as calculatorDerivationTraces above: calculator.ts now
    // also records which input fields fed each derivation (source_field_keys),
    // read the identical way -- leaseReviewSchema.js's readFieldEvidence()
    // already expects this shape (entry.evidence?.source_field_keys), it just
    // never received it for the fields only calculator.ts derives.
    const calculatorDerivationSourceFields = (r._derivation_source_fields ?? {}) as Record<string, string[]>;
    const rowConfidence = normalizeConfidence(
      r.confidence_score ?? result.metadata?.avgConfidence,
    ) ?? avgConfidence;
    const workflowOutput = workflowOutputs[index] ?? null;
    const standardFields = precomputedStandardFieldsByRow?.[index] ?? buildStandardFieldsForEntries({
      schemaEntries, index, values, workflowOutput, fieldConfidences, fieldSources, fieldEvidence,
      calculatorDerivationTraces, calculatorDerivationSourceFields, doclingRaw, extractionModuleType,
      truthAssemblyCanonicalFields, source, rowConfidence,
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
    const duplicateCanonicalFields = findDuplicateCanonicalReviewFields([...standardFields, ...customFields]);
    const missingRequired = requiredFields.filter((field) => isBlank(values[field]));
    const rowValidationErrors = duplicateCanonicalFields;
    const rowWarnings = [
      ...(missingRequired.length > 0 ? [`Missing required fields: ${missingRequired.join(", ")}`] : []),
      ...(duplicateCanonicalFields.length > 0 ? [`Duplicate canonical fields: ${duplicateCanonicalFields.map((item) => item.field_key).join(", ")}`] : []),
    ];

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
      validation_errors: rowValidationErrors,
      warnings: rowWarnings,
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
      // Release 1: how much of the schema has real (enforced) evidence
      // validation vs. advisory-only vs. no check at all — admin-only,
      // keeps the configuration gap honestly visible. See schemas.ts#getEvidencePolicyCoverage.
      evidence_policy_coverage: getEvidencePolicyCoverage(extractionModuleType),
    },
    built_at: new Date().toISOString(),
  };
}

function filterUserWarnings(warnings: string[] = [], rowCount = 0): string[] {
  const out: string[] = [];
  for (const warning of warnings) {
    const text = String(warning || "");
    if (rowCount > 0 && /no tables found/i.test(text)) continue;
    if (rowCount > 0 && /OPENAI_API_KEY|OpenAI|AI fallback|No LLM configured/i.test(text)) {
      continue;
    }
    if (/OPENAI_API_KEY|OpenAI|No LLM configured/i.test(text)) {
      const sanitized = "AI fallback extraction is unavailable because OpenAI is not configured. Deterministic document parsing still ran.";
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

function findDuplicateCanonicalReviewFields(fields: Array<Record<string, any>>) {
  const seen = new Set<string>();
  const duplicates: Array<{ code: string; field_key: string; canonical_field_key: string; scope_key: string }> = [];
  for (const field of fields) {
    const canonicalFieldKey = String(field?.canonical_field_key ?? field?.field_key ?? "").trim();
    if (!canonicalFieldKey) continue;
    const scopeKey = String(field?.scope_key ?? "lease").trim() || "lease";
    const uniqueKey = `${scopeKey}:${canonicalFieldKey}`;
    if (seen.has(uniqueKey)) {
      duplicates.push({
        code: "DUPLICATE_CANONICAL_FIELD",
        field_key: String(field?.field_key ?? canonicalFieldKey),
        canonical_field_key: canonicalFieldKey,
        scope_key: scopeKey,
      });
      continue;
    }
    seen.add(uniqueKey);
  }
  return duplicates;
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
  candidates?: unknown[];
  conflictCandidates?: unknown[];
  conflictCandidateIds?: unknown[];
  selectedCandidateId?: string | null;
  canonicalStatus?: string | null;
  resolutionState?: string | null;
  requiresReview?: boolean;
  decision?: Record<string, unknown> | null;
}) {
  const hasMarkup = rejectMarkupValue(opts.value);
  const effectiveValue = hasMarkup ? null : (opts.value ?? null);
  const blank = isBlank(effectiveValue);
  const status = hasMarkup ? "needs_review" : opts.status;
  const hasEvidence = Boolean(opts.evidence);
  const canonicalStatus = normalizeLeaseReviewFieldStatus(opts.canonicalStatus ?? status, { value: effectiveValue, hasEvidence });
  const resolutionState = opts.resolutionState ?? resolutionStateForStatus(canonicalStatus, opts.selectedCandidateId ?? null);
  const requiresReview = opts.requiresReview ?? (canonicalStatus === "conflict" || canonicalStatus === "invalid" || canonicalStatus === "manual_review" || canonicalStatus === "insufficient_evidence");
  const baseValidationErrors = Array.isArray(opts.validationErrors) ? opts.validationErrors : [];
  const validationErrors = hasMarkup
    ? [...baseValidationErrors, "Rejected: extracted value contained HTML/markup fragments"]
    : baseValidationErrors;
  return {
    id: `${opts.recordIndex}:${opts.isStandard ? "standard" : "custom"}:${opts.fieldKey}`,
    field_key: opts.fieldKey,
    canonical_field_key: opts.fieldKey,
    scope_key: "lease",
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
    canonical_status: canonicalStatus,
    resolution_state: resolutionState,
    requires_review: requiresReview,
    authoritative_value: getAuthoritativeFieldValue({ value: effectiveValue, status, canonical_status: canonicalStatus, review_status: null, evidence: opts.evidence }),
    validation_errors: validationErrors,
    candidates: opts.candidates ?? [],
    conflict_candidates: opts.conflictCandidates ?? [],
    conflict_candidate_ids: opts.conflictCandidateIds ?? opts.conflictCandidates ?? [],
    selected_candidate_id: opts.selectedCandidateId ?? null,
    decision: opts.decision ?? null,
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
  if (lower.includes("llm") || lower.includes("openai")) return "llm";
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

function normalizeFactLedgerResume(value: unknown): import("../_shared/extraction/openai-fact-ledger/types.ts").FactLedgerResumeState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const startChunkIndex = Math.floor(Number(raw.startChunkIndex ?? raw.nextChunkIndex ?? 0));
  const priorFacts = Array.isArray(raw.priorFacts) ? raw.priorFacts : Array.isArray(raw.partialFacts) ? raw.partialFacts : [];
  if ((!Number.isFinite(startChunkIndex) || startChunkIndex <= 0) && priorFacts.length === 0) return undefined;
  return {
    startChunkIndex: Number.isFinite(startChunkIndex) && startChunkIndex > 0 ? startChunkIndex : 0,
    priorFacts: priorFacts as any[],
    chunksProcessed: Number.isFinite(Number(raw.chunksProcessed)) ? Number(raw.chunksProcessed) : undefined,
    chunksSucceeded: Number.isFinite(Number(raw.chunksSucceeded)) ? Number(raw.chunksSucceeded) : undefined,
    chunksFailed: Number.isFinite(Number(raw.chunksFailed)) ? Number(raw.chunksFailed) : undefined,
    failedChunkIndexes: Array.isArray(raw.failedChunkIndexes) ? raw.failedChunkIndexes.map((n) => Number(n)).filter(Number.isFinite) : undefined,
  };
}
async function persistFactLedgerProgress(args: {
  supabaseAdmin: any;
  logger: any;
  pipelineJobId?: string | null;
  fileId: string;
  progress: Record<string, unknown>;
}): Promise<void> {
  const progress = {
    ...args.progress,
    updated_at: new Date().toISOString(),
    continuation_enqueue_supported: true,
  };

  await args.logger.event("normalize", "progress", {
    kind: "openai_fact_ledger_progress",
    openai_fact_ledger_progress: progress,
  });

  if (!args.pipelineJobId) return;

  try {
    const { data: existing } = await args.supabaseAdmin
      .from("pipeline_jobs")
      .select("metadata")
      .eq("id", args.pipelineJobId)
      .maybeSingle();

    const metadata = existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {};
    await args.supabaseAdmin
      .from("pipeline_jobs")
      .update({
        metadata: {
          ...metadata,
          openai_fact_ledger_progress: progress,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", args.pipelineJobId);
  } catch (error) {
    console.warn(`[normalize-pdf-output] fact ledger progress persist failed file_id=${args.fileId}`, error);
  }
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
  /** P1.3: server-owned attempt number from the claimed pipeline_jobs.attempt
   * (post-claim value, already incremented by claim_pipeline_job) -- never
   * a locally-tracked counter. */
  workerAttempt?: number | null;
  jsonResponse: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  const { supabaseAdmin, orgId, fileId, pipelineJobId, workerAttempt, jsonResponse } = args;
  const logger = createLogger(supabaseAdmin, fileId, orgId);
  let stage: StageHandle | null = null;

  // docling_raw and azure_raw_response are always written as identical
  // duplicates of each other (lease-extraction-worker/index.ts:115-116,
  // 311-312; parse-document-azure/index.ts:275-276, 680-681 -- every
  // production write site sets both columns to the same value). Fetching
  // both here doubles an already-large OCR blob for no reason, on top of
  // normalized_output + ui_review_payload (each can be 1-3 MB -- see the
  // trimmed-SELECT comment at the other selectUploadedFileWithV3Fallback
  // call below) -- a combination that has previously pushed this function
  // past its memory ceiling (546, "not enough compute resources").
  const { data: fileRecord, error: fetchError } = await selectUploadedFileWithV3Fallback(
    supabaseAdmin,
    "id, org_id, file_name, module_type, status, review_required, document_subtype, " +
      "extraction_method, docling_raw, normalized_output, ui_review_payload, active_generation_id",
    fileId,
    orgId,
  );

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

  // P1.3: stage created only now that real work is actually starting (past
  // the staleness/status/idempotency pre-flight checks above), and only
  // when this generation is provenance-enabled (jobGenerationId resolved).
  // extraction_run_id is resolved here (not passed in) because
  // jobGenerationId itself is only known at this point, from the claimed
  // job's own pipeline_jobs.generation_id.
  if (jobGenerationId) {
    const enrichExtractionRunId = await resolveExtractionRunId(supabaseAdmin, orgId, jobGenerationId);
    stage = await withExtractionStage(supabaseAdmin, {
      orgId,
      uploadedFileId: fileId,
      generationId: jobGenerationId,
      extractionRunId: enrichExtractionRunId,
      pipelineJobId,
      stage: "enrich",
      attempt: Number(workerAttempt) || 1,
    });
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
      enrichedPayload.metadata.extraction_contract_version = EXTRACTION_CONTRACT_VERSION;
    }

    const clauseCount = enrichedPayload.records?.[0]?.workflow_output?.lease_clauses?.length ?? 0;
    const sourceBackedCount = (enrichedPayload.records?.[0]?.standard_fields ?? []).filter(
      (f: any) => f?.evidence?.source_text || f?.evidence?.source_page != null,
    ).length;

    if (await isEnrichGenerationStale()) {
      console.log(`[normalize-pdf-output] enrich_stale_generation_skipped file_id=${fileId} job_id=${pipelineJobId} — superseded before persisting result, discarding stale output`);
      // Not a processing failure -- a newer generation started. No real
      // 'superseded' extraction_stage_runs status exists yet (avoiding
      // another schema change during P1.3, per the plan); fail() with this
      // specific error_code/outcome distinguishes it from an ordinary
      // terminal failure for anything reading this data later.
      await stage?.fail("STAGE_SUPERSEDED", "Superseded by a newer extraction generation before persisting the enrich result.", { outcome: "superseded" });
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

    // P2.7: claims ledger side-write, mode-gated (off/shadow/active, P2.2).
    // maybeRunClaimsLedgerForStage never throws -- a claims-ledger failure
    // must never break the primary enrich response, which is already
    // durably persisted above. Active-mode correctness is enforced later,
    // by finalize_lease_extraction_for_review's own P2.7 checks, not by
    // failing this stage.
    const claimsLedgerMode = getLeaseClaimsLedgerMode();
    const packageMode = getLeaseDocumentPackageMode();
    const financialMode = getLeaseFinancialScheduleMode();
    let enrichExtractionRunId: string | null = null;
    if (claimsLedgerMode !== "off" && jobGenerationId) {
      enrichExtractionRunId = await resolveExtractionRunId(supabaseAdmin, orgId, jobGenerationId);
      const recordFields = (enrichedPayload.records?.[0]?.fields ?? {}) as Record<string, any>;
      const deterministicFields: Record<string, any> = {};
      for (const [fieldKey, field] of Object.entries(recordFields)) {
        if (!field || typeof field !== "object") continue;
        deterministicFields[fieldKey] = {
          value: field.value ?? null,
          source: field.source === "llm" ? "llm" : field.source === "table" ? "table" : "rule",
          confidence: typeof field.confidence === "number" ? field.confidence : 0,
          sourceText: field.evidence?.source_clause ?? null,
          sourcePage: field.evidence?.page_number ?? null,
        };
      }
      // Discovered/unmapped LLM findings surface inside workflow_output.lease_fields
      // as synthetic entries with field_group:"discovered" (built from
      // unmappedLlmFields by buildLeaseWorkflowAbstraction,
      // lease-workflow.ts:3086-3107) -- there is no separately-exposed
      // unmapped_llm_keys array on the output, so this is the real,
      // grounded source for the dynamic-findings adapter.
      const workflowLeaseFields = ((enrichedPayload.records?.[0]?.workflow_output as any)?.lease_fields ?? {}) as Record<string, any>;
      const unmappedLlmFields = Object.entries(workflowLeaseFields)
        .filter(([, field]) => field?.field_group === "discovered")
        .map(([key, field]) => ({
          key,
          value: field.value ?? null,
          sourceText: field.source_clause ?? field.exact_source_text ?? null,
          sourcePage: field.source_page ?? null,
          confidence: typeof field.confidence_score === "number" ? field.confidence_score : null,
        }));

      await maybeRunClaimsLedgerForStage(
        supabaseAdmin,
        {
          orgId,
          uploadedFileId: fileId,
          leaseId: null,
          extractionRunId: enrichExtractionRunId,
          extractionStageRunId: stage?.stageRunId ?? null,
          generationId: jobGenerationId,
          stageAttempt: Number(workerAttempt) || 1,
        },
        {
          deterministicFields,
          semanticCandidateGroups: [],
          unmappedLlmFields,
          legacyExtractionData: { fields: recordFields },
        },
      );
    }

    // P3.7: package runtime is a single mode-gated server boundary after P2
    // projection and before the finalizer. Mode=off does not call the
    // orchestrator at all, preserving the P3.6 runtime baseline exactly.
    if (packageMode !== "off" && jobGenerationId) {
      if (!enrichExtractionRunId) {
        enrichExtractionRunId = await resolveExtractionRunId(supabaseAdmin, orgId, jobGenerationId);
      }
      const recordFields = (enrichedPayload.records?.[0]?.fields ?? {}) as Record<string, any>;
      await maybeRunLeaseDocumentPackagePipeline(
        supabaseAdmin,
        {
          orgId,
          uploadedFileId: fileId,
          leaseId: null,
          extractionRunId: enrichExtractionRunId,
          extractionStageRunId: stage?.stageRunId ?? null,
          generationId: jobGenerationId,
          stageAttempt: Number(workerAttempt) || 1,
        },
        { singleDocumentCompatibility: { fields: recordFields } },
      );
    }
    // P4.7: financial runtime is a single mode-gated server boundary after
    // P2/P3 authority and before the finalizer. Mode=off does not invoke it.
    if (financialMode !== "off" && jobGenerationId) {
      if (!enrichExtractionRunId) {
        enrichExtractionRunId = await resolveExtractionRunId(supabaseAdmin, orgId, jobGenerationId);
      }
      const recordFields = (enrichedPayload.records?.[0]?.fields ?? {}) as Record<string, any>;
      await maybeRunLeaseFinancialScheduleRuntime(
        supabaseAdmin,
        {
          orgId,
          uploadedFileId: fileId,
          leaseId: null,
          extractionRunId: enrichExtractionRunId,
          generationId: jobGenerationId,
          stageAttempt: Number(workerAttempt) || 1,
        },
        { currentCompatibility: { fields: recordFields }, packageAwareInput: packageMode !== "off" },
      );
    }

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
        p_ledger_mode: claimsLedgerMode,
        p_package_mode: packageMode,
        p_financial_mode: financialMode,
      });
    } catch (finalizeError: any) {
      console.warn(`[normalize-pdf-output] finalize_lease_extraction_for_review call failed file_id=${fileId}:`, finalizeError?.message ?? finalizeError);
    }

    await stage?.complete({
      outcome: "completed",
      evidenceProduced: sourceBackedCount,
      fieldsProduced: clauseCount,
    });

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
      await stage?.fail("STAGE_SUPERSEDED", "Superseded by a newer extraction generation before persisting the enrich failure.", { outcome: "superseded" });
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
        p_package_mode: getLeaseDocumentPackageMode(),
        p_financial_mode: getLeaseFinancialScheduleMode(),
      });
    } catch (finalizeError: any) {
      console.warn(`[normalize-pdf-output] finalize_lease_extraction_for_review call failed file_id=${fileId}:`, finalizeError?.message ?? finalizeError);
    }

    await stage?.fail("ENRICHMENT_FAILED", message, { outcome: "terminal_failure" });
    return jsonResponse({ error: true, message, error_code: "ENRICHMENT_FAILED" }, 500);
  } finally {
    await stage?.ensureSettled();
  }
}

// ---------------------------------------------------------------------------
// Bounded Per-Domain Enrich Refactor (see docs/lease-extraction-architecture-audit-2026-07-29.md and
// the "Bounded Per-Domain Enrich Refactor" plan). Each of the 10 stage names
// in enrich-bounded-stage/stage-sequence.ts is handled by ONE call to
// handleBoundedEnrichStage below -- one stage, one Edge Function invocation,
// memory released before the next stage's invocation starts. This is the
// active wiring: lease-extraction-worker dispatches these stages instead of
// the single monolithic "enrich" mode when ENRICH_BOUNDED_STAGE_MODE is
// "active" (see feature-mode.ts) -- the monolithic handleEnrichMode() above
// remains completely unchanged and is what still runs when it is "off".
// ---------------------------------------------------------------------------

/** Reads a prior stage's persisted output, but ONLY if it actually completed -- never reuses a failed/incomplete/missing entry. */
function getCompletedStageData(results: Record<string, BoundedStageResultEntry>, stage: EnrichBoundedStageName): any | null {
  const entry = results[stage];
  return entry && entry.status === "completed" ? entry.data : null;
}

/**
 * Phase 4.5: the shared body of what used to be 5 fallthrough
 * `case "enrich_evidence_<domain>":` labels inside handleBoundedEnrichStage's
 * switch, extracted verbatim (only `stage`/`STAGE_TO_LLM_CALL_DOMAIN[stage]!`
 * became the passed-in `domain` parameter -- no other line changed). Returns
 * `stageData` exactly like every other stage's case body does; the caller
 * still owns the shared post-switch fence-check/telemetry/persistence tail,
 * which is untouched by this extraction (see the Phase 4.5 plan's grounding
 * note on why this is not a self-returning Response handler).
 */
function handleEnrichEvidenceDomainStage(args: {
  domain: LlmCallDomain;
  derivation: unknown;
  extractionModuleType: ExtractionModuleType;
  row: Record<string, unknown>;
  moduleType: string;
  doclingRaw: Record<string, unknown> | null;
  truthAssemblyCanonicalFields: ReturnType<typeof assembleCanonicalFields>["canonicalFields"];
  fileRecord: any;
  normalizedOutput: any;
}): any {
  const { domain, derivation, extractionModuleType, row, moduleType, doclingRaw, truthAssemblyCanonicalFields, fileRecord, normalizedOutput } = args;
  const schema = getSchema(extractionModuleType);
  const allSchemaEntries = Object.entries(schema).filter(([, def]) => !(def as any).derived);
  const domainEntries = getSchemaEntriesForDomain(allSchemaEntries, domain);
  // Deliberately the RAW row here, matching buildReviewPayload's own
  // evidence loop exactly -- its per-field Lease Truth Assembly
  // override happens later, inside buildStandardFieldsForEntries,
  // directly from truthAssemblyCanonicalFields (see that function's
  // own comment) -- NOT via a pre-overridden row like the workflow-
  // abstraction stages above need.
  const values = stripInternalKeys(row);
  // Mirrors buildReviewPayload's own rows.map() exactly (see its
  // extractCamNoteFromText call): a blank "notes" field on a lease row
  // falls back to a CAM sentence pulled from the document text itself.
  // Omitting this here silently regresses "notes" for lease documents
  // in the bounded path (caught by _tests/enrich-bounded-stages.test.ts's
  // byte-equivalence gate).
  if (isLeaseModuleType(moduleType) && isBlank(values.notes)) {
    const camNote = extractCamNoteFromText(doclingRaw);
    if (camNote) values.notes = camNote;
  }
  const fieldConfidencesRow = (row._field_confidences ?? {}) as Record<string, number>;
  const fieldSourcesRow = (row._field_sources ?? {}) as Record<string, string>;
  const fieldEvidenceRow = (row._field_evidence ?? {}) as Record<string, any>;
  const calculatorDerivationTraces = (row._derivation_traces ?? {}) as Record<string, string>;
  const calculatorDerivationSourceFields = (row._derivation_source_fields ?? {}) as Record<string, string[]>;
  const rowConfidence = normalizeConfidence((row as any).confidence_score ?? normalizedOutput.metadata?.avgConfidence);
  const source = sourceFromMethod(fileRecord.extraction_method ?? normalizedOutput.method);
  return buildStandardFieldsForEntries({
    schemaEntries: domainEntries, index: 0, values, workflowOutput: derivation,
    fieldConfidences: fieldConfidencesRow, fieldSources: fieldSourcesRow, fieldEvidence: fieldEvidenceRow,
    calculatorDerivationTraces, calculatorDerivationSourceFields, doclingRaw, extractionModuleType,
    truthAssemblyCanonicalFields, source, rowConfidence,
  });
}

async function handleBoundedEnrichStage(args: {
  supabaseAdmin: any;
  orgId: string;
  fileId: string;
  pipelineJobId: string;
  generationId: string;
  stage: EnrichBoundedStageName;
  workerAttempt?: number | null;
  jsonResponse: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  const { supabaseAdmin, orgId, fileId, pipelineJobId, generationId, stage, jsonResponse } = args;

  // --- 1. validate identifiers (reference-only request body -- see the plan) ---
  if (!fileId) return jsonResponse({ error: true, error_code: "MISSING_FILE_ID", message: "file_id is required" }, 400);
  if (!pipelineJobId) return jsonResponse({ error: true, error_code: "MISSING_PIPELINE_JOB_ID", message: "pipeline_job_id is required" }, 400);
  if (!generationId) return jsonResponse({ error: true, error_code: "MISSING_GENERATION_ID", message: "generation_id is required" }, 400);
  if (!isEnrichBoundedStageName(stage)) {
    return jsonResponse({ error: true, error_code: "UNKNOWN_BOUNDED_STAGE", message: `Unknown bounded enrich stage: ${stage}` }, 400);
  }

  const logger = createLogger(supabaseAdmin, fileId, orgId);

  // --- 2. enforce the generation fence BEFORE loading any data ---
  const preFence = await checkGenerationStillActive({ supabaseAdmin, fileId, orgId, expectedGenerationId: generationId });
  if (!preFence.stillActive) {
    console.log(`[normalize-pdf-output] bounded_stage_stale_generation_skipped stage=${stage} file_id=${fileId} generation_id=${generationId} current=${preFence.currentGenerationId}`);
    return jsonResponse({ error: false, file_id: fileId, stage, stale_generation: true }, 200);
  }

  // --- 3. load only the persisted input this stage needs. Every bounded
  // stage needs docling_raw + normalized_output (to reconstruct row state);
  // only enrich_truth_assembly additionally needs ui_review_payload (it is
  // the only stage that overwrites it -- see the plan's requirement that
  // only final assembly may overwrite the minimal payload with the rich
  // canonical one). file_name/review_required are tiny scalars, fetched
  // uniformly for simplicity -- they are not the columns previously
  // implicated in 546 (docling_raw/normalized_output/ui_review_payload,
  // each "can be 1-3 MB" per handleEnrichMode's own comment above).
  const needsUiReviewPayload = isFinalEnrichBoundedStage(stage);
  const { data: fileRecord, error: fetchError } = await supabaseAdmin
    .from("uploaded_files")
    .select(
      "id, org_id, file_name, module_type, document_subtype, extraction_method, review_required, docling_raw, normalized_output, active_generation_id" +
      (needsUiReviewPayload ? ", ui_review_payload" : ""),
    )
    .eq("id", fileId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (fetchError || !fileRecord) {
    return jsonResponse({ error: true, error_code: "FILE_NOT_FOUND", message: `File not found: ${fetchError?.message ?? "invalid file_id"}` }, 404);
  }

  const normalizedOutput = fileRecord.normalized_output as {
    rows: Record<string, unknown>[];
    method: string;
    warnings: string[];
    validationErrors: unknown[];
    metadata: Record<string, unknown>;
  } | null;
  if (!normalizedOutput || !Array.isArray(normalizedOutput.rows)) {
    return jsonResponse({ error: true, error_code: "NO_NORMALIZED_OUTPUT", message: "No normalized_output found to enrich -- run normalize first." }, 422);
  }

  // --- idempotency: a repeated invocation of an already-completed stage
  // (same generation, same stage_version) returns the existing result
  // without recomputing anything -- no Azure/OpenAI calls, no duplicate
  // rows, no double-advance. ---
  const idempotencyCheck = isStageAlreadyCompleted({ normalizedOutput, stage, generationId });
  if (idempotencyCheck.reusable) {
    console.log(`[normalize-pdf-output] bounded_stage_already_completed stage=${stage} file_id=${fileId} generation_id=${generationId}`);
    await logger.event(stage, "reused_from_cache", { metadata: { job_id: pipelineJobId, generation_id: generationId } });
    return jsonResponse({ error: false, file_id: fileId, stage, status: "completed", reused_from_cache: true }, 200);
  }

  const moduleType = fileRecord.module_type ?? "unknown";
  const documentSubtype = fileRecord.document_subtype ?? null;
  const doclingRaw = (fileRecord.docling_raw ?? null) as Record<string, unknown> | null;
  const row = (normalizedOutput.rows[0] ?? {}) as Record<string, unknown>;
  const boundedResults = readBoundedStageResults(normalizedOutput);

  // Lease Truth Assembly canonical fields, computed once from the SAME
  // already-persisted normalize-stage data every stage needs -- cheap
  // (schema-sized, not document-sized), so recomputing it fresh in each
  // stage invocation is fine (confirmed not part of the "dominant cost").
  const extractionModuleType = toExtractionModuleType(moduleType);
  const truthAssemblyCanonicalFields = assembleCanonicalFields({
    rows: normalizedOutput.rows as Array<Record<string, unknown>>,
    extractionDebug: (normalizedOutput.metadata as any)?.extractionDebug ?? {},
    moduleType: extractionModuleType,
  }).canonicalFields;
  // The "effective row" -- row with Lease Truth Assembly's canonical
  // overrides applied per field -- is what buildReviewPayload feeds into
  // buildLeaseWorkflowAbstraction (NOT the raw row); the workflow-abstraction
  // stages (enrich_fields/enrich_items/enrich_derivation) must use the SAME
  // effective row, or their output silently diverges from the monolithic
  // path (caught by _tests/enrich-bounded-stages.test.ts's byte-equivalence
  // gate). The evidence-domain stages/remainder deliberately do NOT use this
  // -- buildReviewPayload's own evidence loop reads the RAW row too (its
  // per-field override happens later, inside buildStandardFieldsForEntries
  // itself, via truthAssemblyCanonicalFields directly).
  const schemaForEffectiveRow = getSchema(extractionModuleType);
  const effectiveRow: Record<string, unknown> = { ...row };
  for (const [fieldKey] of Object.entries(schemaForEffectiveRow).filter(([, def]) => !(def as any).derived)) {
    const publishId = publishIdFor(fieldKey);
    const canonicalResult = truthAssemblyCanonicalFields[publishId];
    if (!canonicalResult || canonicalResult.status === "not_stated") continue;
    effectiveRow[fieldKey] = canonicalResult.status === "conflicting" ? null : canonicalResult.value;
  }

  const telemetry = startBoundedStageTelemetry({
    stage,
    stageVersion: STAGE_RESULT_VERSION,
    generationId,
    input: { text_blocks: doclingRaw?.text_blocks, full_text_length: (doclingRaw?.full_text as string | undefined)?.length ?? 0 },
  });

  // --- 6. hard limits, checked before every stage executes. Real bounded-
  // slice splitting is not implemented in this change-set (a deliberate,
  // explicit scope decision -- see the report); per the requirement, an
  // oversized document must not silently fall back to whole-document
  // processing, so this fails explicitly instead. ---
  const textBlocks = Array.isArray(doclingRaw?.text_blocks) ? (doclingRaw!.text_blocks as unknown[]) : [];
  const fullTextChars = typeof doclingRaw?.full_text === "string" ? (doclingRaw!.full_text as string).length : 0;
  const pageCount = Number((doclingRaw as any)?.page_count) || 0;
  const limitCheck = checkStageInputAgainstLimits(stage, { textBlockCount: textBlocks.length, fullTextChars, pageCount });
  if (!limitCheck.withinLimits) {
    const message = `Stage ${stage} input exceeds configured limits: ${limitCheck.exceededBy.join("; ")}`;
    console.error(`[normalize-pdf-output] bounded_stage_limit_exceeded stage=${stage} file_id=${fileId}: ${message}`);
    await logger.event(stage, "failed", { error_code: "BOUNDED_STAGE_LIMIT_EXCEEDED", error_message: message, metadata: { job_id: pipelineJobId } });
    return jsonResponse({ error: true, error_code: "BOUNDED_STAGE_LIMIT_EXCEEDED", limit_exceeded: true, message }, 422);
  }

  let stageData: any = null;

  try {
    if (isEnrichEvidenceDomainStage(stage)) {
      // Phase 4.5: dynamic dispatch replacing what used to be 5 fallthrough
      // `case "enrich_evidence_<domain>":` labels -- isEnrichEvidenceDomainStage
      // is a registry-membership check (not a stage.startsWith(...) guess),
      // so a typo'd or unregistered stage name falls through to the switch's
      // `default` below and is rejected as UNKNOWN_BOUNDED_STAGE, same as today.
      const derivation = getCompletedStageData(boundedResults, "enrich_derivation");
      if (!derivation) return jsonResponse({ error: true, error_code: "PRIOR_STAGE_MISSING", message: "enrich_derivation must complete before evidence-domain stages" }, 422);
      stageData = handleEnrichEvidenceDomainStage({
        domain: getDomainForEnrichStage(stage),
        derivation, extractionModuleType, row, moduleType, doclingRaw,
        truthAssemblyCanonicalFields, fileRecord, normalizedOutput,
      });
    } else {
    switch (stage) {
      case "enrich_clauses": {
        stageData = runLeaseWorkflowStage1Clauses({ doclingRaw });
        break;
      }
      case "enrich_fields": {
        const stage1 = getCompletedStageData(boundedResults, "enrich_clauses");
        if (!stage1) return jsonResponse({ error: true, error_code: "PRIOR_STAGE_MISSING", message: "enrich_clauses must complete before enrich_fields" }, 422);
        stageData = runLeaseWorkflowStage2Fields({ row: effectiveRow, doclingRaw, documentSubtype, stage1 });
        break;
      }
      case "enrich_items": {
        const stage1 = getCompletedStageData(boundedResults, "enrich_clauses");
        const stage2 = getCompletedStageData(boundedResults, "enrich_fields");
        if (!stage1 || !stage2) return jsonResponse({ error: true, error_code: "PRIOR_STAGE_MISSING", message: "enrich_clauses/enrich_fields must complete before enrich_items" }, 422);
        stageData = runLeaseWorkflowStage3Items({ row: effectiveRow, doclingRaw, documentSubtype, stage1, stage2 });
        break;
      }
      case "enrich_derivation": {
        const stage1 = getCompletedStageData(boundedResults, "enrich_clauses");
        const stage2 = getCompletedStageData(boundedResults, "enrich_fields");
        const stage3 = getCompletedStageData(boundedResults, "enrich_items");
        if (!stage1 || !stage2 || !stage3) return jsonResponse({ error: true, error_code: "PRIOR_STAGE_MISSING", message: "prior workflow stages must complete before enrich_derivation" }, 422);
        stageData = runLeaseWorkflowStage4Derivation({ row: effectiveRow, doclingRaw, documentSubtype, stage1, stage2, stage3 });
        break;
      }
      case "enrich_truth_assembly": {
        const derivation = getCompletedStageData(boundedResults, "enrich_derivation");
        const evidenceByDomain = ENRICH_EVIDENCE_DOMAIN_STAGES.map((s) => getCompletedStageData(boundedResults, s));
        if (!derivation || evidenceByDomain.some((d) => d == null)) {
          return jsonResponse({ error: true, error_code: "PRIOR_STAGE_MISSING", message: "all workflow and evidence-domain stages must complete before enrich_truth_assembly" }, 422);
        }
        // Catch-all remainder pass: any schema field whose FieldGroup maps to
        // no LlmCallDomain (e.g. budget_inputs/approval_controls) was not
        // covered by any of the 5 evidence-domain stages -- computed here,
        // once, so every schema field is covered exactly once overall
        // (proven for the partition itself in
        // _tests/enrich-evidence-domain-split.test.ts; this is the one place
        // that also has to fold the remainder back in).
        const schema = getSchema(extractionModuleType);
        const allSchemaEntries = Object.entries(schema).filter(([, def]) => !(def as any).derived);
        const remainderEntries = getSchemaEntriesWithNoDomain(allSchemaEntries);
        const values = stripInternalKeys(row);
        // Mirrors buildReviewPayload's own rows.map() exactly -- see the
        // matching comment in the evidence-domain-stage case above.
        if (isLeaseModuleType(moduleType) && isBlank(values.notes)) {
          const camNote = extractCamNoteFromText(doclingRaw);
          if (camNote) values.notes = camNote;
        }
        const fieldConfidencesRow = (row._field_confidences ?? {}) as Record<string, number>;
        const fieldSourcesRow = (row._field_sources ?? {}) as Record<string, string>;
        const fieldEvidenceRow = (row._field_evidence ?? {}) as Record<string, any>;
        const calculatorDerivationTraces = (row._derivation_traces ?? {}) as Record<string, string>;
        const calculatorDerivationSourceFields = (row._derivation_source_fields ?? {}) as Record<string, string[]>;
        const rowConfidence = normalizeConfidence((row as any).confidence_score ?? normalizedOutput.metadata?.avgConfidence);
        const source = sourceFromMethod(fileRecord.extraction_method ?? normalizedOutput.method);
        const remainderFields = remainderEntries.length > 0
          ? buildStandardFieldsForEntries({
            schemaEntries: remainderEntries, index: 0, values, workflowOutput: derivation,
            fieldConfidences: fieldConfidencesRow, fieldSources: fieldSourcesRow, fieldEvidence: fieldEvidenceRow,
            calculatorDerivationTraces, calculatorDerivationSourceFields, doclingRaw, extractionModuleType,
            truthAssemblyCanonicalFields, source, rowConfidence,
          })
          : [];
        // Pooling in dispatch order (domain 1..5, then the remainder) does
        // NOT match the schema's declared field order -- restore it so the
        // bounded path's standard_fields order is byte-equivalent to the
        // monolithic single-pass loop's order, regardless of which stage
        // produced a given field.
        const pooledStandardFields = reorderStandardFieldsBySchema(
          [...evidenceByDomain.flat(), ...remainderFields],
          allSchemaEntries,
        );

        // The only canonical publisher: this reuses buildReviewPayload's
        // final-assembly tail (Lease Truth Assembly + payload shape)
        // VERBATIM via the precomputed* hooks, exactly as every other
        // caller does -- no second publisher, no duplicated logic.
        const enrichedPayload = buildReviewPayload({
          fileId,
          fileName: fileRecord.file_name ?? "document",
          moduleType,
          documentSubtype,
          extractionMethod: fileRecord.extraction_method ?? null,
          reviewRequired: !!fileRecord.review_required,
          doclingRaw,
          result: normalizedOutput,
          precomputedWorkflowOutputs: [derivation],
          precomputedStandardFieldsByRow: [pooledStandardFields],
        }) as Record<string, any>;

        const currentPayload = (fileRecord.ui_review_payload ?? {}) as Record<string, unknown>;
        enrichedPayload.enrichment_status = "completed";
        enrichedPayload.core_ready = (currentPayload as any).core_ready ?? computeCoreReady(enrichedPayload.records?.[0]?.standard_fields ?? []);
        if (enrichedPayload.metadata && typeof enrichedPayload.metadata === "object") {
          enrichedPayload.metadata.extraction_contract_version = EXTRACTION_CONTRACT_VERSION;
        }
        stageData = { enriched_payload: enrichedPayload };
        break;
      }
      default: {
        return jsonResponse({ error: true, error_code: "UNKNOWN_BOUNDED_STAGE", message: `No handler for stage ${stage}` }, 400);
      }
    }
    }
  } catch (computeError: any) {
    const message = computeError?.message ?? String(computeError);
    console.error(`[normalize-pdf-output] bounded_stage_failed stage=${stage} file_id=${fileId}: ${message}`);
    await logger.event(stage, "failed", { error_code: "BOUNDED_STAGE_EXCEPTION", error_message: message, metadata: { job_id: pipelineJobId } });
    return jsonResponse({ error: true, error_code: "BOUNDED_STAGE_EXCEPTION", message }, 500);
  }

  // --- 7. enforce the generation fence AGAIN before committing output --
  // the compute above (especially derivation/evidence stages) can take real
  // time, during which a newer generation can start. ---
  const postFence = await checkGenerationStillActive({ supabaseAdmin, fileId, orgId, expectedGenerationId: generationId });
  if (!postFence.stillActive) {
    console.log(`[normalize-pdf-output] bounded_stage_stale_generation_skipped_before_persist stage=${stage} file_id=${fileId} generation_id=${generationId} current=${postFence.currentGenerationId}`);
    return jsonResponse({ error: false, file_id: fileId, stage, stale_generation: true }, 200);
  }

  // --- persist. Only enrich_truth_assembly may overwrite ui_review_payload
  // (the minimal payload stays the reviewer-visible payload for every other
  // stage -- see the requirement that only final assembly is the canonical
  // publisher). ---
  const finalTelemetry = telemetry.finish({
    output: stageData,
    pageCount,
    tableCount: Array.isArray((doclingRaw as any)?.tables) ? (doclingRaw as any).tables.length : null,
  });

  // enrich_truth_assembly's real output (the full rich payload) is persisted
  // separately into ui_review_payload below -- storing it again inside
  // normalized_output.bounded_stage_results would just duplicate a large
  // blob for no benefit; a small completion marker is enough for the
  // idempotency check and stage-sequence bookkeeping.
  const updatedNormalizedOutput = mergeBoundedStageResult({
    normalizedOutput,
    stage,
    generationId,
    status: "completed",
    data: stage === "enrich_truth_assembly" ? { assembled: true } : stageData,
  });

  const updates: Record<string, unknown> = { normalized_output: updatedNormalizedOutput, updated_at: new Date().toISOString() };
  if (stage === "enrich_truth_assembly") {
    updates.ui_review_payload = stageData.enriched_payload;
  }

  const { error: persistError } = await supabaseAdmin.from("uploaded_files").update(updates).eq("id", fileId);
  if (persistError) {
    console.error(`[normalize-pdf-output] bounded_stage_persist_failed stage=${stage} file_id=${fileId}: ${persistError.message}`);
    await logger.event(stage, "failed", { error_code: "BOUNDED_STAGE_PERSIST_FAILED", error_message: persistError.message, metadata: { job_id: pipelineJobId } });
    return jsonResponse({ error: true, error_code: "BOUNDED_STAGE_PERSIST_FAILED", message: persistError.message }, 500);
  }

  await logger.event(stage, "completed", {
    metadata: { job_id: pipelineJobId, generation_id: generationId, telemetry: finalTelemetry },
  });
  console.log(`[normalize-pdf-output] bounded_stage_completed stage=${stage} file_id=${fileId} duration_ms=${finalTelemetry.duration_ms}`);

  if (stage === "enrich_truth_assembly") {
    // Same mode-gated post-processing + finalize call as the monolithic
    // handleEnrichMode() runs today, unchanged -- confirmed no-ops while
    // their flags default "off" (see docs/lease-extraction-architecture-audit-2026-07-29.md /
    // the plan's exploration findings).
    const claimsLedgerMode = getLeaseClaimsLedgerMode();
    const packageMode = getLeaseDocumentPackageMode();
    const financialMode = getLeaseFinancialScheduleMode();
    const enrichedPayload = stageData.enriched_payload;
    let enrichExtractionRunId: string | null = null;
    if (claimsLedgerMode !== "off") {
      enrichExtractionRunId = await resolveExtractionRunId(supabaseAdmin, orgId, generationId);
      const recordFields = (enrichedPayload.records?.[0]?.fields ?? {}) as Record<string, any>;
      await maybeRunClaimsLedgerForStage(
        supabaseAdmin,
        { orgId, uploadedFileId: fileId, leaseId: null, extractionRunId: enrichExtractionRunId, extractionStageRunId: null, generationId, stageAttempt: 1 },
        { deterministicFields: {}, semanticCandidateGroups: [], unmappedLlmFields: [], legacyExtractionData: { fields: recordFields } },
      );
    }
    if (packageMode !== "off") {
      if (!enrichExtractionRunId) enrichExtractionRunId = await resolveExtractionRunId(supabaseAdmin, orgId, generationId);
      const recordFields = (enrichedPayload.records?.[0]?.fields ?? {}) as Record<string, any>;
      await maybeRunLeaseDocumentPackagePipeline(
        supabaseAdmin,
        { orgId, uploadedFileId: fileId, leaseId: null, extractionRunId: enrichExtractionRunId, extractionStageRunId: null, generationId, stageAttempt: 1 },
        { singleDocumentCompatibility: { fields: recordFields } },
      );
    }
    if (financialMode !== "off") {
      if (!enrichExtractionRunId) enrichExtractionRunId = await resolveExtractionRunId(supabaseAdmin, orgId, generationId);
      const recordFields = (enrichedPayload.records?.[0]?.fields ?? {}) as Record<string, any>;
      await maybeRunLeaseFinancialScheduleRuntime(
        supabaseAdmin,
        { orgId, uploadedFileId: fileId, leaseId: null, extractionRunId: enrichExtractionRunId, generationId, stageAttempt: 1 },
        { currentCompatibility: { fields: recordFields }, packageAwareInput: packageMode !== "off" },
      );
    }

    // Finalize review readiness -- inspect {data, error} explicitly, never
    // swallow a non-throwing RPC error, keep p_package_mode/p_financial_mode
    // exactly as every other call site (do not drop them to make this call
    // succeed locally -- see docs/lease-extraction-architecture-audit-2026-07-29.md).
    const { error: finalizeError } = await supabaseAdmin.rpc("finalize_lease_extraction_for_review", {
      p_org_id: orgId,
      p_uploaded_file_id: fileId,
      p_generation_id: generationId,
      p_package_mode: packageMode,
      p_financial_mode: financialMode,
    });
    if (finalizeError) {
      console.error(`[normalize-pdf-output] finalize_lease_extraction_for_review RPC returned an error file_id=${fileId} generation_id=${generationId}:`, finalizeError.message);
      await logger.event(stage, "readiness_finalize_failed", { error_code: "READINESS_FINALIZE_RPC_ERROR", error_message: finalizeError.message, metadata: { job_id: pipelineJobId } });
    }

    return jsonResponse({
      error: false, file_id: fileId, stage, status: "completed", chain_complete: true,
      clauses: enrichedPayload.records?.[0]?.workflow_output?.lease_clauses?.length ?? 0,
    }, 200);
  }

  return jsonResponse({ error: false, file_id: fileId, stage, status: "completed" }, 200);
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

  // P1.3: extraction-stage provenance for the "normalize" branch only
  // (handleEnrichMode manages its own stage handle separately, since it's a
  // distinct stage). Declared here so the outer `finally` can always call
  // ensureSettled(), even on an early auth/validation failure.
  let stage: StageHandle | null = null;

  // -- Auth guard --------------------------------------------------------------
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
    const {
      file_id, dry_run, sample_text, job_id, pipeline_job_id, worker_attempt, mode,
      // P1.3: generation_id/extraction_run_id, threaded by the worker's
      // generation-scoped dispatch. Named distinctly from the pre-existing
      // `extractionRunId` local below (a debug/trace id unrelated to the
      // extraction_runs table) to avoid confusion between the two concepts.
      generation_id, extraction_run_id: provenanceExtractionRunId,
    } = body;

    // dry_run=true: validate auth and optionally run extraction on sample_text.
    // No file_id required and no DB writes — used by pipeline-health-check.
    if (dry_run === true) {
      const hasOpenAI = isLLMProviderConfigured();

      let extraction: Record<string, unknown> | null = null;
      if (typeof sample_text === "string" && sample_text.length > 0) {
        // Dry-run sample text uses the same lease architecture fence as the
        // real path: whole-document LLM primary plus sectioned LLM continuation.
        // No uploaded_files row exists in this branch, so there is nothing to
        // write.
        const dryRunProvider = enforceLeaseExtractionArchitecture(
          "lease",
          resolveBusinessExtractionProvider(
            isInternalCall(req) ? (body as any)?.debug_business_extraction_provider : null,
          ),
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
          // Azure+OpenAI route: routed through the same orchestrator as the
          // real path so dry-run behavior cannot drift from live lease routing.
          const result = await runBusinessExtraction({
            requestedProvider: dryRunProvider,
            moduleType: "lease",
            fileName: "dry_run_sample.txt",
            docling: dryRunDocling,
            documentSubtype: null,
            correlationId: "dry_run",
          });
          assertAuthoritativeLeaseExtractionResult("lease", result as Record<string, any>);
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
          openai_configured: hasOpenAI,
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
      // extraction_run_id is NOT resolved here -- generation_id for enrich
      // isn't known until handleEnrichMode looks up the claimed job's
      // pipeline_jobs.generation_id internally (jobGenerationId). It
      // resolves extraction_run_id itself from that value.
      return await handleEnrichMode({
        supabaseAdmin, orgId, fileId: file_id,
        pipelineJobId: pipeline_job_id || job_id,
        workerAttempt: worker_attempt,
        jsonResponse,
      });
    }

    // Bounded Per-Domain Enrich Refactor: one of the 10 stage names in
    // enrich-bounded-stage/stage-sequence.ts. Unlike "enrich" above,
    // generation_id is passed directly in the request body (the worker
    // reads it fresh off the claimed pipeline_jobs row before dispatching),
    // not resolved by a separate lookup -- see the plan's request contract.
    if (isEnrichBoundedStageName(mode)) {
      return await handleBoundedEnrichStage({
        supabaseAdmin, orgId, fileId: file_id,
        pipelineJobId: pipeline_job_id || job_id,
        generationId: generation_id,
        stage: mode,
        workerAttempt: worker_attempt,
        jsonResponse,
      });
    }

    // Fetch only the columns this function actually uses.
    // SELECT * would also load ui_review_payload, normalized_output, parsed_data,
    // and reviewed_output from previous runs — each can be 1–3 MB — pushing the
    // Edge Function over the memory limit (546) before extraction even starts.
    // docling_raw and azure_raw_response are always written as identical
    // duplicates (see the same note on the enrich-mode select above) --
    // fetching only one halves this blob's transfer/memory cost.
    const { data: fileRecord, error: fetchError } = await selectUploadedFileWithV3Fallback(
      supabaseAdmin,
      "id, org_id, file_name, file_url, file_size, mime_type, module_type, " +
        "status, review_required, document_subtype, extraction_method, docling_raw",
      file_id,
      orgId,
    );

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
    fileRecord.docling_raw = fileRecord.docling_raw ?? null;
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
    const extractionGenerationId = generation_id ?? fileRecord.active_generation_id ?? null;

    // P1.3: only attempt to record a stage run when this request actually
    // carries a generation_id (worker-dispatched, lease-module calls) --
    // out of scope otherwise, exactly like parse-document-azure's same check.
    if (generation_id) {
      stage = await withExtractionStage(supabaseAdmin, {
        orgId,
        uploadedFileId: file_id,
        generationId: generation_id,
        extractionRunId: provenanceExtractionRunId ?? null,
        pipelineJobId: finalPipelineJobId,
        stage: "normalize",
        attempt: Number(worker_attempt) || 1,
      });
    }

    // Must be ready for normalization. `validating` is accepted for retry/reconcile
    // calls after the upstream worker timed out while normalize-pdf-output was
    // already running; rejecting that state loops the job into an empty review.
    const normalizeRunnableStatuses = new Set(["pdf_parsed", "validating"]);
    if (!normalizeRunnableStatuses.has(String(fileRecord.status))) {
      await stage?.fail("INVALID_STATUS", `File status must be 'pdf_parsed' or 'validating'. Current: '${fileRecord.status}'`, { outcome: "terminal_failure" });
      return jsonResponse(
        {
          error: true,
          message: `File status must be 'pdf_parsed' or 'validating'. Current: '${fileRecord.status}'`,
          error_code: "INVALID_STATUS",
        },
        422,
      );
    }

    if (!fileRecord.docling_raw) {
      await stage?.fail("NO_DOCLING_OUTPUT", "No parser output found. Run parse-document-azure first.", { outcome: "terminal_failure" });
      return jsonResponse(
        {
          error: true,
          message: "No parser output found. Run parse-document-azure first.",
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
      await stage?.fail(parseTextErrorCode, message, { outcome: "terminal_failure" });
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

    // When parse-document-azure stored an empty docling_raw because no backend was
    // configured AND the file was too large for native extraction, skip the
    // Vision-fallback download that would re-OOM this function for the same reason.
    const extractionSkipped =
      (fileRecord.docling_raw as any)?._metadata?.extraction_skipped_reason ||
      (fileRecord.docling_raw as any)?.extraction_method === "none";
    const hasLLM = isLLMProviderConfigured();
    if (extractionSkipped && !hasLLM) {
      console.warn(
        `[normalize-pdf-output] file_id=${file_id} — parse-document-azure stored empty output ` +
        `and no LLM is configured. Transitioning to review_required with empty payload so the ` +
        `reviewer can fill fields manually.`,
      );
    }

    const fileSizeBytes = Number(fileRecord.file_size || 0);
    const fileSizeIsKnown = Number.isFinite(fileSizeBytes) && fileSizeBytes > 0;

    // Load file bytes from Supabase Storage ONLY when parser text is too
    // weak for the LLM extractor to work from — i.e. for scanned / image-only
    // PDFs. For digital PDFs with sufficient extracted text the file bytes are
    // never used and downloading them wastes 3–8 MB of Edge Function RAM,
    // which is the primary cause of the 546 "compute resources" error.
    const doclingBlockCount = Array.isArray((fileRecord.docling_raw as any)?.text_blocks)
      ? (fileRecord.docling_raw as any).text_blocks.length
      : 0;
    // A document with >=2 500 chars AND >=5 text blocks has enough content
    // for rule/table/LLM extraction without Vision. These thresholds match
    // the MIN_NATIVE_PDF_TEXT_CHARS and MIN_DIGITAL_BLOCKS constants in
    // _shared/extraction/parser.ts.
    // A document with >=2500 chars AND >=5 text blocks has enough content for
    // rule/table/LLM extraction without Vision. The second condition catches
    // plain-text OCR fallback results (0 text_blocks but full_text >= 5000 chars)
    // — re-downloading the file in that case would be redundant and OOM the function.
    const doclingTextIsGood = doclingTextLength >= 2500 && (doclingBlockCount >= 5 || doclingTextLength >= 5000);
    const azureLayoutMode =
      Deno.env.get("EXTRACTION_PROVIDER") === "azure_document_intelligence" ||
      isAzureLayoutOutput(fileRecord.docling_raw as Record<string, unknown>);
    const fileTooLargeForInlineVision =
      fileSizeIsKnown && fileSizeBytes > MAX_INLINE_FILE_BYTES;

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
    // a previous OCR path and pretend it's the lease PDF.
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
        `file_id=${file_id} max_inline_file_mb=${(MAX_INLINE_FILE_BYTES / (1024 * 1024)).toFixed(1)}`,
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

          if (bytes.length > MAX_INLINE_FILE_BYTES) {
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
              // let extraction proceed with whatever the parser produced.
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
      const businessExtractionProvider = enforceLeaseExtractionArchitecture(
        extractionModuleType,
        resolveBusinessExtractionProvider(
          isInternalCall(req) ? (body as any)?.debug_business_extraction_provider : null,
        ),
      );
      console.log(`[normalize-pdf-output] STAGE pipeline_start file_id=${file_id} fileBase64=${!!fileBase64} azureLayoutMode=${azureLayoutMode} provider=${businessExtractionProvider}`);
      // Run the canonical extraction pipeline. For leases, the architecture
      // fence above forces whole-document LLM primary plus sectioned LLM
      // continuation; non-lease modules keep their configured provider strategy.
      const pipelineDocling = buildPipelineLayoutInput(fileRecord.docling_raw as Record<string, unknown> | null);
      // One call through the business-extraction orchestrator returns a common
      // ExtractionPipelineResult shape for primary/fallback/manual-review
      // outcomes; review payload building and persistence consume that shape.
      const mockOpenAIScenario = resolveMockOpenAIScenario(req, body as Record<string, unknown>, businessExtractionProvider);
      const factLedgerResume = normalizeFactLedgerResume((body as any)?.fact_ledger_resume);
      const result = await runBusinessExtraction({
        requestedProvider: businessExtractionProvider,
        moduleType: extractionModuleType,
        fileName,
        document: pipelineDocling,
        docling: pipelineDocling,
        documentSubtype: fileRecord.document_subtype ?? null,
        ...(fileBase64 && !azureLayoutMode ? { fileBase64, fileMimeType: fileMimeType || "application/pdf" } : {}),
        correlationId: file_id,
        canonicalLayoutSchemaVersion: (fileRecord.docling_raw as any)?.layout_contract_version ?? null,
        canonicalLayout: (fileRecord as any).canonical_layout_v3 ?? null,
        ...(mockOpenAIScenario ? { mockOpenAIScenario } : {}),
        factLedgerProgress: (progress: Record<string, unknown>) => persistFactLedgerProgress({
          supabaseAdmin,
          logger,
          pipelineJobId: finalPipelineJobId,
          fileId: file_id,
          progress,
        }),
        ...(factLedgerResume ? { factLedgerResume } : {}),
        ...(stage?.stageRunId
          ? {
            provenance: {
              supabaseAdmin,
              context: {
                orgId,
                uploadedFileId: file_id,
                generationId: generation_id ?? "",
                extractionRunId: provenanceExtractionRunId ?? null,
                stageRunId: stage.stageRunId,
                stageAttempt: Number(worker_attempt) || 1,
                operation: "business_extraction",
              },
            },
          }
          : {}),
      });
      result.metadata = {
        ...(result.metadata ?? {}),
        generation_id: extractionGenerationId,
      };
      assertAuthoritativeLeaseExtractionResult(extractionModuleType, result as Record<string, any>);
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
          max_inline_file_bytes: MAX_INLINE_FILE_BYTES,
          file_bytes_length: fileBytesLength,
          file_magic_detected: detectedMagic,
          file_name: fileRecord.file_name ?? null,
          file_mime_resolved: fileMimeType,
          file_id: file_id,
        };
      }

      const meaningfulValueCount = countMeaningfulRowValues(result.rows as Array<Record<string, unknown>>);
      // Compute this immediately after extraction so the default deferred
      // enrichment return persists the truth. Previously it was computed
      // only hundreds of lines later in the inline-only path, causing rows
      // with real OpenAI facts to report openai_extraction_attempted=false.
      const openaiExtractionAttempted =
        Number((result.metadata as any)?.provenance?.openai_attempt_count ?? 0) > 0 ||
        Boolean((result.metadata as any)?.extractionDebug?.llm_call_attempted) ||
        envFlagEnabled("ALLOW_RULE_ONLY_EXTRACTION");

      // Verification (persisted into extractionDebug, not just logged, so it
      // survives past the function's log retention and is inspectable from
      // the DB/UI): exactly what runBusinessExtraction() returned, before
      // any fallback/failure branching below decides what to do about it.
      // This is what distinguishes "OpenAI returned nothing" from "OpenAI
      // returned facts, but mapping dropped them" -- both looked identical
      // (silently degrade to an empty manual-review row) before this check.
      const openaiDebugForVerification =
        ((result.metadata as any)?.extractionDebug?.openai_fact_ledger) ??
        ((result.metadata as any)?.extractionDebug?.vertex_fact_ledger) ??
        null;
      const factsExtractedCount = Number(openaiDebugForVerification?.facts_extracted_count ?? 0);
      const factsMappedCount = Number(openaiDebugForVerification?.facts_mapped_count ?? 0);
      const row0Keys = Object.keys(result.rows?.[0] ?? {}).filter((k) => !k.startsWith("_"));
      console.log(
        `[normalize-pdf-output] STAGE extraction_verification file_id=${file_id} provider=${businessExtractionProvider} ` +
        `method=${result.method} rows_length=${result.rows?.length ?? 0} row0_keys=${JSON.stringify(row0Keys)} ` +
        `meaningful_value_count=${meaningfulValueCount} openai_facts_extracted=${factsExtractedCount} ` +
        `openai_facts_mapped=${factsMappedCount} openai_failure_classification=${openaiDebugForVerification?.failure_classification ?? "n/a"}`,
      );
      if (result.metadata && typeof result.metadata === "object") {
        (result.metadata as any).extractionDebug = {
          ...((result.metadata as any).extractionDebug || {}),
          extraction_verification: {
            provider: businessExtractionProvider,
            method: result.method,
            rows_length: result.rows?.length ?? 0,
            row0_keys: row0Keys,
            meaningful_value_count: meaningfulValueCount,
            openai_facts_extracted_count: factsExtractedCount,
            openai_facts_mapped_count: factsMappedCount,
            openai_failure_classification: openaiDebugForVerification?.failure_classification ?? null,
          },
        };
      }

      if (!result.rows || result.rows.length === 0 || meaningfulValueCount === 0) {
        // P0.3 guarantee: this attempt produced nothing usable, but a prior
        // successful run may already have persisted real values for this
        // file (e.g. a re-extraction that regressed). Re-read before
        // overwriting them with a failure state.
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

        // Azure parsed the document and extraction actually ran, but
        // produced nothing usable. This used to inject a synthetic empty
        // row and still mark review_required for lease documents ("let the
        // reviewer fill it in manually") -- which silently hid every real
        // extraction bug this session found (miscounted text, a missing
        // migration column, a rejected temperature parameter) behind an
        // identical-looking "no fields, please fill in manually" state.
        // Fail loudly and specifically instead, for every module type: a
        // reviewer can still see exactly what failed and why via
        // error_code/error_message, rather than a payload that looks like a
        // normal, genuinely-empty document.
        const wholeDocumentFailureClassification =
          openaiDebugForVerification?.extraction_mode === "whole_document_llm_v2"
            ? String(openaiDebugForVerification?.failure_classification ?? "").trim()
            : "";
        const errorCode = wholeDocumentFailureClassification
          ? "WHOLE_DOCUMENT_LLM_FAILED"
          : factsExtractedCount > 0 && factsMappedCount === 0
            ? "FIELD_MAPPING_FAILED"
            : "AI_EMPTY_EXTRACTION";
        const reason = errorCode === "WHOLE_DOCUMENT_LLM_FAILED"
          ? `Authoritative whole-document LLM extraction failed (${wholeDocumentFailureClassification}). ` +
            `Warnings: ${(result.warnings ?? []).join("; ")}`
          : errorCode === "FIELD_MAPPING_FAILED"
            ? `OpenAI extracted ${factsExtractedCount} fact(s) from the document, but none mapped to a standard lease field.`
            : `Extraction produced no usable lease values. Warnings: ${(result.warnings ?? []).join("; ")}`;
        const pipeline = buildPipelineMetadata({
          parser_status: parserStatus ?? PARSER_STATUSES.COMPLETED,
          normalize_status: NORMALIZE_STATUSES.FAILED,
          ai_status: "ai_empty_output",
          review_status: REVIEW_STATUSES.BLOCKED,
          error_code: errorCode,
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
          message: errorCode === "FIELD_MAPPING_FAILED"
            ? "The AI extraction found information in this document but could not map it to any lease field."
            : "No usable lease values were extracted from the parsed document.",
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
          openai_extraction_attempted: openaiExtractionAttempted,
        });
        await logger.event("normalize", "blocked", {
          normalize_status: NORMALIZE_STATUSES.FAILED,
          ai_status: "ai_empty_output",
          error_code: errorCode,
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
          error_code: errorCode,
          message: reason,
          ui_review_payload: payload,
        }, 422);
      }

      // -- Fast core-field persist -----------------------------------------
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
          openai_extraction_attempted: openaiExtractionAttempted,
          ...(reviewRequired ? { review_status: "pending" } : {}),
        },
      );
      const minimalSourceBackedCount = (minimalPayload.records[0]?.standard_fields ?? [])
        .filter((f: any) => f.status === "auto_populated" || f.status === "pending_enrichment").length;
      const minimalValueCount = (minimalPayload.records[0]?.standard_fields ?? [])
        .filter((f: any) => f.value != null && f.value !== "").length;
      // Azure+OpenAI Phase 4E (local implementation): CAS token-chaining.
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
        // Fatal, not logged-and-continued: this write is the ONLY thing that
        // makes extracted values visible in the UI (records[0].standard_fields).
        // Continuing past a failed write here used to let normalize report
        // "completed" while ui_review_payload silently kept whatever it held
        // before this run -- a completed stage with no UI fields, exactly the
        // failure mode this check exists to prevent. setFailed() (not
        // setStatus()) because the FSM-checked write above already failed
        // once for this row; this is the forceful, always-lands fallback.
        const persistErrorMessage = `Could not persist extraction results: ${minimalPersistError.message}`;
        console.error(`[normalize-pdf-output] ${persistErrorMessage} file_id=${file_id}`);
        await setFailed(supabaseAdmin, file_id, persistErrorMessage, "normalize", 55);
        await logger.event("normalize", "failed", {
          error_code: "REVIEW_PAYLOAD_PERSIST_FAILED",
          error_message: persistErrorMessage,
        });
        return jsonResponse({
          error: true,
          file_id,
          processing_status: "failed",
          normalize_status: NORMALIZE_STATUSES.FAILED,
          error_code: "REVIEW_PAYLOAD_PERSIST_FAILED",
          message: persistErrorMessage,
        }, 500);
      }
      console.log(
        `[normalize-pdf-output] minimal_payload_persisted file_id=${file_id} ` +
        `values=${minimalValueCount} source_backed=${minimalSourceBackedCount} core_ready=${minimalPayload.core_ready}`,
      );

      // -- Document Intelligence v3 side-write (Phase 2, opt-in) ------------
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
          uploadedFile: { ...fileRecord, ui_review_payload: minimalPayload },
          leaseId: null,
          pipelineJobId: finalPipelineJobId ?? null,
          generationId: extractionGenerationId,
          result,
          logger,
        });
      } catch (v3SideWriteError: any) {
        console.warn(
          `[normalize-pdf-output] document_intelligence_v3 side-write threw unexpectedly for file_id=${file_id}: ` +
          `${v3SideWriteError?.message ?? v3SideWriteError} — current normalize flow continues unaffected.`,
        );
      }

      // -- P0.1: defer the expensive evidence/clause pass -------------------
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
        // Bounded Per-Domain Enrich Refactor: dispatch the first bounded stage
        // when active. Also force bounded mode for documents too large for the
        // legacy single-shot "enrich" function, even if the env flag was set
        // to "off"; that monolithic path is the known 546/compute hotspot.
        const boundedMode = getEnrichBoundedStageMode();
        const enrichInputSize = readEnrichInputSizeFromDocling(fileRecord.docling_raw as Record<string, unknown>);
        const guardReasons = monolithicEnrichGuardReasons(enrichInputSize);
        if (shouldUseBoundedEnrich(boundedMode, enrichInputSize)) {
          await enqueueBoundedEnrichStage({
            supabaseAdmin,
            orgId,
            fileId: file_id,
            stage: firstEnrichBoundedStage(),
            generationId: extractionGenerationId,
            moduleType,
            logger,
          });
          if (boundedMode !== "active") {
            await logger.event("enrich", "bounded_forced_for_large_document", {
              provider: "lease-extraction-worker",
              metadata: { mode: boundedMode, input_size: enrichInputSize, guard_reasons: guardReasons },
            });
          }
        } else {
          await enqueueEnrichmentJob({
            supabaseAdmin,
            orgId,
            fileId: file_id,
            moduleType,
            logger,
          });
        }
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
        // The normalize stage is a completed stage regardless of
        // reviewRequired -- "needs human review" and "stage succeeded" are
        // different questions (the contract's manual_review outcome).
        await stage?.complete({
          outcome: reviewRequired ? "manual_review" : "completed",
          fieldsProduced: result.rows.length,
          workflowOutputPresent: !!(result.metadata as any)?.workflow_output,
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

      // -- Consolidated extraction_debug ----------------------------------
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
          extraction_contract_version: EXTRACTION_CONTRACT_VERSION,
          extraction_build_version: "2026-06-22.1",
          extraction_run_id: extractionRunId,
          pipeline_job_id: finalPipelineJobId,
          generation_id: extractionGenerationId,
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
          extraction_contract_version: EXTRACTION_CONTRACT_VERSION,
          extraction_build_version: "2026-06-22.1",
          extraction_run_id: extractionRunId,
          pipeline_job_id: finalPipelineJobId,
          generation_id: extractionGenerationId,
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
          (uiReviewPayload.metadata as Record<string, unknown>).extraction_contract_version = EXTRACTION_CONTRACT_VERSION;
          (uiReviewPayload.metadata as Record<string, unknown>).extraction_build_version = "2026-06-22.1";
          (uiReviewPayload.metadata as Record<string, unknown>).extraction_run_id = extractionRunId;
          (uiReviewPayload.metadata as Record<string, unknown>).pipeline_job_id = finalPipelineJobId;
          (uiReviewPayload.metadata as Record<string, unknown>).generation_id = extractionGenerationId;
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

      // Azure+OpenAI Phase 4E (local implementation): conditional-write CAS
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

      // Honest signal for evaluate_lease_extraction_readiness's
      // OPENAI_EXTRACTION_NOT_ATTEMPTED gate (20260865000000). Covers every
      // mode: openai_fact_ledger/openai_primary_legacy_fallback always call
      // the orchestrator's runOpenAIOnce() (provenance.openai_attempt_count
      // &gt; 0); legacy_hybrid's own internal LLM step (llm-extractor.ts) sets
      // extractionDebug.llm_call_attempted when IT makes a real call. Only
      // an explicit emergency override bypasses this.
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
          openai_extraction_attempted: openaiExtractionAttempted,
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

      // Local-debug-only path (NORMALIZE_INLINE_ENRICHMENT=true) -- the
      // production default already completed the stage above and returned.
      await stage?.complete({
        outcome: reviewRequired ? "manual_review" : "completed",
        fieldsProduced: result.rows.length,
        workflowOutputPresent: !!(uiReviewPayload as any)?.metadata?.workflow_output,
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
      await stage?.fail("NORMALIZE_FAILED", String(normError?.message ?? normError), { outcome: "terminal_failure" });
      throw normError;
    }
  } catch (err) {
    console.error("[normalize-pdf-output] Error:", err.message);
    const isAuthError = /unauthorized|missing authorization|invalid token|auth failed/i.test(
      String(err.message ?? ""),
    );
    const isUnsupportedProvider = /Unsupported (extraction provider|business extraction mode)/i.test(
      String(err.message ?? ""),
    );
    const isArchitectureViolation = /LEASE_EXTRACTION_ARCHITECTURE_VIOLATION/i.test(
      String(err.message ?? ""),
    );
    const outerErrorCode = isAuthError
      ? "UNAUTHORIZED_NORMALIZE_CALL"
      : isArchitectureViolation
        ? "LEASE_EXTRACTION_ARCHITECTURE_VIOLATION"
        : isUnsupportedProvider
          ? "UNSUPPORTED_EXTRACTION_PROVIDER"
          : "NORMALIZATION_FAILED";
    // Idempotent with the inner catch's stage.fail() when re-thrown from
    // there; the only path for errors before the inner try (auth, status
    // transitions) or truly unexpected exceptions.
    await stage?.fail(outerErrorCode, String(err.message ?? err), { outcome: "terminal_failure" });
    return jsonResponse(
      {
        ok: false,
        error: true,
        message: err.message,
        error_code: outerErrorCode,
      },
      isAuthError ? 401 : 400,
    );
  } finally {
    await stage?.ensureSettled();
  }
});

// Test hook (same pattern as _shared/extraction/parser.ts).
export const __test__ = {
  buildPipelineLayoutInput,
  buildMinimalReviewPayload,
  buildReviewPayload,
  buildStandardFieldsForEntries,
  handleBoundedEnrichStage,
  handleEnrichEvidenceDomainStage,
  extractCamNoteFromText,
  isBlank,
  rejectMarkupValue,
  buildReviewField,
  resolveBusinessExtractionProvider,
  enforceLeaseExtractionArchitecture,
  wholeDocumentExtractionMode,
  assertAuthoritativeLeaseExtractionResult,
  resolveMockOpenAIScenario,
  isLocalSupabaseUrl,
  localProviderMocksEnabled,
  externalProviderCallsDisabled,
};
