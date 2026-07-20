# Module: Lease-Expense Rules & Classification

> Generated: 2026-07-20 · Revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` · Canonical score **2.8 / 5**, criticality **12 (High)** — [03](../03-module-catalog-and-maturity.md) · Index: [04](../04-module-deep-dives.md)

## Functional / technical view
Extracts and formalizes how lease clauses translate into billable expense rules (CAM eligibility, payment treatment, approval/review/publish status). Pages: `LeaseExpenseRules`, `LeaseExpenseClassification`. Backend: `extract-lease-expense-rules`, `save-lease-expense-rule-set`⚠, `update-lease-expense-rule*`⚠ (3 functions), `approve-lease-expense-rule`, `reject-lease-expense-rule`, `mark-lease-expense-rule-not-applicable`, `publish-lease-expense-rule-to-cam`. Client engine `leaseExpenseRuleService.js` (108 KB) — substantial business logic living in the browser. Tables: `lease_expense_rules`, `lease_expense_values`, `lease_expense_rule_clauses` — **the three tables lacking direct `org_id`** ([TEN-002](../findings-register.md#ten-002)), scoped instead via `rule_set_id → lease_expense_rule_sets.org_id` policy chains.

## Workflow view
AI-assisted extraction produces draft rules → human review/approval (`approve-lease-expense-rule`/`reject-*`/`mark-not-applicable`) → publish to CAM (feeds the [CAM engine](cam-engine.md)). Heaviest unit-test concentration outside the review module itself.

## Assessment
**Strengths:** good test coverage; clean approval/rejection lifecycle with explicit terminal states; feeds CAM cleanly.
**Weaknesses:** the module owning [TEN-002](../findings-register.md#ten-002)'s indirect-scoping risk; 5 of ~9 functions undeclared in config.toml ([SEC-002](../findings-register.md#sec-002)); 108 KB of business logic client-side duplicates server concerns and risks drift.
**Recommended:** org_id denormalization (M, P2, shared with CAM); declare functions (S, P1).
