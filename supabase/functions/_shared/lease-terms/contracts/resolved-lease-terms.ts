export interface RentScheduleRow {
  id: string;
  row_type: string;
  phase: string;
  period_start: string;
  period_end: string;
  monthly_amount: number | null;
  annual_amount: number | null;
  rsf: number | null;
  status: string;
  is_abatement: boolean;
  abatement_percent: number | null;
  building_id: string | null;
  unit_id: string | null;
  approved_at: string | null;
  approved_by: string | null;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
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
  status: string;
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

export interface ResolvedPremises {
  propertyId: string | null;
  buildingId: string | null;
  unitId: string | null;
  rsf: number | null;
}

export interface ResolvedRent {
  monthlyAmount: number | null;
  annualAmount: number | null;
  rowType: string;
  phase: string;
  periodStart: string;
  periodEnd: string;
  abatementApplied: {
    percent: number | null;
    monthlyAmount: number | null;
  } | null;
  effectiveDatingSupported: true;
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
  reportingRequirements: Record<string, unknown> | null;
  unresolvedTerms: UnresolvedTerm[];
  sourceEvidence: SourceEvidenceRef[];
}
