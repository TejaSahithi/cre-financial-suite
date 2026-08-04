/**
 * camLabels — business-friendly display names for CAM Setup technical
 * values. Pure presentation layer: never used for calculation, filtering,
 * or persistence logic — only for what the user sees on screen.
 */

const CALENDAR_TYPE_LABELS = {
  calendar_year: "Calendar Year",
  fiscal_year: "Fiscal Year",
  lease_year: "Lease Year",
  custom: "Custom",
};

const POOL_TYPE_LABELS = {
  property: "Property-Wide",
  building: "Building-Wide",
  custom: "Custom Scope",
};

const SCOPE_TYPE_LABELS = {
  property: "Property-Wide",
  building: "Building",
  unit: "Unit",
  custom: "Custom",
};

const POOL_STATUS_LABELS = {
  draft: "Draft",
  active: "Active",
  closed: "Closed",
};

const RECOVERY_PERIOD_STATUS_LABELS = {
  draft: "Draft",
  open: "Open",
  soft_closed: "Soft Closed",
  locked: "Locked",
};

const RECOVERY_METHOD_LABELS = {
  pro_rata_share: "Area Pro-Rata Share",
  pro_rata: "Area Pro-Rata Share",
  fixed_percentage: "Fixed Contractual Percentage",
};

const ALLOCATION_BASIS_LABELS = {
  rentable_area: "Rentable Area",
  usable_area: "Usable Area",
  gross_area: "Gross Area",
  fixed_contractual: "Fixed Contractual Share",
  pro_rata_sqft: "Rentable Area",
};

const STEP_TYPE_LABELS = {
  INCLUDE_CATEGORY: "Category Included",
  EXCLUDE_CATEGORY: "Category Excluded",
  DIRECT_ASSIGN: "Direct Charge",
  GROSS_UP_VARIABLE: "Gross-Up to Target Occupancy",
  ADD_CAPITAL_AMORTIZATION: "Capital Amortization",
  CALCULATE_SHARE: "Area Pro-Rata Share",
  APPLY_BASE_YEAR: "Base Year Deduction",
  APPLY_EXPENSE_STOP: "Expense Stop",
  APPLY_DEDUCTIBLE: "Deductible",
  APPLY_FLOOR: "Floor",
  APPLY_CAP: "Recovery Cap",
  ADD_MANAGEMENT_FEE: "Management Fee",
  ADD_ADMIN_FEE: "Administrative Fee",
  PRORATE: "Daily Proration",
  RECONCILE_ESTIMATES: "Estimate Reconciliation",
};

const CAP_TYPE_LABELS = {
  fixed_dollar: "Fixed Dollar Cap",
  noncumulative: "Non-Cumulative % Cap",
  cumulative: "Cumulative (Compounding) % Cap",
};

const POLICY_TYPE_LABELS = {
  category_recovery: "Category Recovery",
  pool_participation: "Pool Participation",
  direct_charge: "Direct Charge",
  exclusion: "Exclusion",
};

const POLICY_STATUS_LABELS = {
  draft: "Draft (Not Yet Approved)",
  approved: "Approved Lease Policy",
  rejected: "Rejected",
  superseded: "Superseded",
};

const EFFECTIVE_DATE_SOURCE_LABELS = {
  amendment_effective_date: "Lease Amendment Date",
  lease_commencement: "Lease Commencement Date",
  manual_override: "Manually Confirmed Date",
};

const ADJUSTMENT_TYPE_LABELS = {
  prior_period_adjustment: "Prior Period Adjustment",
  prior_credit: "Prior Credit",
};

const ADJUSTMENT_STATE_LABELS = {
  KNOWN_ZERO: "Confirmed: None Owed",
  KNOWN_AMOUNT: "Confirmed Amount",
  UNKNOWN: "Not Yet Determined",
  NOT_APPLICABLE: "Not Applicable",
};

const PARTICIPANT_STATUS_LABELS = {
  active: "Active Participant",
  ended: "No Longer Participating",
};

const PARTICIPANT_SOURCE_LABELS = {
  explicit: "Explicitly Confirmed",
  legacy_backfill: "From Historical Backfill",
};

const RECOVERABILITY_LABELS = {
  recoverable: "Recoverable",
  non_recoverable: "Not Recoverable",
  conditional: "Conditionally Recoverable",
  excluded: "Excluded",
  needs_review: "Needs Review",
};

const PUBLICATION_STATUS_LABELS = {
  published: "Published",
  withdrawn: "Withdrawn",
  superseded: "Superseded",
};

const READINESS_EXCEPTION_LABELS = {
  RECOVERY_PERIOD_NOT_READY: "Recovery period is not open for calculation",
  POLICY_MISSING: "An approved lease has no materialized recovery policy",
  POLICY_CONFLICT: "A lease has more than one active, conflicting recovery policy",
  PREMISES_MISSING: "A lease with an active policy has no effective premises on file",
  AREA_MISSING: "A premises record has no effective area for this period",
  OCCUPANCY_UNKNOWN: "No occupancy record exists for this scope in this period",
  POOL_CATEGORY_MISSING: "An expense category used by an approved policy is not mapped to any pool",
  POOL_ASSIGNMENT_MISSING: "A published expense has not been assigned to a recovery pool",
  ALLOCATION_UNBALANCED: "An expense's pool assignments do not sum to its full amount",
  BASE_YEAR_MISSING: "A base-year policy step has no base-year amount on file",
  CAP_HISTORY_MISSING: "A cap policy step has no prior-year history to compute against",
  PRIOR_ADJUSTMENT_UNKNOWN: "A prior-period adjustment or credit has not been confirmed",
  EXPENSE_CATEGORY_MISSING: "A published expense has no category assigned",
  EXPENSE_SERVICE_PERIOD_MISSING: "A published expense has no service period on file",
};

function fromMap(map, value, fallback) {
  if (value == null || value === "") return fallback ?? "—";
  return map[value] ?? humanize(value);
}

function humanize(value) {
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function calendarTypeLabel(v) { return fromMap(CALENDAR_TYPE_LABELS, v); }
export function poolTypeLabel(v) { return fromMap(POOL_TYPE_LABELS, v); }
export function scopeTypeLabel(v) { return fromMap(SCOPE_TYPE_LABELS, v); }
export function poolStatusLabel(v) { return fromMap(POOL_STATUS_LABELS, v); }
export function recoveryPeriodStatusLabel(v) { return fromMap(RECOVERY_PERIOD_STATUS_LABELS, v); }
export function recoveryMethodLabel(v) { return fromMap(RECOVERY_METHOD_LABELS, v); }
export function allocationBasisLabel(v) { return fromMap(ALLOCATION_BASIS_LABELS, v); }
export function stepTypeLabel(v) { return fromMap(STEP_TYPE_LABELS, v); }
export function capTypeLabel(v) { return fromMap(CAP_TYPE_LABELS, v); }
export function policyTypeLabel(v) { return fromMap(POLICY_TYPE_LABELS, v); }
export function policyStatusLabel(v) { return fromMap(POLICY_STATUS_LABELS, v, "Draft (Not Yet Approved)"); }
export function effectiveDateSourceLabel(v) { return fromMap(EFFECTIVE_DATE_SOURCE_LABELS, v); }
export function adjustmentTypeLabel(v) { return fromMap(ADJUSTMENT_TYPE_LABELS, v); }
export function adjustmentStateLabel(v) { return fromMap(ADJUSTMENT_STATE_LABELS, v); }
export function participantStatusLabel(v) { return fromMap(PARTICIPANT_STATUS_LABELS, v); }
export function participantSourceLabel(v) { return fromMap(PARTICIPANT_SOURCE_LABELS, v); }
export function recoverabilityLabel(v) { return fromMap(RECOVERABILITY_LABELS, v); }
export function publicationStatusLabel(v) { return fromMap(PUBLICATION_STATUS_LABELS, v); }
export function readinessExceptionLabel(code, fallbackMessage) {
  return READINESS_EXCEPTION_LABELS[code] ?? fallbackMessage ?? humanize(code);
}

/** Common CAM category display names, used only to seed a friendlier default pool name — never used for calculation. */
const CATEGORY_POOL_NAME_HINTS = [
  { match: /operat/i, name: "Operating CAM" },
  { match: /tax/i, name: "Real Estate Taxes" },
  { match: /insur/i, name: "Insurance" },
  { match: /utilit/i, name: "Utilities" },
  { match: /park/i, name: "Parking" },
  { match: /market|promo/i, name: "Marketing" },
  { match: /janitor|clean/i, name: "Janitorial" },
  { match: /landscap/i, name: "Landscaping" },
  { match: /security/i, name: "Security" },
  { match: /snow|ice/i, name: "Snow Removal" },
];

export function suggestedPoolNameForCategory(categoryName) {
  const hint = CATEGORY_POOL_NAME_HINTS.find((h) => h.match.test(categoryName || ""));
  return hint ? hint.name : (categoryName || "Uncategorized");
}
