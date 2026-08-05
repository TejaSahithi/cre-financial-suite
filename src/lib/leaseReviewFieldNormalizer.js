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
import { validateFieldValue, validateFieldEvidenceSupport } from "@/components/lease-review/utils/fieldValidator";
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

const CLAUSE_RECORD_ONLY_DYNAMIC_KEYS = new Set([
  "tax", "taxes", "insurance", "utilities", "utility", "repairs", "maintenance", "repairs_maintenance",
  "parking", "security", "percentage_rent", "notices", "notice", "condemnation", "signage",
  "alterations", "compliance_laws", "subordination_estoppel", "use_prohibited", "uses_prohibited",
]);

function normalizeDynamicReviewKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isClauseRecordOnlyDynamicItem(item) {
  const rawKey = item?.field_key || item?.key || item?.item_type || item?.clause_type || item?.business_area || "";
  const key = normalizeDynamicReviewKey(rawKey);
  const strippedKey = key.replace(/^clause_/, "");
  const sourceName = String(item?.extraction_method || item?.item_id || item?.id || "").toLowerCase();
  if (sourceName === "whole_document_llm_v2") return false;
  if (sourceName.startsWith("clause:")) return true;
  if (!CLAUSE_RECORD_ONLY_DYNAMIC_KEYS.has(strippedKey)) return false;
  const value = item?.normalized_value ?? item?.normalizedValue ?? item?.value ?? item?.raw_value ?? item?.rawValue ?? null;
  const sourceText = item?.source_text ?? item?.exact_source_text ?? item?.source_clause ?? item?.clause_text ?? "";
  const operativeClauseOnly = key.startsWith("clause_")
    && (value === null || value === undefined || value === "")
    && /\b(?:tenant|landlord)\s+(?:shall|must|will|agrees?|is\s+responsible)\b/i.test(String(sourceText || ""));
  return !operativeClauseOnly;
}

function compactText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function isParagraphLikeReviewValue(value) {
  const text = compactText(value);
  if (!text) return false;
  if (text.length > 220) return true;
  if ((text.match(/[.!?]\s+/g) || []).length >= 2) return true;
  return text.length > 120 && /\b(?:this lease|tenant shall|landlord shall|hereby|provided however|notwithstanding|subject to|pursuant to)\b/i.test(text);
}

function clauseValueLabel(row) {
  const text = compactText(row?.summary || row?.sourceText);
  if (!text) return "Supporting clause";
  const sentence = text.match(/^[^.!?]{1,220}[.!?]?/)?.[0] || text;
  return sentence.length > 140 ? `${sentence.slice(0, 139).trimEnd()}...` : sentence;
}

const CLAUSE_DOMAIN_TAB_RULES = [
  { tabKey: "parties_premises", pattern: /premises|demised|suite|unit|floor|parking|signage|use|exclusive use|common area description/i },
  { tabKey: "rent_charges", pattern: /rent|minimum rent|base rent|additional rent|deposit|fee|charge|allowance|abatement|holdover|late/i },
  { tabKey: "expenses_recoveries", pattern: /expense|recover|reimburse|gross|net|triple|pro rata|operating/i },
  { tabKey: "cam_rules", pattern: /\bcam\b|common area maintenance|management fee|admin fee|gross.?up|cap|expense stop|base year/i },
  { tabKey: "taxes", pattern: /tax|assessment|levy|appeal|protest/i },
  { tabKey: "insurance", pattern: /insurance|insured|liability|subrogation|certificate|deductible/i },
  { tabKey: "utilities", pattern: /utilit|electric|water|sewer|gas|hvac|trash|meter/i },
  { tabKey: "repairs_maintenance", pattern: /repair|maintenance|hvac|roof|structural|janitorial|landscap|snow|pest/i },
  { tabKey: "legal_options", pattern: /assign|sublet|sublease|consent|option|renewal|termination|default|remed|surrender|exclusive|estoppel|snda|subordination|indemn|casualty|condemnation|alteration|hazardous/i },
  { tabKey: "critical_dates", pattern: /deadline|critical date|commencement|expiration|notice period|must open/i },
  { tabKey: "notices", pattern: /notice|mail|courier|address|copy to|email/i },
  { tabKey: "signatures", pattern: /signature|signatory|signed|execution|counterpart/i },
  { tabKey: "documents_exhibits", pattern: /exhibit|document|guaranty|work letter|site plan|attached|schedule/i },
];

function routeClauseRecordToDomainTab(row) {
  const explicit = row?.businessArea || row?.business_area || row?.display_tab || row?.tabKey;
  if (explicit && LEASE_REVIEW_CANONICAL_TABS.some((tab) => tab.key === explicit) && explicit !== "clause_records") return explicit;
  const text = [row?.title, row?.clauseType, row?.summary, row?.sourceText].filter(Boolean).join(" ");
  const matched = CLAUSE_DOMAIN_TAB_RULES.find((rule) => rule.pattern.test(text));
  return matched?.tabKey || null;
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

function toIsoDate(value) {
  if (!isMeaningfulValue(value)) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value ?? "").trim();
  if (!text) return null;
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const us = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (us) {
    const [, month, day, year] = us;
    const yyyy = year.length === 2 ? (Number(year) > 50 ? `19${year}` : `20${year}`) : year;
    return `${yyyy}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())).toISOString().slice(0, 10);
}

function parseLeaseTermMonths(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  const text = String(value ?? "").toLowerCase();
  if (!text) return null;
  const numeric = moneyNumber(text);
  if (numeric && /^\s*\d{1,3}\s*$/.test(text)) return Math.round(numeric);
  const years = text.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\b/);
  if (years) return Math.round(Number(years[1]) * 12);
  const months = text.match(/(\d+(?:\.\d+)?)\s*(?:months?|mos?)\b/);
  if (months) return Math.round(Number(months[1]));
  const writtenMonths = text.match(/\b(?:initial\s+|base\s+)?(?:term|period)[\s\S]{0,80}?\((\d{1,3})\)\s*months?\b/);
  if (writtenMonths) return Number(writtenMonths[1]);
  if (/\byear\s*to\s*year\b|\bannual(?:ly)?\b|\bone\s+year\b/.test(text)) return 12;
  return null;
}

function addMonthsInclusiveEnd(startIso, months) {
  if (!startIso || !Number.isFinite(months) || months <= 0) return null;
  const start = new Date(`${startIso}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  const targetIndex = start.getUTCMonth() + Math.round(months);
  const targetYear = start.getUTCFullYear() + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const targetDay = Math.min(
    start.getUTCDate(),
    new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate(),
  );
  const end = new Date(Date.UTC(targetYear, targetMonth, targetDay));
  end.setUTCDate(end.getUTCDate() - 1);
  return Number.isNaN(end.getTime()) ? null : end.toISOString().slice(0, 10);
}

function deriveTermMonthsFromDates(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  const inclusiveEnd = new Date(end);
  inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() + 1);
  const months =
    (inclusiveEnd.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (inclusiveEnd.getUTCMonth() - start.getUTCMonth());
  if (months <= 0) return null;
  return Math.round(months);
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

function normalizePlaceholderComparable(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isFieldLabelPlaceholderValue(canonicalKey, value, contract) {
  const normalizedValue = normalizePlaceholderComparable(value);
  if (!normalizedValue) return false;
  const labelCandidates = new Set([
    canonicalKey,
    titleize(canonicalKey),
    contract?.label,
    contract?.displayLabel,
    ...(Array.isArray(contract?.aliases) ? contract.aliases : []),
    ...getFieldAliases(canonicalKey),
  ].filter(Boolean).map(normalizePlaceholderComparable));
  return labelCandidates.has(normalizedValue);
}

const REVIEW_STREET_ADDRESS_PATTERN = /\b\d{1,6}\s+[A-Z0-9][A-Za-z0-9.'#\-]*(?:\s+[A-Z0-9][A-Za-z0-9.'#\-]*){0,8}\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Lane|Ln\.?|Way|Parkway|Pkwy\.?|Highway|Hwy\.?|Court|Ct\.?|Circle|Cir\.?|Trail|Terrace|Ter\.?|Place|Pl\.?|Center)\b(?:\s*,\s*[^.;\n]{2,80})?/i;
const REVIEW_MONTH_DATE_PATTERN = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?\s*,\s*\d{4}\b/i;

function recoveryEvidenceText(evidence) {
  const uniqueParts = [];
  const seen = new Set();
  for (const part of [
    evidence?.sourceText,
    evidence?.source_text,
    evidence?.sourceClause,
    evidence?.source_clause,
    evidence?.rawValue,
    evidence?.raw_value,
  ]) {
    const text = compactText(part);
    if (!text) continue;
    const comparable = normalizePlaceholderComparable(text);
    if (seen.has(comparable)) continue;
    seen.add(comparable);
    uniqueParts.push(text);
  }
  return compactText(uniqueParts.join(" "));
}

function cleanRecoveredAddress(value) {
  const text = compactText(value);
  if (!text) return null;
  return text
    .replace(/\s+\b(?:for the lease|the notice address|landlord|tenant|assignee|assignor)\b[\s\S]*$/i, "")
    .replace(/[),.;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function propertyAddressEvidenceIsWrongPartyAddress(evidence) {
  const text = recoveryEvidenceText(evidence);
  if (!text) return false;
  const premisesContext = /\b(?:premises|demised premises|leased premises|lease of approximately|located at|located in|property located|shopping center known as)\b/i.test(text);
  if (premisesContext) return false;
  return /\b(?:tenant contact|tenant information|tenant address|landlord address|notice address|assignee address|assignor address|mailing address)\b/i.test(text);
}

function recoverDateFromSourceText(text) {
  const explicitMonthDate = text.match(REVIEW_MONTH_DATE_PATTERN)?.[0];
  return toIsoDate(explicitMonthDate || text);
}

function isLabelOnlyDynamicValue(label, value, key = null) {
  const normalizedValue = normalizePlaceholderComparable(value);
  if (!normalizedValue) return false;
  const candidates = [label, key, titleize(key)].filter(Boolean).map(normalizePlaceholderComparable);
  return candidates.includes(normalizedValue);
}
function recoverStandardValueFromEvidence(canonicalKey, evidence) {
  const text = recoveryEvidenceText(evidence);
  if (!text) return null;

  if (canonicalKey === "property_address") {
    if (propertyAddressEvidenceIsWrongPartyAddress(evidence)) return null;
    if (!/\b(?:premises|demised premises|leased premises|lease of approximately|located at|located in|property located|shopping center known as)\b/i.test(text)) return null;
    return cleanRecoveredAddress(text.match(REVIEW_STREET_ADDRESS_PATTERN)?.[0]);
  }

  if (canonicalKey === "assignee_notice_address" || canonicalKey.endsWith("_address")) {
    return cleanRecoveredAddress(text.match(REVIEW_STREET_ADDRESS_PATTERN)?.[0]);
  }

  if (canonicalKey === "expiration_date" || canonicalKey === "end_date" || canonicalKey.endsWith("_date")) {
    return recoverDateFromSourceText(text);
  }

  if (canonicalKey === "square_footage" || canonicalKey === "building_rsf") {
    const match = text.match(/\b([0-9][0-9,]*(?:\.\d+)?)\s*(?:rentable\s+)?(?:square\s*feet|sq\.?\s*ft\.?|sf|rsf)\b/i);
    if (!match) return null;
    const parsed = Number(String(match[1]).replace(/,/g, ""));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  if (/amount|deposit|rent|fee|allowance/i.test(canonicalKey)) {
    const amount = moneyNumber(text);
    return amount != null && amount > 0 ? amount : null;
  }

  return null;
}
function standardFieldFallback(lease, canonicalKey, { value, evidence, allowNoProviderCoreFallbacks = false } = {}) {
  if (!allowNoProviderCoreFallbacks) return null;
  if (canonicalKey === "property_address") {
    return findPremisesAddressFallback(lease, value, evidence);
  }
  if (canonicalKey === "security_deposit" && !isMeaningfulValue(value)) {
    return findSecurityDepositFallback(lease);
  }
  return null;
}

function deriveLeaseTermContext(lease) {
  const commencement =
    toIsoDate(readTypedLeaseColumnValue(lease, "commencement_date"))
    || toIsoDate(readTypedLeaseColumnValue(lease, "start_date"))
    || toIsoDate(readFieldValue(lease, "commencement_date"))
    || toIsoDate(readFieldValue(lease, "start_date"));
  const existingExpiration =
    toIsoDate(readTypedLeaseColumnValue(lease, "expiration_date"))
    || toIsoDate(readTypedLeaseColumnValue(lease, "end_date"))
    || toIsoDate(readFieldValue(lease, "expiration_date"))
    || toIsoDate(readFieldValue(lease, "end_date"));
  const expirationEvidence = readFieldEvidence(lease, "expiration_date");
  const endEvidence = readFieldEvidence(lease, "end_date");
  const termValue =
    readTypedLeaseColumnValue(lease, "lease_term_months")
    ?? readTypedLeaseColumnValue(lease, "lease_term")
    ?? readFieldValue(lease, "lease_term_months")
    ?? readFieldValue(lease, "lease_term");
  const leaseTermEvidence = readFieldEvidence(lease, "lease_term_months");
  const leaseTermTextEvidence = readFieldEvidence(lease, "lease_term");
  const termText = [
    termValue,
    leaseTermEvidence?.sourceText,
    leaseTermEvidence?.sourceClause,
    leaseTermEvidence?.rawValue,
    leaseTermTextEvidence?.sourceText,
    leaseTermTextEvidence?.sourceClause,
    leaseTermTextEvidence?.rawValue,
  ].filter(Boolean).join(" ");
  const existingTermMonths = parseLeaseTermMonths(termValue) || parseLeaseTermMonths(termText);
  // A recurring month/day is an anniversary label, not the final lease
  // expiration. The final year can only be established from an explicit
  // expiration date or an independently sourced initial-term length.
  const derivedExpiration = !existingExpiration && commencement && existingTermMonths
    ? addMonthsInclusiveEnd(commencement, existingTermMonths)
    : null;
  const derivedTermMonths = !existingTermMonths && commencement && existingExpiration
    ? deriveTermMonthsFromDates(commencement, existingExpiration)
    : null;

  return {
    commencement,
    existingExpiration,
    derivedExpiration,
    expirationEvidence: expirationEvidence?.sourceText || expirationEvidence?.sourceClause ? expirationEvidence : endEvidence,
    existingTermMonths,
    derivedTermMonths,
  };
}

function derivedStandardField(lease, canonicalKey, value, termContext) {
  if (isMeaningfulValue(value)) return null;
  if ((canonicalKey === "expiration_date" || canonicalKey === "end_date") && termContext?.derivedExpiration) {
    const evidence = readFieldEvidence(lease, "lease_term_months")
      || readFieldEvidence(lease, "lease_term")
      || termContext.expirationEvidence
      || {};
    return {
      value: termContext.derivedExpiration,
      confidence: 0.9,
      reviewReason: "Expiration date was calculated from the approved commencement date and stated initial lease term. Verify both source inputs before approval.",
      evidence: {
        value: termContext.derivedExpiration,
        rawValue: termContext.derivedExpiration,
        sourcePage: evidence.sourcePage ?? null,
        sourceText: evidence.sourceText ?? evidence.sourceClause ?? null,
        sourceClause: evidence.sourceClause ?? evidence.sourceText ?? null,
        extractionStatus: EXTRACTION_STATUSES.CALCULATED,
        evidenceType: "derived",
        sourceTextQuality: SOURCE_TEXT_QUALITIES.DERIVED,
        sourceFieldKeys: ["commencement_date", "lease_term_months"],
        derivationTrace: `expiration_date = commencement_date ${termContext.commencement} + lease_term_months ${termContext.existingTermMonths} - 1 day`,
        requiresReview: true,
        reviewReason: "Calculated from commencement date and the independently extracted initial lease term.",
      },
    };
  }
  if (canonicalKey === "lease_term_months" && termContext?.derivedTermMonths) {
    const evidence = termContext.expirationEvidence || {};
    return {
      value: termContext.derivedTermMonths,
      confidence: 0.8,
      reviewReason: "Lease term months were derived from commencement and expiration dates. Verify before approval.",
      evidence: {
        value: termContext.derivedTermMonths,
        rawValue: String(termContext.derivedTermMonths),
        sourcePage: evidence.sourcePage ?? null,
        sourceText: evidence.sourceText ?? evidence.sourceClause ?? null,
        sourceClause: evidence.sourceClause ?? evidence.sourceText ?? null,
        extractionStatus: EXTRACTION_STATUSES.CALCULATED,
        evidenceType: "derived",
        sourceTextQuality: SOURCE_TEXT_QUALITIES.DERIVED,
        sourceFieldKeys: ["commencement_date", "expiration_date"],
        derivationTrace: `lease_term_months = months between ${termContext.commencement} and ${termContext.existingExpiration || termContext.derivedExpiration}`,
        requiresReview: true,
      },
    };
  }
  if (canonicalKey === "monthly_rent") {
    const annualRentValue = readTypedLeaseColumnValue(lease, "annual_rent") ?? readFieldValue(lease, "annual_rent");
    const annualRent = moneyNumber(annualRentValue);
    if (annualRent != null && annualRent > 0) {
      const evidence = readFieldEvidence(lease, "annual_rent") || {};
      const monthlyRent = annualRent / 12;
      return {
        value: monthlyRent,
        confidence: 0.86,
        reviewReason: "Monthly rent was calculated from annual rent divided by 12. Verify the payment schedule before approval.",
        evidence: {
          value: monthlyRent,
          rawValue: moneyDisplay(monthlyRent),
          sourcePage: evidence.sourcePage ?? null,
          sourceText: evidence.sourceText ?? evidence.sourceClause ?? null,
          sourceClause: evidence.sourceClause ?? evidence.sourceText ?? null,
          extractionStatus: EXTRACTION_STATUSES.CALCULATED,
          evidenceType: "derived",
          sourceTextQuality: SOURCE_TEXT_QUALITIES.DERIVED,
          sourceFieldKeys: ["annual_rent"],
          derivationTrace: `monthly_rent = annual_rent ${moneyDisplay(annualRent) || annualRent} / 12`,
          requiresReview: true,
        },
      };
    }
  }
  if (canonicalKey === "annual_rent") {
    const monthlyRentValue = readTypedLeaseColumnValue(lease, "monthly_rent") ?? readFieldValue(lease, "monthly_rent");
    const monthlyRent = moneyNumber(monthlyRentValue);
    if (monthlyRent != null && monthlyRent > 0) {
      const evidence = readFieldEvidence(lease, "monthly_rent") || {};
      const annualRent = monthlyRent * 12;
      return {
        value: annualRent,
        confidence: 0.88,
        reviewReason: "Annual rent was calculated from monthly rent multiplied by 12.",
        evidence: {
          value: annualRent,
          rawValue: moneyDisplay(annualRent),
          sourcePage: evidence.sourcePage ?? null,
          sourceText: evidence.sourceText ?? evidence.sourceClause ?? null,
          sourceClause: evidence.sourceClause ?? evidence.sourceText ?? null,
          extractionStatus: EXTRACTION_STATUSES.CALCULATED,
          evidenceType: "derived",
          sourceTextQuality: SOURCE_TEXT_QUALITIES.DERIVED,
          sourceFieldKeys: ["monthly_rent"],
          derivationTrace: `annual_rent = monthly_rent ${moneyDisplay(monthlyRent) || monthlyRent} * 12`,
          requiresReview: true,
        },
      };
    }
  }
  return null;
}

const GROSS_INCLUDED_NO_SEPARATE_CHARGE_KEYS = new Set([
  "base_year",
  "expense_stop",
  "cam_amount",
  "cam_cap_type",
  "cam_cap_pct",
  "admin_fee_pct",
  "management_fee_basis",
  "gross_up_enabled",
  "gross_up_threshold",
]);

function grossLeaseNoSeparateChargeField(lease, canonicalKey, value) {
  if (isMeaningfulValue(value) || !GROSS_INCLUDED_NO_SEPARATE_CHARGE_KEYS.has(canonicalKey)) return null;
  const leaseTypeValue = readFieldValue(lease, "lease_type") ?? readTypedLeaseColumnValue(lease, "lease_type");
  const leaseTypeText = String(leaseTypeValue ?? "").toLowerCase();
  if (!/\b(?:gross|full[_\s-]?service)\b/.test(leaseTypeText)) return null;
  const leaseTypeEvidence = readFieldEvidence(lease, "lease_type") || {};
  const camTreatmentEvidence = readFieldEvidence(lease, "cam_treatment") || {};
  const sourceText = camTreatmentEvidence.sourceText
    || camTreatmentEvidence.sourceClause
    || leaseTypeEvidence.sourceText
    || leaseTypeEvidence.sourceClause
    || `Lease type is ${leaseTypeValue}; no separate ${titleize(canonicalKey)} was extracted.`;
  return {
    value: null,
    displayValue: "N/A - included in rent / no separate charge extracted",
    status: "not_applicable",
    confidence: Math.max(readFieldConfidence(lease, "lease_type") ?? 0.7, 0.7),
    reviewReason: "Gross/full-service lease: no separate numeric charge was extracted for this rule row.",
    evidence: {
      rawValue: null,
      sourcePage: camTreatmentEvidence.sourcePage ?? leaseTypeEvidence.sourcePage ?? null,
      sourceText,
      sourceClause: sourceText,
      extractionStatus: EXTRACTION_STATUSES.NOT_FOUND,
      evidenceType: "derived",
      sourceTextQuality: SOURCE_TEXT_QUALITIES.DERIVED,
      sourceFieldKeys: ["lease_type", "cam_treatment"],
      derivationTrace: `${canonicalKey} left null because lease_type=${leaseTypeValue || "gross/full-service"} and no separate charge was extracted`,
      requiresReview: false,
      reviewReason: "Not applicable unless reviewer identifies a separate charge, cap, base year, or expense stop.",
    },
  };
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

function requiredFieldHasValueWithAlternates(byKey, key) {
  if (requiredFieldHasValue(byKey, key)) return true;
  const contract = getFieldContract(key);
  return (contract?.alternateFieldKeys || []).some((alternateKey) => requiredFieldHasValue(byKey, alternateKey));
}

function isReviewBlockingStandardRow(row, requiredKeySet) {
  if (!row || row.rowType !== "standard") return false;
  const canonicalKey = row.canonicalKey || row.fieldKey || row.field_key;
  if (!requiredKeySet.has(canonicalKey)) return false;
  return row.status === "needs_review" || row.status === "manual_required";
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

const STRICT_SOURCE_BACKED_VALUE_KEYS = new Set([
  "tenant_name", "landlord_name", "property_name", "property_address", "suite_number",
  "permitted_use", "square_footage", "landlord_consent", "landlord_consent_for_transfer",
  "electric_responsibility",
  "responsibility_utilities", "responsibility_taxes", "responsibility_insurance",
  "maintenance_responsibility",
]);

function consentEvidenceSemanticallySupportsValue(canonicalKey, value, evidence) {
  if (canonicalKey !== "landlord_consent" && canonicalKey !== "landlord_consent_for_transfer") return false;
  if (!isMeaningfulValue(value)) return false;
  const text = normalizeComparableText([evidence?.sourceText, evidence?.sourceClause].filter(Boolean).join(" "));
  if (!text) return false;
  return /\b(?:prior written )?consent\b/.test(text)
    && /\blandlord\b/.test(text)
    && /\b(?:transfer|assign|assignment|sublet|sublease)\b/.test(text);
}

function shouldBlankUnsupportedStandardValue(canonicalKey, value, evidence, review) {
  if (!STRICT_SOURCE_BACKED_VALUE_KEYS.has(canonicalKey)) return false;
  if (!isMeaningfulValue(value)) return false;
  if (review?.status === REVIEW_STATUSES.EDITED) return false;
  if (consentEvidenceSemanticallySupportsValue(canonicalKey, value, evidence)) return false;
  if (canonicalKey === "property_address" && propertyAddressEvidenceIsWrongPartyAddress(evidence)) return true;
  const quality = resolveSourceTextQuality({ ...(evidence || {}), value });
  if (quality === SOURCE_TEXT_QUALITIES.INCONSISTENT || quality === SOURCE_TEXT_QUALITIES.MISSING) return true;
  return !hasValidSourceEvidence({ ...(evidence || {}), value });
}

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

// Release 1: resolveExtractionStatus() (leaseReviewSchema.js) already
// distinguishes not_found/missing -- genuinely different states ("the lease
// doesn't state this" vs "extraction never ran at all") -- and
// extractionStatus carries that distinction into this function. The
// pre-Release-1 version of this function ignored it in the blank-value
// case, collapsing both into a single flat "missing" badge before a
// reviewer ever saw the row. Fixed here by branching on extractionStatus
// instead of short-circuiting on hasValue alone.
//
// Scope note: an earlier version of this fix also special-cased
// EXTRACTION_STATUSES.MISSING_SOURCE_EVIDENCE for the has-a-value branch,
// and returned a distinct "conflicting" badge for EXTRACTION_STATUSES.CONFLICT
// instead of "needs_review". Both were reverted: the former conflicted with
// an existing, deliberately-designed case (a value pieced together from
// multiple source snippets, e.g. an addendum total, that intentionally
// resolves to the generic "needs_review"); the latter is read verbatim by
// readinessSummary's needsReviewFields computation (leaseReviewFieldNormalizer.js),
// so renaming it would also require auditing every downstream consumer of
// that exact string, which is a bigger change than this fix warrants.
// Scoped to exactly what the audit found: the blank-value collapse.
//
// Precedence (highest to lowest): reviewer edits always win over any
// extraction signal; not_found/not_applicable/missing come next for blank
// values; auto_populated is the only state that requires everything to
// have gone right; needs_review is the catch-all (including conflicts).
//
// Follow-up (deferred past Release 1, per review): splitting this single
// overloaded `status` into independent extractionStatus/validationStatus/
// reviewStatus properties instead of layering more meanings onto one field.
// Revisit if this precedence list stops being sufficient.
function computeFieldStatus({ hasValue, evidenceVerified, confidenceBucket, reviewStatus, extractionStatus }) {
  if (reviewStatus === REVIEW_STATUSES.EDITED) return "manually_edited";
  if (extractionStatus === EXTRACTION_STATUSES.CONFLICT) return "needs_review";
  if (!hasValue) {
    if (extractionStatus === EXTRACTION_STATUSES.NOT_FOUND) return "not_found";
    if (reviewStatus === REVIEW_STATUSES.N_A) return "not_applicable";
    return "missing";
  }
  if (evidenceVerified && confidenceBucket === "high") return "auto_populated";
  return "needs_review";
}

/**
 * One row per LEASE_FIELD_CONTRACT entry that's a real, directly-extractable
 * LEASE_SCHEMA field (skips `computed: true` entries like tenant_pro_rata_share
 * and row-level, non-field entries like document_profile/approval_status —
 * those are surfaced separately, see normalizeApprovalBlockers).
 */
export function normalizeStandardFields(lease, { fieldReviews, allowNoProviderCoreFallbacks = false } = {}) {
  const effectiveFieldReviews = fieldReviews ?? lease?.extraction_data?.field_reviews ?? {};
  const termContext = deriveLeaseTermContext(lease);
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
    const fallback = standardFieldFallback(lease, canonicalKey, {
      value,
      evidence,
      allowNoProviderCoreFallbacks,
    });
    if (fallback) {
      value = fallback.value;
      evidence = fallback.evidence;
      confidence = fallback.confidence;
      fallbackReviewReason = fallback.reviewReason;
      fallbackSourceProvider = fallback.sourceProvider;
    }
    const derived = derivedStandardField(lease, canonicalKey, value, termContext);
    if (derived) {
      value = derived.value;
      evidence = derived.evidence;
      confidence = derived.confidence;
      fallbackReviewReason = derived.reviewReason;
    }
    const grossNoSeparateCharge = grossLeaseNoSeparateChargeField(lease, canonicalKey, value);
    let displayValueOverride = null;
    let statusOverride = null;
    if (grossNoSeparateCharge) {
      value = grossNoSeparateCharge.value;
      evidence = grossNoSeparateCharge.evidence;
      confidence = grossNoSeparateCharge.confidence;
      fallbackReviewReason = grossNoSeparateCharge.reviewReason;
      displayValueOverride = grossNoSeparateCharge.displayValue;
      statusOverride = grossNoSeparateCharge.status;
    }

    // Phase 39: reject layout/markup artifacts (e.g. "<figure>") before they
    // can be displayed as an accepted value. invalidValueRejected is read
    // downstream by hasRowValue/normalizeApprovalBlockers ONLY to keep this
    // display fix from silently creating a new approval blocker - it is not
    // a general "field is fine" signal.
    let invalidValueRejected = false;
    let evidenceOverrideReason = null;
    if (isFieldLabelPlaceholderValue(canonicalKey, value, contract)) {
      const recoveredValue = recoverStandardValueFromEvidence(canonicalKey, evidence);
      if (isMeaningfulValue(recoveredValue)) {
        value = recoveredValue;
        confidence = Math.max(typeof confidence === "number" ? confidence : 0, 0.9);
        fallbackReviewReason = "Recovered normalized value from the cited source text because the extracted value only repeated the field label.";
        fallbackSourceProvider = fallbackSourceProvider || "source_text_placeholder_recovery";
        const recoveredSourceText = evidence?.sourceText ?? evidence?.source_text ?? null;
        const recoveredSourceClause = evidence?.sourceClause ?? evidence?.source_clause ?? recoveredSourceText;
        evidence = {
          ...(evidence || {}),
          value,
          rawValue: value,
          raw_value: value,
          sourceText: recoveredSourceText,
          source_text: recoveredSourceText,
          sourceClause: recoveredSourceClause,
          source_clause: recoveredSourceClause,
          extractionStatus: EXTRACTION_STATUSES.EXTRACTED,
          extraction_status: EXTRACTION_STATUSES.EXTRACTED,
          evidenceType: "extracted",
          evidence_type: "extracted",
          sourceTextQuality: SOURCE_TEXT_QUALITIES.PARTIAL,
          source_text_quality: SOURCE_TEXT_QUALITIES.PARTIAL,
          reviewReason: fallbackReviewReason,
          review_reason: fallbackReviewReason,
        };
      } else {
        evidenceOverrideReason = "Extracted value matched the field label, not a lease value. Needs re-extraction or manual review.";
        invalidValueRejected = true;
        value = null;
        evidence = {
          ...(evidence || {}),
          requiresReview: true,
          reviewReason: evidenceOverrideReason,
        };
      }
    }
    if (!evidenceOverrideReason && isMarkupArtifactValue(value)) {
      evidenceOverrideReason = `Extracted value "${value}" was a layout/markup artifact, not a real field value, and was rejected.`;
      invalidValueRejected = true;
      value = null;
    }

    if (!evidenceOverrideReason && shouldBlankUnsupportedStandardValue(canonicalKey, value, evidence, review)) {
      evidenceOverrideReason =
        "Extracted value was rejected because the cited source text does not support this field/value. Needs re-extraction or manual review.";
      value = null;
      evidence = {
        ...(evidence || {}),
        requiresReview: true,
        reviewReason: evidenceOverrideReason,
      };
    }
    if (!evidenceOverrideReason && isParagraphLikeReviewValue(value)) {
      const preservedSourceText = evidence?.sourceText || value;
      evidenceOverrideReason =
        "Extracted value looked like a source paragraph instead of a normalized field answer. The paragraph is preserved as evidence and the field needs review.";
      value = null;
      evidence = {
        ...(evidence || {}),
        sourceText: preservedSourceText,
        requiresReview: true,
        reviewReason: evidenceOverrideReason,
      };
    }
    const validationErrors = [
      ...(Array.isArray(evidence?.validationErrors) ? evidence.validationErrors : []),
      ...(Array.isArray(evidence?.validation_errors) ? evidence.validation_errors : []),
    ];
    const valueFromTypedLeaseColumn = reviewedValue === undefined
      && typedColumnValue !== undefined
      && Object.is(value, typedColumnValue);
    if (!evidenceOverrideReason && isMeaningfulValue(value)) {
      const validationResult = validateFieldValue(canonicalKey, value);
      const supportValidation = validationResult.valid && !valueFromTypedLeaseColumn
        ? validateFieldEvidenceSupport(canonicalKey, value, evidence)
        : validationResult;
      if (!supportValidation.valid) {
        validationErrors.push(`${canonicalKey}_failed_validation`);
        const preservedSourceText = evidence?.sourceText || evidence?.sourceClause || null;
        evidenceOverrideReason = supportValidation.reason || "Extracted value failed field/source validation.";
        invalidValueRejected = true;
        value = null;
        evidence = {
          ...(evidence || {}),
          sourceText: preservedSourceText,
          requiresReview: true,
          reviewReason: evidenceOverrideReason,
          validationErrors,
        };
      }
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
    const status = statusOverride || (evidenceOverrideReason && !invalidValueRejected && !hasValue && evidence?.sourceText
      ? "needs_review"
      : computeFieldStatus({
        hasValue,
        evidenceVerified,
        confidenceBucket: classifyConfidence(confidence),
        reviewStatus: review?.status,
        extractionStatus,
      }));
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
      displayValue: displayValueOverride ?? value,
      display_value: displayValueOverride ?? value,
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
      validationErrors,
      validation_errors: validationErrors,
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
    if (item.creates_dynamic_row === false) continue;
    if (isClauseRecordOnlyDynamicItem(item)) continue;
    const candidateKey = item.field_key || item.item_type || item.key;
    const canonicalCandidate = resolveCanonicalFieldKey(candidateKey);
    if (getFieldContract(canonicalCandidate)) continue;
    const sourceText = cleanDocumentItemSource(item.source_text ?? item.exact_source_text ?? item.source_clause ?? null);
    const dedupeKey = `${item.item_type || item.field_key || ""}|${String(sourceText || item.value || "").toLowerCase().slice(0, 140)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const tabKey = routeDynamicRowToTab(item);
    const confidence = typeof item.confidence === "number" ? item.confidence : null;
    const label = item.label || titleize(item.item_type || item.field_key || "Finding");
    const rawDynamicValue = item.normalized_value ?? item.value ?? null;
    const labelOnlyValue = isLabelOnlyDynamicValue(label, rawDynamicValue, candidateKey);
    const dynamicValue = labelOnlyValue ? null : rawDynamicValue;
    const dynamicReviewReason = labelOnlyValue
      ? "Extracted value repeated the row label, not a lease value. Review the cited source text."
      : (item.review_reason ?? item.reviewReason ?? item.requires_review_reason ?? item.requiresReviewReason ?? null);
    const declaredValueType = String(item.value_type ?? item.valueType ?? item.data_type ?? item.dataType ?? "").trim().toLowerCase();
    const valueType = /(schedule|table|matrix|ledger)/i.test(declaredValueType)
      ? "schedule"
      : /(currency|money|amount|dollar)/i.test(declaredValueType)
        ? "currency"
        : /(date|deadline)/i.test(declaredValueType)
          ? "date"
          : /(boolean|bool|yes_no|yesno)/i.test(declaredValueType)
            ? "boolean"
            : /(number|numeric|percent|percentage|rate)/i.test(declaredValueType)
              ? "number"
              : /schedule|matrix|table|ledger/i.test(String(item.field_key || item.item_type || item.key || ""))
                ? "schedule"
                : null;
    rows.push({
      rowType: "dynamic",
      typeLabel: "Dynamic",
      key: item.item_id || item.id || `dynamic-${rows.length}`,
      fieldKey: item.field_key || item.item_type || null,
      label,
      category: item.business_area || item.display_tab || item.item_type || "unknown_needs_review",
      type: valueType || "text",
      dataType: valueType || "text",
      valueType: valueType || "text",
      value_type: item.value_type ?? item.valueType ?? valueType ?? "text",
      tabKey,
      editable: false,
      value: dynamicValue,
      normalizedValue: dynamicValue,
      normalized_value: dynamicValue,
      sourcePage: item.source_page ?? item.page_number ?? null,
      source_page: item.source_page ?? item.page_number ?? null,
      page_number: item.source_page ?? item.page_number ?? null,
      sourceText,
      source_text: sourceText,
      confidence,
      confidencePercent: normalizeConfidencePercent(confidence),
      status: labelOnlyValue ? "needs_review" : normalizeRowStatus(item.review_status || item.status || item.extraction_status),
      // Phase 40: dynamic-finding items don't carry the same structured
      // extraction-status/evidence-quality metadata standard fields do, so
      // resolveLeaseReviewExtractionMode's inputs can't be built reliably
      // here. Defaulting to unknown rather than guessing "explicit".
      extractionMode: EXTRACTION_MODES.UNKNOWN,
      extraction_mode: EXTRACTION_MODES.UNKNOWN,
      mapsToExistingField: Boolean(item.maps_to_existing_field),
      createsDynamicRow: true,
      reviewReason: dynamicReviewReason,
      review_reason: dynamicReviewReason,
      validationMessage: dynamicReviewReason,
      defaultVisible: true,
      advanced: false,
    });
  }
  return mergeDynamicFallbackRows(rows, normalizeNoProviderDynamicFallbackRows(lease));
}

// ── Clause records ────────────────────────────────────────────────────────

function stripDocumentSourceMarkup(value) {
  return String(value ?? "")
    .replace(/\[\[\s*PAGE\s+\d+\s*\]\]/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:td|th|tr|p|div|li|h[1-6])>/gi, " ")
    .replace(/<(?:td|th|tr|table|tbody|thead|p|div|span|li|ul|ol|h[1-6])\b[^>]*>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function cleanDocumentItemSource(value) {
  const text = stripDocumentSourceMarkup(value);
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

function shouldKeepClauseRecord(row, { profile, preserveFinancialClauses = false } = {}) {
  if (!cleanDocumentItemSource(row?.clause_text)) return false;

  // Assignment clause behavior was intentionally broadened in Phase 44A; keep
  // that path stable. The Phase 50 noise regression is specific to base-lease
  // fact echoes that already have dedicated standard/rule rows.
  if (profile !== "base_lease") return true;

  const semanticKey = clauseSemanticFieldKey(row);
  const type = row?.clause_type;

  if (isExpenseCamRentOrSecurityClause(row) && !preserveFinancialClauses) return false;
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
export function normalizeClauseRecords(lease, { profile = resolveCurrentReviewProfile(lease), preserveFinancialClauses = false } = {}) {
  const rows = computeFallbackClauseRows(lease)
    .filter((c) => cleanDocumentItemSource(c.clause_text))
    .filter((c) => shouldKeepClauseRecord(c, { profile, preserveFinancialClauses }));
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
        type: "schedule",
        dataType: "schedule",
        valueType: "schedule",
        value_type: "schedule",
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
  const rowValue = rule?.display_value ?? rule?.value ?? rule?.normalized_value ?? rule?.amount ?? null;
  const fallbackRuleValue = rowValue
    ?? rule?.normalized_rule
    ?? rule?.responsible_party
    ?? (recoverable == null ? null : (recoverable ? "Recoverable from tenant" : "Not recoverable from tenant"));
  return {
    rowType: camRule ? "cam_rule" : "expense_rule",
    typeLabel: camRule ? "CAM Rule" : "Expense Rule",
    key: rule?.id || rule?.rule_key || `${camRule ? "cam" : "expense"}-${rule?.expense_category ?? rule?.category ?? "rule"}`,
    category: rule?.expense_category ?? rule?.category ?? rule?.normalized_key ?? "unknown",
    label: rule?.normalized_rule || rule?.subcategory_name || rule?.category_name || rule?.expense_category || rule?.category || (camRule ? "CAM rule" : "Expense rule"),
    tabKey: camRule ? "cam_rules" : "expenses_recoveries",
    editable: false,
    value: fallbackRuleValue,
    normalizedValue: fallbackRuleValue,
    normalized_value: fallbackRuleValue,
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

export function isLeaseApprovedForDownstream(lease) {
  const abstractStatus = String(lease?.abstract_status || "").trim().toLowerCase();
  const leaseStatus = String(lease?.status || "").trim().toLowerCase();
  return abstractStatus === "approved"
    || leaseStatus === "approved"
    || Boolean(lease?.abstract_approved_at);
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
    const hasValue = (row ? (isMeaningfulValue(row.value) || row.invalidValueRejected === true) : false)
      || requiredFieldHasValueWithAlternates(byKey, contract.canonicalKey);
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
      const policyHasValue = requiredFieldHasValueWithAlternates(byKey, key);
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

function materialTermValue(row) {
  return row?.displayValue ?? row?.display_value ?? row?.normalizedValue ?? row?.normalized_value ?? row?.value ?? row?.summary ?? null;
}

function materialTermSourceText(row) {
  return row?.sourceText ?? row?.source_text ?? row?.exact_source_text ?? row?.source_clause ?? row?.summary ?? null;
}

function materialTermPage(row) {
  return row?.sourcePage ?? row?.source_page ?? row?.page_number ?? null;
}

function materialTermDedupeKey(row, sourceKind) {
  return [
    sourceKind,
    normalizeComparableText(row?.fieldKey || row?.field_key || row?.canonicalKey || row?.category || row?.label || row?.title || row?.clauseType),
    normalizeComparableText(materialTermValue(row)),
    normalizeComparableText(materialTermSourceText(row)).slice(0, 180),
  ].join("|");
}

function makeMaterialTermRow(row, sourceKind, index) {
  const value = materialTermValue(row);
  const sourceText = materialTermSourceText(row);
  const page = materialTermPage(row);
  const label = row?.label || row?.title || row?.clauseType || row?.category || row?.fieldKey || row?.canonicalKey || "Lease term";
  return {
    ...row,
    rowType: "material_term",
    typeLabel: "Material Term",
    key: `material-${sourceKind}-${row?.key || row?.id || row?.fieldKey || row?.canonicalKey || index}`,
    fieldKey: row?.fieldKey || row?.field_key || row?.canonicalKey || row?.category || null,
    field_key: row?.field_key || row?.fieldKey || row?.canonicalKey || row?.category || null,
    label,
    tabKey: "material_terms",
    category: row?.category || sourceKind,
    editable: false,
    value,
    normalizedValue: value,
    normalized_value: value,
    displayValue: value,
    display_value: value,
    sourceText,
    source_text: sourceText,
    sourcePage: page,
    source_page: page,
    page_number: page,
    status: row?.status || row?.review_status || "needs_review",
    extractionMode: row?.extractionMode || row?.extraction_mode || EXTRACTION_MODES.UNKNOWN,
    extraction_mode: row?.extraction_mode || row?.extractionMode || EXTRACTION_MODES.UNKNOWN,
    confidence: row?.confidence ?? null,
    confidencePercent: row?.confidencePercent ?? normalizeConfidencePercent(row?.confidence),
    materialSource: sourceKind,
    mappedRowType: row?.rowType || sourceKind,
    defaultVisible: true,
    advanced: false,
  };
}

export function buildMaterialTermLedger({ standardFields = [], dynamicFindings = [], expenseRules = [], camRules = [], clauseRecords = [] } = {}) {
  const seen = new Set();
  const terms = [];
  const add = (row, sourceKind) => {
    if (!row || typeof row !== "object") return;
    const value = materialTermValue(row);
    const sourceText = materialTermSourceText(row);
    if (!isMeaningfulValue(value) && !sourceText) return;
    if (row.invalidValueRejected && !sourceText) return;
    const key = materialTermDedupeKey(row, sourceKind);
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(makeMaterialTermRow(row, sourceKind, terms.length));
  };

  standardFields.forEach((row) => add(row, "canonical_field"));
  expenseRules.forEach((row) => add(row, "expense_rule"));
  camRules.forEach((row) => add(row, "cam_rule"));
  dynamicFindings.forEach((row) => add(row, "dynamic_finding"));
  clauseRecords.forEach((row) => add({
    ...row,
    key: row.key || `${row.clauseType || "clause"}-${row.sourcePage ?? "p"}`,
    label: row.title || row.clauseType || "Lease clause",
    value: clauseValueLabel(row),
    normalized_value: clauseValueLabel(row),
    sourceText: row.sourceText,
    source_text: row.sourceText,
    sourcePage: row.sourcePage,
    source_page: row.sourcePage,
    status: row.reviewStatus || row.status || "pending",
    extractionMode: EXTRACTION_MODES.UNKNOWN,
  }, "clause"));

  return terms;
}
export function buildRowsByTab({ standardFields, dynamicFindings, expenseRules, camRules, clauseRecords, criticalDates, materialTerms = [] }) {
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
    const baseKey = `${row.clauseType}-${row.sourcePage ?? "unknown"}-${String(row.summary || "").slice(0, 24)}`;
    const valueLabel = clauseValueLabel(row);
    const makeClauseRow = (tabKey, suffix = "") => ({
      rowType: "clause",
      typeLabel: "Clause",
      key: `${baseKey}${suffix}`,
      label: row.title || row.clauseType,
      fieldKey: row.clauseType || null,
      field_key: row.clauseType || null,
      category: row.businessArea || row.clauseType || "clause_records",
      tabKey,
      editable: false,
      value: valueLabel,
      normalizedValue: valueLabel,
      normalized_value: valueLabel,
      display_value: valueLabel,
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
    tabs.clause_records.push(makeClauseRow("clause_records"));

    const domainTab = routeClauseRecordToDomainTab(row);
    if (domainTab && tabs[domainTab]) {
      const duplicateInDomain = tabs[domainTab].some((existing) =>
        normalizeComparableText(existing.sourceText || existing.source_text) === normalizeComparableText(row.sourceText)
        && normalizeComparableText(existing.label) === normalizeComparableText(row.title || row.clauseType),
      );
      if (!duplicateInDomain) tabs[domainTab].push(makeClauseRow(domainTab, `-${domainTab}-supporting`));
    }
  }

  for (const row of materialTerms) if (tabs.material_terms) tabs.material_terms.push(row);

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
  const missingRequired = requiredKeys.filter((key) => !requiredFieldHasValueWithAlternates(byKey, key));
  const needsReview = standardFields.filter((row) => isReviewBlockingStandardRow(row, requiredKeySet));
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
      missingRequired: standardRows.filter((row) => requiredKeySet.has(row.canonicalKey) && !requiredFieldHasValueWithAlternates(byKey, row.canonicalKey)).length,
      needsReview: rows.filter((row) => isReviewBlockingStandardRow(row, requiredKeySet)).length,
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

export function buildDebugCounts({ standardFields, dynamicFindings, clauseRecords, expenseRules, camRules = [], criticalDates, materialTerms = [], approvalBlockers, tabs = {} }) {
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
    material_terms_count: materialTerms.length,
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
export function normalizeLeaseReviewData(lease, { fieldReviews, allowNoProviderCoreFallbacks = false, allowDiagnosticExpenseRuleFallbacks = false } = {}) {
  const effectiveFieldReviews = fieldReviews ?? lease?.extraction_data?.field_reviews ?? {};
  const standardFields = normalizeStandardFields(lease, {
    fieldReviews: effectiveFieldReviews,
    allowNoProviderCoreFallbacks,
  });
  const currentReviewPolicy = buildCurrentReviewPolicy(lease, {
    rows: standardFields,
    fieldReviews: effectiveFieldReviews,
    legacyRequiredFieldKeys: REQUIRED_FIELD_KEYS,
  });
  const dynamicFindings = normalizeDynamicFindings(lease);
  const downstreamApproved = isLeaseApprovedForDownstream(lease);
  // Expense/CAM obligations are extracted from the lease document, but they
  // become visible in the normal UI only after lease abstract approval publishes
  // them to the persisted lease_expense_rule tables. Keep raw workflow/no-provider
  // rows available only for explicit diagnostics.
  const allRuleRows = allowDiagnosticExpenseRuleFallbacks ? normalizeExpenseRuleFallback(lease) : [];
  const hasStructuredRuleEvidence = allRuleRows.some((row) => row.sourceText || row.source_text || isMeaningfulValue(row.value ?? row.normalized_value));
  const clauseRecords = normalizeClauseRecords(lease, {
    profile: currentReviewPolicy.profile,
    preserveFinancialClauses: !hasStructuredRuleEvidence,
  });
  const expenseRules = allRuleRows.filter((row) => row.rowType !== "cam_rule");
  const camRules = allRuleRows.filter((row) => row.rowType === "cam_rule");
  const criticalDates = downstreamApproved ? normalizeCriticalDates(standardFields) : [];
  const approvalBlockers = normalizeApprovalBlockers(lease, standardFields, currentReviewPolicy);
  const materialTerms = buildMaterialTermLedger({ standardFields, dynamicFindings, expenseRules, camRules, clauseRecords });
  const tabs = buildRowsByTab({ standardFields, dynamicFindings, expenseRules, camRules, clauseRecords, criticalDates, materialTerms });
  if (!downstreamApproved) {
    tabs.critical_dates = [];
    tabs.budget_preview = [];
  }
  const readinessSummary = buildReadinessSummary({ standardFields, dynamicFindings, expenseRules, camRules, clauseRecords, criticalDates, approvalBlockers, tabs, currentReviewPolicy });
  const budgetPreview = tabs.budget_preview || [];
  const debugCounts = buildDebugCounts({ standardFields, dynamicFindings, clauseRecords, expenseRules, camRules, criticalDates, materialTerms, approvalBlockers, tabs });

  return {
    readinessSummary,
    tabs,
    standardFields,
    dynamicFindings,
    clauseRecords,
    expenseRules,
    camRules,
    criticalDates,
    materialTerms,
    approvalBlockers,
    currentReviewPolicy,
    downstreamApproved,
    budgetPreview,
    debugCounts,
  };
}
