# Module: Budgeting

> Generated: 2026-07-20 · Revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` · Canonical score **2.6 / 5**, criticality **11 (High)** — [03](../03-module-catalog-and-maturity.md) · Index: [04](../04-module-deep-dives.md)

## Functional / technical view
AI-assisted annual budget generation plus manual review/editing. Pages: `BudgetDashboard`, `CreateBudget`, `BudgetReview`. Backend: `compute-budget`, `generate-budget`. Tables: `budgets`, `budget_line_items`.

**Re-verified finding ([DATA-001](../findings-register.md#data-001)):** the historical self-audit claims (F-007 "hardcoded fake numbers," F-012 "hardcoded 2027") are **largely stale**. At the frozen commit, `budget_year` correctly defaults to `getFullYear()+1` ([generate-budget/index.ts:288](../../../supabase/functions/generate-budget/index.ts#L288)), and the Vertex-failure fallback (`estimateBudget`, lines 198–223) computes real heuristic figures from actual lease rents and historical aggregates with a stated 3% growth assumption — not fabricated numbers. The residual issue is presentation: the fallback response is shaped identically to an AI result, so the UI has no way to badge it as an estimate without inspecting `ai_insights` text.

## Workflow view
Generate (AI or heuristic fallback, indistinguishable to the caller) → review/edit line items → save. No approval workflow comparable to lease-review's blockers pattern found.

## Assessment
**Strengths:** the fallback logic is more sound than history suggested — this is a case where the codebase improved past a prior finding without anyone updating the finding.
**Weaknesses:** AI-vs-heuristic provenance not surfaced to the user (residual [DATA-001](../findings-register.md#data-001)); no dedicated tests for `estimateBudget`'s math; no approval/lock workflow once a budget is finalized (last-write-wins).
**Recommended:** add `source` field to the response + UI badge (S, P2); unit-test the heuristic formula (S, P2); consider a finalize/lock state (M, P3).
