// @ts-nocheck
import { diffCompatibilityFields, diffFieldOrdering } from "../../claims/adapters/compatibility-diff.ts";
import type { CompatibilityFieldEntry } from "../../claims/adapters/compatibility-payload-builder.ts";
import type { FinancialFieldProjection, FinancialProjectionDiffClassification, FinancialProjectionDiffResult, FinancialScheduleProjection } from "./financial-projection-types.ts";

function translateBase(classification: string): FinancialProjectionDiffClassification {
  if (classification === "missing_in_claim_projection") return "missing_in_p4_projection";
  if (classification === "extra_in_claim_projection") return "extra_in_p4_projection";
  if (classification === "value_mismatch") return "stated_calculated_mismatch";
  return classification as FinancialProjectionDiffClassification;
}

function projectionByCompatibilityKey(rows: FinancialFieldProjection[]) {
  const out = new Map<string, FinancialFieldProjection>();
  for (const row of rows) if (row.compatibilityFieldKey) out.set(row.compatibilityFieldKey, row);
  return out;
}

export function diffFinancialCompatibility(input: {
  currentFields: Record<string, CompatibilityFieldEntry>;
  p4Fields: Record<string, CompatibilityFieldEntry>;
  fieldProjections?: FinancialFieldProjection[];
  scheduleProjections?: FinancialScheduleProjection[];
  valueTypeByFieldKey?: Map<string, string>;
}): FinancialProjectionDiffResult[] {
  const rowsByField = projectionByCompatibilityKey(input.fieldProjections ?? []);
  const base = diffCompatibilityFields(input.currentFields ?? {}, input.p4Fields ?? {}, { valueTypeByFieldKey: input.valueTypeByFieldKey });
  const results: FinancialProjectionDiffResult[] = [];

  for (const item of base) {
    const row = rowsByField.get(item.fieldKey);
    let classification = translateBase(item.classification);
    if (item.classification === "extra_in_claim_projection" && row?.valueOrigin === "calculated" && /date$/i.test(item.fieldKey)) classification = "date_resolved";
    else if (item.classification === "extra_in_claim_projection" && row?.valueOrigin === "calculated") classification = "calculated_value_added";
    else if (item.classification === "extra_in_claim_projection" && row?.valueOrigin === "extracted") classification = "extracted_value_added";
    if (row?.projectionStatus === "requires_related_document") classification = "related_document_required";
    if (row?.projectionStatus === "unresolved") classification = row.formulaKey ? "formula_unresolved" : "date_remains_unresolved";
    if (row?.conflictId || row?.valueOrigin === "stated_calculated_mismatch") classification = "stated_calculated_mismatch";
    results.push({ fieldKey: item.fieldKey, classification, currentValue: item.legacyValue, p4Value: item.claimValue, detail: row?.formulaKey ?? null });
  }

  for (const schedule of input.scheduleProjections ?? []) {
    if (schedule.amountRole === "first_year_billed_rent") {
      const currentAnnual = input.currentFields?.annual_rent?.value;
      if (currentAnnual !== undefined && String(currentAnnual) !== String(schedule.amount ?? "")) {
        results.push({ fieldKey: "first_year_billed_rent", classification: "annualized_vs_billed_corrected", currentValue: currentAnnual, p4Value: schedule.amount, detail: "first-year billed schedule remains distinct from annualized reference" });
      }
    }
    if (schedule.scheduleType === "free_rent_period" || schedule.billingStatus === "fully_abated") {
      results.push({ fieldKey: schedule.scheduleKey, classification: "free_rent_applied", p4Value: schedule.amount ?? 0, detail: `${schedule.startTermMonth ?? "?"}-${schedule.endTermMonth ?? "?"}` });
    }
    if (schedule.scheduleStatus === "unresolved" && schedule.formulaKey) {
      results.push({ fieldKey: schedule.scheduleKey, classification: "formula_unresolved", detail: schedule.formulaKey });
    }
    if (schedule.conflictId) results.push({ fieldKey: schedule.scheduleKey, classification: "financial_conflict", detail: schedule.conflictId });
  }

  if (diffFieldOrdering(input.currentFields ?? {}, input.p4Fields ?? {})) results.push({ fieldKey: "__field_order__", classification: "ordering_mismatch" });
  return results.sort((a, b) => a.fieldKey.localeCompare(b.fieldKey) || a.classification.localeCompare(b.classification));
}

export function summarizeFinancialDiff(results: FinancialProjectionDiffResult[]) {
  const summary: Record<string, number> = {
    equal: 0, representation_only: 0, extracted_value_added: 0, calculated_value_added: 0, date_resolved: 0, date_remains_unresolved: 0, term_resolved: 0, rent_schedule_enriched: 0, annualized_vs_billed_corrected: 0, free_rent_applied: 0, escalation_calculated: 0, deposit_reconciled: 0, amortization_validated: 0, stated_calculated_match: 0, stated_calculated_mismatch: 0, formula_unresolved: 0, related_document_required: 0, financial_conflict: 0, missing_in_p4_projection: 0, extra_in_p4_projection: 0, evidence_mismatch: 0, status_mismatch: 0, ordering_mismatch: 0,
  };
  for (const result of results) summary[result.classification] = (summary[result.classification] ?? 0) + 1;
  return summary;
}

export function shouldStoreDetailedDiffArtifact(results: FinancialProjectionDiffResult[], maxInline = 100) {
  return results.length > maxInline;
}
