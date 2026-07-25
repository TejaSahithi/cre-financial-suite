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
import { checkFieldSemanticCompatibility, hasSemanticRequirement, inferSemanticProfile } from "../semantic-compatibility.ts";
import type { ExtractedField, ExtractedRecord, ModuleType } from "../types.ts";
import type {
  Fact,
  FactFieldMappingResult,
  FieldSelectionProvenance,
  FieldGuardDecision,
  FieldCandidateSummary,
  FieldRejectedCandidateSummary,
} from "./types.ts";

const MIN_LABEL_SCORE = 3; // shortest meaningful label match (e.g. "by:" is too weak alone)

// ── Micro-step 0: provenance (additive, diagnostic-only — see types.ts) ─────
// Bounded to a small, high-value field set so payload growth stays small and
// predictable (~10 fields x up to 11 candidate summaries x a capped
// sourceText each — see LEASE_EXTRACTION_UI_PIPELINE_AUDIT.md Section 16.3's
// size estimate). Not "all 88 fields" — extending coverage is a deliberate,
// separate decision, not a side effect of this change.
const TRACKED_PROVENANCE_FIELDS = new Set([
  "monthly_rent",
  "annual_rent",
  "ti_allowance",
  "expiration_date",
  "broker_name",
  "renewal_options",
  "tenant_signatory_name",
  "responsibility_repairs",
  "insurance_responsibility",
  "electric_responsibility",
]);
const CANDIDATE_SOURCE_TEXT_MAX_CHARS = 600;
const CANDIDATE_LIST_MAX_LENGTH = 5;

function truncateForProvenance(text: unknown): string | null {
  const str = String(text ?? "").trim();
  if (!str) return null;
  return str.length > CANDIDATE_SOURCE_TEXT_MAX_CHARS
    ? `${str.slice(0, CANDIDATE_SOURCE_TEXT_MAX_CHARS)}…`
    : str;
}

function toCandidateSummary(fact: Fact, score: number | null): FieldCandidateSummary {
  return {
    value: fact.value,
    sourceText: truncateForProvenance(fact.sourceText),
    sourcePage: fact.sourcePage ?? null,
    chunkIndex: typeof fact.chunkIndex === "number" ? fact.chunkIndex : null,
    mapperScore: score,
    modelConfidence: typeof fact.confidence === "number" ? fact.confidence : null,
  };
}
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

function sourceHasResponsibilityDomain(fieldName: string, sourceText: string): boolean {
  const source = cleanEvidenceSnippet(sourceText);
  if (/^(?:responsibility_taxes|tax_responsibility)$/.test(fieldName)) return /\b(?:tax|taxes|real\s+estate\s+tax|property\s+tax|assessment)\b/i.test(source);
  if (/^(?:responsibility_insurance|insurance_responsibility|property_insurance_responsibility)$/.test(fieldName)) return /\b(?:insurance|premium|coverage|policy|policies)\b/i.test(source);
  if (fieldName === "responsibility_utilities") return /\b(?:utilities|electric(?:ity|al)?|water|sewer|gas|janitorial|trash|refuse)\b/i.test(source);
  if (fieldName === "responsibility_repairs") return /\b(?:repair|repairs|maintenance|maintain|alteration|condition)\b/i.test(source);
  if (fieldName === "hvac_responsibility") return /\b(?:hvac|heating|ventilation|air\s+conditioning)\b/i.test(source);
  return true;
}

/**
 * Micro-step 0 note: `reasonsOut`, when passed, is populated with the exact
 * reason string for whichever early-return fired (or left empty if the
 * function reaches its final `return true`). This is purely additive — the
 * function's boolean return value and every condition below are BYTE-FOR-
 * BYTE unchanged from before this parameter existed; `reject(reason)` is
 * just `return false` with an optional side-channel note. All existing
 * behavior (every caller that omits the third argument) is identical.
 */
function looksLikeFieldCompatibleFact(fact: Fact, fieldName: string, reasonsOut?: string[]): boolean {
  const reject = (reason: string): false => {
    reasonsOut?.push(reason);
    return false;
  };
  const valueText = cleanEvidenceSnippet(fact.value).trim();
  const sourceText = cleanEvidenceSnippet(fact.sourceText);
  const sourceLower = sourceText.toLowerCase();

  if (fieldName === "broker_name") {
    if (!valueText || valueText.split(/\s+/).length > 10) return reject("broker_name: value is empty or longer than 10 words");
    if (/\b(?:costs?\s+of\s+reletting|reletting|damages?|attorneys?|repairs?|maintenance|alterations?|default|remedies?)\b/i.test(valueText)) return reject("broker_name: value itself contains reletting/damages/repairs/default language, not a broker name");
    if (/\b(?:costs?\s+of\s+reletting|damages?|attorneys?|repairs?|maintenance|alterations?|default|remedies?)\b/i.test(sourceText) && !/\b(?:broker|brokers|brokerage|real\s+estate\s+broker|realtor|realty)\b/i.test(sourceText)) return reject("broker_name: source text frames this as a reletting/damages remedies clause with no broker/brokerage token present");
    if (!/\b(?:broker|brokers|brokerage|real\s+estate\s+broker|realtor|realty)\b/i.test(`${sourceText} ${valueText}`)) return reject("broker_name: neither value nor source text contains a broker/brokerage/realty token");
  }

  if (fieldName === "permitted_use" || fieldName === "premises_use") {
    if (!valueText || valueText.length > 90) return reject(`${fieldName}: value is empty or longer than 90 characters`);
    if (/^\s*(?:as\s+is|where\s+is|as\s+is,?\s+where\s+is|premises|permitted\s+use)\s*$/i.test(valueText)) return reject(`${fieldName}: value is just a label/heading fragment ("as is", "premises", "permitted use"), not an actual use description`);
    if (/\b(?:delivery\s+of\s+possession|good\s+order|condition\s+and\s+repair|maintenance|common\s+areas?|signage|default|assignment|consent)\b/i.test(valueText)) return reject(`${fieldName}: value contains delivery/condition/maintenance/consent language, not a use description`);
    if (!/\b(?:permitted\s+use|use\s+of\s+(?:the\s+)?premises|shall\s+be\s+used|shall\s+use|solely\s+for|operation\s+of|purpose)\b/i.test(sourceText)) return reject(`${fieldName}: source text has no permitted-use framing language`);
  }

  if (fieldName === "property_address") {
    if (!valueText || valueText.length < 8) return reject("property_address: value is empty or shorter than 8 characters");
    if (/\b(?:as\s+is|where\s+is|condition|delivery\s+of\s+possession|tenant\s+acknowledges)\b/i.test(valueText)) return reject("property_address: value contains \"as is\"/condition/delivery-of-possession language, not an address");
    if (/\b(?:as\s+is|where\s+is|delivery\s+of\s+possession)\b/i.test(sourceText)) return reject("property_address: source text is an \"as is\"/delivery-of-possession clause, not an address statement");
    if (sourceIsLandlordOrTenantAddress(sourceText) && !/\b(?:premises|property|building)\b/i.test(sourceText)) return reject("property_address: source text is a landlord/tenant mailing address, not the premises/property address");
    if (looksLikeShortUnitIdentifier(valueText)) return reject("property_address: value looks like a short suite/unit identifier, not a full address");
    if (!looksLikeStreetAddress(valueText) && !(sourceIsPremisesLocation(sourceText) && looksLikeStreetAddress(sourceText))) return reject("property_address: neither the value nor the premises-location source text has street-address shape");
  }

  if (fieldName === "unit_number") {
    if (!looksLikeShortUnitIdentifier(valueText)) return reject("unit_number: value does not look like a short suite/unit identifier");
    if (sourceIsLandlordOrTenantAddress(sourceText)) return reject("unit_number: source text is a landlord/tenant mailing address, not a premises unit reference");
    if (/\b(?:rent|square\s+feet|sf|rsf|address\s+of\s+landlord|address\s+of\s+tenant)\b/i.test(valueText)) return reject("unit_number: value contains rent/square-footage/address language, not a unit identifier");
  }

  if (fieldName === "square_footage" || fieldName === "rentable_area_sqft" || fieldName === "tenant_rsf" || fieldName === "building_rsf") {
    const value = normalizeMoneyValue(fact.value);
    if (value === null || value < 100 || value > 5_000_000) return reject(`${fieldName}: value is not a number in the plausible square-footage range (100-5,000,000)`);
    if (!/\b(?:square\s+feet|sq\.?\s*ft\.?|rentable\s+square\s+feet|rsf|\bsf\b|floor\s+area)\b/i.test(sourceText)) return reject(`${fieldName}: source text has no square-footage unit language`);
    if (!sourceHasMoneyOrNumberNearValue(sourceText, value)) return reject(`${fieldName}: the numeric value does not appear as a number/token in the source text`);
  }

  if (fieldName === "lease_term_months") {
    const value = normalizeMoneyValue(fact.value);
    if (value === null || value < 1 || value > 1200) return reject("lease_term_months: value is not a number in the plausible term range (1-1200 months)");
    if (sourceIsHoldoverOrPenaltyRent(sourceText)) return reject("lease_term_months: source text is a holdover/penalty-rent clause, not a term-length statement");
    if (!/\b(?:term|months?|years?|commencement|expiration|expire|through)\b/i.test(sourceText)) return reject("lease_term_months: source text has no term/month/year/commencement/expiration language");
    if (!sourceHasMoneyOrNumberNearValue(sourceText, value) && !/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:month|year)/i.test(sourceText)) return reject("lease_term_months: neither a matching numeral nor a spelled-out month/year count appears in the source text");
  }

  if (fieldName === "monthly_rent") {
    const value = normalizeMoneyValue(fact.value);
    if (/\b(?:%|percent|increase|escalat|renewal)\b/i.test(sourceText) && !/\b(?:per\s+month|monthly|installments?)\b/i.test(sourceText)) return reject("monthly_rent: source text reads as a percentage/escalation/renewal clause with no monthly/installment qualifier");
    const monthlyInstallment = sourceMonthlyInstallmentAmount(sourceText);
    if (monthlyInstallment !== null && value !== null && !roughlyEqualMoney(value, monthlyInstallment)) return reject(`monthly_rent: source text names an explicit monthly-installment amount (${monthlyInstallment}) that does not match this candidate's value (${value})`);
    const annualAmount = sourceAnnualRentAmount(sourceText);
    if (annualAmount !== null && value !== null && roughlyEqualMoney(value, annualAmount)) return reject("monthly_rent: this value equals the source text's stated ANNUAL amount, not a monthly amount");
    if (sourceIsHoldoverOrPenaltyRent(sourceText)) return reject("monthly_rent: source text is a holdover/penalty-rent clause, not a base-rent statement");
    if (value !== null && !sourceHasMoneyOrNumberNearValue(sourceText, value) && !roughlyEqualMoney(value, monthlyInstallment)) return reject("monthly_rent: value does not appear as a matching number/token in the source text");
  }
  if (fieldName === "annual_rent") {
    if (/\b(?:%|percent|increase|escalat|renewal)\b/i.test(sourceText) && !/\b(?:annual|annually|per\s+year|yearly)\b/i.test(sourceText)) return reject("annual_rent: source text reads as a percentage/escalation/renewal clause with no annual/yearly qualifier");
    const value = normalizeMoneyValue(fact.value);
    const annualAmount = sourceAnnualRentAmount(sourceText);
    if (sourceIsHoldoverOrPenaltyRent(sourceText)) return reject("annual_rent: source text is a holdover/penalty-rent clause, not a base-rent statement");
    if (annualAmount !== null && value !== null && roughlyEqualMoney(value, annualAmount)) return true;
    const monthlyInstallment = sourceMonthlyInstallmentAmount(sourceText);
    if (monthlyInstallment !== null && value !== null && roughlyEqualMoney(value, monthlyInstallment)) return reject("annual_rent: this value equals the source text's stated MONTHLY installment amount, not an annual amount");
    if (value !== null && !sourceHasMoneyOrNumberNearValue(sourceText, value)) return reject("annual_rent: value does not appear as a matching number/token in the source text");
  }

  if (fieldName === "tenant_name" || fieldName === "landlord_name") {
    if (!valueText || valueText.split(/\s+/).length > 12) return reject(`${fieldName}: value is empty or longer than 12 words`);
    if (/^[a-z][a-z\s-]+$/.test(valueText) && !/\b(?:llc|l\.l\.c\.|inc|corp|company|co\.|lp|llp|trust|foundation|partners?|crossing|center|restaurant)\b/i.test(valueText)) {
      return reject(`${fieldName}: value looks like lowercase prose with no entity-suffix/proper-noun token`);
    }
    if (!/\b(?:party|parties|between|tenant\s+name|landlord\s+name|lessee\s+name|lessor\s+name|herein\s+called|referred\s+to\s+as|called\s+["']?(?:tenant|landlord|lessee|lessor))\b/i.test(sourceText)) {
      return reject(`${fieldName}: source text has no party-identification framing language`);
    }
    const expectedRole = fieldName === "tenant_name" ? "tenant|lessee" : "landlord|lessor";
    const oppositeRole = fieldName === "tenant_name" ? "landlord|lessor" : "tenant|lessee";
    if (!new RegExp(`(?:herein\\s+called|referred\\s+to\\s+as|called)\\s+["']?(?:${expectedRole})\\b|(?:${expectedRole})\\s+name`, "i").test(sourceText)) {
      return reject(`${fieldName}: source text does not label a party as "${expectedRole.replace("|", "/")}"`);
    }
    const hasExplicitExpectedRole = valueIsLabeledAsRole(valueText, sourceText, expectedRole);
    const hasExplicitOppositeRole = valueIsLabeledAsRole(valueText, sourceText, oppositeRole);
    if (hasExplicitOppositeRole && !hasExplicitExpectedRole) return reject(`${fieldName}: value is explicitly labeled as the OPPOSITE role ("${oppositeRole.replace("|", "/")}") in the source text`);
  }

  if (fieldName === "property_name") {
    if (!valueText || valueText.split(/\s+/).length > 8) return reject("property_name: value is empty or longer than 8 words");
    if (looksLikeStreetAddress(valueText)) return reject("property_name: value looks like a street address, not a marketing/trade name");
    if (/^[a-z][a-z\s-]+$/.test(valueText)) return reject("property_name: value looks like lowercase prose, not a proper name");
    if (/\b(?:license|non-exclusive|common\s+areas?|premises|lease|tenant|landlord|abatement|damage|fault|neglect)\b/i.test(valueText)) return reject("property_name: value contains clause/legal language, not a property name");
    if (/\b(?:building\s*\d+\s*,?\s*suites?|suites?\s*\d+|unit\s*\d+|space\s*\d+)\b/i.test(valueText)) return reject("property_name: value looks like a building/suite/unit/space identifier, not the property's marketing name");
    if (!/\b(?:shopping\s+center|development|plaza|complex|park|building|mall|village|known\s+as|property\s+name)\b/i.test(sourceText)) return reject("property_name: source text has no shopping-center/plaza/building/\"known as\" framing language");
  }
  if (fieldName === "renewal_notice_months") {
    if (!/\b(?:notice|notify|written\s+notice|exercise)\b/i.test(sourceText)) return reject("renewal_notice_months: source text has no notice/notify/exercise language");
    if (!/\b(?:prior|before|advance|not\s+less\s+than|at\s+least)\b/i.test(sourceText)) return reject("renewal_notice_months: source text has no prior/advance/not-less-than timing language");
  }

  if (fieldName === "renewal_options") {
    if (/^\s*\d+(?:\.\d+)?\s*%?\s*$/.test(valueText) && /\b(?:rent|increase|escalat|%)\b/i.test(sourceText)) return reject("renewal_options: value is a bare percentage/number and source text reads as a rent-escalation clause, not a renewal grant");
    if (!/\b(?:renew|renewal|option|extend|extension)\b/i.test(sourceText)) return reject("renewal_options: source text contains no renew/renewal/option/extend/extension language");
    if (/\b(subject\s+and\s+subordinate|deeds?\s+of\s+trust|mortgages?)\b/i.test(sourceLower)) return reject("renewal_options: source text is a subordination/mortgage clause, not a renewal-option grant");
  }

  if (fieldName === "assignment_provisions") {
    if (!/\b(?:assign|assignment|sublet|sublease|transfer)\b/i.test(sourceText)) return reject("assignment_provisions: source text contains no assign/assignment/sublet/sublease/transfer language");
    if (/\b(?:default|failure\s+by\s+tenant|cure\s+period|remed(?:y|ies))\b/i.test(sourceText) && !/\b(?:assign|assignment|sublet|sublease|transfer)\b/i.test(valueText)) return reject("assignment_provisions: source text is a default/cure/remedies clause and the value itself has no assignment-specific language");
  }

  if (fieldName === "landlord_consent_for_transfer") {
    if (!/\b(?:assign|assignment|sublet|sublease|transfer)\b/i.test(sourceText)) return reject("landlord_consent_for_transfer: source text contains no assign/assignment/sublet/sublease/transfer language");
    if (/\bpermitted\s+use\b/i.test(sourceText) && !/\b(?:assign|assignment|sublet|sublease|transfer)\b/i.test(valueText)) return reject("landlord_consent_for_transfer: source text is a permitted-use clause and the value itself has no assignment-specific language");
  }

  if (fieldName === "landlord_consent") {
    if (/\b(?:shall\s+not\s+(?:assign|sublet)|without\s+landlord(?:'s)?\s+(?:prior\s+written\s+)?consent)\b/i.test(sourceText)) return reject("landlord_consent: source text is a prohibition/consent-required clause phrased negatively, not an affirmative consent grant");
  }
  if (fieldName === "assumption_scope") {
    if (!/\b(?:assignee|assignment|assigned|transfer|assumes?\s+(?:the\s+)?(?:obligations|duties|liabilities|lease))\b/i.test(sourceText)) return reject("assumption_scope: source text contains no assignee/assignment/assumes-obligations language");
    if (/\b(?:assumes?\s+all\s+risk|risk\s+of\s+damage|injury\s+or\s+damage|gross\s+negligence)\b/i.test(sourceText) && !/\bassignee\b/i.test(sourceText)) return reject("assumption_scope: source text is a risk-of-loss/negligence clause with no assignee reference");
  }

  if (fieldName === "assignment_consideration") {
    const value = normalizeMoneyValue(fact.value);
    if (value !== null && value <= 0) return reject("assignment_consideration: value is not a positive dollar amount");
    if (!/\b(?:assignment|assignor|assignee|transfer|consideration)\b/i.test(sourceText)) return reject("assignment_consideration: source text contains no assignment/assignor/assignee/consideration language");
    if (value !== null && !sourceHasMoneyOrNumberNearValue(sourceText, value)) return reject("assignment_consideration: value does not appear as a matching number/token in the source text");
  }

  if (fieldName === "escalation_rate") {
    if (sourceIsHoldoverOrPenaltyRent(sourceText)) return reject("escalation_rate: source text is a holdover/penalty-rent clause, not an escalation statement");
    if (!/\b(?:rent|base\s+rent|minimum\s+rent|escalat|increase|renewal)\b/i.test(sourceText)) return reject("escalation_rate: source text has no rent/escalation/increase language");
    if (!/\b(?:%|percent|increase|escalat)\b/i.test(sourceText)) return reject("escalation_rate: source text has no percentage/increase/escalation language");
    if (/^\s*["']?control["']?\s+(?:shall\s+)?mean/i.test(sourceText)) return reject("escalation_rate: source text is a defined-term (\"Control shall mean...\") clause, not an escalation statement");
  }

  if (/^(?:responsibility_taxes|tax_responsibility|responsibility_insurance|insurance_responsibility|property_insurance_responsibility|responsibility_utilities|responsibility_repairs|hvac_responsibility)$/.test(fieldName)) {
    if (!valueLooksLikePartyResponsibility(valueText)) return reject(`${fieldName}: value does not look like a normalized tenant/landlord/shared responsibility answer`);
    if (!sourceHasResponsibilityDomain(fieldName, sourceText)) return reject(`${fieldName}: source text does not mention this field's expense domain (tax/insurance/utilities/repairs/HVAC as applicable)`);
    if (/\b(?:good\s+order,?\s+condition\s+and\s+repair|costs?\s+of\s+reletting|all\s+risk\s+of\s+damage)\b/i.test(valueText)) return reject(`${fieldName}: value contains generic repair/reletting/risk-of-damage clause language, not a responsibility answer`);
  }

  return true;
}

// Every fieldName that has an actual `if (fieldName === "...")` branch in
// looksLikeFieldCompatibleFact above. Kept as an explicit list (not derived)
// so "guard: null" in FieldGuardDecision reliably means "no guard branch
// exists for this field" — the original pipeline audit's confirmed finding
// for ti_allowance/expiration_date/tenant_signatory_name — distinct from
// "a guard exists and this candidate passed it".
const FIELDS_WITH_SHAPE_GUARD = new Set([
  "broker_name", "permitted_use", "premises_use", "property_address", "unit_number",
  "square_footage", "rentable_area_sqft", "tenant_rsf", "building_rsf",
  "lease_term_months", "monthly_rent", "annual_rent", "tenant_name", "landlord_name",
  "property_name", "renewal_notice_months", "renewal_options", "assignment_provisions",
  "landlord_consent_for_transfer", "landlord_consent", "assumption_scope",
  "assignment_consideration", "escalation_rate",
  "responsibility_taxes", "tax_responsibility", "responsibility_insurance",
  "insurance_responsibility", "property_insurance_responsibility",
  "responsibility_utilities", "responsibility_repairs", "hvac_responsibility",
]);

/** Additive-only wrapper: unchanged boolean behavior, explicit reason
 *  reporting. `guard: null` means no guard branch exists for this field at
 *  all (Micro-step 0's "no_guard_configured" case — e.g. ti_allowance,
 *  expiration_date, tenant_signatory_name today) — distinct from a guard
 *  existing and this candidate passing it.
 *
 *  Semantic compatibility layer: in addition to the per-field pattern guard
 *  above (looksLikeFieldCompatibleFact), a candidate for a field with an
 *  entry in FIELD_SEMANTIC_REQUIREMENTS (semantic-compatibility.ts) must also
 *  clear a generalized, role-based compatibility check shared with
 *  legacy_hybrid (merger.ts's mergeField() runs the identical check). This is
 *  the FINAL acceptance gate for those fields -- a semantically incompatible
 *  candidate is hard-rejected here (passed=false -> score forced to 0 by
 *  scoreFactAgainstFieldDetailed below), never merely down-scored. Label/
 *  keyword scoring further down this file remains retrieval/ranking only. */
function explainFieldCompatibility(fact: Fact, fieldName: string): FieldGuardDecision {
  const hasGuard = FIELDS_WITH_SHAPE_GUARD.has(fieldName) || hasSemanticRequirement(fieldName);
  const reasons: string[] = [];
  const patternPassed = looksLikeFieldCompatibleFact(fact, fieldName, reasons);

  let semanticPassed = true;
  if (hasSemanticRequirement(fieldName)) {
    const profile = inferSemanticProfile({ value: fact.value, sourceText: fact.sourceText, category: fact.category ?? null });
    const semanticResult = checkFieldSemanticCompatibility(profile, fieldName, { value: fact.value, sourceText: fact.sourceText, category: fact.category ?? null });
    semanticPassed = semanticResult.compatible;
    if (!semanticPassed && semanticResult.reason) reasons.push(semanticResult.reason);
  }

  const passed = patternPassed && semanticPassed;
  return {
    passed,
    guard: hasGuard ? `${fieldName}_shape_guard` : null,
    reasons: passed ? [] : (reasons.length > 0 ? reasons : [`No specific guard branch exists for field "${fieldName}"; it passed by default.`]),
  };
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
interface ScoringDetail {
  score: number;
  matchedLabels: string[];
  guardResult: FieldGuardDecision;
  clauseCategory: string | null;
  clauseCategoryDecision: string;
  clauseCategoryAllowed: boolean;
  clauseCategoryReasons: string[];
}

/**
 * Micro-step 0: this is the SAME computation scoreFactAgainstField always
 * performed, refactored (not duplicated) so the detail it always computed
 * internally — matched labels, the guard's pass/fail reasoning, the
 * candidate-decision result — can be captured for provenance instead of
 * being discarded once reduced to a single number. scoreFactAgainstField
 * below is now a thin wrapper returning exactly `.score` from this function,
 * so its return value for any given (fact, fieldName, def, moduleType) is
 * provably identical to before this refactor — every early-return, every
 * scoring bonus, and every condition is unchanged, just no longer thrown
 * away after the fact.
 */
function scoreFactAgainstFieldDetailed(fact: Fact, fieldName: string, def: FieldDef, moduleType: ModuleType): ScoringDetail {
  const guardResult = explainFieldCompatibility(fact, fieldName);
  if (!guardResult.passed) {
    return { score: 0, matchedLabels: [], guardResult, clauseCategory: fact.category ?? null, clauseCategoryDecision: "not_evaluated", clauseCategoryAllowed: false, clauseCategoryReasons: [] };
  }

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
  if (decision.decision === "reject") {
    return { score: 0, matchedLabels: [], guardResult, clauseCategory: fact.category ?? null, clauseCategoryDecision: decision.decision, clauseCategoryAllowed: false, clauseCategoryReasons: decision.reasons };
  }

  const haystack = `${fact.sourceText} ${String(fact.value ?? "")}`.toLowerCase();
  let score = 0;
  const matchedLabels: string[] = [];
  const contract = getFieldContract(fieldName);
  const candidateLabels = [...(def.labels || []), ...(contract?.aliases || [])];
  for (const label of candidateLabels) {
    const needle = label.toLowerCase().replace(/_/g, " ");
    if (needle.length < 3) continue;
    if (haystack.includes(needle)) {
      matchedLabels.push(label);
      score = Math.max(score, needle.length);
    }
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

  return {
    score,
    matchedLabels,
    guardResult,
    clauseCategory: fact.category ?? null,
    clauseCategoryDecision: decision.decision,
    clauseCategoryAllowed: decision.matchedAllowedCategories.length > 0,
    clauseCategoryReasons: decision.reasons,
  };
}

function scoreFactAgainstField(fact: Fact, fieldName: string, def: FieldDef, moduleType: ModuleType): number {
  return scoreFactAgainstFieldDetailed(fact, fieldName, def, moduleType).score;
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
  // Micro-step 0: every (fact, detail) pair ever considered for a TRACKED
  // field, regardless of whether it won, lost, or was rejected — purely
  // additive bookkeeping alongside the existing bestByField/unmappedFacts/
  // rejectedCandidates tracking above, which is completely unchanged by
  // this addition. Bounded to TRACKED_PROVENANCE_FIELDS so this never grows
  // unboundedly for the other ~78 schema fields this Micro-step doesn't
  // instrument.
  const provenanceCandidatesByField = new Map<string, Array<{ fact: Fact; detail: ScoringDetail }>>();

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
      const isTracked = TRACKED_PROVENANCE_FIELDS.has(fieldName);
      // Same computation as always (scoreFactAgainstFieldDetailed's `.score`
      // is byte-identical to the old scoreFactAgainstField's return value —
      // see that function's own comment) — just also keeping the detail
      // object around when this is a tracked field, instead of only ever
      // asking for the plain number.
      const detail = isTracked
        ? scoreFactAgainstFieldDetailed(fact, fieldName, fieldDef, moduleType)
        : null;
      const score = detail ? detail.score : scoreFactAgainstField(fact, fieldName, fieldDef, moduleType);
      if (isTracked && detail) {
        const list = provenanceCandidatesByField.get(fieldName) ?? [];
        list.push({ fact, detail });
        provenanceCandidatesByField.set(fieldName, list);
      }
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

  // Micro-step 0: build fieldProvenance for TRACKED_PROVENANCE_FIELDS only,
  // from the bookkeeping collected above — this does not alter `fields`,
  // `record`, or `validated` in any way; it is read-only summarization of
  // decisions that already happened.
  const fieldProvenance: Record<string, FieldSelectionProvenance> = {};
  for (const fieldName of TRACKED_PROVENANCE_FIELDS) {
    const winner = bestByField.get(fieldName);
    const candidates = provenanceCandidatesByField.get(fieldName) ?? [];
    if (!winner && candidates.length === 0) continue; // nothing to report for this document

    const validationHasError = validated.errors.some((err: any) =>
      (err?.field ?? err?.field_key ?? err?.fieldKey) === fieldName,
    );

    // Was the winner actually scored as a candidate for THIS field, or did
    // it arrive via resolveLeaseTermDatePair's date-pair heuristic or
    // mirrorDateAlias's paired-field copy above? Both are legitimate, but
    // distinct from "won this field's own scoring race" — surfacing this
    // distinction is directly relevant to diagnosing e.g. an
    // expiration_date value that is really end_date's winner copied over.
    const winnerCandidateEntry = winner
      ? candidates.find((c) => c.fact === winner.fact)
      : undefined;

    if (winner && !winnerCandidateEntry) {
      fieldProvenance[fieldName] = {
        fieldKey: fieldName,
        pipelinePath: "openai_fact_ledger",
        chunkIndex: typeof winner.fact.chunkIndex === "number" ? winner.fact.chunkIndex : null,
        clauseCategory: winner.fact.category ?? null,
        clauseCategoryDecision: null,
        clauseCategoryAllowed: null,
        clauseCategoryReasons: [],
        mapperScore: null,
        matchedLabels: [],
        shapeGuard: { passed: true, guard: null, reasons: ["Value assigned via a paired-date-field heuristic (resolveLeaseTermDatePair or mirrorDateAlias), not this field's own per-fact scoring."] },
        modelConfidence: typeof winner.fact.confidence === "number" ? winner.fact.confidence : null,
        ruleConfidence: null,
        validationStatus: validationHasError ? "rejected" : "accepted",
        selected: toCandidateSummary(winner.fact, null),
        competingCandidates: [],
        rejectedCandidates: [],
      };
      continue;
    }

    const sorted = [...candidates].sort((a, b) => b.detail.score - a.detail.score);
    const competing = sorted
      .filter((c) => c.fact !== winner?.fact && c.detail.guardResult.passed && c.detail.clauseCategoryDecision !== "reject" && c.detail.score > 0)
      .slice(0, CANDIDATE_LIST_MAX_LENGTH)
      .map((c) => toCandidateSummary(c.fact, c.detail.score));
    const rejected = sorted
      .filter((c) => c.fact !== winner?.fact && (!c.detail.guardResult.passed || c.detail.clauseCategoryDecision === "reject"))
      .slice(0, CANDIDATE_LIST_MAX_LENGTH)
      .map((c): FieldRejectedCandidateSummary => ({
        ...toCandidateSummary(c.fact, c.detail.score),
        rejectionReason: !c.detail.guardResult.passed
          ? c.detail.guardResult.reasons[0] ?? null
          : c.detail.clauseCategoryReasons[0] ?? "clause category rejected",
      }));

    if (winner && winnerCandidateEntry) {
      const { detail } = winnerCandidateEntry;
      fieldProvenance[fieldName] = {
        fieldKey: fieldName,
        pipelinePath: "openai_fact_ledger",
        chunkIndex: typeof winner.fact.chunkIndex === "number" ? winner.fact.chunkIndex : null,
        clauseCategory: detail.clauseCategory,
        clauseCategoryDecision: detail.clauseCategoryDecision,
        clauseCategoryAllowed: detail.clauseCategoryAllowed,
        clauseCategoryReasons: detail.clauseCategoryReasons,
        mapperScore: detail.score,
        matchedLabels: detail.matchedLabels,
        shapeGuard: detail.guardResult,
        modelConfidence: typeof winner.fact.confidence === "number" ? winner.fact.confidence : null,
        ruleConfidence: null,
        validationStatus: validationHasError ? "rejected" : "accepted",
        selected: toCandidateSummary(winner.fact, detail.score),
        competingCandidates: competing,
        rejectedCandidates: rejected,
      };
    } else if (candidates.length > 0) {
      // No winner at all (field ended up unmapped/null), but candidates were
      // considered and rejected/lost — still worth reporting so a reviewer
      // can see WHY this field is empty rather than just that it is. Prefer
      // the actual guard/reason from the best-ranked candidate that failed
      // its shape/semantic guard (e.g. a semantic-compatibility hard
      // rejection) over the generic "no candidate cleared MIN_LABEL_SCORE"
      // message — that generic message previously overwrote a real,
      // actionable rejection reason whenever the only candidate(s) for a
      // field were guard-rejected rather than merely low-scoring.
      const topGuardRejected = sorted.find((c) => !c.detail.guardResult.passed);
      const fallbackShapeGuard = topGuardRejected
        ? topGuardRejected.detail.guardResult
        : { passed: false, guard: null, reasons: ["No candidate cleared MIN_LABEL_SCORE for this field."] };
      fieldProvenance[fieldName] = {
        fieldKey: fieldName,
        pipelinePath: "openai_fact_ledger",
        chunkIndex: null,
        clauseCategory: null,
        clauseCategoryDecision: null,
        clauseCategoryAllowed: null,
        clauseCategoryReasons: [],
        mapperScore: null,
        matchedLabels: [],
        shapeGuard: fallbackShapeGuard,
        modelConfidence: null,
        ruleConfidence: null,
        validationStatus: "not_run",
        selected: { value: null, sourceText: null, sourcePage: null, chunkIndex: null, mapperScore: null, modelConfidence: null },
        competingCandidates: competing,
        rejectedCandidates: rejected,
      };
    }
  }

  return {
    records: validated.records,
    validationErrors: validated.errors,
    unmappedFacts,
    rejectedCandidates,
    fieldProvenance,
  };
}
