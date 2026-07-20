# 13 — Testing & Quality Engineering

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

Phase-0 E1 facts: `vitest run src/` → **62 files, 685/685 pass, 5.2 s**; `test:e2e:phase5f` → **fails** at seeding (`42501`, [OPS-003](findings-register.md#ops-003)); lint/typecheck clean (with lint blind spots, [QA-002](findings-register.md#qa-002)). **No numeric coverage is estimated — no coverage tooling/report exists in the repo.**

## 1. What exists

| Layer | State | Evidence |
|---|---|---|
| Unit (Vitest) | 62 files concentrated in `src/lib/__tests__`, `src/services/__tests__`, `src/components/lease-review/**`, `src/components/lease-expense/**`, `src/pages/__tests__` | E1 run |
| Integration-style scripts | `scripts/phase5c/5d/5e *.test.js` (run manually, not in `npm test` scope) | inventory |
| E2E (Playwright) | 1 spec: seeded multi-org login → lease upload → field edit w/ citations → reload persistence → approve; includes an **external-network guard** asserting the flow is fully local | `e2e/phase5f/lease-review-workflow.spec.js` |
| API contract tests | `MISSING` (no shared contracts to test — [06 §2](06-frontend-backend-integration.md)) | — |
| DB tests (policies/RLS) | `MISSING` — no pgTAP/policy tests; **cross-tenant isolation is untested** | — |
| Edge-function tests | `supabase/functions/_tests/` exists; not wired into any runnable gate (`PARTIAL`, depth unaudited) | inventory |
| Security / performance / load / chaos / a11y / visual | `MISSING` | — |
| Test data management | e2e helper seeds orgs/users; unit tests use rich local fixtures/mocks | helper file |
| Flakiness controls | Serial e2e (workers:1), retries:0, forbidOnly | playwright.config.js |
| CI enforcement | **None** ([OPS-001](findings-register.md#ops-001)); no pre-commit hooks | — |
| Coverage reporting | `MISSING` | — |

## 2. Test-to-module map (canonical scores from [03](03-module-catalog-and-maturity.md))

| Module | Unit | E2E | Assessment |
|---|---|---|---|
| Lease review & approval (3.3) | Heavy (field contracts, normalizers, resolvers, review schema) | The one spec | Best-tested area of the product |
| Lease-expense rules (2.8) | Heavy (`lease-expense/**`, rule service tests) | via e2e stage | Good |
| Ingestion/extraction (3.2) | Service-level units; function `_tests` unwired | pipeline covered by e2e when it runs | Medium |
| Expenses (2.7) | Service workflow tests (delete/update/bulk/sync) | ❌ | Medium |
| Auth & MFA (3.3) | Some lib tests | ❌ | **Gap vs criticality (17)** |
| Orgs/RBAC (3.1) | rbac lib tests | ❌ | Gap vs criticality (17) |
| Billing (2.7) | ❌ none found | ❌ | **Critical untested revenue path** |
| CAM (2.6), Budgeting (2.6), Revenue/variance (2.5) | thin | ❌ | Gap |
| Audit logging (2.4), Admin (2.6), Notifications (2.0), Documents (2.8), Onboarding (2.6) | thin/none | ❌ | Gap |

## 3. Critical untested paths & false-confidence risks

1. **Cross-tenant isolation** — zero tests assert org A cannot read org B (the single most valuable missing test class — [10 §9](10-multi-tenant-saas-readiness.md)).
2. **Billing lifecycle** — checkout/webhook/plan-state has no tests at any level.
3. **Auth flows** — signup/confirm/MFA/reset are untested beyond units.
4. **RLS policies** — 156+ policies, no policy tests; drift precedent makes this worse ([TEN-001](findings-register.md#ten-001)).
5. **False confidence:** "685/685 green" measures the lease domain's client logic, not the product; the only integration proof (e2e) is currently broken; unit mocks encode the same assumptions as the code they test (contract drift invisible — [06 §2](06-frontend-backend-integration.md)).

## 4. Recommended pyramid & release gates (RECOMMENDED)

- **Pyramid:** keep the strong unit base → add a policy/DB test layer (pgTAP or SQL fixtures asserting RLS per table × role × org) → function-level integration tests against local Supabase (the `_tests/` dir is the seed) → 4–6 e2e journeys (auth+onboarding, lease pipeline [exists], billing, CAM/budget, admin).
- **Minimum release gates (CI):** lint + typecheck + vitest (blocking) → migration dry-run on fresh DB (blocking) → e2e lease journey (blocking once [OPS-003](findings-register.md#ops-003) fixed) → `npm audit` high+ (report → later blocking).
- **Enterprise-grade additions:** cross-tenant suite as a permanent gate; load test on pipeline (k6, 100 concurrent uploads); coverage reporting with ratchet (no numeric target until baseline measured); remove lint ignores ([QA-002](findings-register.md#qa-002)).

Related: [05 — Workflows](05-end-to-end-workflows.md) · [14 — DevOps](14-devops-infrastructure-and-delivery.md)
