# Enterprise Repo Structure

## Direction

Keep the existing app, but harden it into feature modules with thin pages, shared infrastructure, and server-owned financial workflows.

## Target Boundaries

- `src/app`: application shell, providers, routing, and route loading only.
- `src/pages`: route entry components. Pages should compose feature components and call feature hooks, not own financial workflow logic.
- `src/features`: domain modules grouped by product capability, such as `lease-review`, `cam`, `expenses`, `access-control`, and `auth`.
- `src/services`: data access and integration clients. Services should not import page components.
- `src/services/utils`: pure shared service utilities with no browser workflow side effects.
- `src/lib`: cross-cutting client helpers such as RBAC, org resolution, and formatting.
- `supabase/functions`: server-side workflows and durable side effects.
- `supabase/migrations`: schema, RLS, RPCs, and data integrity constraints.

## Rules

1. Financial decisions must have one canonical source of truth.
2. Page components must not orchestrate multi-step approval, billing, CAM, audit, or notification workflows.
3. Any workflow that writes multiple business entities must move to a server-side RPC or Edge Function.
4. Every database read/write path must carry `org_id` explicitly or resolve it through a reviewed helper.
5. Route modules should be lazy-loaded unless there is a measured reason to include them in the app shell.
6. Generated artifacts, logs, binaries, one-off scripts, and local test files should not stay in the root repo.
7. Tests should cover the business invariant, not the implementation accident.

## Current First Step

Routing now lazy-loads page modules through `src/pages.config.js`, with `src/app/AppRoutes.jsx` providing the suspense boundary. This makes each page a separate deployable frontend module boundary and reduces the pressure to import every feature at startup.

## Next Refactor Targets

- Done: lease approval server workflow (`docs/lease-approval-server-workflow.md`), rule/CAM canonicalization sprints 1-3 (`docs/rule-cam-hardening-plan.md`), canonical workflow-pattern template + shared run-table helpers (`docs/server-owned-workflow-pattern.md`), pipeline call-graph documentation and removal of the `LeaseUpload.jsx` client-side lease-draft bypass (`docs/pipeline-call-graph.md`).
- In progress (enterprise-readiness hardening, phased): fold rent-schedule generation and immutable abstract versioning into the lease approval transaction; move expense classification derivation and CAM/lease config writes onto the same server-owned pattern as CAM-send/publish; collapse budgeting's two divergent paths (`CreateBudget.jsx` direct-insert vs. `compute-budget`) onto the gated engine; reconcile the `audit_logs` column-shape drift and remove redundant client-side audit inserts; module-by-module RLS lockdown on `leases`/`expenses`/`budgets`/config tables to reject direct client writes entirely.
- Split finance services by bounded context: lease rules, actual expense classification, CAM publication, audit events, and notifications.
- Replace root-level scratch/test scripts with either committed tests under `src/**/__tests__` or ignored local tooling.
- Add CI gates for `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build`.
- Add org/tenant isolation tests around every critical workflow.
