// @ts-nocheck
/**
 * Vertex Fact Ledger — Dynamic Fact Surfacer
 *
 * Emits rows in the EXACT existing shape lease-workflow.ts's
 * createDocumentItem() produces (that function is called directly, not
 * reimplemented) so dynamicFields.js's collectExtractedDocumentItems() picks
 * these up with zero frontend changes: maps_to_existing_field: false and
 * creates_dynamic_row: true are createDocumentItem()'s defaults whenever no
 * field_key is supplied and source_text is present.
 */

import { createDocumentItem } from "../lease-workflow.ts";
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
    const dedupeKey = `${fact.category}|${fact.sourceText.toLowerCase().slice(0, 140)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    items.push(createDocumentItem({
      item_id: `vertex_fact:${fact.category}:${dedupeKey.slice(0, 60)}`,
      document_profile: documentProfile,
      item_type: fact.category,
      business_area: "clause_records",
      label: titleizeCategory(fact.category),
      value: fact.value,
      normalized_value: fact.value,
      raw_value: fact.value,
      source_text: fact.sourceText,
      source_page: fact.sourcePage,
      confidence: fact.confidence,
      extraction_method: "vertex_fact_ledger",
      extraction_status: "extracted",
      maps_to_existing_field: false,
      maps_to_fixed_field: false,
      creates_dynamic_row: true,
    }));
  }

  return items;
}
