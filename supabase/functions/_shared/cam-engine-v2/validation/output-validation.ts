// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-D step 6
// ("validate output balancing and currency") and Phase 3B-F ("output
// balance checks", "input currency consistency validation", "maximum
// calculation-line and payload safeguards"). Pure function — runs after
// runCamEngine, before persistence, so a structurally broken result never
// reaches the ledger tables at all.
import type { CamRunInput } from "../contracts/cam-input.ts";
import type { CalcException, CamRunOutput } from "../contracts/cam-output.ts";

// Defends against a runaway/misconfigured snapshot producing an
// unreasonably large payload before it ever reaches persistence — not a
// tuned production limit, just a sane circuit breaker.
export const MAX_CALCULATION_LINES = 500_000;

const CURRENCY_RE = /^[A-Z]{3}$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateCamRunOutput(input: CamRunInput, output: CamRunOutput): CalcException[] {
  const exceptions: CalcException[] = [];

  if (!CURRENCY_RE.test(input.run.currency)) {
    exceptions.push({
      severity: "blocking", code: "CURRENCY_INVALID", entity_type: "cam_runs", entity_id: input.run.id,
      message: `run.currency "${input.run.currency}" is not a valid 3-letter ISO currency code`,
    });
  }
  for (const pool of input.pools) {
    if (pool.currency !== input.run.currency) {
      exceptions.push({
        severity: "blocking", code: "CURRENCY_MISMATCH", entity_type: "recovery_pools", entity_id: pool.id,
        message: `Pool ${pool.id} currency "${pool.currency}" does not match run currency "${input.run.currency}" — mixed-currency runs are not supported`,
      });
    }
  }

  for (const pr of output.pool_results) {
    for (const [field, value] of Object.entries(pr)) {
      if (field === "denominator_metrics") continue;
      if (typeof value === "number" && !isFiniteNumber(value)) {
        exceptions.push({
          severity: "blocking", code: "NON_FINITE_AMOUNT", entity_type: "cam_run_pool_results", entity_id: pr.pool_id,
          message: `Pool result ${pr.pool_id}.${field} is not a finite number (${value})`,
        });
      }
    }
  }
  for (const lr of output.lease_results) {
    for (const [field, value] of Object.entries(lr)) {
      if (typeof value === "number" && !isFiniteNumber(value)) {
        exceptions.push({
          severity: "blocking", code: "NON_FINITE_AMOUNT", entity_type: "cam_run_lease_results", entity_id: lr.lease_id,
          message: `Lease result ${lr.lease_id}.${field} is not a finite number (${value})`,
        });
      }
    }
  }

  if (output.calculation_lines.length > MAX_CALCULATION_LINES) {
    exceptions.push({
      severity: "blocking", code: "CALCULATION_LINE_LIMIT_EXCEEDED", entity_type: "cam_runs", entity_id: input.run.id,
      message: `This run produced ${output.calculation_lines.length} calculation lines, exceeding the safety limit of ${MAX_CALCULATION_LINES} — refusing to persist an unreasonably large payload`,
    });
  }

  return exceptions;
}
