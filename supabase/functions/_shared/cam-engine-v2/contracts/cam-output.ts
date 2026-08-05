// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3 result
// contract. Every engine function that can encounter a missing or
// ambiguous financial input returns exceptions alongside (or instead of) a
// value — per Phase 3 requirement 15, the engine produces blocking
// exceptions rather than silently defaulting. A BLOCKING exception means
// the run as a whole cannot proceed to POSTED; WARNING/INFO are collected
// but do not by themselves prevent calculation.
//
// Phase 4B rounding contract: CalculationLine now includes segment_start
// and segment_end (already emitted by the engine; now formally declared).
// The engine emits a ROUNDING_DETAIL line (formula_code=ANNUAL_BOUNDARY_ROUND)
// per lease showing:
//   input_amount  = unrounded aggregate (internal precision)
//   output_amount = rounded annual recovery (ledger precision)
//   adjustment    = residual (output - input; often sub-cent)
// Monthly estimate charges round at MONTH inside reconcileEstimates; that
// rounding is captured in the ESTIMATE_RECON line, not ROUNDING_DETAIL.
export type CalcExceptionSeverity = "blocking" | "review_required" | "warning" | "info";

export interface CalcException {
  severity: CalcExceptionSeverity;
  code: string;
  entity_type: string;
  entity_id: string | null;
  message: string;
}

/**
 * A single step in the CAM calculation ledger. line_type is a string
 * (not a union) per the migration header: the blueprint catalog is
 * illustrative, not exhaustive. Registered line_type values:
 *   POOL_SOURCE          — raw pool expense assembly
 *   GROSS_UP             — gross-up adjustment
 *   RESIDUAL_ALLOCATION  — largest-remainder residual correction
 *   TENANT_SHARE         — pro-rata / fixed-percent share calculation
 *   BASE_YEAR            — base-year deduction
 *   CAP                  — controllable-expense cap application
 *   ADMIN_FEE            — administration fee addition
 *   ROUNDING_DETAIL      — Phase 4B annual boundary rounding (one per lease):
 *                          input_amount=unrounded aggregate, output_amount=rounded,
 *                          adjustment=residual, scope in explanation field
 *   ESTIMATE_RECON       — final reconciliation vs. monthly estimates billed
 */
export interface CalculationLine {
  lease_id: string | null;
  pool_id: string | null;
  sequence: number;
  line_type: string;
  category: string | null;
  formula_code: string;
  input_amount: number | null;
  output_amount: number | null;
  adjustment: number | null;
  policy_step_id: string | null;
  explanation: string;
  /** ISO date — the effective-date segment this line covers (or period start/end for annual lines). */
  segment_start: string;
  /** ISO date — the effective-date segment this line covers (or period start/end for annual lines). */
  segment_end: string;

  // --- Rounding disclosure (specification 21.18 / 22) ----------------------
  // Populated on lines that cross a rounding boundary. Intermediate
  // policy-step lines carry high-precision input/output and leave these null:
  // they are deliberately NOT rounded, so there is nothing to disclose.
  /** The full-precision value before any ledger rounding was applied. */
  unrounded_aggregate?: number | null;
  /** The boundary this line was rounded at, e.g. LEASE_POOL_PERIOD. */
  rounding_scope?: string | null;
  /** The value after rounding once at `rounding_scope`. */
  rounded_amount?: number | null;
  /** rounded_amount - unrounded_aggregate, including any largest-remainder correction. */
  rounding_residual?: number | null;
  /** The rounding policy actually in force for this run, frozen onto the line. */
  rounding_policy?: {
    internal_decimal_places: number;
    ledger_decimal_places: number;
    annual_rounding_scope: string;
    estimate_rounding_scope: string;
    residual_allocation: string;
  } | null;
}

export interface PoolResult {
  pool_id: string;
  actual_amount: number;
  excluded_amount: number;
  gross_up_adjustment: number;
  amortization: number;
  adjusted_pool: number;
  denominator_metrics: Record<string, unknown>;
}

export interface LeaseResult {
  lease_id: string;
  final_recovery: number;
  estimates_billed: number;
  amount_due_credit: number;
}

export interface CamRunOutput {
  input_hash: string;
  pool_results: PoolResult[];
  lease_results: LeaseResult[];
  calculation_lines: CalculationLine[];
  exceptions: CalcException[];
  ready_to_post: boolean;
}
