# Module: Dashboards, Analytics & Reporting

> Generated: 2026-07-20 · Revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` · Canonical score **2.4 / 5**, criticality **10 (High)** — [03](../03-module-catalog-and-maturity.md) · Index: [04](../04-module-deep-dives.md)

## Functional / technical view
The visualization/output layer. Pages: `Dashboard`, `AnalyticsReports`, `Analytics`, `Reports`. Components: `src/components/dashboard/*` (KPICard, NOITrendChart, OccupancyChart, BudgetVsActualChart, ExpenseDistChart, LeaseExpiryTimeline, PortfolioSummary, PropertyPerformanceTable, ActivityFeed, AlertsPanel, QuickActions) — Recharts-based, reasonably comprehensive component set. Export: `export-data` function + client-side `xlsx`/`jspdf`/`html2canvas`.

## Workflow view
Live queries feed charts directly (no reporting/materialized layer — [08 §6](../08-database-schema-and-ui-gap-analysis.md)); export triggers client-side file generation from fetched data.

## Assessment
**Strengths:** a genuinely broad component library already exists — this is more built-out than its score suggests on the UI side; export covers the common formats CFOs expect (Excel, PDF).
**Weaknesses:** no reporting/materialized layer means large-portfolio reports run as live queries against unpaginated fetches ([06 §2](../06-frontend-backend-integration.md)) — a scale risk once customers have hundreds of properties; no scheduled/emailed reports; `ActivityFeed`/`AlertsPanel` depend on the same weak notification producer chain as [notifications](notifications-critical-dates.md).
**Recommended:** scheduled report delivery via email (M, P2 — a common expansion-revenue feature); pagination/aggregation for large-portfolio reports (M, P2); this is the natural home for a future usage/cost dashboard ([OPS-007](../findings-register.md#ops-007)).
