import type {
  LeaseTermsSnapshot,
  RentScheduleRow,
  ResolvedLeaseTerms,
  ResolvedPercentageRent,
  ResolvedPremises,
  ResolvedRecoveryPointer,
  ResolvedRent,
  SourceEvidenceRef,
  UnresolvedTerm,
} from "./contracts/resolved-lease-terms.ts";
import { evaluateHvacResponsibility } from "../lease-responsibilities/hvac-responsibility-evaluator.ts";

const BASE_RENT_ROW_TYPES = new Set([
  "base_rent",
  "ground_rent",
  "renewal_base_rent",
  "holdover_rent",
  "manual",
]);

const TERM_FIELD_KEYS: Record<string, string[]> = {
  managementFee: ["management_fee_basis", "admin_fee_pct", "admin_fee_percent"],
  taxes: ["tax_responsibility", "real_estate_tax_responsibility", "tax_reimbursement_method"],
  insurance: [
    "insurance_responsibility",
    "property_insurance_responsibility",
    "tenant_insurance_required",
    "general_liability_min",
    "waiver_of_subrogation",
    "additional_insureds_required",
  ],
  utilities: [
    "responsibility_utilities",
    "electric_responsibility",
    "water_sewer_responsibility",
    "utility_reimbursement_amount",
    "water_sewer_reimbursement_amount",
  ],
  hvac: ["hvac_responsibility"],
  renewalOptions: ["renewal_options", "renewal_type", "right_of_first_refusal", "renewal_notice_months"],
};

function screamingSnakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function coversDate(row: RentScheduleRow, asOfDate: string): boolean {
  return row.period_start <= asOfDate && asOfDate <= row.period_end;
}

function rentEvidence(row: RentScheduleRow, abstractVersion: number): SourceEvidenceRef {
  return {
    kind: "rent_schedule_row",
    rentScheduleId: row.id,
    documentId: null,
    sourcePage: null,
    sourceText: null,
    abstractVersion,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}

function fieldEvidence(fieldKey: string, snapshot: LeaseTermsSnapshot): SourceEvidenceRef | null {
  const entry = snapshot.approvedFields[fieldKey];
  if (!entry) return null;
  return {
    kind: "abstract_field",
    fieldKey,
    documentId: snapshot.sourceDocumentId,
    sourcePage: entry.source_page,
    sourceText: entry.source_text,
    abstractVersion: snapshot.abstractVersion,
    approvedBy: entry.reviewer,
    approvedAt: entry.reviewed_at,
  };
}

function passThroughSection(
  termName: string,
  snapshot: LeaseTermsSnapshot,
  unresolvedTerms: UnresolvedTerm[],
  sourceEvidence: SourceEvidenceRef[],
): Record<string, unknown> | null {
  const keys = TERM_FIELD_KEYS[termName] ?? [];
  const values: Record<string, unknown> = {};
  let any = false;
  for (const key of keys) {
    const entry = snapshot.approvedFields[key];
    if (!entry) continue;
    values[key] = entry.value;
    any = true;
    const evidence = fieldEvidence(key, snapshot);
    if (evidence) sourceEvidence.push(evidence);
  }
  if (!any) {
    unresolvedTerms.push({
      term: termName,
      code: `${screamingSnakeCase(termName)}_NOT_FOUND`,
      message: `No approved lease fields found for ${termName}.`,
    });
    return null;
  }
  values.effectiveDatingSupported = false;
  return values;
}


function resolveHvacSection(
  snapshot: LeaseTermsSnapshot,
  unresolvedTerms: UnresolvedTerm[],
  sourceEvidence: SourceEvidenceRef[],
): Record<string, unknown> | null {
  const entry = snapshot.approvedFields.hvac_responsibility;
  if (!entry) {
    unresolvedTerms.push({
      term: "hvac",
      code: "HVAC_NOT_FOUND",
      message: "No approved HVAC responsibility field found.",
    });
    return null;
  }

  const evidence = fieldEvidence("hvac_responsibility", snapshot);
  if (evidence) sourceEvidence.push(evidence);
  const evaluated = evaluateHvacResponsibility({
    responsibility: entry.value as string | null,
    text: entry.source_text || String(entry.value || ""),
    source: evidence ? { ...evidence } : {},
  });

  if (evaluated.status === "review_required") {
    unresolvedTerms.push({
      term: "hvac",
      code: evaluated.reasonCodes[0] || "HVAC_REVIEW_REQUIRED",
      message: "HVAC responsibility could not be deterministically resolved from the approved lease term.",
    });
  }

  return {
    approvedValue: entry.value,
    status: evaluated.status,
    responsibility: evaluated.responsibility,
    thresholdAmount: evaluated.thresholdAmount ?? null,
    replacementResponsibility: evaluated.replacementResponsibility ?? null,
    reasonCodes: evaluated.reasonCodes,
    effectiveDatingSupported: false,
  };
}
function emptyResolvedLeaseTerms(leaseId: string, asOfDate: string): ResolvedLeaseTerms {
  return {
    leaseId,
    asOfDate,
    premises: null,
    rent: null,
    expenseRecovery: null,
    cam: null,
    managementFee: null,
    percentageRent: null,
    taxes: null,
    insurance: null,
    utilities: null,
    hvac: null,
    renewalOptions: null,
    reportingRequirements: null,
    unresolvedTerms: [],
    sourceEvidence: [],
  };
}

export function resolveLeaseTerms(snapshot: LeaseTermsSnapshot, asOfDate: string): ResolvedLeaseTerms {
  if (!snapshot.approvedAt || asOfDate < snapshot.approvedAt.slice(0, 10)) {
    const result = emptyResolvedLeaseTerms(snapshot.leaseId, asOfDate);
    result.unresolvedTerms.push({
      term: "*",
      code: "LEASE_NOT_YET_APPROVED_AS_OF_DATE",
      message: `Lease has no approved terms as of ${asOfDate}; earliest approval is ${snapshot.approvedAt ?? "none"}.`,
    });
    return result;
  }

  const unresolvedTerms: UnresolvedTerm[] = [];
  const sourceEvidence: SourceEvidenceRef[] = [];

  const baseRows = snapshot.rentScheduleRows.filter(
    (row) => row.status === "approved" && BASE_RENT_ROW_TYPES.has(row.row_type) && coversDate(row, asOfDate),
  );
  const abatementRows = snapshot.rentScheduleRows.filter(
    (row) => row.status === "approved" && (row.row_type === "abatement" || row.is_abatement) &&
      coversDate(row, asOfDate),
  );
  const percentageRows = snapshot.rentScheduleRows.filter(
    (row) => row.status === "approved" && row.row_type === "percentage_rent" && coversDate(row, asOfDate),
  );

  let rent: ResolvedRent | null = null;
  let matchedRow: RentScheduleRow | null = null;
  if (baseRows.length === 0) {
    unresolvedTerms.push({
      term: "rent",
      code: "RENT_SCHEDULE_GAP",
      message: `No approved rent schedule row covers ${asOfDate}.`,
    });
  } else if (baseRows.length > 1) {
    unresolvedTerms.push({
      term: "rent",
      code: "RENT_SCHEDULE_OVERLAP",
      message: `${baseRows.length} approved rent schedule rows cover ${asOfDate}; cannot determine which applies.`,
    });
  } else {
    matchedRow = baseRows[0];
    rent = {
      monthlyAmount: matchedRow.monthly_amount,
      annualAmount: matchedRow.annual_amount,
      rowType: matchedRow.row_type,
      phase: matchedRow.phase,
      periodStart: matchedRow.period_start,
      periodEnd: matchedRow.period_end,
      abatementApplied: abatementRows.length > 0
        ? { percent: abatementRows[0].abatement_percent, monthlyAmount: abatementRows[0].monthly_amount }
        : null,
      effectiveDatingSupported: true,
    };
    sourceEvidence.push(rentEvidence(matchedRow, snapshot.abstractVersion));
    for (const row of abatementRows) sourceEvidence.push(rentEvidence(row, snapshot.abstractVersion));
  }

  const premises: ResolvedPremises = {
    propertyId: snapshot.propertyId,
    buildingId: matchedRow?.building_id ?? null,
    unitId: matchedRow?.unit_id ?? snapshot.unitId,
    rsf: matchedRow?.rsf ?? null,
  };

  const percentageRent: ResolvedPercentageRent | null = percentageRows.length > 0
    ? {
      hasScheduledPercentageRentRows: true,
      rowCount: percentageRows.length,
      effectiveDatingSupported: false,
    }
    : null;
  if (!percentageRent) {
    unresolvedTerms.push({
      term: "percentageRent",
      code: "PERCENTAGE_RENT_NOT_FOUND",
      message: "No percentage rent schedule rows found for this period.",
    });
  }

  let expenseRecovery: ResolvedRecoveryPointer | null = null;
  if (!snapshot.expenseRuleSet) {
    unresolvedTerms.push({
      term: "expenseRecovery",
      code: "EXPENSE_RECOVERY_NOT_FOUND",
      message: "No expense rule set found for this lease.",
    });
  } else {
    expenseRecovery = {
      ruleSetId: snapshot.expenseRuleSet.id,
      status: snapshot.expenseRuleSet.status,
      effectiveDatingSupported: false,
    };
    if (snapshot.expenseRuleSet.status !== "approved") {
      unresolvedTerms.push({
        term: "expenseRecovery",
        code: "EXPENSE_RECOVERY_NOT_APPROVED",
        message: `Expense rule set ${snapshot.expenseRuleSet.id} has status "${snapshot.expenseRuleSet.status}", not "approved".`,
      });
    }
  }

  unresolvedTerms.push({
    term: "reportingRequirements",
    code: "REPORTING_REQUIREMENTS_NOT_MODELED",
    message: "No lease schema fields model reporting requirements yet; percentage rent reporting is a later domain.",
  });

  return {
    leaseId: snapshot.leaseId,
    asOfDate,
    premises,
    rent,
    expenseRecovery,
    cam: expenseRecovery ? { ...expenseRecovery } : null,
    managementFee: passThroughSection("managementFee", snapshot, unresolvedTerms, sourceEvidence),
    percentageRent,
    taxes: passThroughSection("taxes", snapshot, unresolvedTerms, sourceEvidence),
    insurance: passThroughSection("insurance", snapshot, unresolvedTerms, sourceEvidence),
    utilities: passThroughSection("utilities", snapshot, unresolvedTerms, sourceEvidence),
    hvac: resolveHvacSection(snapshot, unresolvedTerms, sourceEvidence),
    renewalOptions: passThroughSection("renewalOptions", snapshot, unresolvedTerms, sourceEvidence),
    reportingRequirements: null,
    unresolvedTerms,
    sourceEvidence,
  };
}
