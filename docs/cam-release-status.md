# CAM Canonical-Category Release Status

**Last updated:** 2026-08-05
**Scope:** migrations 037–041, CAM engine category matching, the LEASE_POOL_PERIOD
rounding boundary, automatic CAM preparation, CAM Setup readiness.

---

## Status

```
LOCAL IMPLEMENTATION:              VERIFIED
REMOTE BASELINE:                   NOT VERIFIED
REMOTE MIGRATIONS:                 NOT DEPLOYED
REMOTE REMEDIATION:                NOT EXECUTED
PRODUCTION CAM FINANCIAL TIE-OUT:  PENDING
```

---

## What "LOCAL IMPLEMENTATION: VERIFIED" means here

Verified against a **fresh local Supabase database**, rebuilt from scratch with
`supabase db reset` so that all migrations — including 037, 038, 039 and 040 — were
applied in order to an empty database.

- Clean bootstrap succeeds end to end (exit 0).
- Migrations 037–040 present in `supabase_migrations.schema_migrations`.
- `cam_expense_inputs.expense_category_id` exists with its foreign key, index and
  population trigger; `cam_profiles` is absent.
- The full chain runs: lease rule → materialized policy → recovery pool → participant →
  published expense → canonical category → pool assignment → readiness → CAM calculation
  → lease results → calculation lines.
- A two-lease, four-pool fixture (multi-premises, operating/taxes/insurance/utilities,
  gross-up, admin fee, base year, cap, estimates, one ambiguous category, one excluded
  expense) ties out, with every variance attributed.
- 329 CAM tests pass, including real-database tests for migrations 039/040 and 8
  rounding-boundary regression tests.
- The former $0.07 tie-out variance is **eliminated**: the engine now reproduces the
  analytic hand-calculation exactly (21,667.50 and 12,125.00).
- Clean bootstrap from an empty database succeeds (previously impossible — see
  `docs/cam-migration-bootstrap-repairs.md`).

It does **not** mean any of this has been observed on real customer data.

---

## What is explicitly NOT verified

| Item | Status | Why |
|---|---|---|
| Remote row counts and published amounts | **NOT VERIFIED** | No read access to the linked project was provided. No baseline was captured. |
| Remote migration state beyond the ledger listing | **NOT VERIFIED** | The ledger was listed, but per prior experience an "applied" ledger entry does not guarantee the DDL is live. |
| Remote `cam_profiles` row count | **NOT VERIFIED** | Requires a read query against the linked database. Migration 038 will abort on its own if the table is non-empty. |
| Remote ambiguous/unknown category volume | **NOT VERIFIED** | Requires the dry-run report against real data. |
| Effect on real tenant recoveries | **NOT VERIFIED** | Requires a production tie-out. |

No remote migration was pushed. No Edge Function was deployed. No linked-project object
was created, altered or dropped.

---

## Known risk carried into deployment

**Point-in-time recovery is disabled on the linked project.** The last check reported
`walg_enabled: true` (daily physical backups, 7 retained) and `pitr_enabled: false`.
A rollback therefore restores the most recent daily snapshot and loses every write since.
For a change that backfills a financial column, enable PITR before deploying.

---

## Financial impact of this change

Before this change, CAM category matching compared a UUID
(`recovery_pool_categories.expense_category_id`,
`lease_recovery_policy_steps.expense_category_id`) against a free-text label
(`cam_expense_inputs.category`). That comparison can never succeed. Consequences on real
data:

- Explicit **exclude** rules never excluded anything.
- A pool holding any **include** rule classified every expense as excluded, so the pool
  collapsed to zero and tenants recovered nothing.
- Pool and assignment suggestions never matched, producing an empty CAM Setup.

Any CAM figure produced before deployment should be treated as suspect and recalculated
afterwards. Post-deployment numbers are not comparable to pre-deployment numbers without
accounting for this fix.

---

## Deployment artifacts

| Artifact | Purpose |
|---|---|
| `docs/cam-deployment-runbook.md` | Sequence, backup prerequisite, migration order, dry-run, approval gate, apply, rollback, post-deployment validation |
| `scripts/cam_remote_preflight_readonly.sql` | Read-only baseline and stop conditions |
| `scripts/cam_category_remediation_dry_run.sql` | Read-only remediation report with counts and monetary totals |
| `scripts/cam_remote_postflight_readonly.sql` | Read-only post-deployment verification |
| `docs/cam-migration-bootstrap-repairs.md` | The `unnest(get_my_org_ids())` repairs, with equivalence argument and proofs |
| `docs/cam-release-failure-inventory.md` | Every remaining test/lint failure, classified |

All three scripts were executed against the local database to confirm they run without
error, contain no credentials, and issue no writes.

---

## Sign-off required before this status can change

`REMOTE MIGRATIONS: DEPLOYED` may only be recorded once an authorized database
administrator has:

1. Confirmed a restore point (and preferably enabled PITR).
2. Captured and attached the preflight output.
3. Pushed 037 → 038 → 039 → 040.
4. Captured and attached the dry-run report.
5. Obtained human approval on the ambiguous/unknown buckets.
6. Applied remediation and resolved ambiguous rows through
   `resolve_cam_input_category` with reason, actor and evidence.
7. Captured and attached the postflight output.
8. Completed a real-property tie-out with no unexplained variance.

Until every one of those is done, this document must continue to read
`PRODUCTION CAM FINANCIAL TIE-OUT: PENDING`.
