// @ts-nocheck
/**
 * Deterministic (no-LLM) candidate extraction for the adaptive fact-ledger
 * path (openai-fact-ledger/adaptive-extractor.ts).
 *
 * Reuses rule-extractor.ts's EXISTING, already-tested deterministic
 * extraction (`extractRuleBased`) rather than re-implementing label/pattern/
 * table matching from scratch -- that module already produces exactly the
 * candidate shapes this task's own examples describe (labelled parties,
 * label-adjacent handwritten values, addresses, suite numbers, square
 * footage, currency amounts, percentages, dates, table rows) via
 * extractFromDoclingFields/extractViaLabels/extractViaPatterns/
 * extractFromKeyValueTables/extractRentScheduleFromTables. It has simply
 * never been wired into the openai_fact_ledger provider before now --
 * legacy_hybrid was its only consumer.
 *
 * This module's only real job is a FORMAT bridge: convert rule-extractor's
 * per-field ExtractedField results into the same Fact[] shape LLM-produced
 * facts already use, tagged with a clause category and an LlmCallDomain, so
 * they compete on equal footing inside fact-field-mapper.ts's existing
 * scoring + semantic-compatibility gate -- no new merge logic, no new final
 * publisher.
 */

import { extractRuleBased } from "./rule-extractor.ts";
import { getFieldContract, type FieldGroup } from "./field-contract.ts";
import type { DoclingOutput, ModuleType } from "./types.ts";
import type { Fact } from "./openai-fact-ledger/types.ts";
import type { LlmCallDomain } from "./section-router.ts";

export const FIELD_GROUP_TO_LLM_CALL_DOMAIN: Record<FieldGroup, LlmCallDomain | null> = {
  document_identity: "core_terms",
  parties: "core_terms",
  property_premises: "core_terms",
  term_dates: "core_terms",
  signatures: "core_terms",
  rent_charges: "rent_and_charges",
  expenses_recoveries: "expenses_and_cam",
  cam_rules: "expenses_and_cam",
  taxes: "expenses_and_cam",
  insurance: "expenses_and_cam",
  utilities: "expenses_and_cam",
  repairs_maintenance: "operating_obligations",
  legal_options: "legal_rights_and_dates",
  critical_dates: "legal_rights_and_dates",
  notices: "legal_rights_and_dates",
  budget_inputs: null,
  approval_controls: null,
};

/** Same clause-category vocabulary mapping section-router.ts uses for
 *  SectionDomain, applied here per FieldGroup so a rule-extracted candidate
 *  and an LLM-produced fact for the same real-world concept carry directly
 *  comparable `category` values. */
export const FIELD_GROUP_CLAUSE_CATEGORY: Record<FieldGroup, string> = {
  document_identity: "clause:default",
  parties: "clause:party_identification",
  property_premises: "clause:premises_description",
  term_dates: "clause:lease_term",
  rent_charges: "clause:rent_escalation",
  expenses_recoveries: "clause:operating_expense_recovery",
  cam_rules: "clause:cam_recoveries",
  taxes: "clause:taxes",
  insurance: "clause:insurance",
  utilities: "clause:operating_expense_recovery",
  repairs_maintenance: "clause:repairs_maintenance",
  legal_options: "clause:renewal_option",
  critical_dates: "clause:lease_term",
  notices: "clause:notices",
  signatures: "clause:default",
  budget_inputs: "clause:default",
  approval_controls: "clause:default",
};

export interface DeterministicCandidate {
  fact: Fact;
  fieldKey: string;
  llmCallDomain: LlmCallDomain | null;
}

export interface DeterministicExtractionResult {
  /** All deterministic facts, ready to merge with LLM-produced facts and
   *  feed into mapFactsToStandardFields exactly like any other Fact[]. */
  facts: Fact[];
  candidatesByDomain: Partial<Record<LlmCallDomain, DeterministicCandidate[]>>;
  /** Canonical field keys that already have a non-null, evidence-carrying
   *  rule-extracted value -- consumed by domain-readiness.ts to decide
   *  whether a domain's critical facts are already present. */
  fieldKeysCovered: Set<string>;
}

/**
 * Deterministically extracts every candidate rule-extractor.ts's existing
 * label/pattern/table/docling-field matchers can find, with zero LLM calls,
 * and tags each with the LlmCallDomain it belongs to (for adaptive escalation
 * decisions) and a shared clause category (for scoring parity with LLM facts).
 */
export function extractDeterministicCandidates(
  docling: DoclingOutput,
  moduleType: ModuleType,
): DeterministicExtractionResult {
  const { records } = extractRuleBased(docling, moduleType);
  const record = records[0];
  const facts: Fact[] = [];
  const candidatesByDomain: Partial<Record<LlmCallDomain, DeterministicCandidate[]>> = {};
  const fieldKeysCovered = new Set<string>();

  if (record) {
    for (const [fieldKey, field] of Object.entries(record.fields ?? {})) {
      if (field == null || (field as any).value == null || (field as any).value === "") continue;
      const contract = getFieldContract(fieldKey);
      const group: FieldGroup = contract?.group ?? "document_identity";
      const llmCallDomain = FIELD_GROUP_TO_LLM_CALL_DOMAIN[group] ?? null;
      const category = FIELD_GROUP_CLAUSE_CATEGORY[group] ?? "clause:default";
      const fact: Fact = {
        category,
        value: (field as any).value,
        sourceText: (field as any).sourceText || `${fieldKey}: ${(field as any).value}`,
        sourcePage: (field as any).sourcePage ?? null,
        confidence: typeof (field as any).confidence === "number" ? (field as any).confidence : 0.85,
      };
      facts.push(fact);
      fieldKeysCovered.add(fieldKey);
      if (llmCallDomain) {
        (candidatesByDomain[llmCallDomain] ??= []).push({ fact, fieldKey, llmCallDomain });
      }
    }
  }

  return { facts, candidatesByDomain, fieldKeysCovered };
}
