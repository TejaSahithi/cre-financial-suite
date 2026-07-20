# Module: Expense Management

> Generated: 2026-07-20 · Revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` · Canonical score **2.7 / 5**, criticality **11 (High)** — [03](../03-module-catalog-and-maturity.md) · Index: [04](../04-module-deep-dives.md)

## Functional / technical view
General operating-expense tracking distinct from lease-derived CAM charges. Pages: `ExpenseDashboard`, `Expenses`, `AddExpense`, `BulkImport`, `ExpenseReview`, `ExpenseProjection`. Backend: `compute-expense`, `create-expense-workflow`⚠, `bulk-create-expenses`⚠, `delete-expenses`⚠, `update-expense-amount`⚠, `update-expense-details`⚠, `persist-expense-classification`⚠, `review-expense-classification`⚠, `manual-override-expense-classification`⚠, `send-expense-classification-to-cam` — **9 of 10 functions undeclared** ([SEC-002](../findings-register.md#sec-002)), the highest concentration of the config gap in any single module. Client engine `expenseService.js` (137 KB, the largest domain service in the codebase).

## Workflow view
Manual entry or bulk import → classification (manual or rule-driven from the [expense-rules module](lease-expense-rules-classification.md)) → review → projection. `delete-expenses`⚠ is a bulk-destructive path with no soft-delete backstop ([08 §3](../08-database-schema-and-ui-gap-analysis.md)).

## Assessment
**Strengths:** comprehensive workflow coverage (entry, import, review, projection); reasonable service-level test coverage (delete/update/bulk/sync workflows tested per the frontend exploration).
**Weaknesses:** the config.toml declaration gap is worst here — 9 undeclared functions including bulk-delete on financial data; 137 KB client engine is the largest single concentration of business logic outside the server boundary in the product.
**Recommended:** declare all 9 functions with explicit justification (S, P1 — this module should be first in line for [SEC-002](../findings-register.md#sec-002) remediation); soft-delete before bulk-delete ships to more customers (M, P2).
