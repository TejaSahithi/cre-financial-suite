// Resolved Lease Terms — Phase 1 contracts. Mirrors the cam-engine-v2
// contracts/ split: LeaseTermsSnapshot is the frozen input the pure
// resolve() function consumes (built once by load-lease-terms-snapshot.ts);
// ResolvedLeaseTerms is its deterministic output.
//
// See docs/superpowers/specs/2026-08-13-resolved-lease-terms-phase0-1-design.md
// for the full design rationale, including why only rent/premises get true
// effective dating in v1.

export interface RentScheduleRow {
  id: string;
  row_type: string; // base_rent | ground_rent | percentage_rent | abatement | renewal_base_rent | holdover_rent | manual
  phase: string; // contracted | approved_renewal | assumed_renewal | holdover
  period_start: string; // ISO date
  period_end: string; // ISO date
  monthly_amount: number | null;
  annual_amount: number | null;
  rsf: number | null;
  status: string; // draft | approved | superseded | archived
  is_abatement: boolean;
  abatement_percent: number | null;
  building_id: string | null;
  unit_id: string | null;
  approved_at: string | null;
  approved_by: string | null;
  source: string; // approved_abstract | manual — row's own provenance; approved_abstract rows chain to the lease's approved rent field for document evidence, manual rows have none
}

export interface AbstractSnapshotFieldEntry {
  value: unknown;
  source_page: number | null;
  source_text: string | null;
  reviewer: string | null;
  reviewed_at: string | null;
}

export interface ExpenseRuleSetPointer {
  id: string;
  status: string; // draft | review_required | reviewed | approved | archived
  approvedAt: string | null;
}

export interface LeaseTermsSnapshot {
  leaseId: string;
  orgId: string;
  propertyId: string | null;
  unitId: string | null;
  abstractVersion: number;
  approvedAt: string | null;
  approvedFields: Record<string, AbstractSnapshotFieldEntry>;
  sourceDocumentId: string | null;
  rentScheduleRows: RentScheduleRow[];
  expenseRuleSet: ExpenseRuleSetPointer | null;
}

export interface SourceEvidenceRef {
  kind: "abstract_field" | "rent_schedule_row";
  fieldKey?: string;
  rentScheduleId?: string;
  scheduleSource?: string; // rent_schedules.source ("approved_abstract" | "manual") — only set for kind "rent_schedule_row"
  documentId: string | null;
  sourcePage: number | null;
  sourceText: string | null;
  abstractVersion: number;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface UnresolvedTerm {
  term: string;
  code: string;
  message: string;
}

export interface ResolvedRent {
  monthlyAmount: number | null;
  annualAmount: number | null;
  rowType: string;
  phase: string;
  periodStart: string;
  periodEnd: string;
  abatementApplied: { percent: number | null; monthlyAmount: number | null } | null;
  effectiveDatingSupported: true;
}

export interface ResolvedPremises {
  propertyId: string | null;
  buildingId: string | null;
  unitId: string | null;
  rsf: number | null;
  // true only when buildingId/rsf came from the asOfDate-matched rent
  // schedule row; false when rent itself was unresolved (gap/overlap) —
  // propertyId/unitId (lease-level, not date-dependent) stay populated
  // either way.
  effectiveDatingSupported: boolean;
}

export interface ResolvedRecoveryPointer {
  ruleSetId: string | null;
  status: string | null;
  effectiveDatingSupported: false;
}

export interface ResolvedPercentageRent {
  hasScheduledPercentageRentRows: boolean;
  rowCount: number;
  effectiveDatingSupported: false;
}

export interface ResolvedLeaseTerms {
  leaseId: string;
  asOfDate: string;
  premises: ResolvedPremises | null;
  rent: ResolvedRent | null;
  expenseRecovery: ResolvedRecoveryPointer | null;
  cam: ResolvedRecoveryPointer | null;
  managementFee: Record<string, unknown> | null;
  percentageRent: ResolvedPercentageRent | null;
  taxes: Record<string, unknown> | null;
  insurance: Record<string, unknown> | null;
  utilities: Record<string, unknown> | null;
  hvac: Record<string, unknown> | null;
  renewalOptions: Record<string, unknown> | null;
  reportingRequirements: null;
  unresolvedTerms: UnresolvedTerm[];
  sourceEvidence: SourceEvidenceRef[];
}
