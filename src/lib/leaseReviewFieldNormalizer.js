/**
 * LeaseReview field normalizer — the single place that computes every "wide
 * payload-path union" the grouped Lease Review UI needs, so every consuming
 * section reads from ONE normalized object instead of each re-deriving its
 * own union. That duplication is exactly how the ExtractionDebugPanel count
 * mismatch happened (its own narrower union disagreeing with the real
 * Clause Records/Dynamic Findings unions) — see docs/lease-standard-field-model.md
 * and this task's plan for the full writeup.
 *
 * Built entirely on top of existing, working code:
 *   - readFieldValue/readFieldEvidence/readFieldConfidence/resolveExtractionStatus/
 *     hasValidSourceEvidence/classifyConfidence/normalizeClauseType/isMeaningfulValue
 *     (src/lib/leaseReviewSchema.js) — the canonical resolver, untouched.
 *   - collectExtractedDocumentItems (src/components/lease-review/utils/dynamicFields.js)
 *     — the existing dynamic-item collector, untouched.
 *   - src/lib/leaseFieldContract.js — the 17-group canonical field list.
 *
 * No new payload-path invention beyond what SpecializedTables.jsx's own
 * fallbackClauses already checked (that logic is ported here verbatim, not
 * rewritten, so ClauseRecordsTable's behavior doesn't change).
 */

import {
  readFieldValue,
  readFieldEvidence,
  readFieldConfidence,
  resolveExtractionStatus,
  resolveSourceTextQuality,
  hasValidSourceEvidence,
  classifyConfidence,
  normalizeClauseType,
  isMeaningfulValue,
  isMarkupArtifactValue,
  isCalculatedExtractionStatus,
  isManualExtractionStatus,
  normalizeEvidenceComparable,
  REVIEW_STATUSES,
  RESOLVED_REVIEW_STATUSES,
  EXTRACTION_STATUSES,
  SOURCE_TEXT_QUALITIES,
  EXTRACTION_MODES,
  REQUIRED_FIELD_KEYS,
} from "@/lib/leaseReviewSchema";
import { collectExtractedDocumentItems } from "@/components/lease-review/utils/dynamicFields";
import { LEASE_FIELD_CONTRACT, LEASE_REVIEW_CANONICAL_TABS, getFieldContract, resolveCanonicalFieldKey } from "@/lib/leaseFieldContract";
import { buildCurrentReviewPolicy, resolveCurrentReviewProfile } from "@/lib/leaseReviewCurrentPolicy";
import { getFieldAliases } from "@/lib/leaseFieldResolver";

function titleize(key) {
  return String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim() || "Untitled";
}

function normalizeConfidencePercent(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return null;
  return score <= 1 ? Math.round(score * 100) : Math.round(score);
}

const NO_PROVIDER_FALLBACK_SOURCE = "no_provider_payload_fallback";

function compactText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function normalizeComparableText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:suite|suites|ste)\b/g, "suite")
    .replace(/\s+/g, " ")
    .trim();
}

function moneyNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = String(value ?? "").match(/[\d,]+(?:\.\d{2})?/);
  if (!match) return null;
  const parsed = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function moneyDisplay(value) {
  const numeric = moneyNumber(value);
  if (numeric == null) return null;
  return "$" + numeric.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function sourceSnippet(text, index = 0, radius = 520) {
  const raw = String(text ?? "");
  const start = Math.max(0, index - radius);
  const end = Math.min(raw.length, index + radius);
  return compactText(raw.slice(start, end));
}

function readDoclingPages(lease) {
  const candidates = [
    lease?.docling_raw,
    lease?.extraction_data?.docling_raw,
    lease?.uploaded_files?.docling_raw,
    lease?.uploaded_file?.docling_raw,
    lease?.uploaded_files?.parsed_data?.docling_raw,
    lease?.uploaded_file?.parsed_data?.docling_raw,
  ];
  for (const docling of candidates) {
    const pages = Array.isArray(docling?.pages) ? docling.pages : null;
    if (!pages?.length) continue;
    return pages
      .map((page, idx) => ({
        page: page?.page ?? page?.page_number ?? idx + 1,
        text: compactText(page?.text ?? page?.markdown ?? page?.content ?? ""),
      }))
      .filter((page) => page.text);
  }
  return [];
}

function isLikelyContactAddressSource(text) {
  const value = String(text ?? "").toLowerCase();
  if (!value) return false;
  const contactSignal = /\b(?:tenant contact information|notice address|notices? to tenant|tenant address|guarantor|personal contact|mailing address|address:\s*)\b/i.test(value);
  const premisesSignal = /\b(?:premises|demised premises|shopping center|center|building|suite|leased premises)\b/i.test(value);
  return contactSignal && !premisesSignal;
}

function findPremisesAddressFallback(lease, existingValue, existingEvidence) {
  const pages = readDoclingPages(lease);
  if (!pages.length) return null;
    const addressPattern = /\b\d{3,6}\s+[A-Z][A-Za-z0-9.'? \-]+?\s*,\s*[A-Za-z.'? \-]+,\s*[A-Z]{2}\s*\d{5}\b/g;
  const candidates = [];
  for (const page of pages) {
    for (const match of page.text.matchAll(addressPattern)) {
      const value = compactText(match[0].replace(/\s+,/g, ","));
      if (!value) continue;
      const snippet = sourceSnippet(page.text, match.index, 620);
      const lower = String(snippet || "").toLowerCase();
      let score = 0;
      if (/\b(?:premises|demised premises|leased premises)\b/i.test(lower)) score += 8;
      if (/\b(?:shopping center|center|the markets at choto|markets at choto)\b/i.test(lower)) score += 6;
      if (/\b(?:building|suite|suites)\b/i.test(lower)) score += 4;
      if (Number(page.page) <= 2) score += 2;
      if (isLikelyContactAddressSource(snippet)) score -= 12;
      candidates.push({ value, sourceText: snippet, sourcePage: page.page, score });
    }
  }
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 8) return null;

  const comparableExisting = normalizeComparableText(existingValue);
  const comparableBest = normalizeComparableText(best.value);
  if (comparableExisting && comparableExisting === comparableBest) return null;

  const existingLooksContact = isLikelyContactAddressSource(existingEvidence?.sourceText);
  if (!comparableExisting || existingLooksContact || best.score >= 14) {
    return {
      value: best.value,
      confidence: 0.84,
      sourceProvider: NO_PROVIDER_FALLBACK_SOURCE,
      reviewReason: comparableExisting
        ? "No-provider fallback replaced a likely tenant/contact address with stronger premises address evidence. Needs reviewer confirmation."
        : "No-provider fallback supplied premises address from source text. Needs reviewer confirmation.",
      evidence: {
        value: best.value,
        rawValue: best.value,
        sourcePage: best.sourcePage,
        sourceText: best.sourceText,
        extractionStatus: EXTRACTION_STATUSES.EXTRACTED,
        evidenceType: "extracted",
        sourceTextQuality: SOURCE_TEXT_QUALITIES.PARTIAL,
        requiresReview: true,
      },
    };
  }
  return null;
}

function findSecurityDepositFallback(lease) {
  for (const page of readDoclingPages(lease)) {
    if (!/security deposit addendum|security deposit/i.test(page.text)) continue;
    const totalMatch =
      page.text.match(/(?:for\s+a\s+total\s+of|total\s+of)[\s\S]{0,180}?\$([\d,]+(?:\.\d{2})?)/i)
      || page.text.match(/security deposit[\s\S]{0,420}?\$([\d,]+(?:\.\d{2})?)/i);
    if (!totalMatch) continue;
    const value = moneyNumber(totalMatch[1]);
    if (value == null) continue;
    const snippet = sourceSnippet(page.text, totalMatch.index ?? 0, 560);
    const amountCount = (snippet?.match(/\$[\d,]+(?:\.\d{2})?/g) || []).length;
    return {
      value,
      confidence: amountCount > 1 ? 0.86 : 0.9,
      sourceProvider: NO_PROVIDER_FALLBACK_SOURCE,
      reviewReason: amountCount > 1
        ? "No-provider fallback selected the total security deposit from multiple addendum amounts. Needs reviewer confirmation."
        : "No-provider fallback supplied security deposit from addendum text. Needs reviewer confirmation.",
      evidence: {
        value,
        rawValue: moneyDisplay(value),
        sourcePage: page.page,
        sourceText: snippet,
        extractionStatus: EXTRACTION_STATUSES.EXTRACTED,
        evidenceType: "extracted",
        sourceTextQuality: SOURCE_TEXT_QUALITIES.PARTIAL,
        requiresReview: true,
      },
    };
  }
  return null;
}

function standardFieldFallback(lease, canonicalKey, { value, evidence } = {}) {
  if (canonicalKey === "property_address") {
    return findPremisesAddressFallback(lease, value, evidence);
  }
  if (canonicalKey === "security_deposit" && !isMeaningfulValue(value)) {
    return findSecurityDepositFallback(lease);
  }
  return null;
}

function readTypedLeaseColumnValue(lease, canonicalKey) {
  if (!lease || typeof lease !== "object") return undefined;
  for (const key of getFieldAliases(canonicalKey)) {
    if (!Object.prototype.hasOwnProperty.call(lease, key)) continue;
    const value = lease[key];
    if (isMeaningfulValue(value)) return value;
  }
  return undefined;
}
function readResolvedReviewValue(review) {
  if (!review || !RESOLVED_REVIEW_STATUSES.has(review.status)) return undefined;
  const value = review.value ?? review.normalized_value ?? review.normalizedValue ?? review.raw_value ?? review.rawValue;
  return isMeaningfulValue(value) ? value : undefined;
}

function mergeReviewEvidence(evidence, review) {
  if (!review) return evidence;
  const sourcePage = review.source_page ?? review.sourcePage ?? evidence?.sourcePage ?? null;
  const sourceText = review.source_text ?? review.sourceText ?? evidence?.sourceText ?? null;
  if (sourcePage === (evidence?.sourcePage ?? null) && sourceText === (evidence?.sourceText ?? null)) return evidence;
  return {
    ...(evidence || {}),
    sourcePage,
    sourceText,
  };
}
function hasRowValue(row) {
  // Phase 39: a required field whose only extracted value was rejected as a
  // layout/markup artifact (see normalizeStandardFields/isMarkupArtifactValue)
  // must not silently become a NEW missing/incomplete signal as a side
  // effect of that display fix - it already had signal before the fix (that
  // is why it was required), and this phase intentionally preserves the
  // existing approval-blocker set. This is the ONLY place besides
  // normalizeApprovalBlockers that reads invalidValueRejected, and it never
  // widens beyond that one flag.
  if (row?.invalidValueRejected) return true;
  return isMeaningfulValue(row?.value ?? row?.normalized_value ?? row?.normalizedValue);
}

// Phase 46: some required-field keys use a legacy name (e.g. premises_address,
// premises_use, lease_term - from REQUIRED_FIELD_KEYS in leaseReviewSchema.js)
// while `standardFields`/`byKey` is keyed by LEASE_FIELD_CONTRACT's newer
// canonical name (property_address, permitted_use, lease_term_months).
// readFieldValue/readFieldEvidence already resolve this via getFieldAliases()
// (leaseFieldResolver.js) when reading the raw lease payload directly, but
// normalizeApprovalBlockers/buildReadinessSummary check `standardFields` rows
// instead and never applied the same aliasing - so a populated, evidence-backed
// canonical field could still show as a missing legacy-named blocker. This
// checks every alias's row through the same hasRowValue() gate used
// everywhere else, so weak/rejected/valueless alias rows still block exactly
// as before - it only recognizes a REAL value under a different key name.
function requiredFieldHasValue(byKey, key) {
  return getFieldAliases(key).some((aliasKey) => hasRowValue(byKey.get(aliasKey)));
}

// Phase 39: signature-date fields whose only evidence describes when the
// ORIGINAL lease was entered into (not this document's own execution) must
// not be treated as an accepted/evidence-verified signature fact. Scoped to
// exactly these two canonical keys - not a general date-field rule.
const SIGNATURE_DATE_KEYS_REQUIRING_EXECUTION_CONTEXT = new Set([
  "tenant_signature_date",
  "landlord_signature_date",
]);

const LEASE_REFERENCE_DATE_PATTERN =
  /\b(?:entered\s+into\s+(?:that\s+certain\s+)?lease|that\s+certain\s+lease\s+dated|the\s+lease\s+dated|pursuant\s+to\s+(?:that\s+certain\s+)?lease|under\s+(?:that\s+certain\s+)?lease)\b/i;
const SIGNATURE_EXECUTION_CONTEXT_PATTERN =
  /\b(?:in\s+witness\s+whereof|executed[\s\S]{0,20}as\s+of|signed\s+as\s+of|\/s\/|date\s+of\s+signature|signature\s+date)\b/i;

export function isSignatureDateSourcedFromLeaseReference(sourceText) {
  if (!sourceText) return false;
  const text = String(sourceText);
  return LEASE_REFERENCE_DATE_PATTERN.test(text) && !SIGNATURE_EXECUTION_CONTEXT_PATTERN.test(text);
}

/**
 * Phase 40: resolves the user-facing "how did this value come to exist"
 * extraction mode (EXTRACTION_MODES) from signals that are ALREADY computed
 * by the existing resolvers - resolveExtractionStatus, hasValidSourceEvidence
 * / resolveSourceTextQuality, and review status. It never invents a mode:
 * every branch is grounded in a real, already-trusted signal, and anything
 * it can't confidently classify falls through to "unknown" rather than
 * guessing "explicit".
 *
 * Order matters:
 *   1. A human explicitly edited the value (REVIEW_STATUSES.EDITED) -
 *      reviewer_entered, regardless of what extraction said.
 *   2. A human flagged it for manual entry (REVIEW_STATUSES.MANUAL_REQUIRED)
 *      or the backend/system already tagged it manual - manual.
 *   3. This field's evidence was explicitly rejected this session (Phase 39
 *      invalid-markup or signature-date-from-original-lease demotions) -
 *      unknown. Never explicit/normalized/inferred for a value the system
 *      just finished saying it doesn't trust.
 *   4. No meaningful value - unknown (nothing to describe a mode for).
 *   5. Backend/system says calculated/derived/computed - calculated.
 *   6. Backend/system says inferred - inferred.
 *   7. No valid source evidence at all - unknown.
 *   8. Source-text quality (exact/partial -> explicit, derived -> normalized,
 *      inferred -> inferred) - otherwise unknown.
 */
export function resolveLeaseReviewExtractionMode({
  hasValue,
  extractionStatus,
  evidenceVerified,
  evidence,
  reviewStatus,
  invalidValueRejected = false,
  evidenceOverrideReason = null,
} = {}) {
  if (reviewStatus === REVIEW_STATUSES.EDITED) return EXTRACTION_MODES.REVIEWER_ENTERED;
  if (reviewStatus === REVIEW_STATUSES.MANUAL_REQUIRED) return EXTRACTION_MODES.MANUAL;
  if (isManualExtractionStatus(extractionStatus)) return EXTRACTION_MODES.MANUAL;

  if (invalidValueRejected || evidenceOverrideReason) return EXTRACTION_MODES.UNKNOWN;
  if (!hasValue) return EXTRACTION_MODES.UNKNOWN;
  if (isCalculatedExtractionStatus(extractionStatus)) return EXTRACTION_MODES.CALCULATED;
  if (extractionStatus === EXTRACTION_STATUSES.INFERRED) return EXTRACTION_MODES.INFERRED;
  if (!evidenceVerified) return EXTRACTION_MODES.UNKNOWN;

  const quality = resolveSourceTextQuality(evidence);
  if (quality === SOURCE_TEXT_QUALITIES.EXACT || quality === SOURCE_TEXT_QUALITIES.PARTIAL) return EXTRACTION_MODES.EXPLICIT;
  if (quality === SOURCE_TEXT_QUALITIES.DERIVED) return EXTRACTION_MODES.NORMALIZED;
  if (quality === SOURCE_TEXT_QUALITIES.INFERRED) return EXTRACTION_MODES.INFERRED;
  return EXTRACTION_MODES.UNKNOWN;
}

const DYNAMIC_TAB_RULES = [
  { tabKey: "parties_premises", pattern: /parking|premises|suite|unit|floor|signage|storage|loading|rooftop|patio|use restriction/i },
  { tabKey: "rent_charges", pattern: /rent|credit|abatement|charge|deposit|fee|breakpoint|percentage/i },
  { tabKey: "expenses_recoveries", pattern: /expense|recover|reimburse|exclusion|non.?recover|audit|true.?up|reconciliation|operating/i },
  { tabKey: "cam_rules", pattern: /\bcam\b|common area|gross.?up|cap|base year|expense stop|admin fee|management fee/i },
  { tabKey: "taxes", pattern: /tax|assessment|appeal|protest|refund/i },
  { tabKey: "insurance", pattern: /insurance|insured|liability|subrogation|deductible|certificate|carrier/i },
  { tabKey: "utilities", pattern: /utility|utilities|electric|water|sewer|gas|hvac|trash|telecom|meter/i },
  { tabKey: "repairs_maintenance", pattern: /repair|maintenance|hvac|roof|structural|janitorial|landscap|snow|pest|glass/i },
  { tabKey: "legal_options", pattern: /assign|sublet|option|renewal|termination|exclusive|co.?tenancy|radius|default|holdover|alteration|snda|estoppel|indemn/i },
  { tabKey: "critical_dates", pattern: /deadline|notice date|critical date|must open|delivery deadline|reporting date/i },
  { tabKey: "notices", pattern: /notice|mail|courier|email|copy to|address/i },
  { tabKey: "signatures", pattern: /signature|signatory|signed|counterpart|electronic/i },
  { tabKey: "documents_exhibits", pattern: /exhibit|document|guaranty|snda|estoppel|assignment|work letter|site plan|attached|referenced/i },
];

export function routeDynamicRowToTab(fact = {}) {
  const explicit = fact.tabKey || fact.tab_key || fact.display_tab || fact.business_area || fact.category;
  if (explicit && LEASE_REVIEW_CANONICAL_TABS.some((tab) => tab.key === explicit)) return explicit;
  const text = [
    fact.label,
    fact.item_type,
    fact.field_key,
    fact.category,
    fact.value,
    fact.normalized_value,
    fact.source_text,
    fact.exact_source_text,
  ].filter(Boolean).join(" ");
  const matched = DYNAMIC_TAB_RULES.find((rule) => rule.pattern.test(text));
  return matched?.tabKey || "legal_options";
}

function normalizeRowStatus(status, fallback = "needs_review") {
  const text = String(status || "").toLowerCase();
  if (["approved", "accepted", "active"].includes(text)) return "approved";
  if (["rejected", "ignored"].includes(text)) return "rejected";
  if (["missing", "not_found"].includes(text)) return "missing";
  if (["auto_populated", "extracted", "draft_from_extraction", "draft"].includes(text)) return text;
  return fallback;
}

// ── Standard fields ───────────────────────────────────────────────────────

function describeApprovalImpact(contract) {
  const parts = [];
  if (contract.requiredForApproval) parts.push("blocks core approval readiness");
  if (contract.requiredForCam) parts.push("required for CAM calculation");
  if (contract.requiredForBudget) parts.push("required for Budget handoff");
  if (contract.requiredByDocumentProfile?.length) {
    parts.push(`blocks approval for: ${contract.requiredByDocumentProfile.join(", ")}`);
  }
  return parts.length ? parts.join("; ") : "Advisory only — no downstream gate today.";
}

function computeFieldStatus({ hasValue, evidenceVerified, confidenceBucket, reviewStatus, extractionStatus }) {
  if (reviewStatus === REVIEW_STATUSES.EDITED) return "manually_edited";
  if (extractionStatus === EXTRACTION_STATUSES.CONFLICT) return "needs_review";
  if (!hasValue) return "missing";
  if (evidenceVerified && confidenceBucket === "high") return "auto_populated";
  return "needs_review";
}

/**
 * One row per LEASE_FIELD_CONTRACT entry that's a real, directly-extractable
 * LEASE_SCHEMA field (skips `computed: true` entries like tenant_pro_rata_share
 * and row-level, non-field entries like document_profile/approval_status —
 * those are surfaced separately, see normalizeApprovalBlockers).
 */
export function normalizeStandardFields(lease, { fieldReviews } = {}) {
  const effectiveFieldReviews = fieldReviews ?? lease?.extraction_data?.field_reviews ?? {};
  const rows = [];
  for (const rawContract of LEASE_FIELD_CONTRACT) {
    const contract = getFieldContract(rawContract.canonicalKey) || rawContract;
    if (contract.computed || !contract.inLeaseSchema) continue;
    const canonicalKey = contract.canonicalKey;
    const review = effectiveFieldReviews?.[canonicalKey];
    const reviewedValue = readResolvedReviewValue(review);
    const typedColumnValue = readTypedLeaseColumnValue(lease, canonicalKey);
    let value = reviewedValue !== undefined
      ? reviewedValue
      : typedColumnValue !== undefined
        ? typedColumnValue
        : readFieldValue(lease, canonicalKey);
    let evidence = readFieldEvidence(lease, canonicalKey);
    let confidence = readFieldConfidence(lease, canonicalKey);
    if (reviewedValue !== undefined) {
      evidence = mergeReviewEvidence(evidence, review);
      confidence = typeof review?.confidence === "number" ? review.confidence : confidence;
    }
    let fallbackReviewReason = null;
    let fallbackSourceProvider = null;
    const fallback = standardFieldFallback(lease, canonicalKey, { value, evidence });
    if (fallback) {
      value = fallback.value;
      evidence = fallback.evidence;
      confidence = fallback.confidence;
      fallbackReviewReason = fallback.reviewReason;
      fallbackSourceProvider = fallback.sourceProvider;
    }

    // Phase 39: reject layout/markup artifacts (e.g. "<figure>") before they
    // can be displayed as an accepted value. invalidValueRejected is read
    // downstream by hasRowValue/normalizeApprovalBlockers ONLY to keep this
    // display fix from silently creating a new approval blocker - it is not
    // a general "field is fine" signal.
    let invalidValueRejected = false;
    let evidenceOverrideReason = null;
    if (isMarkupArtifactValue(value)) {
      evidenceOverrideReason = `Extracted value "${value}" was a layout/markup artifact, not a real field value, and was rejected.`;
      invalidValueRejected = true;
      value = null;
    }

    const extractionStatus = resolveExtractionStatus(lease, canonicalKey, { value, confidence, evidence });
    let evidenceVerified = invalidValueRejected ? false : hasValidSourceEvidence(evidence);

    // Phase 39: signature dates sourced from original-lease-reference text
    // (not this document's own execution) must not read as accepted facts.
    // Value is retained (not fabricated away) - only evidenceVerified/status
    // are demoted, via the existing computeFieldStatus needs_review branch.
    if (
      !evidenceOverrideReason &&
      SIGNATURE_DATE_KEYS_REQUIRING_EXECUTION_CONTEXT.has(canonicalKey) &&
      isSignatureDateSourcedFromLeaseReference(evidence?.sourceText)
    ) {
      evidenceVerified = false;
      evidenceOverrideReason =
        "Source text describes when the original lease was entered into, not this document's signature date. Needs manual verification.";
    }
    const hasValue = isMeaningfulValue(value);
    const status = computeFieldStatus({
      hasValue,
      evidenceVerified,
      confidenceBucket: classifyConfidence(confidence),
      reviewStatus: review?.status,
      extractionStatus,
    });
    const extractionMode = resolveLeaseReviewExtractionMode({
      hasValue,
      extractionStatus,
      evidenceVerified,
      evidence,
      reviewStatus: review?.status,
      invalidValueRejected,
      evidenceOverrideReason,
    });

    rows.push({
      rowType: "standard",
      typeLabel: "Standard",
      fieldKey: canonicalKey,
      canonicalKey,
      key: canonicalKey,
      field_key: canonicalKey,
      label: contract.displayLabel || contract.label,
      field_label: contract.displayLabel || contract.label,
      group: contract.group,
      tabKey: contract.canonicalTab,
      canonicalTab: contract.canonicalTab,
      editable: true,
      value,
      normalizedValue: value,
      normalized_value: value,
      display_value: value,
      confidence,
      confidencePercent: normalizeConfidencePercent(confidence),
      status,
      extraction_status: status,
      sourcePage: evidence?.sourcePage ?? null,
      source_page: evidence?.sourcePage ?? null,
      page_number: evidence?.sourcePage ?? null,
      sourceText: evidence?.sourceText ?? null,
      source_text: evidence?.sourceText ?? null,
      evidenceVerified,
      invalidValueRejected,
      extractionMode,
      extraction_mode: extractionMode,
      required: Boolean(contract.requiredForApproval),
      requiredForApproval: Boolean(contract.requiredForApproval),
      requiredForCam: Boolean(contract.requiredForCam),
      requiredForBudget: Boolean(contract.requiredForBudget),
      requiredForExpenseRules: Boolean(contract.requiredForExpenseRules),
      defaultVisible: Boolean(contract.defaultVisible),
      advanced: Boolean(contract.advanced),
      dataType: contract.dataType,
      type: contract.dataType === "money" ? "currency" : contract.dataType === "percent" ? "number" : contract.dataType,
      readOnlyReferences: contract.readOnlyReferences || [],
      approvalImpact: describeApprovalImpact(contract),
      validationMessage: evidenceOverrideReason ?? fallbackReviewReason ?? (evidence?.reviewReason ?? evidence?.approvalBlockingReason ?? null),
      fallbackApplied: Boolean(fallbackSourceProvider),
      sourceProvider: fallbackSourceProvider ?? evidence?.extractionStatus
        ?? lease?.extraction_data?.workflow_output?.extraction_provider
        ?? "unknown",
    });
  }
  return rows;
}

export function getStandardFieldsByGroup(standardFields, group) {
  return standardFields.filter((row) => row.group === group);
}

// ── Dynamic findings ─────────────────────────────────────────────────────

/**
 * Facts extracted but not mapped to a standard field. Reuses
 * collectExtractedDocumentItems() (dynamicFields.js) — not reimplemented —
 * plus the openai_fact_ledger diagnostic path
 * explicitly (additive; empty for legacy_hybrid leases, the live default).
 */
export function normalizeDynamicFindings(lease) {
  const collected = collectExtractedDocumentItems(lease) || [];
  const openAIItems =
    lease?.uploaded_files?.ui_review_payload?.metadata?.extractionDebug?.openai_fact_ledger?.dynamic_items
    ?? lease?.uploaded_file?.ui_review_payload?.metadata?.extractionDebug?.openai_fact_ledger?.dynamic_items
    ?? lease?.uploaded_files?.ui_review_payload?.metadata?.extractionDebug?.vertex_fact_ledger?.dynamic_items
    ?? lease?.uploaded_file?.ui_review_payload?.metadata?.extractionDebug?.vertex_fact_ledger?.dynamic_items
    ?? [];
  const merged = [...collected, ...(Array.isArray(openAIItems) ? openAIItems : [])];

  const seen = new Set();
  const rows = [];
  for (const item of merged) {
    if (!item || typeof item !== "object") continue;
    if (item.maps_to_existing_field) continue;
    const candidateKey = item.field_key || item.item_type || item.key;
    const canonicalCandidate = resolveCanonicalFieldKey(candidateKey);
    if (getFieldContract(canonicalCandidate)) continue;
    const sourceText = item.source_text ?? item.exact_source_text ?? null;
    const dedupeKey = `${item.item_type || item.field_key || ""}|${String(sourceText || item.value || "").toLowerCase().slice(0, 140)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const tabKey = routeDynamicRowToTab(item);
    const confidence = typeof item.confidence === "number" ? item.confidence : null;
    rows.push({
      rowType: "dynamic",
      typeLabel: "Dynamic",
      key: item.item_id || item.id || `dynamic-${rows.length}`,
      fieldKey: item.field_key || item.item_type || null,
      label: item.label || titleize(item.item_type || item.field_key || "Finding"),
      category: item.business_area || item.display_tab || item.item_type || "unknown_needs_review",
      tabKey,
      editable: false,
      value: item.normalized_value ?? item.value ?? null,
      normalizedValue: item.normalized_value ?? item.value ?? null,
      normalized_value: item.normalized_value ?? item.value ?? null,
      sourcePage: item.source_page ?? item.page_number ?? null,
      source_page: item.source_page ?? item.page_number ?? null,
      page_number: item.source_page ?? item.page_number ?? null,
      sourceText,
      source_text: sourceText,
      confidence,
      confidencePercent: normalizeConfidencePercent(confidence),
      status: normalizeRowStatus(item.review_status || item.status || item.extraction_status),
      // Phase 40: dynamic-finding items don't carry the same structured
      // extraction-status/evidence-quality metadata standard fields do, so
      // resolveLeaseReviewExtractionMode's inputs can't be built reliably
      // here. Defaulting to unknown rather than guessing "explicit".
      extractionMode: EXTRACTION_MODES.UNKNOWN,
      extraction_mode: EXTRACTION_MODES.UNKNOWN,
      mapsToExistingField: Boolean(item.maps_to_existing_field),
      createsDynamicRow: item.creates_dynamic_row !== false,
      defaultVisible: true,
      advanced: false,
    });
  }
  return mergeDynamicFallbackRows(rows, normalizeNoProviderDynamicFallbackRows(lease));
}

// ── Clause records ────────────────────────────────────────────────────────

function cleanDocumentItemSource(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/^(llm extracted|extracted|manual_review|not found|unknown|n\/a|na|null)$/i.test(text)) return null;
  if (text.toLowerCase().includes("derived from")) return null;
  if (/^[a-z][a-z0-9_]*_[a-z0-9_]*\s*:\s*/i.test(text)) return null;
  if (/^[a-z][a-z0-9_]{2,60}$/i.test(text)) return null;
  return text;
}

function looksLikeClauseEvidence(value) {
  const text = cleanDocumentItemSource(value);
  if (!text) return false;
  if (text.length > 180) return true;
  return /\b(?:summary of basic lease information|this lease|article\s+\d+|section\s+\d+|tenant shall|landlord shall|premises|rent:|security deposit|common area|operating expense|insurance|utilities|maintenance|repairs?)\b/i.test(text);
}

function documentItemSource(item) {
  if (!item || typeof item !== "object") return null;
  return cleanDocumentItemSource(
    item.source_text
      || item.exact_source_text
      || item.source_clause
      || item.exact_text
      || item.clause_text
      || item.snippet
      || (looksLikeClauseEvidence(item.normalized_value ?? item.value ?? item.raw_value ?? item.rawValue)
        ? item.normalized_value ?? item.value ?? item.raw_value ?? item.rawValue
        : null),
  );
}

function documentItemValue(item) {
  if (!item || typeof item !== "object") return null;
  const value = item.normalized_value ?? item.normalizedValue ?? item.normalized_meaning ?? item.normalizedMeaning ?? item.value ?? item.raw_value ?? item.rawValue ?? null;
  return looksLikeClauseEvidence(value) ? null : value;
}
const CLAUSE_DUPLICATE_TYPES = new Set([
  "rent_clause",
  "security_deposit",
  "operating_expense_recovery",
  "cam_recoveries",
  "late_fees",
  "insurance_requirements",
  "use_permitted_use",
  "repairs_maintenance",
  "notices",
  "broker_commission",
]);

const HIGH_VALUE_LEGAL_CLAUSE_TYPES = new Set([
  "assignment_subletting",
  "defaults_remedies",
  "renewal_option",
  "termination",
  "indemnification",
  "alterations",
  "holdover",
  "subordination",
  "estoppel",
  "guaranty",
]);

const HIGH_VALUE_LEGAL_FIELD_KEYS = new Set([
  "assignment_provisions",
  "default_cure_period",
  "renewal_options",
  "renewal_type",
  "right_of_first_refusal",
  "early_termination_option",
  "landlord_consent",
  "landlord_consent_for_transfer",
  "assumption_scope",
]);

function clauseTitleToFieldKey(title) {
  return String(title || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function clauseSemanticFieldKey(row) {
  const candidates = [
    row?.structured_fields_json?.item_type,
    row?.structured_fields_json?.field_key,
    row?.structured_fields_json?.key,
    row?.field_key,
    row?.item_type,
    row?.clause_type,
    clauseTitleToFieldKey(row?.clause_title),
  ];
  for (const candidate of candidates) {
    const canonical = resolveCanonicalFieldKey(candidate);
    if (getFieldContract(canonical)) return canonical;
  }
  return null;
}

function clauseCombinedText(row) {
  return compactText([row?.clause_title, row?.clause_type, row?.clause_text].filter(Boolean).join(" ")) || "";
}

function isExpenseCamRentOrSecurityClause(row) {
  const text = clauseCombinedText(row);
  return /\b(?:security deposit|rent addendum|minimum rent|monthly rent|base rent|rent schedule|months?\s*[- ]?\d|cam estimate|common area maintenance|common areas?|operating expenses?|expense recover(?:y|ies)|real estate taxes?|insurance premiums?|pro[-\s]?rata|management costs?|administrative fee|admin fee|five percent of rent collected)\b/i.test(text);
}

function isGenericLegalBoilerplateClause(row) {
  const text = String(row?.clause_text || "");
  const normalized = normalizeEvidenceComparable(text);
  if (!normalized || normalized.length < 35) return true;
  if (/^(?:by|date|address|tenant|landlord|suite|building|consideration received|located in a shopping center)\b/i.test(text.trim())) return true;
  if (/\b(?:whereas|hereto|thereof|hereof|pursuant to|notwithstanding)\b/i.test(text) && text.length < 120) return true;
  return false;
}

function isRetainableHighValueLegalClause(row, semanticKey) {
  const type = row?.clause_type;
  const text = clauseCombinedText(row);
  if (HIGH_VALUE_LEGAL_CLAUSE_TYPES.has(type) || HIGH_VALUE_LEGAL_FIELD_KEYS.has(semanticKey)) {
    return /\b(?:assign|subleas|transfer|default|remed|cure|renew|option|terminat|indemn|holdover|subordination|estoppel|guarant|consent|alteration|improvement)\b/i.test(text);
  }
  return /\b(?:exclusive use|co-tenancy|continuous operation|go dark|relocation|radius restriction|non-compete|indemnif|holdover|subordination|estoppel|guaranty|default remedies|early termination|renewal option)\b/i.test(text);
}

function shouldKeepClauseRecord(row, { profile } = {}) {
  if (!cleanDocumentItemSource(row?.clause_text)) return false;

  // Assignment clause behavior was intentionally broadened in Phase 44A; keep
  // that path stable. The Phase 50 noise regression is specific to base-lease
  // fact echoes that already have dedicated standard/rule rows.
  if (profile !== "base_lease") return true;

  const semanticKey = clauseSemanticFieldKey(row);
  const type = row?.clause_type;

  if (isExpenseCamRentOrSecurityClause(row)) return false;
  if (CLAUSE_DUPLICATE_TYPES.has(type)) return false;
  if (semanticKey && getFieldContract(semanticKey) && !isRetainableHighValueLegalClause(row, semanticKey)) return false;
  if (isGenericLegalBoilerplateClause(row) && !isRetainableHighValueLegalClause(row, semanticKey)) return false;

  return isRetainableHighValueLegalClause(row, semanticKey) || !semanticKey;
}


/**
 * Ported verbatim from SpecializedTables.jsx's `fallbackClauses` useMemo body
 * (same 24-path union, same cleanDocumentItemSource gating, same dedupe) —
 * extracted as a plain function so it isn't coupled to a React hook and can
 * be shared by ClauseRecordsTable, Dynamic Findings, and the debug panel.
 * ClauseRecordsTable still layers the DB-backed `lease_clauses` table rows
 * on top of this (that query stays async/component-local; this function
 * only covers the synchronous payload-derived fallback).
 */
export function computeFallbackClauseRows(lease) {
  const rawWorkflowOutput = lease?.extraction_data?.workflow_output || {};
  const workflowOutput = rawWorkflowOutput.workflow_output || rawWorkflowOutput;
  const ufPayload = lease?.uploaded_files?.ui_review_payload || lease?.uploaded_file?.ui_review_payload || {};
  const ufMetaWorkflow = ufPayload?.metadata?.workflow_output || {};
  const ufWorkflowOutput = ufMetaWorkflow.workflow_output || ufMetaWorkflow;
  const ufRecordOutput = (ufPayload?.records || ufPayload?.rows || [])[0]?.workflow_output || {};
  const recordOutput = Array.isArray(rawWorkflowOutput.records) ? rawWorkflowOutput.records[0] || {} : {};

  const fromWorkflow = workflowOutput?.lease_clauses;
  const fromTopLevel = lease?.extraction_data?.lease_clauses;
  const fromUploadMeta = ufWorkflowOutput?.lease_clauses;
  const fromUploadRecord = ufRecordOutput?.lease_clauses;

  const itemRows = [
    workflowOutput.extracted_document_items,
    workflowOutput.clause_records,
    recordOutput.extracted_document_items,
    recordOutput.clause_records,
    rawWorkflowOutput.extracted_document_items,
    rawWorkflowOutput.clause_records,
    lease?.extraction_data?.extracted_document_items,
    lease?.extraction_data?.clause_records,
    ufWorkflowOutput.extracted_document_items,
    ufWorkflowOutput.clause_records,
    ufRecordOutput.extracted_document_items,
    ufRecordOutput.clause_records,
    collectExtractedDocumentItems(lease),
  ].flatMap((rows) => (Array.isArray(rows) ? rows : []));

  const fieldMapRows = [
    workflowOutput.lease_fields,
    recordOutput.lease_fields,
    lease?.extraction_data?.fields,
    ufWorkflowOutput.lease_fields,
    ufRecordOutput.lease_fields,
  ].flatMap((map, mapIdx) => {
    if (!map || typeof map !== "object" || Array.isArray(map)) return [];
    return Object.entries(map).map(([key, entry]) => ({
      item_id: `field-map-${mapIdx}-${key}`,
      item_type: key,
      label: titleize(key),
      business_area: "clause_records",
      source_text: documentItemSource(entry),
      source_page: entry?.source_page ?? entry?.page_number ?? entry?.page ?? null,
      confidence: entry?.confidence_score ?? entry?.confidence ?? null,
      normalized_value: documentItemValue(entry),
      value: documentItemValue(entry),
      extraction_status: entry?.extraction_status ?? null,
    }));
  });

  const list = [fromWorkflow, fromTopLevel, fromUploadMeta, fromUploadRecord, recordOutput.lease_clauses]
    .flatMap((rows) => (Array.isArray(rows) ? rows : []));
  const clauseRows = list
    .map((c, idx) => {
      const clauseText = cleanDocumentItemSource(c.clause_text || c.exact_text || c.exact_source_text || c.source_text || c.source_clause);
      const baseStructuredFields = c.structured_fields_json || {
        normalized_meaning: c.normalized_meaning || c.normalized_value || c.value || null,
        evidence_type: c.evidence_type || null,
        requires_review: c.requires_review ?? null,
      };
      return {
        id: c.id || c.item_id || `extract-${idx}`,
        clause_type: normalizeClauseType(c.clause_type || c.type || c.item_type || "clause_records"),
        clause_title: c.clause_title || c.title || c.label || c.section_title || "Extracted Clause",
        clause_text: clauseText,
        source_page: c.source_page ?? c.page_number ?? c.page ?? null,
        confidence_score: c.confidence_score ?? c.confidence ?? null,
        _raw_value: c.normalized_value ?? c.value ?? null,
        // Phase 44A-Fix: same rejected-evidence guard as discoveredRows below
        // - do not let a signature date sourced from the original lease
        // reference read as a clean legal summary via this path either.
        structured_fields_json: {
          ...baseStructuredFields,
          requires_review: baseStructuredFields.requires_review || isSignatureDateSourcedFromLeaseReference(clauseText) || undefined,
        },
      };
    })
    // Phase 44A-Fix: same markup-artifact rejection as discoveredRows below,
    // checked against both the resolved value and the clause text.
    .filter((row) => !isMarkupArtifactValue(row._raw_value) && !isMarkupArtifactValue(row.clause_text))
    .filter((row) => cleanDocumentItemSource(row.clause_text))
    .map(({ _raw_value, ...row }) => row);

  const discoveredRows = [...itemRows, ...fieldMapRows]
    .filter((item) => documentItemSource(item))
    // Phase 44A-Fix: never surface a rejected layout/markup artifact (e.g.
    // "<figure>") as a clause row - same rejection rule Phase 39 applies to
    // standard fields (isMarkupArtifactValue), just reused here so Clause
    // Records can't become a second, unguarded path for the same garbage.
    // Checked against both the resolved value and the source text, since a
    // clause's source text can wrap the artifact in surrounding context
    // (e.g. "LANDLORD:\n\n<figure>") where the artifact only shows up
    // cleanly in the resolved value.
    .filter((item) => !isMarkupArtifactValue(documentItemValue(item)) && !isMarkupArtifactValue(documentItemSource(item)))
    .map((item, idx) => {
      const semanticType = String(item.item_type || item.field_key || item.clause_type || item.business_area || item.display_tab || "clause_records").replace(/^clause[_-]/i, "");
      const clauseText = documentItemSource(item);
      return {
        id: item.item_id || item.id || `document-item-${idx}`,
        is_document_item: true,
        clause_type: normalizeClauseType(semanticType),
        clause_title: item.label || item.section_title || item.item_type || item.field_key || "Discovered Field",
        clause_text: clauseText,
        source_page: item.source_page ?? item.page_number ?? item.page ?? null,
        confidence_score: item.confidence_score ?? item.confidence ?? null,
        structured_fields_json: {
          item_type: item.item_type || null,
          display_tab: item.display_tab || null,
          value: documentItemValue(item),
          extraction_status: item.extraction_status || null,
          evidence_type: item.evidence_type || null,
          maps_to_fixed_field: item.maps_to_fixed_field ?? null,
          creates_dynamic_row: item.creates_dynamic_row ?? null,
          // Phase 44A-Fix: text that is itself the exact evidence Phase 39
          // already rejected as a signature date sourced from the original
          // lease reference (not this document's own execution) must not
          // read as a clean legal summary either - flag it the same way,
          // reusing the same predicate rather than re-deriving the rule.
          requires_review: isSignatureDateSourcedFromLeaseReference(clauseText) || undefined,
        },
      };
    });

  // Phase 44A-Fix: dedup on normalized content (type + title + text), not
  // on an exact key that includes source_page. computeFallbackClauseRows
  // unions 5 separate lease_fields-shaped payload maps (see fieldMapRows
  // above); when the same field appears in two of them, one copy often
  // carries a real source_page and the other doesn't, which used to defeat
  // the old page-inclusive dedup key entirely (Phase 44A audit: 16 of 35
  // rows were exactly this). A short cached copy can also be a truncated
  // prefix of a fuller one from a different map (isNearDuplicateClauseText
  // handles that case) rather than byte-identical. When two rows collide,
  // keep whichever has a real source_page, or the longer text if both/
  // neither do.
  function isNearDuplicateClauseText(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    return shorter.length >= 40 && longer.startsWith(shorter);
  }

  const normalizedDiscovered = discoveredRows.map((row) => ({
    row,
    normalizedTitle: normalizeEvidenceComparable(row.clause_title),
    normalizedText: normalizeEvidenceComparable(row.clause_text),
  }));

  const dedupedDiscovered = [];
  for (const entry of normalizedDiscovered) {
    const existingIndex = dedupedDiscovered.findIndex(
      (candidate) =>
        candidate.row.clause_type === entry.row.clause_type &&
        candidate.normalizedTitle === entry.normalizedTitle &&
        isNearDuplicateClauseText(candidate.normalizedText, entry.normalizedText),
    );
    if (existingIndex === -1) {
      dedupedDiscovered.push(entry);
      continue;
    }
    const existing = dedupedDiscovered[existingIndex];
    const preferEntry =
      (existing.row.source_page == null && entry.row.source_page != null) ||
      existing.normalizedText.length < entry.normalizedText.length;
    if (preferEntry) dedupedDiscovered[existingIndex] = entry;
  }

  return [...clauseRows, ...dedupedDiscovered.map((entry) => entry.row)];
}

/** Phase-6 UI shape, sync/payload-only (no `lease_clauses` DB table rows —
 *  ClauseRecordsTable layers those in separately since that query is async). */
export function normalizeClauseRecords(lease, { profile = resolveCurrentReviewProfile(lease) } = {}) {
  const rows = computeFallbackClauseRows(lease)
    .filter((c) => cleanDocumentItemSource(c.clause_text))
    .filter((c) => shouldKeepClauseRecord(c, { profile }));
  return rows.map((c) => ({
    clauseType: c.clause_type,
    title: c.clause_title,
    summary: c.clause_text,
    sourcePage: c.source_page ?? null,
    sourceText: c.clause_text,
    confidence: c.confidence_score ?? null,
    businessArea: c.structured_fields_json?.display_tab || c.clause_type,
    reviewStatus: c.structured_fields_json?.requires_review || profile === "base_lease" ? "needs_review" : "pending",
  }));
}

// ── CAM / Expense rules ───────────────────────────────────────────────────

function findPageSnippet(lease, pattern, { radius = 560, preferredPagePattern = null } = {}) {
  const pages = readDoclingPages(lease);
  const matches = [];
  for (const page of pages) {
    const match = page.text.match(pattern);
    if (!match) continue;
    let score = 1;
    if (preferredPagePattern?.test(page.text)) score += 5;
    matches.push({ page: page.page, text: page.text, match, index: match.index ?? 0, score });
  }
  const best = matches.sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  return {
    page: best.page,
    sourceText: sourceSnippet(best.text, best.index, radius),
    match: best.match,
  };
}

function findCamEstimateFallback(lease) {
  const found = findPageSnippet(
    lease,
    /CAM\s+estimate(?:\s+for\s+(\d{4}))?\s+is\s+\$([\d,]+(?:\.\d{2})?)\s+per\s+(leasable\s+)?square\s+foot/i,
    { preferredPagePattern: /rent addendum|common area maintenance|CAM estimate/i },
  );
  if (!found) return null;
  const year = found.match[1] || null;
  const amount = moneyNumber(found.match[2]);
  if (amount == null) return null;
  return {
    id: "fallback-cam-estimate",
    rule_key: "fallback_cam_estimate_psf",
    expense_category: "common_area_maintenance_estimate",
    normalized_rule: year
      ? "CAM estimate " + year + ": " + moneyDisplay(amount) + " per leasable square foot"
      : "CAM estimate: " + moneyDisplay(amount) + " per leasable square foot",
    value: moneyDisplay(amount) + " per leasable square foot",
    amount,
    basis: "per_leasable_square_foot",
    recoverable_from_tenant: true,
    recovery_method: "estimate_per_leasable_square_foot",
    source_page: found.page,
    source_text: found.sourceText,
    confidence_score: 0.86,
    review_status: "needs_review",
    requires_review: true,
    source: NO_PROVIDER_FALLBACK_SOURCE,
  };
}

function findProRataExpenseSnippet(lease) {
  return findPageSnippet(
    lease,
    /Pro-rata\s+Share\s+of\s+Real\s+Estate\s+Taxes[\s\S]{0,1400}?Tenant\s+shall\s+pay\s+its\s+Pro-Rata\s+Share[\s\S]{0,160}?expenses/i,
    { preferredPagePattern: /Pro-rata\s+Share\s+of\s+Real\s+Estate\s+Taxes/i, radius: 760 },
  );
}

function buildProRataExpenseRules(lease) {
  const found = findProRataExpenseSnippet(lease);
  if (!found) return [];
  const base = {
    recoverable_from_tenant: true,
    responsible_party: "tenant",
    recovery_method: "pro_rata_share",
    source_page: found.page,
    source_text: found.sourceText,
    confidence_score: 0.84,
    review_status: "needs_review",
    requires_review: true,
    source: NO_PROVIDER_FALLBACK_SOURCE,
  };
  return [
    { ...base, id: "fallback-pro-rata-taxes", rule_key: "fallback_pro_rata_real_estate_taxes", expense_category: "real_estate_taxes", normalized_rule: "Tenant pays pro-rata share of real estate taxes as Additional Rent", value: "Tenant pro-rata share" },
    { ...base, id: "fallback-pro-rata-insurance", rule_key: "fallback_pro_rata_insurance_premiums", expense_category: "insurance_premiums", normalized_rule: "Tenant pays pro-rata share of insurance premiums as Additional Rent", value: "Tenant pro-rata share" },
    { ...base, id: "fallback-pro-rata-cam", rule_key: "fallback_pro_rata_common_area_maintenance", expense_category: "common_area_maintenance", normalized_rule: "Tenant pays pro-rata share of common area maintenance expenses as Additional Rent", value: "Tenant pro-rata share" },
  ];
}

function buildAdminFeeRule(lease) {
  const adminFee = readFieldValue(lease, "admin_fee_pct");
  const numeric = typeof adminFee === "number" ? adminFee : moneyNumber(adminFee);
  if (numeric == null) return null;
  const evidence = readFieldEvidence(lease, "admin_fee_pct");
  const sourceText = evidence?.sourceText || findPageSnippet(
    lease,
    /not\s+to\s+exceed\s+[^.]{0,80}five\s+percent[\s\S]{0,240}?Common\s+Areas/i,
    { preferredPagePattern: /common area maintenance expenses/i },
  )?.sourceText;
  if (!sourceText || !/common areas?|shopping center|management costs/i.test(sourceText)) return null;
  return {
    id: "fallback-admin-fee",
    rule_key: "fallback_admin_fee_pct",
    expense_category: "administrative_fee",
    normalized_rule: "Admin / management fee: " + numeric + "% of rent collected for Common Area operations",
    value: numeric + "%",
    admin_fee_percent: numeric,
    recoverable_from_tenant: true,
    recovery_method: "percentage_of_rent_collected",
    source_page: evidence?.sourcePage ?? evidence?.source_page ?? null,
    source_text: sourceText,
    confidence_score: 0.82,
    review_status: "needs_review",
    requires_review: true,
    source: NO_PROVIDER_FALLBACK_SOURCE,
  };
}

function normalizeNoProviderExpenseRuleFallbacks(lease) {
  return [
    findCamEstimateFallback(lease),
    ...buildProRataExpenseRules(lease),
    buildAdminFeeRule(lease),
  ].filter(Boolean);
}

function expenseRuleComparable(rule) {
  return [
    rule?.expense_category ?? rule?.category ?? rule?.normalized_key ?? rule?.rule_type ?? "unknown",
    rule?.rule_key ?? rule?.id ?? "",
    normalizeComparableText(rule?.normalized_rule ?? rule?.source_text ?? rule?.source_clause ?? rule?.value ?? ""),
  ].join("|");
}

function mergeExpenseRuleInputs(rules, fallbackRules) {
  const merged = [];
  const seen = new Set();
  for (const rule of [...(Array.isArray(rules) ? rules : []), ...(Array.isArray(fallbackRules) ? fallbackRules : [])]) {
    if (!rule || typeof rule !== "object") continue;
    const category = String(rule.expense_category ?? rule.category ?? rule.normalized_key ?? rule.rule_type ?? "unknown").toLowerCase();
    const categoryAlreadyStructured = merged.some((existing) => {
      if (existing?.source === NO_PROVIDER_FALLBACK_SOURCE) return false;
      const existingCategory = String(existing.expense_category ?? existing.category ?? existing.normalized_key ?? existing.rule_type ?? "unknown").toLowerCase();
      return existingCategory === category;
    });
    if (rule.source === NO_PROVIDER_FALLBACK_SOURCE && categoryAlreadyStructured) continue;
    const key = expenseRuleComparable(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(rule);
  }
  return merged;
}

function normalizeRentScheduleFallbackRows(lease) {
  const rows = [];
  for (const page of readDoclingPages(lease)) {
    if (!/rent addendum/i.test(page.text)) continue;
    const rentPattern = /Months?\s*-?\s*(\d{1,3})\s*-\s*(\d{1,3})\s*\$\s*([\d,]+\.\d{2})\s*\$\s*([\d,]+\.\d{2})/gi;
    for (const match of page.text.matchAll(rentPattern)) {
      const startMonth = Number(match[1]);
      const endMonth = Number(match[2]);
      const psf = moneyNumber(match[3]);
      const monthly = moneyNumber(match[4]);
      if (!startMonth || !endMonth || psf == null || monthly == null) continue;
      const sourceText = sourceSnippet(page.text, match.index, 500);
      rows.push({
        rowType: "dynamic",
        typeLabel: "Rent Schedule",
        key: "fallback-rent-schedule-" + startMonth + "-" + endMonth,
        fieldKey: "rent_schedule",
        label: "Rent Addendum Months " + startMonth + "-" + endMonth,
        category: "rent_schedule",
        tabKey: "rent_charges",
        editable: false,
        value: moneyDisplay(monthly) + " per month / " + moneyDisplay(psf) + " PSF",
        normalizedValue: { startMonth, endMonth, monthlyRent: monthly, rentPsf: psf },
        normalized_value: { startMonth, endMonth, monthlyRent: monthly, rentPsf: psf },
        sourcePage: page.page,
        source_page: page.page,
        page_number: page.page,
        sourceText,
        source_text: sourceText,
        confidence: 0.82,
        confidencePercent: normalizeConfidencePercent(0.82),
        status: "needs_review",
        extractionMode: EXTRACTION_MODES.UNKNOWN,
        extraction_mode: EXTRACTION_MODES.UNKNOWN,
        defaultVisible: true,
        advanced: false,
        sourceProvider: NO_PROVIDER_FALLBACK_SOURCE,
      });
    }
  }
  return rows;
}

function normalizeNoProviderDynamicFallbackRows(lease) {
  return normalizeRentScheduleFallbackRows(lease);
}

function mergeDynamicFallbackRows(rows, fallbackRows) {
  const merged = [];
  const seen = new Set();
  for (const row of [...(rows || []), ...(fallbackRows || [])]) {
    const key = [row?.tabKey, row?.category, row?.label, normalizeComparableText(row?.sourceText ?? row?.value ?? "")].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
}

function isCamRule(rule) {
  const category = String(rule?.expense_category ?? rule?.category ?? rule?.normalized_key ?? rule?.rule_type ?? "").toLowerCase();
  return /\bcam\b|common_area|operating_expenses|gross_up|cap|base_year|expense_stop|admin|management|reconciliation|true_up|audit|allocation|pro_rata|proportionate/.test(category)
    || rule?.gross_up_threshold != null
    || rule?.gross_up_percent != null
    || rule?.cam_cap_pct != null
    || rule?.cap_percent != null
    || rule?.admin_fee_percent != null
    || rule?.management_fee_percent != null
    || rule?.tenant_share_percent != null;
}

function normalizeExpenseRuleShape(rule) {
  const camRule = isCamRule(rule);
  const confidence = rule?.confidence_score ?? rule?.confidence ?? null;
  const needsReview = (rule?.review_status ?? rule?.row_status ?? "").toLowerCase() === "needs_review"
    || Boolean(rule?.requires_review);
  const recoverable = rule?.recoverable_from_tenant ?? rule?.recoverable_flag ?? rule?.is_recoverable ?? null;
  const calculationIncomplete = needsReview && recoverable == null;
  const rowValue = rule?.display_value ?? rule?.value ?? rule?.normalized_value ?? rule?.amount ?? null;
  return {
    rowType: camRule ? "cam_rule" : "expense_rule",
    typeLabel: camRule ? "CAM Rule" : "Expense Rule",
    key: rule?.id || rule?.rule_key || `${camRule ? "cam" : "expense"}-${rule?.expense_category ?? rule?.category ?? "rule"}`,
    category: rule?.expense_category ?? rule?.category ?? rule?.normalized_key ?? "unknown",
    label: rule?.normalized_rule || rule?.subcategory_name || rule?.category_name || rule?.expense_category || rule?.category || (camRule ? "CAM rule" : "Expense rule"),
    tabKey: camRule ? "cam_rules" : "expenses_recoveries",
    editable: false,
    value: calculationIncomplete ? "Clause found - calculation needs review" : rowValue,
    normalizedValue: calculationIncomplete ? "Clause found - calculation needs review" : rowValue,
    normalized_value: calculationIncomplete ? "Clause found - calculation needs review" : rowValue,
    amount: rule?.amount ?? null,
    basis: rule?.basis ?? null,
    recoverable,
    responsibleParty: rule?.responsible_party ?? rule?.responsibleParty ?? null,
    allocationMethod: rule?.recovery_method ?? rule?.allocation_method ?? null,
    cap: rule?.cap_percent ?? rule?.cam_cap_pct ?? null,
    floor: rule?.floor_percent ?? rule?.floor ?? null,
    adminFeePercent: rule?.admin_fee_percent ?? rule?.admin_fee_pct ?? null,
    exclusions: rule?.exclusions ?? rule?.excluded_items ?? null,
    sourcePage: rule?.source_page ?? rule?.page_number ?? null,
    source_page: rule?.source_page ?? rule?.page_number ?? null,
    page_number: rule?.source_page ?? rule?.page_number ?? null,
    sourceText: rule?.exact_source_text ?? rule?.source_clause ?? rule?.source_text ?? null,
    source_text: rule?.exact_source_text ?? rule?.source_clause ?? rule?.source_text ?? null,
    confidence,
    confidencePercent: normalizeConfidencePercent(confidence),
    status: normalizeRowStatus(rule?.review_status || rule?.row_status || rule?.status, "needs_review"),
    needsReview,
    // Phase 40: expense/CAM rule rows don't carry the same structured
    // extraction-status/evidence-quality metadata standard fields do (see
    // normalizeDynamicFindings above for the same reasoning) - unknown
    // rather than a guessed mode.
    extractionMode: EXTRACTION_MODES.UNKNOWN,
    extraction_mode: EXTRACTION_MODES.UNKNOWN,
    defaultVisible: true,
    advanced: false,
  };
}

/** Rich path: already-loaded, already-normalized DB expense-rule rows (via
 *  leaseExpenseRuleService.loadRuleSet()/normalizeLeaseExpenseRule(), the
 *  same service ExpenseRulesTable/CamRulesTable already use) — reused, not
 *  reimplemented. Call this with the rows your data hook already loaded. */
export function normalizeExpenseRuleRows(rules) {
  return (Array.isArray(rules) ? rules : []).map(normalizeExpenseRuleShape);
}

/** Sync-only fallback (workflow_output.expense_rules), for contexts with no
 *  DB query available (debug counts, tests) — mirrors what ExpenseRulesTable
 *  itself falls back to when the lease_expense_rules table is empty. */
export function normalizeExpenseRuleFallback(lease) {
  const rawWorkflowOutput = lease?.extraction_data?.workflow_output || {};
  const workflowOutput = rawWorkflowOutput.workflow_output || rawWorkflowOutput;
  const rules = workflowOutput?.expense_rules;
  const fallbackRules = normalizeNoProviderExpenseRuleFallbacks(lease);
  return normalizeExpenseRuleRows(mergeExpenseRuleInputs(rules, fallbackRules));
}

// ── Critical dates ────────────────────────────────────────────────────────

const CRITICAL_DATE_KEYS = [
  "lease_date",
  "commencement_date",
  "rent_commencement_date",
  "expiration_date",
  "renewal_notice_months",
  "termination_notice_months",
  "option_exercise_deadline",
];

/** The fixed CriticalDatesTable checklist, sourced from the already-computed
 *  standardFields rows (no re-resolution) for parity with the existing table. */
export function normalizeCriticalDates(standardFields) {
  const byKey = new Map(standardFields.map((row) => [row.canonicalKey, row]));
  return CRITICAL_DATE_KEYS.map((key) => byKey.get(key)).filter(Boolean);
}

// ── Advisory approval blockers ────────────────────────────────────────────

function readDocumentProfile(lease) {
  const rawWorkflowOutput = lease?.extraction_data?.workflow_output || {};
  const workflowOutput = rawWorkflowOutput.workflow_output || rawWorkflowOutput;
  return workflowOutput?.document_profile ?? workflowOutput?.selected_document_profile ?? null;
}

function readServerApprovalBlockers(lease) {
  const ufPayload = lease?.uploaded_files?.ui_review_payload || lease?.uploaded_file?.ui_review_payload || null;
  const fromTopLevel = ufPayload?.approval_blockers;
  const fromOpenAI = ufPayload?.metadata?.extractionDebug?.openai_fact_ledger?.approval_blockers
    ?? ufPayload?.metadata?.extractionDebug?.vertex_fact_ledger?.approval_blockers;
  const rawWorkflowOutput = lease?.extraction_data?.workflow_output || {};
  const workflowOutput = rawWorkflowOutput.workflow_output || rawWorkflowOutput;
  const fromWorkflow = workflowOutput?.approval_blockers;
  const list = fromTopLevel ?? fromOpenAI ?? fromWorkflow ?? null;
  return Array.isArray(list) ? list : null;
}

/**
 * Advisory-only, never enforced. Prefers real backend-computed blockers
 * (populated under openai_fact_ledger, with legacy vertex_fact_ledger fallback)
 * and falls back to a client-side, clearly-labeled estimate built purely
 * from field-contract requiredByDocumentProfile flags against the
 * already-normalized standardFields — so this section shows real,
 * profile-aware content for legacy_hybrid leases too, without inventing any
 * new backend logic or enforcing anything.
 */
export function normalizeApprovalBlockers(lease, standardFields, currentReviewPolicy = null) {
  const documentProfile = currentReviewPolicy?.profile || readDocumentProfile(lease);
  const serverBlockers = readServerApprovalBlockers(lease);

  if (serverBlockers) {
    return {
      documentProfile,
      source: "server",
      missingFields: serverBlockers.map((b) => b.fieldKey ?? b.field_key ?? b.label ?? String(b)),
      warnings: currentReviewPolicy?.advisoryGaps?.map((gap) => gap.detail || gap.title).filter(Boolean) || [],
      budgetBlockers: [],
      camBlockers: [],
    };
  }

  // Client-side advisory estimate: use the current-review policy when it
  // exists so assignment documents do not inherit field-contract hard blockers
  // that the profile-aware policy intentionally downgraded to advisory.
  const byKey = new Map(standardFields.map((row) => [row.canonicalKey, row]));
  const policyRequiredKeys = Array.isArray(currentReviewPolicy?.requiredFieldKeys)
    ? currentReviewPolicy.requiredFieldKeys
    : null;
  const policyRequiredKeySet = policyRequiredKeys ? new Set(policyRequiredKeys) : null;
  const missingFields = [];
  const budgetBlockers = [];
  const camBlockers = [];
  for (const contract of LEASE_FIELD_CONTRACT) {
    if (!contract.inLeaseSchema || contract.computed) continue;
    const appliesToProfile = policyRequiredKeySet
      ? policyRequiredKeySet.has(contract.canonicalKey)
      : (documentProfile ? contract.requiredByDocumentProfile?.includes(documentProfile) : false);
    const row = byKey.get(contract.canonicalKey);
    // Phase 39: same narrow carve-out as hasRowValue() above - a required
    // field whose value was rejected as an invalid layout/markup artifact
    // must not become a NEW blocker as a side effect of that display fix.
    const hasValue = row ? (isMeaningfulValue(row.value) || row.invalidValueRejected === true) : false;
    if (appliesToProfile && !hasValue) missingFields.push(contract.canonicalKey);
    if (currentReviewPolicy?.applyBaseLeaseBlockers !== false) {
      if (contract.requiredForBudget && !hasValue) budgetBlockers.push(contract.canonicalKey);
      if (contract.requiredForCam && !hasValue) camBlockers.push(contract.canonicalKey);
    }
  }
  if (policyRequiredKeys) {
    for (const key of policyRequiredKeys) {
      // Phase 39: same narrow invalidValueRejected carve-out as above -
      // this supplementary pass covers policy-required keys not iterated by
      // LEASE_FIELD_CONTRACT above and must not re-add a rejected-artifact
      // field as a blocker either.
      // Phase 46: resolve through requiredFieldHasValue() so a legacy key
      // name (e.g. premises_address) is satisfied by its populated,
      // evidence-backed canonical alias (e.g. property_address) - see
      // requiredFieldHasValue() above.
      const policyHasValue = requiredFieldHasValue(byKey, key);
      if (!missingFields.includes(key) && !policyHasValue) {
        missingFields.push(key);
      }
    }
  }

  return {
    documentProfile,
    source: "client_estimate",
    missingFields,
    warnings: currentReviewPolicy?.advisoryGaps?.length
      ? currentReviewPolicy.advisoryGaps.map((gap) => gap.detail || gap.title).filter(Boolean)
      : (documentProfile ? [] : ["Document profile not classified - advisory estimate uses no profile filter (all fields advisory)."]),
    budgetBlockers,
    camBlockers,
  };
}

// ── Debug counts ───────────────────────────────────────────────────────────

export function buildRowsByTab({ standardFields, dynamicFindings, expenseRules, camRules, clauseRecords, criticalDates }) {
  const tabs = LEASE_REVIEW_CANONICAL_TABS.reduce((acc, tab) => {
    acc[tab.key] = [];
    return acc;
  }, {});

  const toReadOnlyReference = (row, tabKey) => ({
    ...row,
    rowType: "read_only_reference",
    typeLabel: "Reference",
    tabKey,
    editable: false,
    key: `${row.canonicalKey}-${tabKey}-reference`,
  });

  for (const row of standardFields) {
    if (tabs[row.tabKey]) tabs[row.tabKey].push(row);
    for (const refTab of row.readOnlyReferences || []) {
      if (tabs[refTab]) tabs[refTab].push(toReadOnlyReference(row, refTab));
    }
  }
  for (const row of dynamicFindings) if (tabs[row.tabKey]) tabs[row.tabKey].push(row);
  for (const row of expenseRules) tabs.expenses_recoveries.push(row);
  for (const row of camRules) tabs.cam_rules.push(row);

  for (const row of clauseRecords) {
    tabs.clause_records.push({
      rowType: "clause",
      typeLabel: "Clause",
      key: `${row.clauseType}-${row.sourcePage ?? "unknown"}-${String(row.summary || "").slice(0, 24)}`,
      label: row.title || row.clauseType,
      tabKey: "clause_records",
      editable: false,
      value: row.summary,
      normalizedValue: row.summary,
      normalized_value: row.summary,
      status: row.reviewStatus || "pending",
      confidence: row.confidence,
      confidencePercent: normalizeConfidencePercent(row.confidence),
      sourcePage: row.sourcePage,
      source_page: row.sourcePage,
      page_number: row.sourcePage,
      sourceText: row.sourceText,
      source_text: row.sourceText,
      // Phase 40: clause records are legal summaries, not field extractions -
      // same reasoning as normalizeDynamicFindings above, unknown rather
      // than a guessed mode.
      extractionMode: EXTRACTION_MODES.UNKNOWN,
      extraction_mode: EXTRACTION_MODES.UNKNOWN,
      defaultVisible: true,
    });
  }

  for (const row of criticalDates) {
    if (!tabs.critical_dates.some((existing) => existing.canonicalKey === row.canonicalKey)) {
      tabs.critical_dates.push(toReadOnlyReference(row, "critical_dates"));
    }
  }
  return tabs;
}

export function buildReadinessSummary({ standardFields, dynamicFindings, expenseRules, camRules, clauseRecords, criticalDates, approvalBlockers, tabs, currentReviewPolicy }) {
  const requiredKeys = currentReviewPolicy?.requiredFieldKeys || REQUIRED_FIELD_KEYS;
  const requiredKeySet = new Set(requiredKeys);
  const byKey = new Map(standardFields.map((row) => [row.canonicalKey, row]));
  // Phase 46: same alias-aware lookup as normalizeApprovalBlockers, so this
  // independent missing-required-fields computation doesn't reproduce the
  // same legacy-key-name false positive (e.g. premises_address vs.
  // property_address).
  const missingRequired = requiredKeys.filter((key) => !requiredFieldHasValue(byKey, key));
  const needsReview = standardFields.filter((row) => row.status === "needs_review" || row.status === "manual_required");
  const sourceBacked = standardFields.filter((row) => row.evidenceVerified);
  const tabSummaries = LEASE_REVIEW_CANONICAL_TABS.map((tab) => {
    const rows = tabs?.[tab.key] || [];
    const standardRows = rows.filter((row) => row.rowType === "standard");
    return {
      key: tab.key,
      label: tab.label,
      rows: rows.length,
      complete: standardRows.filter(hasRowValue).length,
      totalStandard: standardRows.length,
      missingRequired: standardRows.filter((row) => requiredKeySet.has(row.canonicalKey) && !hasRowValue(row)).length,
      needsReview: rows.filter((row) => row.status === "needs_review" || row.status === "manual_required").length,
    };
  });

  return {
    approvalReadiness: missingRequired.length === 0 && needsReview.length === 0 ? "ready" : "needs_review",
    budgetReadiness: approvalBlockers.budgetBlockers.length === 0 ? "ready" : "blocked",
    camReadiness: approvalBlockers.camBlockers.length === 0 ? "ready" : "needs_review",
    expenseRulesReadiness: expenseRules.length > 0 ? "needs_review" : "no_rules_found",
    missingRequiredFields: missingRequired,
    budgetMissingInputsCount: approvalBlockers.budgetBlockers.length,
    needsReviewFields: needsReview.map((row) => row.canonicalKey),
    sourceBackedCount: sourceBacked.length,
    dynamicRowsCount: dynamicFindings.length,
    expenseRulesCount: expenseRules.length,
    camRulesCount: camRules.length,
    clauseRecordsCount: clauseRecords.length,
    criticalDatesCount: criticalDates.length,
    tabSummaries,
  };
}

export function buildDebugCounts({ standardFields, dynamicFindings, clauseRecords, expenseRules, camRules = [], criticalDates, approvalBlockers, tabs = {} }) {
  const visibleRows = Object.values(tabs).flat();
  return {
    standard_fields_total: standardFields.length,
    standard_fields_populated: standardFields.filter((f) => isMeaningfulValue(f.value)).length,
    standard_fields_source_backed: standardFields.filter((f) => f.evidenceVerified).length,
    standard_fields_missing: standardFields.filter((f) => !isMeaningfulValue(f.value)).length,
    standard_fields_needs_review: standardFields.filter((f) => f.status === "needs_review" || f.status === "manual_required").length,
    dynamic_rows_count: dynamicFindings.length,
    dynamic_findings_count: dynamicFindings.length,
    clause_records_count: clauseRecords.length,
    expense_rules_count: expenseRules.length,
    cam_rules_count: camRules.length,
    critical_dates_count: criticalDates.length,
    visible_rows_count: visibleRows.length,
    approval_blockers_count: approvalBlockers.missingFields.length + approvalBlockers.warnings.length,
  };
}

// Top-level -----------------------------------------------------------------

/**
 * The single normalized view of a lease's review data. Synchronous -
 * DB-backed data (lease_clauses table rows, lease_expense_rules table rows)
 * is NOT included here; those stay in their existing async react-query hooks
 * and get layered on top by the components that already load them.
 */
export function normalizeLeaseReviewData(lease, { fieldReviews } = {}) {
  const effectiveFieldReviews = fieldReviews ?? lease?.extraction_data?.field_reviews ?? {};
  const standardFields = normalizeStandardFields(lease, { fieldReviews: effectiveFieldReviews });
  const currentReviewPolicy = buildCurrentReviewPolicy(lease, {
    rows: standardFields,
    fieldReviews: effectiveFieldReviews,
    legacyRequiredFieldKeys: REQUIRED_FIELD_KEYS,
  });
  const dynamicFindings = normalizeDynamicFindings(lease);
  const clauseRecords = normalizeClauseRecords(lease, { profile: currentReviewPolicy.profile });
  const allRuleRows = normalizeExpenseRuleFallback(lease);
  const expenseRules = allRuleRows.filter((row) => row.rowType !== "cam_rule");
  const camRules = allRuleRows.filter((row) => row.rowType === "cam_rule");
  const criticalDates = normalizeCriticalDates(standardFields);
  const approvalBlockers = normalizeApprovalBlockers(lease, standardFields, currentReviewPolicy);
  const tabs = buildRowsByTab({ standardFields, dynamicFindings, expenseRules, camRules, clauseRecords, criticalDates });
  const readinessSummary = buildReadinessSummary({ standardFields, dynamicFindings, expenseRules, camRules, clauseRecords, criticalDates, approvalBlockers, tabs, currentReviewPolicy });
  const budgetPreview = tabs.budget_preview || [];
  const debugCounts = buildDebugCounts({ standardFields, dynamicFindings, clauseRecords, expenseRules, camRules, criticalDates, approvalBlockers, tabs });

  return {
    readinessSummary,
    tabs,
    standardFields,
    dynamicFindings,
    clauseRecords,
    expenseRules,
    camRules,
    criticalDates,
    approvalBlockers,
    currentReviewPolicy,
    budgetPreview,
    debugCounts,
  };
}
