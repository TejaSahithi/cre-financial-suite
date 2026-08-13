// Pure function: no I/O, deterministic. All data comes from the frozen
// LeaseTermsSnapshot built by load-lease-terms-snapshot.ts. Mirrors
// cam-engine-v2's orchestrator "load once, calculate many" split — see
// docs/superpowers/specs/2026-08-13-resolved-lease-terms-phase0-1-design.md.
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

const BASE_RENT_ROW_TYPES = new Set(["base_rent", "renewal_base_rent", "holdover_rent", "manual"]);

// Curated subsets of supabase/functions/_shared/extraction/field-contract.ts
// canonical keys — NOT a 1:1 group export. field-contract.ts's cam_rules
// group mixes CAM config with management_fee_basis, repairs_maintenance
// mixes general repairs with HVAC, and legal_options mixes renewal terms
// with assignment/termination terms, so each list below hand-picks only
// the keys that actually mean this term. There is deliberately no
// percentageRent or reportingRequirements entry: no canonical lease-schema
// field models either concept yet (confirmed against field-contract.ts).
const TERM_FIELD_KEYS: Record<string, string[]> = {
  managementFee: ["management_fee_basis"],
  taxes: ["tax_responsibility", "responsibility_taxes"],
  insurance: [
    "insurance_responsibility",
    "responsibility_insurance",
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

function rentEvidence(row: RentScheduleRow, snapshot: LeaseTermsSnapshot): SourceEvidenceRef {
  // rent_schedules rows are generated from the lease's approved rent value
  // (rent-schedule.ts's metadata only ever carries derivation math — never
  // a document/page/text citation). The real document evidence for an
  // approved_abstract-sourced row lives one level up, on the lease's
  // approved monthly_rent/annual_rent field entry; a manual row has no
  // document to cite and correctly stays null.
  const rentField = row.source === "approved_abstract"
    ? snapshot.approvedFields["monthly_rent"] ?? snapshot.approvedFields["annual_rent"] ?? null
    : null;
  return {
    kind: "rent_schedule_row",
    rentScheduleId: row.id,
    scheduleSource: row.source,
    documentId: rentField ? snapshot.sourceDocumentId : null,
    sourcePage: rentField ? rentField.source_page : null,
    sourceText: rentField ? rentField.source_text : null,
    abstractVersion: snapshot.abstractVersion,
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
  const keys = TERM_FIELD_KEYS[termName];
  const values: Record<string, unknown> = {};
  let foundAny = false;
  for (const key of keys) {
    const entry = snapshot.approvedFields[key];
    if (!entry) continue;
    values[key] = entry.value;
    foundAny = true;
    const evidence = fieldEvidence(key, snapshot);
    if (evidence) sourceEvidence.push(evidence);
  }
  if (!foundAny) {
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
  if (!snapshot.approvedAt) {
    const result = emptyResolvedLeaseTerms(snapshot.leaseId, asOfDate);
    result.unresolvedTerms.push({
      term: "*",
      code: "LEASE_NOT_YET_APPROVED_AS_OF_DATE",
      message: "Lease has never been approved; no authoritative terms exist for any date.",
    });
    return result;
  }

  const unresolvedTerms: UnresolvedTerm[] = [];
  const sourceEvidence: SourceEvidenceRef[] = [];

  // --- rent: the only field group with true effective dating in v1 ---
  const baseRows = snapshot.rentScheduleRows.filter(
    (r) =>
      r.status === "approved" && BASE_RENT_ROW_TYPES.has(r.row_type) && r.abstract_version === snapshot.abstractVersion &&
      coversDate(r, asOfDate),
  );
  const percentageRows = snapshot.rentScheduleRows.filter(
    (r) =>
      r.status === "approved" && r.row_type === "percentage_rent" && r.abstract_version === snapshot.abstractVersion &&
      coversDate(r, asOfDate),
  );
  const groundRentRows = snapshot.rentScheduleRows.filter(
    (r) =>
      r.status === "approved" && r.row_type === "ground_rent" && r.abstract_version === snapshot.abstractVersion &&
      coversDate(r, asOfDate),
  );

  let rent: ResolvedRent | null = null;
  let matchedRow: RentScheduleRow | null = null;
  if (baseRows.length === 0) {
    unresolvedTerms.push({ term: "rent", code: "RENT_SCHEDULE_GAP", message: `No approved rent schedule row covers ${asOfDate}.` });
  } else if (baseRows.length > 1) {
    unresolvedTerms.push({
      term: "rent",
      code: "RENT_SCHEDULE_OVERLAP",
      message: `${baseRows.length} approved rent schedule rows cover ${asOfDate}; cannot determine which applies.`,
    });
  } else {
    matchedRow = baseRows[0];
    const overlayAbatementRows = snapshot.rentScheduleRows.filter(
      (r) =>
        r.status === "approved" && r.row_type === "abatement" && r.id !== matchedRow!.id &&
        r.abstract_version === snapshot.abstractVersion && coversDate(r, asOfDate),
    );
    const abatementApplied = matchedRow.is_abatement
      ? { percent: matchedRow.abatement_percent, monthlyAmount: matchedRow.monthly_amount }
      : overlayAbatementRows.length > 0
        ? { percent: overlayAbatementRows[0].abatement_percent, monthlyAmount: overlayAbatementRows[0].monthly_amount }
        : null;
    rent = {
      monthlyAmount: matchedRow.monthly_amount,
      annualAmount: matchedRow.annual_amount,
      rowType: matchedRow.row_type,
      phase: matchedRow.phase,
      periodStart: matchedRow.period_start,
      periodEnd: matchedRow.period_end,
      abatementApplied,
      effectiveDatingSupported: true,
    };
    sourceEvidence.push(rentEvidence(matchedRow, snapshot));
    for (const row of overlayAbatementRows) sourceEvidence.push(rentEvidence(row, snapshot));
  }

  // --- premises: sourced from the matched rent row (real numeric rsf/building_id) ---
  const premises: ResolvedPremises = {
    propertyId: snapshot.propertyId,
    buildingId: matchedRow?.building_id ?? null,
    unitId: matchedRow?.unit_id ?? snapshot.unitId,
    rsf: matchedRow?.rsf ?? null,
    effectiveDatingSupported: matchedRow !== null,
  };

  // --- percentage rent: pointer only; Phase 5 owns the actual calculation ---
  const percentageRent: ResolvedPercentageRent | null = percentageRows.length > 0
    ? { hasScheduledPercentageRentRows: true, rowCount: percentageRows.length, effectiveDatingSupported: false }
    : null;
  if (!percentageRent) {
    unresolvedTerms.push({
      term: "percentageRent",
      code: "PERCENTAGE_RENT_NOT_FOUND",
      message: "No percentage rent schedule rows found for this period.",
    });
  }

  // --- ground rent: additive to base rent (rent-schedule.ts emits both rows
  // for the same period when ground rent applies), not a competing
  // alternative — never counts toward RENT_SCHEDULE_OVERLAP. Not resolved
  // as its own field in v1 (no groundRent field on ResolvedLeaseTerms yet),
  // but its existence must stay visible rather than silently dropped.
  if (groundRentRows.length > 0) {
    unresolvedTerms.push({
      term: "groundRent",
      code: "GROUND_RENT_NOT_RESOLVED",
      message: `${groundRentRows.length} approved ground rent schedule row(s) cover ${asOfDate}; this facade does not resolve ground rent as a separate term in v1.`,
    });
  }

  // --- expenseRecovery / cam: pointer only; CAM V2 owns the actual calculation ---
  let expenseRecovery: ResolvedRecoveryPointer | null = null;
  if (!snapshot.expenseRuleSet) {
    unresolvedTerms.push({ term: "expenseRecovery", code: "EXPENSE_RECOVERY_NOT_FOUND", message: "No expense rule set found for this lease." });
  } else {
    expenseRecovery = { ruleSetId: snapshot.expenseRuleSet.id, status: snapshot.expenseRuleSet.status, effectiveDatingSupported: false };
    if (snapshot.expenseRuleSet.status !== "approved") {
      unresolvedTerms.push({
        term: "expenseRecovery",
        code: "EXPENSE_RECOVERY_NOT_APPROVED",
        message: `Expense rule set ${snapshot.expenseRuleSet.id} has status "${snapshot.expenseRuleSet.status}", not "approved".`,
      });
    }
  }
  const cam = expenseRecovery ? { ...expenseRecovery } : null;

  // --- reporting requirements: no canonical lease-schema field models this
  // yet (confirmed against field-contract.ts) — always unresolved in v1,
  // never a fabricated pass-through of a nonexistent field.
  unresolvedTerms.push({
    term: "reportingRequirements",
    code: "REPORTING_REQUIREMENTS_NOT_MODELED",
    message: "No lease schema fields model reporting requirements yet; see Phase 5 (percentage rent / sales reporting).",
  });

  return {
    leaseId: snapshot.leaseId,
    asOfDate,
    premises,
    rent,
    expenseRecovery,
    cam,
    managementFee: passThroughSection("managementFee", snapshot, unresolvedTerms, sourceEvidence),
    percentageRent,
    taxes: passThroughSection("taxes", snapshot, unresolvedTerms, sourceEvidence),
    insurance: passThroughSection("insurance", snapshot, unresolvedTerms, sourceEvidence),
    utilities: passThroughSection("utilities", snapshot, unresolvedTerms, sourceEvidence),
    hvac: passThroughSection("hvac", snapshot, unresolvedTerms, sourceEvidence),
    renewalOptions: passThroughSection("renewalOptions", snapshot, unresolvedTerms, sourceEvidence),
    reportingRequirements: null,
    unresolvedTerms,
    sourceEvidence,
  };
}
