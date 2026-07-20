# Module: Notifications & Critical Dates

> Generated: 2026-07-20 · Revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` · Canonical score **2.0 / 5** (tied-lowest), criticality **7 (Medium)** — [03](../03-module-catalog-and-maturity.md) · Index: [04](../04-module-deep-dives.md)

## Functional / technical view
Two related but distinct capabilities: (1) an in-product `Notifications` page + `notifications` table, and (2) `CriticalDates` tracking (lease expirations, renewal windows) via `manage-lease-critical-date`⚠. The legacy Base44 platform (pre-Supabase migration, [ARC-002](../findings-register.md#arc-002)) had explicit event-triggered functions for this purpose — `onLeaseChanged`, `onExpenseAdded`, `onBudgetChanged` — which are **dead code**, not migrated. No equivalent Supabase-side trigger/producer was found for "lease expiring in N days" style alerts.

## Workflow view
`manage-lease-critical-date`⚠ appears to be a CRUD endpoint for date records, not a proactive alerting engine. Whether anything currently *watches* critical dates and produces a notification is `UNVERIFIED` — no scheduled job, trigger, or cron-equivalent was found feeding the `notifications` table from date proximity.

## Assessment
**Strengths:** the data model for critical dates exists and is reachable from the UI.
**Weaknesses:** this is the module most likely to have quietly regressed during the Base44→Supabase migration — the proactive alerting behavior the legacy triggers implied (lease-expiry notifications) has no confirmed Supabase-side replacement; combined with [OPS-006](../findings-register.md#ops-006) (no scheduler exists at all in the current architecture), there is currently no mechanism to run a "check dates daily" job even if the logic existed.
**Recommended:** confirm with the product owner whether lease-expiry alerting is expected to work today — if not, this is a **silent regression** worth flagging explicitly rather than assuming intentional deprecation (S effort to check, P1 priority because it's a correctness question, not just a gap); once confirmed, a scheduled job is the natural fix once [OPS-006](../findings-register.md#ops-006)'s scheduler exists.
