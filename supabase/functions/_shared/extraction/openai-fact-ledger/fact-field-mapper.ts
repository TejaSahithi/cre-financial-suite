// @ts-nocheck
/**
 * OpenAI Fact Ledger — Fact → Standard Field Mapper
 *
 * Deterministic (no LLM). Scores each fact against every LEASE_SCHEMA field's
 * labels[] PLUS field-contract.ts's aliases for that field (the other
 * vocabularies' names for the same concept — e.g. a fact phrased using
 * "tenant's notice address" should still map onto tenant_address even
 * though that field's own LEASE_SCHEMA labels list is short). This is what
 * closes the parity gap legacy_hybrid didn't have: legacy_hybrid's rule
 * extractor and LLM groups already benefit from lease-workflow.ts's
 * FIELD_SPECS aliases via buildLeaseFieldMap()'s getFirstValue(row,
 * spec.aliases); this mapper previously had no equivalent. Calls the
 * existing, unmodified validateRecords() from validator.ts so type/range/
 * enum enforcement and lease cross-field sanity checks are identical to
 * legacy_hybrid — this module never reimplements validation.
 *
 * Facts that don't clear a real label match for any field pass through
 * untouched as unmappedFacts, for dynamic-fact-surfacer.ts to surface.
 */

import { getSchema, type FieldDef } from "../schemas.ts";
import { validateRecords } from "../validator.ts";
import { getFieldContract } from "../field-contract.ts";
import { evaluateCandidateForField } from "../candidate-decision.ts";
import { cleanEvidenceSnippet } from "../evidence-index.ts";
import type { ExtractedField, ExtractedRecord, ModuleType } from "../types.ts";
import type { Fact, FactFieldMappingResult } from "./types.ts";

const MIN_LABEL_SCORE = 3; // shortest meaningful label match (e.g. "by:" is too weak alone)
function normalizeMoneyValue(value: unknown): number | null {
  if (value == null) return null;
  const text = String(value).replace(/[$,\s]/g, "").trim();
  if (!text || !/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function moneyNearLabel(sourceText: string, labelPattern: RegExp): number | null {
  const match = sourceText.match(labelPattern);
  if (!match?.[1]) return null;
  return normalizeMoneyValue(match[1]);
}

function sourceMonthlyInstallmentAmount(sourceText: string): number | null {
  const clean = sourceText.replace(/\s+/g, " ");
  return (
    moneyNearLabel(clean, /monthly\s+installments?\s+of\s*(?:[$#]\s*)?([\d,]+(?:\s+\d{3})?(?:\.\d{2})?)/i) ??
    moneyNearLabel(clean, /installments?\s+of\s*(?:[$#]\s*)?([\d,]+(?:\s+\d{3})?(?:\.\d{2})?)\s*(?:per\s+month|monthly)/i) ??
    moneyNearLabel(clean, /(?:rent|base\s+rent|minimum\s+rent)\s*[:;-]?\s*(?:[$#]\s*)?([\d,]+(?:\s+\d{3})?(?:\.\d{2})?)\s*(?:per\s+month|monthly|\/month|\/mo)/i) ??
    moneyNearLabel(clean, /(?:per\s+month|monthly)\s*(?:installments?|rent)?\s*(?:of|in)?\s*(?:[$#]\s*)?([\d,]+(?:\s+\d{3})?(?:\.\d{2})?)/i)
  );
}

function sourceAnnualRentAmount(sourceText: string): number | null {
  const clean = sourceText.replace(/\s+/g, " ");
  return (
    moneyNearLabel(clean, /annual\s+(?:amount|rent|base\s+rent)[^$#\d]{0,60}(?:[$#]\s*)?([\d,]+(?:\.\d{2})?)/i) ??
    moneyNearLabel(clean, /(?:per\s+year|annually|yearly)[^$#\d]{0,40}(?:[$#]\s*)?([\d,]+(?:\.\d{2})?)/i) ??
    moneyNearLabel(clean, /(?:[$#]\s*)?([\d,]+(?:\.\d{2})?)\s*(?:per\s+year|annually|yearly)/i)
  );
}

function roughlyEqualMoney(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) <= 1;
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function valueIsLabeledAsRole(valueText: string, sourceText: string, rolePattern: string): boolean {
  if (!valueText) return false;
  const escapedValue = escapeRegExp(valueText).replace(/\s+/g, "\\s+");
  return new RegExp(`${escapedValue}.{0,80}(?:herein\\s+called|referred\\s+to\\s+as|called)\\s+["']?(?:${rolePattern})\\b`, "i").test(sourceText) ||
    new RegExp(`(?:${rolePattern})\\s+name\\s*[:.]\\s*${escapedValue}`, "i").test(sourceText) ||
    new RegExp(`(?:^|\\n)\\s*(?:${rolePattern})\\s*[:.]\\s*${escapedValue}`, "i").test(sourceText);
}

function looksLikeStreetAddress(value: unknown): boolean {
  const text = cleanEvidenceSnippet(value);
  return /\b\d{1,6}\s+[A-Za-z0-9.'#& -]{2,80}\s+(?:street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|drive|dr\.?|lane|ln\.?|highway|hwy|parkway|pkwy|way|court|ct\.?|place|pl\.?|circle|cir\.?|trail|trl\.?)\b/i.test(text) ||
    /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(text);
}

function looksLikeFullAddress(value: unknown): boolean {
  const text = cleanEvidenceSnippet(value);
  return looksLikeStreetAddress(text) || /\b(?:knoxville|seymour|county|tennessee|tn\s*\d{5})\b/i.test(text);
}

function looksLikeShortUnitIdentifier(value: unknown): boolean {
  const text = cleanEvidenceSnippet(value);
  if (!text || text.length > 40 || looksLikeFullAddress(text)) return false;
  return /^(?:suite|ste\.?|unit|space|#)\s*[A-Za-z0-9-]+(?:\s*(?:and|&)\s*[A-Za-z0-9-]+)?$/i.test(text) ||
    /^[A-Za-z0-9-]{1,12}$/.test(text);
}

function sourceIsLandlordOrTenantAddress(sourceText: string): boolean {
  return /\b(?:address\s+of\s+(?:landlord|tenant)|(?:landlord|tenant)(?:'s)?\s+(?:mailing\s+|notice\s+)?address)\b/i.test(sourceText);
}

function sourceIsPremisesLocation(sourceText: string): boolean {
  return /\b(?:premises|property|building|shopping\s+center|demised\s+premises|located\s+at|address\s+of\s+(?:premises|property|building))\b/i.test(sourceText);
}

function sourceHasMoneyOrNumberNearValue(sourceText: string, value: number | null): boolean {
  if (value === null) return true;
  const clean = cleanEvidenceSnippet(sourceText).replace(/\s+/g, " ");
  const normalizedValue = Math.round(value * 100) / 100;
  const tokens = clean.match(/(?:[$#]\s*)?\d[\d,]*(?:\.\d{1,2})?(?:\s+\d{3})?/g) ?? [];
  return tokens.some((token) => {
    const parsed = normalizeMoneyValue(token.replace(/#/g, "$"));
    return parsed !== null && roughlyEqualMoney(parsed, normalizedValue);
  });
}

function sourceIsHoldoverOrPenaltyRent(sourceText: string): boolean {
  return /\b(?:hold[-\s]?over|holding\s+over|expiration\s+of\s+(?:the\s+)?term|150%|one\s+hundred\s+fifty\s+percent|sufferance|damages\s+sustained)\b/i.test(sourceText);
}

function valueLooksLikePartyResponsibility(valueText: string): boolean {
  return /\b(?:tenant|landlord|shared|both|included|gross|full\s+service|landlord\s+with\s+cap)\b/i.test(valueText) &&
    !/,.*(?:cam|insurance|maintenance|janitorial|utility|utilities)/i.test(valueText);
}
function looksLikeFieldCompatibleFact(fact: Fact, fieldName: string): boolean {
  const valueText = cleanEvidenceSnippet(fact.value).trim();
  const sourceText = cleanEvidenceSnippet(fact.sourceText);
  const sourceLower = sourceText.toLowerCase();

  if (fieldName === "property_address") {
    if (!valueText || valueText.length < 8) return false;
    if (/\b(?:as\s+is|where\s+is|condition|delivery\s+of\s+possession|tenant\s+acknowledges)\b/i.test(valueText)) return false;
    if (/\b(?:as\s+is|where\s+is|delivery\s+of\s+possession)\b/i.test(sourceText)) return false;
    if (sourceIsLandlordOrTenantAddress(sourceText) && !/\b(?:premises|property|building)\b/i.test(sourceText)) return false;
    if (!looksLikeStreetAddress(valueText) && !(sourceIsPremisesLocation(sourceText) && looksLikeStreetAddress(sourceText))) return false;
  }

  if (fieldName === "unit_number") {
    if (!looksLikeShortUnitIdentifier(valueText)) return false;
    if (sourceIsLandlordOrTenantAddress(sourceText)) return false;
    if (/\b(?:rent|square\s+feet|sf|rsf|address\s+of\s+landlord|address\s+of\s+tenant)\b/i.test(valueText)) return false;
  }

  if (fieldName === "square_footage" || fieldName === "rentable_area_sqft" || fieldName === "tenant_rsf" || fieldName === "building_rsf") {
    const value = normalizeMoneyValue(fact.value);
    if (value === null || value < 100 || value > 5_000_000) return false;
    if (!/\b(?:square\s+feet|sq\.?\s*ft\.?|rentable\s+square\s+feet|rsf|\bsf\b|floor\s+area)\b/i.test(sourceText)) return false;
    if (!sourceHasMoneyOrNumberNearValue(sourceText, value)) return false;
  }

  if (fieldName === "lease_term_months") {
    const value = normalizeMoneyValue(fact.value);
    if (value === null || value < 1 || value > 1200) return false;
    if (sourceIsHoldoverOrPenaltyRent(sourceText)) return false;
    if (!/\b(?:term|months?|years?|commencement|expiration|expire|through)\b/i.test(sourceText)) return false;
    if (!sourceHasMoneyOrNumberNearValue(sourceText, value) && !/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:month|year)/i.test(sourceText)) return false;
  }

  if (fieldName === "monthly_rent") {
    const value = normalizeMoneyValue(fact.value);
    const monthlyInstallment = sourceMonthlyInstallmentAmount(sourceText);
    if (monthlyInstallment !== null && value !== null && !roughlyEqualMoney(value, monthlyInstallment)) return false;
    const annualAmount = sourceAnnualRentAmount(sourceText);
    if (annualAmount !== null && value !== null && roughlyEqualMoney(value, annualAmount)) return false;
    if (sourceIsHoldoverOrPenaltyRent(sourceText)) return false;
    if (value !== null && !sourceHasMoneyOrNumberNearValue(sourceText, value) && !roughlyEqualMoney(value, monthlyInstallment)) return false;
  }

  if (fieldName === "annual_rent") {
    const value = normalizeMoneyValue(fact.value);
    const annualAmount = sourceAnnualRentAmount(sourceText);
    if (sourceIsHoldoverOrPenaltyRent(sourceText)) return false;
    if (annualAmount !== null && value !== null && roughlyEqualMoney(value, annualAmount)) return true;
    const monthlyInstallment = sourceMonthlyInstallmentAmount(sourceText);
    if (monthlyInstallment !== null && value !== null && roughlyEqualMoney(value, monthlyInstallment)) return false;
    if (value !== null && !sourceHasMoneyOrNumberNearValue(sourceText, value)) return false;
  }

  if (fieldName === "tenant_name" || fieldName === "landlord_name") {
    if (!valueText || valueText.split(/\s+/).length > 12) return false;
    if (/^[a-z][a-z\s-]+$/.test(valueText) && !/\b(?:llc|l\.l\.c\.|inc|corp|company|co\.|lp|llp|trust|foundation|partners?|crossing|center|restaurant)\b/i.test(valueText)) {
      return false;
    }
    if (!/\b(?:party|parties|between|tenant\s+name|landlord\s+name|lessee\s+name|lessor\s+name|herein\s+called|referred\s+to\s+as|called\s+["']?(?:tenant|landlord|lessee|lessor))\b/i.test(sourceText)) {
      return false;
    }
    const expectedRole = fieldName === "tenant_name" ? "tenant|lessee" : "landlord|lessor";
    const oppositeRole = fieldName === "tenant_name" ? "landlord|lessor" : "tenant|lessee";
    if (!new RegExp(`(?:herein\\s+called|referred\\s+to\\s+as|called)\\s+["']?(?:${expectedRole})\\b|(?:${expectedRole})\\s+name`, "i").test(sourceText)) {
      return false;
    }
    const hasExplicitExpectedRole = valueIsLabeledAsRole(valueText, sourceText, expectedRole);
    const hasExplicitOppositeRole = valueIsLabeledAsRole(valueText, sourceText, oppositeRole);
    if (hasExplicitOppositeRole && !hasExplicitExpectedRole) return false;
  }

  if (fieldName === "property_name") {
    if (!valueText || valueText.split(/\s+/).length > 8) return false;
    if (/^[a-z][a-z\s-]+$/.test(valueText)) return false;
    if (/\b(?:license|non-exclusive|common\s+areas?|premises|lease|tenant|landlord|abatement|damage|fault|neglect)\b/i.test(valueText)) return false;
    if (!/\b(?:shopping\s+center|development|plaza|complex|park|building|mall|village|known\s+as|property\s+name)\b/i.test(sourceText)) return false;
  }

  if (fieldName === "renewal_notice_months") {
    if (!/\b(?:notice|notify|written\s+notice|exercise)\b/i.test(sourceText)) return false;
    if (!/\b(?:prior|before|advance|not\s+less\s+than|at\s+least)\b/i.test(sourceText)) return false;
  }

  if (fieldName === "renewal_options") {
    if (!/\b(?:renew|renewal|option|extend|extension)\b/i.test(sourceText)) return false;
    if (/\b(subject\s+and\s+subordinate|deeds?\s+of\s+trust|mortgages?)\b/i.test(sourceLower)) return false;
  }

  if (fieldName === "assignment_provisions") {
    if (!/\b(?:assign|assignment|sublet|sublease|transfer)\b/i.test(sourceText)) return false;
    if (/\b(?:default|failure\s+by\s+tenant|cure\s+period|remed(?:y|ies))\b/i.test(sourceText) && !/\b(?:assign|assignment|sublet|sublease|transfer)\b/i.test(valueText)) return false;
  }

  if (fieldName === "landlord_consent_for_transfer") {
    if (!/\b(?:assign|assignment|sublet|sublease|transfer)\b/i.test(sourceText)) return false;
    if (/\bpermitted\s+use\b/i.test(sourceText) && !/\b(?:assign|assignment|sublet|sublease|transfer)\b/i.test(valueText)) return false;
  }

  if (fieldName === "assumption_scope") {
    if (!/\b(?:assignee|assignment|assigned|transfer|assumes?\s+(?:the\s+)?(?:obligations|duties|liabilities|lease))\b/i.test(sourceText)) return false;
    if (/\b(?:assumes?\s+all\s+risk|risk\s+of\s+damage|injury\s+or\s+damage|gross\s+negligence)\b/i.test(sourceText) && !/\bassignee\b/i.test(sourceText)) return false;
  }

  if (fieldName === "assignment_consideration") {
    const value = normalizeMoneyValue(fact.value);
    if (value !== null && value <= 0) return false;
    if (!/\b(?:assignment|assignor|assignee|transfer|consideration)\b/i.test(sourceText)) return false;
    if (value !== null && !sourceHasMoneyOrNumberNearValue(sourceText, value)) return false;
  }

  if (fieldName === "escalation_rate") {
    if (!/\b(?:rent|base\s+rent|minimum\s+rent|escalat|increase|renewal)\b/i.test(sourceText)) return false;
    if (!/\b(?:%|percent|increase|escalat)\b/i.test(sourceText)) return false;
    if (/^\s*["']?control["']?\s+(?:shall\s+)?mean/i.test(sourceText)) return false;
  }

  if (/^(?:responsibility_taxes|tax_responsibility|responsibility_insurance|insurance_responsibility|responsibility_utilities|responsibility_repairs|hvac_responsibility)$/.test(fieldName)) {
    if (!valueLooksLikePartyResponsibility(valueText)) return false;
  }

  return true;
}

/**
 * Domain-aware (Release 1): fact.category is a real classified value (the
 * 34-clause CLAUSE_DEFINITIONS vocabulary), a stronger signal than keyword
 * length alone. A category explicitly rejected for this field hard-vetoes
 * the candidate before any keyword scoring happens — this is the actual
 * fix for a late-payment clause outscoring a CAM field's own weaker labels
 * (e.g. "administrative fee" matching admin_fee_pct's label list even when
 * the clause is genuinely about late fees, not CAM).
 */
function scoreFactAgainstField(fact: Fact, fieldName: string, def: FieldDef, moduleType: ModuleType): number {
  if (!looksLikeFieldCompatibleFact(fact, fieldName)) return 0;

  const decision = evaluateCandidateForField({
    field: def,
    fieldKey: fieldName,
    moduleType,
    value: fact.value,
    sourceText: fact.sourceText,
    factCategory: fact.category,
    confidence: fact.confidence,
    sourceType: "fact_ledger",
  });
  if (decision.decision === "reject") return 0;

  const haystack = `${fact.sourceText} ${String(fact.value ?? "")}`.toLowerCase();
  let score = 0;
  const contract = getFieldContract(fieldName);
  const candidateLabels = [...(def.labels || []), ...(contract?.aliases || [])];
  for (const label of candidateLabels) {
    const needle = label.toLowerCase().replace(/_/g, " ");
    if (needle.length < 3) continue;
    if (haystack.includes(needle)) score = Math.max(score, needle.length);
  }

  // Only bonus an "accept" driven by a REAL classified category match
  // (matchedAllowedCategories non-empty) -- an "accept" reached via
  // candidate-decision.ts's step-6 text fallback (no category available)
  // is derived from this same field's own `labels`, the identical signal
  // `score` above already counted; bonusing it again let an unconfigured
  // field's own more-specific label match get outscored by a shorter match
  // that only "won" because this field happened to have evidencePolicy
  // configured (a real regression this fixed: see field-contract.test.ts's
  // tax_responsibility/responsibility_taxes duplicate-concept-field test).
  if (decision.decision === "accept" && decision.matchedAllowedCategories.length > 0) score += 10;
  else if (decision.decision === "needs_review") score = Math.floor(score / 2); // cross-domain candidate — heavy penalty, not a hard zero

  if (fieldName === "annual_rent" && roughlyEqualMoney(normalizeMoneyValue(fact.value), sourceAnnualRentAmount(String(fact.sourceText ?? "")))) score += 12;
  if (fieldName === "monthly_rent" && roughlyEqualMoney(normalizeMoneyValue(fact.value), sourceMonthlyInstallmentAmount(String(fact.sourceText ?? "")))) score += 12;
  if ((fieldName === "tenant_name" || fieldName === "landlord_name") && valueIsLabeledAsRole(String(fact.value ?? "").trim(), String(fact.sourceText ?? ""), fieldName === "tenant_name" ? "tenant|lessee" : "landlord|lessor")) score += 12;

  return score;
}

/** Best-effort date parse, defensive against unparseable/garbled OCR text
 *  (e.g. "IST March 2019" from a misread "1st"). Returns null rather than
 *  NaN/Invalid Date so callers can safely skip a fact they can't parse
 *  instead of risking a wrong chronological assignment. */
function tryParseDate(value: unknown): Date | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) return direct;
  // Strip ordinal suffixes ("1st"/"2nd"/"3rd"/"4th") — a common source-text
  // shape Date.parse doesn't handle ("1st March 2019").
  const stripped = text
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1")
    .replace(/\b(?:i|l)st\s+([A-Za-z]+)\s+(\d{4})\b/gi, "1 $1 $2");
  const retry = new Date(stripped);
  return Number.isNaN(retry.getTime()) ? null : retry;
}

/**
 * Deterministic safety net for the "lease term shall be from [START] through
 * [END]" shape — a single compound sentence stating both the start and end
 * date together, with no field-specific label word ("commencement",
 * "expiration") anywhere in it. The fact-ledger prompt is instructed to
 * split this into two distinct facts (see fact-ledger-extractor.ts's "LEASE
 * TERM DATES" instruction), both category "clause:lease_term" — but
 * per-field keyword/category scoring alone can't tell them apart: both
 * facts share the same sourceText, so they'd score IDENTICALLY against
 * start_date/end_date/commencement_date/expiration_date regardless of which
 * one is actually earlier, and ties always resolve to whichever field is
 * declared first in the schema — leaving the other field permanently empty
 * rather than wrong. This resolves that specific, narrow ambiguity the only
 * way it CAN be resolved generically: the earlier calendar date is the
 * start, the later one is the end. Only engages when there are exactly two
 * distinct, successfully-parsed lease_term-categorized dates; anything else
 * (0, 1, or 3+ candidates, or a parse failure) falls through to normal
 * per-field scoring unchanged.
 */
function resolveLeaseTermDatePair(facts: Fact[]): { consumed: Set<Fact>; assignments: Record<string, Fact> } {
  const candidates = facts
    .filter((fact) => fact.category === "clause:lease_term")
    .map((fact) => ({ fact, date: tryParseDate(fact.value) }))
    .filter((entry): entry is { fact: Fact; date: Date } => entry.date !== null);

  const consumed = new Set<Fact>();
  const assignments: Record<string, Fact> = {};
  if (candidates.length < 2) return { consumed, assignments };

  // Two distinct calendar dates only -- 3+ candidates (e.g. a renewal-option
  // deadline also miscategorized as lease_term) is ambiguous enough that
  // guessing is worse than leaving it to normal scoring/unmapped.
  const distinctTimes = new Set(candidates.map((c) => c.date.getTime()));
  if (distinctTimes.size !== 2) return { consumed, assignments };

  const sorted = [...candidates].sort((a, b) => a.date.getTime() - b.date.getTime());
  const earliest = sorted[0].fact;
  const latest = sorted[sorted.length - 1].fact;

  for (const field of ["start_date", "commencement_date"]) assignments[field] = earliest;
  for (const field of ["end_date", "expiration_date"]) assignments[field] = latest;
  consumed.add(earliest);
  consumed.add(latest);
  return { consumed, assignments };
}

/**
 * Map a flat fact ledger onto LEASE_SCHEMA (or the given module's schema)
 * standard fields. Produces exactly one ExtractedRecord (rowIndex 0) — every
 * module this pipeline serves today is single-row per document.
 */
export function mapFactsToStandardFields(args: {
  facts: Fact[];
  moduleType: ModuleType;
}): FactFieldMappingResult {
  const { facts, moduleType } = args;
  const schema = getSchema(moduleType);
  const fieldNames = Object.keys(schema).filter((name) => !schema[name].derived);

  const bestByField = new Map<string, { fact: Fact; score: number }>();
  const unmappedFacts: Fact[] = [];
  const rejectedCandidates: Array<{
    field_key: string;
    candidate_value: unknown;
    candidate_category: string;
    decision: string;
    reason: string;
    source_page: number | null;
    source_text: string;
  }> = [];

  const leaseTermPair = resolveLeaseTermDatePair(facts);
  for (const [fieldName, fact] of Object.entries(leaseTermPair.assignments)) {
    if (!fieldNames.includes(fieldName)) continue; // non-lease module schemas don't have these fields
    bestByField.set(fieldName, { fact, score: MIN_LABEL_SCORE });
  }

  for (const fact of facts) {
    if (leaseTermPair.consumed.has(fact)) continue; // already assigned by the date-pair resolver above
    let bestField: string | null = null;
    let bestScore = 0;
    for (const fieldName of fieldNames) {
      const fieldDef = schema[fieldName];
      const score = scoreFactAgainstField(fact, fieldName, fieldDef, moduleType);
      // Best-effort audit trail: only worth recording a rejection against
      // the field a fact's own labels/text would otherwise have matched —
      // re-checking every field for every fact would be noisy. A non-zero
      // pre-veto keyword score with a zero post-veto score means the veto
      // fired; that's the interesting case for reviewers/tuning.
      if (score === 0 && (fieldDef.allowedClauseCategories?.length || fieldDef.rejectedClauseCategories?.length)) {
        const rawLabelScore = (fieldDef.labels || []).some((label) =>
          label.length >= 3 && `${fact.sourceText} ${String(fact.value ?? "")}`.toLowerCase().includes(label.toLowerCase().replace(/_/g, " ")),
        );
        if (rawLabelScore) {
          rejectedCandidates.push({
            field_key: fieldName,
            candidate_value: fact.value,
            candidate_category: fact.category,
            decision: "reject",
            reason: "category_incompatible",
            source_page: fact.sourcePage,
            source_text: fact.sourceText,
          });
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestField = fieldName;
      }
    }

    if (!bestField || bestScore < MIN_LABEL_SCORE) {
      unmappedFacts.push(fact);
      continue;
    }

    const existing = bestByField.get(bestField);
    if (
      !existing ||
      bestScore > existing.score ||
      (bestScore === existing.score && fact.confidence > existing.fact.confidence)
    ) {
      bestByField.set(bestField, { fact, score: bestScore });
    }
  }

  // Keep paired canonical date fields in sync when a single explicit fact only
  // wins one schema key by declaration order. Lease Review renders these as
  // separate rows, but they represent the same canonical concept pairs.
  const mirrorDateAlias = (from: string, to: string) => {
    if (!fieldNames.includes(from) || !fieldNames.includes(to)) return;
    if (!bestByField.has(from) || bestByField.has(to)) return;
    bestByField.set(to, bestByField.get(from)!);
  };
  mirrorDateAlias("start_date", "commencement_date");
  mirrorDateAlias("commencement_date", "start_date");
  mirrorDateAlias("end_date", "expiration_date");
  mirrorDateAlias("expiration_date", "end_date");

  const fields: Record<string, ExtractedField> = {};
  for (const [fieldName, { fact }] of bestByField.entries()) {
    fields[fieldName] = {
      value: fact.value,
      source: "llm",
      confidence: fact.confidence,
      sourceText: fact.sourceText,
      sourcePage: fact.sourcePage,
    };
  }

  const record: ExtractedRecord = { fields, rowIndex: 0 };
  const validated = validateRecords([record], moduleType);

  return {
    records: validated.records,
    validationErrors: validated.errors,
    unmappedFacts,
    rejectedCandidates,
  };
}
