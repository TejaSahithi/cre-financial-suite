// @ts-nocheck
/**
 * OpenAI Fact Ledger — Dynamic Fact Surfacer
 *
 * Emits rows in the EXACT existing shape lease-workflow.ts's
 * createDocumentItem() produces (that function is called directly, not
 * reimplemented) so dynamicFields.js's collectExtractedDocumentItems() picks
 * these up with zero frontend changes: maps_to_existing_field: false and
 * creates_dynamic_row: true are createDocumentItem()'s defaults whenever no
 * field_key is supplied and source_text is present.
 */

import { createDocumentItem } from "../lease-workflow.ts";
import { LEASE_FIELD_CONTRACT } from "../field-contract.ts";
import { normalizeForPageMatch } from "../evidence-index.ts";
import type { CanonicalDocumentIndex, DocumentProfile, Fact } from "./types.ts";

function titleizeCategory(category: string): string {
  const type = category.startsWith("clause:") ? category.slice("clause:".length) : category;
  return type
    .split("_")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Diagnostic only — does not change what gets surfaced. fact-field-mapper.ts
 * already checked every field's labels + aliases and this fact still didn't
 * clear MIN_LABEL_SCORE, so this is a best-effort "near miss" signal (any
 * alias substring, no score threshold) for a future extraction-tuning pass
 * to have real data to work from instead of guessing why facts go unmapped.
 */
function categoryKey(category: string): string {
  return String(category || "").replace(/^clause:/i, "").toLowerCase();
}

const SUPPRESSED_DYNAMIC_CATEGORIES = new Set([
  "default",
  "definition",
  "party_identification",
  "premises_description",
  "lease_term",
  "rent_escalation",
]);

const BUSINESS_AREA_BY_FACT_CATEGORY: Record<string, string> = {
  operating_expense_recovery: "expenses_recoveries",
  cam_recoveries: "cam_rules",
  cam_rules: "cam_rules",
  taxes: "taxes",
  insurance: "insurance",
  utilities: "utilities",
  repairs_maintenance: "repairs_maintenance",
  maintenance: "repairs_maintenance",
  renewal_option: "legal_options",
  assignment_subletting: "legal_options",
  assignment: "legal_options",
  subletting: "legal_options",
  notices: "notices",
  signage: "legal_options",
  permitted_use: "parties_premises",
  use_clause: "parties_premises",
};

function businessAreaForFact(category: string): string {
  return BUSINESS_AREA_BY_FACT_CATEGORY[categoryKey(category)] || "clause_records";
}

function isDefinitionLikeFact(fact: Fact): boolean {
  const source = normalizeForPageMatch(fact.sourceText);
  const value = normalizeForPageMatch(String(fact.value ?? ""));
  return /\b(?:shall mean|means|defined as|is defined)\b/.test(source) ||
    (/^[a-z_ ]{2,40}$/.test(value) && /\b(?:control|affiliate|business days|environmental laws|hazardous materials)\b/.test(source));
}

function shouldSuppressDynamicFact(fact: Fact, possibleCanonicalMatch: string | null): boolean {
  const key = categoryKey(fact.category);
  if (SUPPRESSED_DYNAMIC_CATEGORIES.has(key)) return true;
  if (isDefinitionLikeFact(fact)) return true;

  // Business-domain facts should still surface in their tabs when they fail
  // canonical mapping. A generic word like "tenant" is only a near-miss
  // diagnostic; it should not hide an expense/CAM/tax/insurance finding.
  if (possibleCanonicalMatch && businessAreaForFact(key) === "clause_records") return true;
  return false;
}
function findPossibleCanonicalMatch(fact: Fact): string | null {
  const haystack = `${fact.sourceText} ${String(fact.value ?? "")}`.toLowerCase();
  for (const entry of LEASE_FIELD_CONTRACT) {
    for (const alias of entry.aliases) {
      const needle = alias.toLowerCase().replace(/_/g, " ");
      if (needle.length >= 3 && haystack.includes(needle)) return entry.canonicalKey;
    }
  }
  return null;
}

/**
 * Surface facts that fact-field-mapper.ts could not map onto a standard
 * LEASE_SCHEMA field as dynamic document items, instead of discarding them.
 */
export function surfaceDynamicFacts(args: {
  unmappedFacts: Fact[];
  docIndex: CanonicalDocumentIndex;
  documentProfile: DocumentProfile;
}): any[] {
  const { unmappedFacts, documentProfile } = args;
  const seen = new Set<string>();
  const items: any[] = [];

  for (const fact of unmappedFacts) {
    const dedupeKey = [
      fact.category,
      Number.isFinite(Number(fact.sourcePage)) ? Number(fact.sourcePage) : "unknown_page",
      normalizeForPageMatch(String(fact.value ?? "")),
      normalizeForPageMatch(fact.sourceText),
    ].join("|");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const possibleCanonicalMatch = findPossibleCanonicalMatch(fact);
    if (possibleCanonicalMatch) {
      console.log(
        `[dynamic-fact-surfacer] near_miss category=${fact.category} possible_canonical_match=${possibleCanonicalMatch} ` +
        `— fact-field-mapper.ts's label score didn't clear the threshold for this field`,
      );
    }
    if (shouldSuppressDynamicFact(fact, possibleCanonicalMatch)) continue;

    // createDocumentItem() returns a fixed-shape object (only reads specific
    // named args keys) — the diagnostic tag below is added onto its RETURN
    // value, not passed as an input arg, since it isn't part of that shape.
    const item = createDocumentItem({
      item_id: `openai_fact:${fact.category}:${dedupeKey.slice(0, 60)}`,
      document_profile: documentProfile,
      item_type: fact.category,
      business_area: businessAreaForFact(fact.category),
      label: titleizeCategory(fact.category),
      value: fact.value,
      normalized_value: fact.value,
      raw_value: fact.value,
      source_text: fact.sourceText,
      source_page: fact.sourcePage,
      confidence: fact.confidence,
      extraction_method: "openai_fact_ledger",
      extraction_status: "extracted",
      maps_to_existing_field: false,
      maps_to_fixed_field: false,
      creates_dynamic_row: true,
    });

    // Diagnostic only — does not affect dedup, display, or whether this
    // surfaces as a dynamic row.
    items.push(possibleCanonicalMatch ? { ...item, possible_canonical_match: possibleCanonicalMatch } : item);
  }

  return items;
}
