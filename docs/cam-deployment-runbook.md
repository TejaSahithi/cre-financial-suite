# CAM Canonical-Category Deployment Runbook

**Covers migrations 037, 038, 039, 040 and the CAM engine/setup changes that depend on them.**

Status of this document: the sequence below has been executed and verified **on a local
Supabase database only**. Nothing in it has been run against a remote/linked project.
See `docs/cam-release-status.md`.

---

## 0. What this deployment changes, in one paragraph

`cam_expense_inputs` gains a canonical `expense_category_id` (UUID). Every CAM category
match — pool inclusion/exclusion, policy-step resolution, pool suggestion, assignment
suggestion — switches from the free-text `category` label to that UUID. Before this
change a UUID was being compared against a text label, so the comparison could never
succeed: explicit exclude rules never excluded, and a normally-configured pool sent every
expense to `excluded`, driving pool totals and tenant recoveries to zero. `category` is
retained unchanged as the display/audit label.

**Because this changes calculated financial output, any draft/preview CAM run produced
before the deployment should be recalculated afterwards, and its numbers should not be
compared to post-deployment numbers without accounting for this fix.**

---

## 1. Prerequisite: backup / restore point (MANDATORY)

Do not proceed without this.

```bash
supabase backups list --project-ref <PROJECT_REF>
```

Confirm and record:

- `walg_enabled` is `true`, and the newest `COMPLETED` backup timestamp.
- `pitr_enabled`. **If `pitr_enabled` is `false`, recovery granularity is the daily
  backup only** — a rollback loses every write since that snapshot. For a financial
  database, enable PITR and wait for it to be active before continuing.

Record the exact restore point (backup id + timestamp) in the deployment ticket.

> As of the last check on the currently-linked project, `pitr_enabled` was **false**.

---

## 2. Preflight (READ-ONLY, no writes)

Run `scripts/cam_remote_preflight_readonly.sql` in the Supabase SQL Editor and save the
full output to the deployment ticket. It reports migration state, `cam_profiles`
existence/row count, CAM input rows and amounts by organization/property, canonical
category coverage, missing service periods, ambiguous/unresolved labels, and affected
draft/approved/posted runs.

**Stop conditions — do not deploy if any of these hold:**

| Condition | Why it blocks |
|---|---|
| `cam_profiles` exists **and has rows** | Migration 038 drops it. It self-aborts if non-empty, which would fail the whole push. Investigate the rows first. |
| Migrations 037/038/039/040 already partially applied | Re-check what actually exists; do not assume the ledger is accurate. |
| A posted/approved run exists for a period whose inputs will be remediated | Post-deployment remediation will require an explicit restatement run. Plan it before, not after. |
| No confirmed restore point | See section 1. |

---

## 3. Deployment compatibility — verified, and why the order is NOT free

Each changed component was checked for whether it can run **before** migration 039.

| Component | Runs before 039? | Evidence |
|---|---|---|
| Frontend (`camReadiness.js`, `camSuggestions.js`, CAM Setup) | **Yes** | Both modules detect column presence via `hasOwnProperty` and fall back. Without this they would flag *every* published expense `EXPENSE_CATEGORY_MISSING`. Pinned by `src/lib/__tests__/camCanonicalCategoryFallback.test.js` (11 cases). |
| `prepare-cam-automatically-v2` | Degraded, not broken | Expenses contribute no canonical-keyed suggestion; Setup shows policy-derived suggestions only and reports `canonical_category_available: false`. |
| `get-cam-setup-readiness`, `cam-setup-actions-v2` | Yes | Read-only with respect to the new column. |
| **`run-cam-calculation-v2` / `build-cam-run-input-v2`** | **NO — fails closed** | The snapshot RPC uses `to_jsonb(ei)`, so pre-039 the row has no `expense_category_id`. `pool-builder.ts` then treats every input as having no canonical category and emits blocking `EXPENSE_CATEGORY_MISSING`. **Every CAM run would return `readiness_failed` and no tenant would be billed.** |

**Conclusion: a pure application-first cutover is unsafe.** Option 1
(compatibility-first) cannot be used for the calculation functions as written.

Migrations 039/040/041 are additive and inert to the currently-deployed code
(old functions never select the new columns), so **database-before-functions is
the safe direction** — but it is adopted deliberately here, not assumed, and it
is protected by a write freeze because a CAM run started mid-deployment could
otherwise straddle two schemas.

**Selected: option 2, maintenance-window deployment.**

### 3.1 `cam_profiles` caller check (blocks 038)

`save-cam-profile` and `approve-cam-profile` Edge Functions still query
`cam_profiles`. The application cannot reach them — `src/services/camConfig.js`
throws `"cam_profiles writes are retired"` before invoking, pinned by
`src/services/__tests__/camConfigCamProfile.test.js` — but they may still be
**deployed**.

038 self-aborts if the table holds rows; it does **not** check for callers.
Therefore, before 038 runs:

```bash
supabase functions list                       # confirm presence
supabase functions delete save-cam-profile
supabase functions delete approve-cam-profile
```

Do not run 038 until both are absent.

---

## 4. Production deployment sequence

Execute in this order. Do not reorder; do not skip a verification step.

**1. Enable PITR and confirm the recovery window.**
`supabase backups list --project-ref <REF>`. Require `pitr_enabled: true` and
record the earliest recoverable timestamp. (Last observed: **false** — daily
snapshots only, so a rollback loses up to 24h.) Record the restore point.

**2. Capture preflight.** Run `scripts/cam_remote_preflight_readonly.sql`;
attach output. Honour every stop condition, especially a non-empty
`cam_profiles`.

**3. Enter the maintenance window (disable CAM writes).** Block CAM run
creation, publication and assignment for the affected organisations. Confirm no
CAM run is in `calculating`.

**4. Verify no legacy CAM calls.** Confirm `save-cam-profile` and
`approve-cam-profile` are undeployed (§3.1); confirm no `compute-cam` or
`cam_profiles` traffic in the last 24h of function logs.

**5. Apply migrations 037 → 038 → 039 → 040 → 041.**
`supabase db push`, having first confirmed via `supabase migration list --linked`
that the pending set is exactly these. 039 backfills unambiguous categories;
ambiguous ones are deliberately left NULL.

**6. Deploy post-migration functions**, then the frontend:
`run-cam-calculation-v2`, `build-cam-run-input-v2`, `prepare-cam-automatically-v2`,
`cam-setup-actions-v2`, `get-cam-setup-readiness`.

**7. Run the remediation dry-run.** `scripts/cam_category_remediation_dry_run.sql`;
attach counts and monetary totals per organisation and property.

**8. Pause for category review.** Human sign-off on the AMBIGUOUS and UNKNOWN
buckets. Nothing is auto-mapped. Do not proceed without a named owner per row.

**9. Resolve approved ambiguities** via `resolve_cam_input_category` with
selected category, reason, actor and evidence (service_role only).

**10. Run postflight.** `scripts/cam_remote_postflight_readonly.sql`; attach.
Expect PASS on objects, `cam_profiles` absence, and published/assigned
reconciliation.

**11. Recalculate stale drafts.** Every run with `stale = true` must be re-run.
Pre-deployment CAM figures are not comparable to post-deployment figures.

**12. Create restatements for affected posted runs.** `resolve_cam_input_category`
returns `posted_run_ids_requiring_restatement`; posted runs are immutable and
are never written to, so each needs an explicit restatement run.

**13. Perform the real-property financial tie-out.** For one real property:
`published = assigned + unassigned`, `assigned = pool actual + pool excluded`,
then one tenant walked through inclusions/exclusions → gross-up → share →
base year/stop → cap → fee → proration → estimates → due/credit. Under the
LEASE_POOL_PERIOD rounding policy this should reconcile **exactly**; the local
verification fixture ties out to the cent with zero variance.

**14. Release CAM for production use.** Lift the maintenance window, re-enable
CAM writes, and update `docs/cam-release-status.md`.

---

## 8. Rollback

Rollback depends on how far the deployment got.

**Before 039 is applied** — nothing to undo; redeploy the previous application build.

**After 039/040, application not yet deployed** — the columns and functions are additive
and inert to old code. Prefer to leave them in place. If removal is genuinely required:

```sql
-- Elevated privileges required. Destroys the canonical category mapping.
drop trigger if exists trg_cam_expense_inputs_canonical_category on public.cam_expense_inputs;
drop function if exists public.resolve_cam_input_category(uuid,uuid,uuid,text,jsonb,uuid,text,boolean);
drop function if exists public.get_cam_input_category_candidates(uuid,uuid,uuid);
drop function if exists public.list_expense_category_candidates(uuid,text);
drop function if exists public.remediate_cam_input_category_ids(uuid,boolean,uuid);
drop function if exists public.cam_expense_inputs_set_canonical_category();
drop function if exists public.resolve_expense_category_id(uuid,text);
alter table public.cam_expense_inputs drop column if exists expense_category_id;
alter table public.cam_runs drop column if exists stale,
                            drop column if exists stale_reason,
                            drop column if exists stale_at;
```

**After the application is deployed** — roll the application back first (the old build
ignores the new column), then decide about the schema. Do not drop
`expense_category_id` while the new application is live: CAM will fail closed and every
recovery will block.

**038 is not reversible by a migration.** `cam_profiles` was verified empty before it was
dropped, so no data is lost, but restoring the table requires the backup from section 1.

**If remediation wrote wrong values**, `expense_category_id` can be reset without touching
any other column:

```sql
-- Elevated privileges required. Scoped reset; amounts and labels are untouched.
update public.cam_expense_inputs
   set expense_category_id = null
 where org_id = '<ORG_UUID>' and updated_at >= '<DEPLOY_TIMESTAMP>';
```

Note the population trigger fires on UPDATE and will immediately re-resolve any
unambiguous label — that is intended self-healing, not a failed reset.

---

## 9. Post-deployment validation

Run `scripts/cam_remote_postflight_readonly.sql` and attach the output. It verifies
migration application, canonical category coverage, trigger/function existence, absence
of `cam_profiles`, unresolved category totals, and CAM input/assignment/pool
reconciliation.

Then confirm in the application, for one real property and period:

- [ ] CAM Setup shows non-empty pool, participant and assignment suggestions, each stating
      the category UUID and scope that produced it.
- [ ] Source counts and monetary totals are non-zero and match the preflight numbers.
- [ ] Any remaining unresolved category appears as an actionable
      `EXPENSE_CATEGORY_MISSING` blocker, not as a silent empty state.
- [ ] A CAM run reaches `calculated`, and pool results show a non-zero
      `actual_amount` (before this fix a configured pool collapsed to zero).
- [ ] `published = assigned + unassigned` and `assigned = pool actual + pool excluded`.
- [ ] One tenant's recovery is manually tied out and any variance is attributable to
      documented rounding/residual behavior.

**Known behavior to expect during tie-out:** the engine prorates cap, base-year and fee
amounts into monthly segments and rounds the chain to the ledger's 2 decimals between
steps, then applies largest-remainder residual allocation. On the local verification
fixture this produced +$0.06 and +$0.01 against the analytic annual figures for two
tenants. Expect small, explainable variances of this shape; they are not a defect of this
deployment, but they must be attributed rather than ignored.
