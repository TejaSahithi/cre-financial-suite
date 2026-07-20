# 12 — Reliability, Scalability & Operations

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

**Canonical owner for operational failure modes.** Delivery pipeline → [14](14-devops-infrastructure-and-delivery.md). Everything here is repo-evidence; production behavior is `UNVERIFIED` throughout ([OPS-005](findings-register.md#ops-005)).

## 1. Posture summary

| Property | State | Evidence |
|---|---|---|
| Statelessness | ✅ SPA + stateless functions; state in Postgres/Storage | arch [02](02-current-state-architecture.md) |
| Single points of failure | One Supabase project = DB+auth+storage+functions blast radius; Vercel for static | `CONFIRMED` |
| Horizontal scalability | Functions auto-scale (platform); Postgres vertical-only until read replicas | platform property (`UNVERIFIED` limits) |
| Connection pooling | Supabase pooler (platform default); functions create clients per invocation — pool pressure at scale (`INFERRED`) | supabase.ts |
| Cache strategy | Client-side only (React Query + api.js TTL); no server cache | [01](01-repository-and-system-inventory.md) |
| Queue strategy | `pipeline_jobs` durable table; **no scheduler/poller** — worker invocation is event-driven from app actions (`INFERRED`); no reaper for stuck jobs | EV-16/17 |
| Backpressure | None (no queue-depth limits, no per-tenant quotas) | [10 §7](10-multi-tenant-saas-readiness.md) |
| Retries | Worker `max_attempts 3` + `retryable` classification; client-side minimal | EV-16/17 |
| Idempotency | Stripe events ✅; extraction idempotency migration ✅; general mutations ❌ | [07 §3](07-api-and-gateway-architecture.md) |
| Timeouts | Worker per-stage (140/240 s); platform defaults elsewhere | EV-17 |
| Circuit breakers / bulkheads | None; only `DISABLE_EXTERNAL_PROVIDER_CALLS` kill-switch | grep |
| Graceful degradation | Budget AI → heuristic fallback (silent — [DATA-001](findings-register.md#data-001)); seed-mode fallback (dangerous — [WKF-002](findings-register.md#wkf-002)) | register |
| DR / backups / restore testing | Platform backups assumed (`UNVERIFIED`); zero restore-test evidence; no DR runbook | `MISSING` |
| Multi-region | Not possible today (single project) | — |
| Deployment safety / rollback | Vercel rollbacks exist (platform); DB/functions: manual, no tested rollback path for 216 migrations | [14](14-devops-infrastructure-and-delivery.md) |
| Feature flags | `enabled_modules` per org (DB) — coarse; no flag system | schema.sql:82 |
| Observability / alerting / incident response / runbooks / capacity / cost visibility | **All MISSING** except DEPLOY.md and pipeline-health-check fn | [OPS-002](findings-register.md#ops-002) |

## 2. Failure-scenario table

| Scenario | Current behavior (evidence-based) | User impact | Detection | Recovery | Data-loss risk | Required improvement | Priority |
|---|---|---|---|---|---|---|---|
| Supabase project outage | Whole product down (auth+data+functions) | Total | Customer reports (no monitoring) | Wait for platform | Low (platform backups) | Uptime monitoring + status page | P1 |
| Extraction provider outage/quota | Stage fails → `failJob` after ≤3 attempts with `error_code`; job visible in FileHistory | Uploads stall | User sees failed status; no alert | Manual retry / re-extraction fn | None | Provider-failure alerting; automatic fallback provider (env-switch exists, not automatic) | P1 |
| Worker never invoked / stuck `queued` jobs | Rows sit `queued` forever (no reaper/poller found) | Silent stall | None | Manual investigation | None | Scheduled reaper + queue-depth metric (**OPS-006**, registered) | P1 |
| Function timeout mid-pipeline | Durability reconciliation distinguishes lost vs durable writes (EV-17) | Retry or fail cleanly | Job status | Retry ≤3 | Low (designed) | — (good) | — |
| Stripe webhook missed/dup | Dedupe on event id; missed events reconcile on Stripe retry (platform) | Plan state lag | None | Stripe redelivery | Low | Webhook-failure alert | P2 |
| Migration fails mid-`db push` | Partial application; no tested rollback; drift precedent | Possible downtime | Deploy operator | Manual SQL surgery | **Medium** | Staging env + migration CI dry-run | P1 |
| Resend outage / missing key | Signup confirmations + invites silently fail (historical F-014 class) | Onboarding blocked | None | Manual resend | None | Email-failure surfacing + alert | P1 |
| Env-var misconfig in prod build | Seed-mode fallback renders fake-working app ([WKF-002](findings-register.md#wkf-002)) | **Writes lost silently** | None | Redeploy | **High** | Hard-fail prod build without env | P1 |
| Large tenant (10k+ leases) | Unpaginated list queries; client-side filtering | Slow pages | None | — | None | Pagination contract ([06 §2](06-frontend-backend-integration.md)) | P2 |
| AI cost runaway (one org uploads 5k docs) | No quotas/metering; costs invisible | Margin burn | Provider invoice, weeks later | Kill-switch env (global, blunt) | None | Per-tenant metering + budget alerts (**OPS-007**, registered) | P1 |
| Audit-log growth unbounded | No retention/partitioning | Slow admin queries | None | Manual | None | Retention policy | P3 |

## 3. Suggested SLIs / SLOs / alerts / dashboards / runbooks (RECOMMENDED)

- **SLIs:** availability of `/` and `pipeline-status`; extraction success rate (= completed / (completed+failed) jobs); p95 stage latency (parse, normalize); signup-confirmation delivery rate; webhook-processing lag; error rate per function.
- **Starter SLOs:** 99.5% app availability; ≥97% extraction success (excl. user-error docs); confirmation email <2 min p95.
- **Alerts:** any `pipeline_jobs` row `queued` >15 min; stage failure rate >10%/hr; function 5xx spike; Resend/Stripe API errors; Postgres CPU/storage thresholds; drift detector (`supabase db diff` nonzero).
- **Dashboards:** pipeline funnel (queued→running→completed/failed by org), AI spend per org/day, auth funnel, top function latencies.
- **Runbooks:** stuck-job reaping; provider-outage failover (flip `EXTRACTION_PROVIDER`); migration rollback procedure; secret rotation ([SEC-003](findings-register.md#sec-003)); tenant offboarding/export.

## 4. Bottleneck forecast (INFERRED, ordered)

1. Postgres write/read volume from unpaginated queries + heavy lease-intelligence joins.
2. Function cold-start + per-invocation client creation under burst uploads.
3. AI provider rate limits during bulk portfolio onboarding (the sales-critical moment).
4. Single-region latency for non-US customers.

Related: [14 — DevOps](14-devops-infrastructure-and-delivery.md) · [20 — Risk register](20-risk-register.md)
