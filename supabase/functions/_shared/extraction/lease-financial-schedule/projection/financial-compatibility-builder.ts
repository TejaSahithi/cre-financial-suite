// @ts-nocheck
import { buildCompatibilityExtractionDataSlice } from "../../claims/adapters/compatibility-payload-builder.ts";
import { fieldGroupMap, toCompatibilityFieldProjectionEntries } from "./financial-field-projector.ts";
import { dateResultsToFieldProjections } from "./date-results-to-fields.ts";
import { termResultsToFieldProjections } from "./term-results-to-fields.ts";
import { rentResultsToFieldProjections, rentResultsToScheduleProjections } from "./rent-results-to-schedule.ts";
import { chargeResultsToFieldProjections, chargeResultsToScheduleProjections } from "./charge-results-to-schedule.ts";
import type { FinancialCompatibilityProjectionCandidate, FinancialFieldProjection, FinancialScheduleProjection } from "./financial-projection-types.ts";

const SINGLE_COMPATIBILITY_FIELDS = new Set(["lease_date", "start_date", "end_date", "commencement_date", "expiration_date", "rent_commencement_date", "monthly_rent", "annual_rent", "rent_per_sf", "security_deposit", "ti_allowance", "lease_term_months", "late_fee_amount", "assignment_consideration"]);

function hasEvidence(row: FinancialFieldProjection) {
  const evidence = row.evidenceSummary ?? {};
  return !!(evidence.source_text ?? evidence.sourceText ?? evidence.input_source_text ?? evidence.inputSourceText ?? row.sourceClaimId);
}

function projectionAuthority(row: FinancialFieldProjection) {
  if (row.projectionStatus === "needs_review" || row.valueOrigin === "stated_calculated_mismatch" || row.conflictId) return 100;
  if (row.valueOrigin === "reviewer") return 90;
  if (row.valueOrigin === "extracted") return 80;
  if (row.valueOrigin === "stated_and_validated") return 70;
  if (row.valueOrigin === "calculated" || row.valueOrigin === "derived") return 60;
  return 10;
}

function chooseDuplicateProjection(left: FinancialFieldProjection, right: FinancialFieldProjection) {
  const leftValue = left.normalizedValue === null || left.normalizedValue === undefined ? null : JSON.stringify(left.normalizedValue);
  const rightValue = right.normalizedValue === null || right.normalizedValue === undefined ? null : JSON.stringify(right.normalizedValue);
  if (left.projectionStatus === "available" && right.projectionStatus === "available" && leftValue !== rightValue) return null;
  if (left.projectionStatus !== "available" && right.projectionStatus === "available") return right;
  if (right.projectionStatus !== "available" && left.projectionStatus === "available") return left;
  if (hasEvidence(right) !== hasEvidence(left)) return hasEvidence(right) ? right : left;
  if (projectionAuthority(right) !== projectionAuthority(left)) return projectionAuthority(right) > projectionAuthority(left) ? right : left;
  return (right.compatibilityFieldKey ?? right.fieldKey).localeCompare(left.compatibilityFieldKey ?? left.fieldKey) < 0 ? right : left;
}

function dedupeCompatibleFieldProjections(rows: FinancialFieldProjection[]) {
  const out: FinancialFieldProjection[] = [];
  const indexes = new Map<string, number>();
  for (const row of rows) {
    const key = row.compatibilityFieldKey ?? row.fieldKey;
    const dedupeKey = `${key}::${row.instanceKey ?? "default"}`;
    if (!SINGLE_COMPATIBILITY_FIELDS.has(key) || row.internalOnly || !indexes.has(dedupeKey)) {
      indexes.set(dedupeKey, out.length);
      out.push(row);
      continue;
    }
    const existingIndex = indexes.get(dedupeKey)!;
    const chosen = chooseDuplicateProjection(out[existingIndex], row);
    if (chosen) out[existingIndex] = chosen;
    else out.push(row);
  }
  return out;
}

function overlayFinancialStatuses(slice: any, fields: FinancialFieldProjection[]) {
  for (const row of fields) {
    const key = row.compatibilityFieldKey;
    if (!key || !slice.fields[key]) continue;
    let status: string | null = null;
    if (row.projectionStatus === "requires_related_document") status = "requires_related_document";
    if (row.projectionStatus === "needs_review" || row.projectionStatus === "ambiguous") status = "conflict_detected";
    if (row.projectionStatus === "unresolved") status = null;
    if (status) {
      slice.fields[key].extraction_status = status;
      slice.field_evidence[key] = { ...slice.fields[key] };
    }
  }
  return slice;
}

export function buildFinancialCompatibilityCandidate(input: {
  dateResults?: any[];
  termResults?: any[];
  rentResults?: any[];
  rentPeriods?: any[];
  chargeResults?: any[];
  extraFieldProjections?: FinancialFieldProjection[];
  extraScheduleProjections?: FinancialScheduleProjection[];
}): FinancialCompatibilityProjectionCandidate {
  const rawFieldProjections = [
    ...dateResultsToFieldProjections(input.dateResults ?? []),
    ...termResultsToFieldProjections(input.termResults ?? []),
    ...rentResultsToFieldProjections(input.rentResults ?? []),
    ...chargeResultsToFieldProjections(input.chargeResults ?? []),
    ...(input.extraFieldProjections ?? []),
  ];
  const fieldProjections = dedupeCompatibleFieldProjections(rawFieldProjections)
    .sort((a, b) => (a.compatibilityFieldKey ?? a.fieldKey).localeCompare(b.compatibilityFieldKey ?? b.fieldKey) || a.fieldKey.localeCompare(b.fieldKey));

  const scheduleProjections = [
    ...rentResultsToScheduleProjections(input.rentResults ?? [], input.rentPeriods ?? []),
    ...chargeResultsToScheduleProjections(input.chargeResults ?? []),
    ...(input.extraScheduleProjections ?? []),
  ].sort((a, b) => (a.sequenceNumber ?? 999999) - (b.sequenceNumber ?? 999999) || a.scheduleKey.localeCompare(b.scheduleKey));

  const entries = toCompatibilityFieldProjectionEntries(fieldProjections);
  const compatibilitySlice = overlayFinancialStatuses(buildCompatibilityExtractionDataSlice(entries, fieldGroupMap()), fieldProjections);

  return {
    fieldProjections,
    scheduleProjections,
    compatibilitySlice,
    metadata: {
      outputFieldCount: fieldProjections.filter((row) => row.projectionStatus !== "unresolved").length,
      outputScheduleCount: scheduleProjections.length,
      calculatedFieldCount: fieldProjections.filter((row) => ["calculated", "derived", "stated_and_validated"].includes(row.valueOrigin)).length,
      unresolvedFieldCount: fieldProjections.filter((row) => row.projectionStatus === "unresolved" || row.valueOrigin === "unresolved").length,
      conflictCount: fieldProjections.filter((row) => row.conflictId || row.projectionStatus === "needs_review" || row.valueOrigin === "stated_calculated_mismatch").length,
      relatedDocumentCount: fieldProjections.filter((row) => row.projectionStatus === "requires_related_document").length,
    },
  };
}