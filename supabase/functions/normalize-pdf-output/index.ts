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
import { getFieldGroups, getSchema } from "../_shared/extraction/schemas.ts";
import { buildLeaseWorkflowAbstraction } from "../_shared/extraction/lease-workflow.ts";
import { setStatus, setFailed } from "../_shared/pipeline-status.ts";
import { createLogger } from "../_shared/logger.ts";
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

function positivePageNumber(value: unknown): number | null {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? page : null;
}

function normalizeForPageMatch(value: unknown): string {
  return cleanEvidenceSnippet(value)
    .toLowerCase()
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function compactForPageMatch(value: unknown): string {
  return normalizeForPageMatch(value).replace(/[^a-z0-9]+/g, "");
}

// Both builder functions are called O(schema_fields) times per request for
// the same doclingRaw reference (once per field in buildReviewPayload).
// Rebuilding them on every call was creating ~300 × 520 KB of temporary
// string objects — the primary cause of the 546 OOM error on large leases.
// WeakMap keys on the object reference so the cache is naturally scoped to
// the request and GC'd when doclingRaw goes out of scope.
const _pageTextCandidatesCache = new WeakMap<object, Array<{ text: string; normalized: string; compact: string; page: number; source: string }>>();
const _evidenceSearchBlocksCache = new WeakMap<object, Array<{ text: string; lowered: string; page: number | null; source: string }>>();

function buildPageTextCandidates(doclingRaw: Record<string, unknown> | null | undefined) {
  if (doclingRaw && _pageTextCandidatesCache.has(doclingRaw)) {
    return _pageTextCandidatesCache.get(doclingRaw)!;
  }
  const candidates: Array<{ text: string; normalized: string; compact: string; page: number; source: string }> = [];
  const push = (value: unknown, pageValue: unknown, source: string) => {
    const page = positivePageNumber(pageValue);
    const text = cleanEvidenceSnippet(value);
    if (!page || !text) return;
    candidates.push({
      text,
      normalized: normalizeForPageMatch(text),
      compact: compactForPageMatch(text),
      page,
      source,
    });
  };

  const pages = Array.isArray((doclingRaw as any)?.pages) ? (doclingRaw as any).pages : [];
  pages.forEach((page: any, index: number) => {
    push(
      page?.text ?? page?.content ?? page?.markdown ?? page?.full_text,
      page?.page ?? page?.page_number ?? page?.number ?? index + 1,
      "page",
    );
  });

  for (const block of Array.isArray((doclingRaw as any)?.text_blocks) ? (doclingRaw as any).text_blocks : []) {
    push(block?.text, block?.page ?? block?.page_number ?? block?.source_page, "text_block");
  }

  const seen = new Set<string>();
  const result = candidates.filter((candidate) => {
    const key = `${candidate.page}|${candidate.source}|${candidate.normalized.slice(0, 240)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (doclingRaw) _pageTextCandidatesCache.set(doclingRaw, result);
  return result;
}

function pageMatchScore(candidate: { normalized: string; compact: string; source: string }, snippet: string): number {
  const normalizedSnippet = normalizeForPageMatch(snippet);
  if (normalizedSnippet.length < 8) return 0;
  if (candidate.normalized.includes(normalizedSnippet)) return 1000 + Math.min(normalizedSnippet.length, 400);

  const compactSnippet = compactForPageMatch(snippet);
  if (compactSnippet.length >= 24 && candidate.compact.includes(compactSnippet)) {
    return 900 + Math.min(compactSnippet.length, 300);
  }

  const anchors = [
    normalizedSnippet.slice(0, Math.min(120, normalizedSnippet.length)),
    normalizedSnippet.slice(Math.max(0, normalizedSnippet.length - 120)),
  ].filter((anchor) => anchor.length >= 45);
  for (const anchor of anchors) {
    if (candidate.normalized.includes(anchor)) return 500 + anchor.length;
  }

  const tokens = [...new Set(normalizedSnippet.match(/[a-z0-9$%]{4,}/g) || [])]
    .filter((token) => !["this", "that", "with", "from", "shall", "tenant", "landlord"].includes(token));
  if (tokens.length < 6) return 0;
  const matched = tokens.filter((token) => candidate.normalized.includes(token)).length;
  const ratio = matched / tokens.length;
  if (matched >= 6 && ratio >= 0.82) return 120 + matched * 8 + (candidate.source === "page" ? 6 : 0);
  return 0;
}

/**
 * Find the parsed page containing a source snippet. This only trusts real
 * page/text blocks, not LLM field metadata, so a default source_page=1 does
 * not leak into review rows unless the snippet is actually found on page 1.
 */
function findPageForSnippet(doclingRaw: Record<string, unknown> | null | undefined, snippet: string): number | null {
  if (!doclingRaw || !snippet) return null;
  let best: { page: number; score: number } | null = null;
  for (const candidate of buildPageTextCandidates(doclingRaw)) {
    const score = pageMatchScore(candidate, snippet);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { page: candidate.page, score };
  }
  return best?.page ?? null;
}

function resolveVerifiedSourcePage(
  doclingRaw: Record<string, unknown> | null | undefined,
  sourceText: string | null,
  proposedPage: unknown,
): number | null {
  if (sourceText) {
    const verified = findPageForSnippet(doclingRaw, sourceText);
    if (verified != null) return verified;
  }

  const page = positivePageNumber(proposedPage);
  if (!page) return null;
  const pageNumbers = new Set(buildPageTextCandidates(doclingRaw).map((candidate) => candidate.page));
  return pageNumbers.size === 1 && pageNumbers.has(page) ? page : null;
}

function isGenericSourceText(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  if (/^(llm extracted|extracted|manual_review|not found|unknown|n\/a|na|null)$/i.test(text)) return true;
  if (lower.includes("derived from")) return true;
  const structuredFieldMatch = text.match(/^[a-z][a-z0-9_]*_[a-z0-9_]*\s*:\s*(.+)$/i);
  if (structuredFieldMatch) {
    const valuePart = structuredFieldMatch[1].trim();
    if (!valuePart || /^(unknown|n\/a|na|null|not found|not specified)$/i.test(valuePart)) return true;
    return false;
  }
  if (/^[a-z][a-z0-9_]{2,60}$/.test(text)) return true;
  return false;
}

function usableSourceText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return isGenericSourceText(text) ? null : text;
}

function cleanEvidenceSnippet(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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

  if (text.length < 8) return value;
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
  const workflowOutputs = extractionModuleType === "lease"
    ? result.rows.map((row) =>
        buildLeaseWorkflowAbstraction({
          row,
          doclingRaw: doclingRaw ?? null,
          documentSubtype,
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
      const value = cleanPartyAddressValue(fieldKey, rawValue);
      // Prefer evidence produced by the LLM/rule extractor; fall back to the
      // workflow's snippet match. This is what makes Raw Extracted / Source
      // Page / Exact Source Text light up in the Lease Review table.
      const llmEvidence = fieldEvidence[fieldKey];
      const llmSourceText = usableSourceText(llmEvidence?.source_text);
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
          const score = (candidate: any) =>
            (candidate.verifiedPage != null ? 100 : 0) +
            (candidate.source === "fallback" ? 20 : candidate.source === "workflow" ? 10 : 0) +
            Math.min(String(candidate.sourceText ?? "").length, 240) / 240;
          return score(b) - score(a);
        });
      const selectedEvidence = evidenceCandidates[0] ?? null;
      const mergedSourceText = selectedEvidence?.sourceText ?? null;
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
    if (rowCount > 0 && /GOOGLE_SERVICE_ACCOUNT_KEY|service account|private_key|JWT|Vertex AI|AI fallback|ANTHROPIC_API_KEY|Claude/i.test(text)) {
      continue;
    }
    if (/GOOGLE_SERVICE_ACCOUNT_KEY|service account|private_key|JWT/i.test(text)) {
      const sanitized = "AI fallback extraction is unavailable because Google Vertex AI is not fully configured. Deterministic document parsing still ran.";
      if (!out.includes(sanitized)) out.push(sanitized);
      continue;
    }
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
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
}) {
  const blank = isBlank(opts.value);
  return {
    id: `${opts.recordIndex}:${opts.isStandard ? "standard" : "custom"}:${opts.fieldKey}`,
    field_key: opts.fieldKey,
    label: humanizeFieldName(opts.fieldKey),
    value: opts.value ?? null,
    original_value: opts.value ?? null,
    field_type: opts.fieldType,
    description: opts.description ?? null,
    required: opts.required,
    is_standard: opts.isStandard,
    confidence: opts.confidence,
    source: blank ? "system" : opts.source,
    evidence: opts.evidence ?? null,
    editable: opts.editable ?? true,
    extraction_status: opts.status ?? (blank ? "not_found" : "extracted"),
    status: opts.status ?? (blank ? "missing" : "pending"),
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
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    const body = await req.json().catch(() => ({}));
    const { file_id } = body;

    if (!file_id) {
      return jsonResponse(
        { error: true, message: "file_id is required", error_code: "MISSING_FILE_ID" },
        400,
      );
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
    const fileTooLargeForInlineVision =
      fileSizeIsKnown && fileSizeBytes > MAX_INLINE_VISION_BYTES;

    console.log(
      `[normalize-pdf-output] STAGE docling_check file_id=${file_id} ` +
      `doclingTextLength=${doclingTextLength} doclingBlockCount=${doclingBlockCount} ` +
      `doclingTextIsGood=${doclingTextIsGood} fileSizeBytes=${fileSizeBytes}`,
    );

    let fileBase64: string | null = null;
    let fileMimeType: string | null = fileRecord.mime_type
      ?? (fileRecord.file_name?.toLowerCase().endsWith(".pdf") ? "application/pdf" : null);
    let fileLoadStatus: string = doclingTextIsGood ? "skipped_good_docling" : "not_attempted";
    let fileLoadError: string | null = null;
    let fileBytesLength = 0;
    let detectedMagic: string | null = null;

    if (doclingTextIsGood) {
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
    const detectMagic = (bytes: Uint8Array): string | null => {
      if (!bytes || bytes.length < 4) return null;
      // %PDF
      if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
      // JPEG: FF D8 FF
      if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "jpeg";
      // PNG: 89 50 4E 47
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "png";
      // GIF: 47 49 46 38
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
      // TIFF: 49 49 2A 00 or 4D 4D 00 2A
      if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2A) ||
          (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[3] === 0x2A)) return "tiff";
      // WEBP: RIFF....WEBP
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "webp_or_riff";
      // HTML error page leaked from CDN — anything starting with "<" or "<!"
      const lead = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]).toLowerCase();
      if (lead.startsWith("<!do") || lead.startsWith("<htm") || lead.startsWith("<?xm")) return "html_or_xml";
      return null;
    };

    if (!doclingTextIsGood && extractionSkipped) {
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
            fileLoadError = `Downloaded bytes do not look like a PDF/image (magic=${detectedMagic ?? "unknown"}, first 16 bytes hex=${
              Array.from(bytes.subarray(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join("")
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

    // Transition to 'validating' while the pipeline runs.
    // (pdf_parsed → validating is allowed in the FSM.)
    const { error: validatingStatusError } = await setStatus(supabaseAdmin, file_id, "validating");
    if (validatingStatusError) {
      throw new Error(`Failed to transition file to validating: ${validatingStatusError.message}`);
    }

    try {
      console.log(`[normalize-pdf-output] STAGE pipeline_start file_id=${file_id} fileBase64=${!!fileBase64}`);
      // Run the canonical extraction pipeline.
      // Rule → Table → LLM(missing only) → Merge → Validate → Calculate.
      const result = await runExtractionPipeline(
        {
          moduleType: extractionModuleType,
          fileName,
          docling: fileRecord.docling_raw,
          ...(fileBase64 ? { fileBase64, fileMimeType: fileMimeType || "application/pdf" } : {}),
        },
        {
          // maxLLMChunks: 2 — lease metadata (parties, dates, rent) lives in
          // the first 1–2 chunks of a well-formatted lease. Rule/table extraction
          // handles structured tables; LLM fills in fields rules couldn't resolve.
          // Keeping this at 2 prevents accumulating too many Gemini response
          // buffers in memory simultaneously (546 resource-exhaustion error).
          maxLLMChunks: 2,
          chunkSize: 3000,
          llmTemperature: 0,
        },
      );
      console.log(`[normalize-pdf-output] STAGE pipeline_done file_id=${file_id} rows=${result.rows?.length ?? 0} method=${result.method}`);

      // Forward file-load status into the pipeline's extractionDebug so the
      // UI/debug panel can show why Vision did or didn't run.
      if (result.metadata && typeof result.metadata === "object") {
        (result.metadata as any).extractionDebug = {
          ...((result.metadata as any).extractionDebug || {}),
          file_load_status: fileLoadStatus,
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
        };
        // Also expose it on the review payload metadata so the draft-creation
        // path (which only reads ui_review_payload) can persist it onto
        // lease.extraction_data.extraction_debug.
        if (uiReviewPayload?.metadata && typeof uiReviewPayload.metadata === "object") {
          (uiReviewPayload.metadata as Record<string, unknown>).extractionDebug = consolidated;
          (uiReviewPayload.metadata as Record<string, unknown>).extraction_debug = consolidated;
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

      // Decide the next status based on the review gate decided at ingest.
      const reviewRequired = !!fileRecord.review_required;
      const nextStatus = reviewRequired ? "review_required" : "validated";

      // FSM: 'validating' → 'validated' is allowed; 'validating' → 'review_required'
      // is NOT a valid transition in the FSM (validated is the intermediate).
      // So we always land on 'validated' first, then flip to 'review_required'
      // if a human gate is required.
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
