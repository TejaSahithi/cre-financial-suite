# 14 — DevOps, Infrastructure & Delivery

> Generated: 2026-07-20 · Repository revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` (branch `feature/lease-intelligence-enterprise-p1-p8`) · Part of the [Project Audit](README.md)

Operational failure modes → [12](12-reliability-scalability-and-operations.md). Production state is `UNVERIFIED` throughout ([OPS-005](findings-register.md#ops-005)).

## 1. Current delivery reality

| Area | State | Evidence | Label |
|---|---|---|---|
| Environments | Local (Supabase CLI stack) + one linked remote project. **No staging.** | `.vercel/project.json`, config.toml | `CONFIRMED` gap |
| Build pipeline | Vercel git integration builds `npm run build` → `dist/` | vercel.json | `CONFIRMED` |
| Test pipeline | **None** — tests run only on developer machines | [OPS-001](findings-register.md#ops-001) | `MISSING` |
| Release pipeline | Frontend: every push to connected branch deploys (INFERRED default). DB/functions/secrets/buckets: 4 separate **manual** surfaces (CLI + dashboard) per DEPLOY.md | EV-21 | `CONFIRMED` manual |
| Infrastructure as code | None beyond migrations + config.toml (buckets partially manual; auth URLs manual; Vercel config in-repo) | EV-20 | `PARTIAL` |
| Secrets | Supabase function secrets + Vercel env; rotation process `MISSING`; service-role key dual-use ([SEC-003](findings-register.md#sec-003)) | DEPLOY.md | `PARTIAL` |
| Containers / networking / DNS / TLS / CDN / LB / autoscaling | All delegated to Vercel + Supabase platforms (appropriate at this stage) | — | `CONFIRMED` platform |
| DB provisioning & backups | Supabase platform; backup tier/restore testing `UNVERIFIED` | — | `UNVERIFIED` |
| Migrations | 216 files, `supabase db push` manually; **drift precedent** ([TEN-001](findings-register.md#ten-001)); repair docs exist (`docs/database/migration-repair.md`, `docs/deploy/schema-sync-checklist.md`) | EV-14/15 | `CONFIRMED` risk |
| Rollback | Vercel: platform rollback. DB: none tested. Functions: redeploy previous manually | — | `PARTIAL` |
| Monitoring / alerting | None ([OPS-002](findings-register.md#ops-002)) | — | `MISSING` |
| Environment promotion | No promotion concept (nothing to promote through) | — | `MISSING` |
| Feature flags | `enabled_modules` per org only | schema.sql:82 | `PARTIAL` |
| Branching/release conventions | Feature branches with disciplined phase naming; `main` default; no tags/releases/changelog found | git history | `PARTIAL` |

## 2. Assessment

- **Reproducibility:** frontend build fully reproducible (E1). Full-stack local reproducibility currently broken ([OPS-003](findings-register.md#ops-003)). Prod reproducibility unknowable — no record ties deployed artifacts to commits for DB/functions.
- **Environment parity:** weak — committed `.env` → local; `.env.production` placeholder; secrets matrix lives in prose; seed-mode fallback can mask misconfig ([WKF-002](findings-register.md#wkf-002)).
- **Deployment risk:** high for DB (manual, drift precedent, no dry-run); moderate for functions (82 units, deploy script exists `scripts/deploy-edge-functions.ps1`); low for frontend.
- **Recovery readiness:** untested restore; no DR runbook; single project blast radius ([12 §2](12-reliability-scalability-and-operations.md)).
- **Supply-chain:** no dependency scanning, no SBOM, mixed esm.sh pins ([ARC-004](findings-register.md#arc-004)); lockfile committed ✅.
- **Drift:** happened, was detected manually, corrected in-repo; no automated drift detection ([TEN-001](findings-register.md#ten-001)).
- **Manual dependencies:** every backend deploy step; bucket/auth dashboard config; secret setting.

## 3. Future-state delivery architecture (RECOMMENDED — sized to a 1–3 engineer team)

1. **Week 1 — CI baseline:** GitHub Actions on PR: `lint` + `typecheck` + `vitest` + `npm audit --audit-level=high` (report). Branch protection on `main`.
2. **Weeks 2–3 — backend delivery:** job that spins ephemeral Supabase (CLI) → applies all 216 migrations from zero (catches ordering/grants issues = fixes [OPS-003](findings-register.md#ops-003) class) → runs function `_tests` → e2e lease journey. Deploy job (manual approval): `db push` → `functions deploy` → smoke check, all from CI with logged artifacts.
3. **Month 2 — environments:** a second Supabase project as **staging**; promotion = same scripts, different project ref; scheduled `supabase db diff` drift alarm against both.
4. **Month 3+:** release tagging + changelog; secret-rotation runbook; preview deployments wired to seeded demo data (safe use of the existing seed system); cost dashboards ([OPS-007](findings-register.md#ops-007)).

Related: [12 — Reliability](12-reliability-scalability-and-operations.md) · [13 — Testing](13-testing-and-quality-engineering.md) · [16 — Roadmap](16-product-and-technical-roadmap.md)
