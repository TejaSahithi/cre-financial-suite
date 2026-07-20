# Module: Revenue, Actuals & Variance

> Generated: 2026-07-20 · Revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` · Canonical score **2.5 / 5**, criticality **11 (High)** — [03](../03-module-catalog-and-maturity.md) · Index: [04](../04-module-deep-dives.md)

## Functional / technical view
The financial-analysis layer that compares budget/plan to actuals. Pages: `Revenue`, `ActualsVariance`, `Actuals`, `Variance`, `Comparison` (YoY), `Reconciliation`. Backend: `compute-revenue`, `compute-reconciliation`. Tables: `actuals`, `computation_snapshots`, `compute_runs`. The `computation_snapshots`/`compute_runs` pattern (point-in-time snapshot of a computation) is a reasonable design for reproducible variance reporting, though its usage depth was not fully traced in this pass (`PARTIAL`).

## Workflow view
Actuals ingested (from expenses/revenue) → compared against budget line items → variance surfaced per property/portfolio → YoY comparison. No test coverage found for the comparison/variance math specifically.

## Assessment
**Strengths:** the snapshot-based computation pattern is architecturally sound for auditability of "what did the numbers say at time X."
**Weaknesses:** untested calculation logic on a CFO-facing output; this module and [dashboards/reporting](dashboards-reporting.md) together form the actual "so what" output of the entire product, yet both score below the module average.
**Recommended:** variance-calculation test fixtures with known-correct outputs (M, P1 — same class of risk as CAM proration: wrong numbers shown to a CFO is a trust-ending failure mode); trace `computation_snapshots` usage fully in a follow-up pass.
