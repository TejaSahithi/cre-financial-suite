# Migration Repair Notes

Date: 2026-06-03

This note records the focused repair work needed to make the local Supabase schema reproducible for lease, expense, and CAM hardening.

## What Was Broken

- Two migration files used the same non-unique timestamp prefix: `20260601`.
- Clean resets failed because later migrations referenced columns before the migrations had created them:
  - `lease_expense_rules.approved_by`
  - `lease_expense_rules.approved_at`
  - `lease_expense_rules.rule_key`
  - `lease_expense_rules.org_id`
- `public.documents` had already been created by an earlier migration, so a later `CREATE TABLE IF NOT EXISTS public.documents` did not add columns required by the lease approval workflow.
- One billing hardening policy used `org_id = ANY (public.get_my_org_ids())` against a set-returning function.
- One audit migration had a UTF-8 byte order mark before the SQL comment.
- `public.get_my_org_ids()` was redefined with a different return type, which Postgres does not allow through `CREATE OR REPLACE FUNCTION`.

## Repairs Applied

- Renamed duplicate migration prefixes to unique 14-digit timestamps:
  - `20260601000000_superadmin_platform_reads.sql`
  - `20260601000100_welcome_email_sent_at.sql`
- Added missing `lease_expense_rules` columns before downstream migrations depend on them.
- Added explicit `ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS ...` statements for the approved lease document fields used by `approve_lease_workflow`.
- Changed the billing policy to use `org_id IN (SELECT public.get_my_org_ids())`.
- Removed the BOM from the audit logging migration.
- Kept `public.get_my_org_ids()` as `RETURNS SETOF uuid` and implemented the super-admin behavior without changing the function signature.

## Verification

Run these before accepting future finance-chain migrations:

```powershell
supabase db reset --local
supabase migration list --local
deno test --allow-all supabase/functions/_tests/finance-chain-integration.test.ts
```

The 2026-06-03 reset applied all migrations through `20260603110000_send_expense_classification_to_cam_workflow.sql`. The CLI then returned a container restart `502`, but `supabase status` showed the database and API were healthy after restart, and the DB-backed finance-chain integration test passed.

After removing a stale `debug-user` function config entry, `supabase db reset --local` completed successfully. On Windows with Supabase CLI `2.84.2`, Kong may still route auth traffic to the old auth container IP after reset. If `/auth/v1/health` returns `502` while the auth container is healthy, restart only the local Kong container and rerun the test:

```powershell
docker restart supabase_kong_cre-financial-suite-main
deno test --allow-all supabase/functions/_tests/finance-chain-integration.test.ts
```

## Future Rules

- Use unique 14-digit migration prefixes: `YYYYMMDDHHMMSS`.
- Add columns before indexes, policies, RPCs, or triggers reference them.
- Do not rely on `CREATE TABLE IF NOT EXISTS` to evolve an existing table; use explicit `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- Do not change function return types with `CREATE OR REPLACE FUNCTION`; drop/recreate only when it is intentionally safe and documented.
- Avoid BOMs and generated editor artifacts in SQL migrations.
- Treat `supabase db reset --local` as the release gate for migration reproducibility.

---

## 2026-07-06 update: the `ANY(get_my_org_ids())` bug recurred, and local/remote have diverged

While hardening the server-owned workflow pattern (`docs/server-owned-workflow-pattern.md`), a full `supabase db reset --local` surfaced that the exact bug this doc already fixed once for a billing policy (`org_id = ANY (public.get_my_org_ids())` — invalid, set-returning function in a policy expression) had recurred in two later migrations that were written without following this doc's own precedent:

- `20260602170000_lease_approval_workflow.sql` — `lease_approval_workflow_runs_select` policy.
- `20260702000000_repair_cam_workflow_schema.sql` — `expense_classification_cam_send_runs_select` policy (itself a repair migration that re-introduced the bug it should have avoided).

Both were fixed in place locally (`org_id IN (SELECT public.get_my_org_ids())`), matching the established fix. `20260602170000` also had a second bug: its `INSERT INTO audit_logs` referenced a `user_id` column that no migration in this repo has ever created (the table has only ever had `user_email`/`user_name`, later `actor_user_id`) — every real lease approval on a database built strictly from these migration files would hit `42703: column "user_id" does not exist` and roll back the whole transaction. Fixed to use the canonical `actor_user_id`/`actor_email`/`severity`/`source` shape.

**Before committing to those in-place edits, the linked remote project (`cjwdwuqqdokblakheyjb`, per `supabase/.temp/project-ref`) was checked directly** — `supabase migration list --linked` and a read-only `supabase db dump --linked --schema public` — since both files were already committed and pushed to `origin/enterprise-architecture-hardening` (confirmed via `git log`/`git diff` against origin). This surfaced two things worth recording precisely, because they change how "broken" these migrations actually are depending on environment:

1. **The RLS policy bug behaves differently by environment.** Remote's live schema dump shows both policies successfully created with the exact `= ANY(public.get_my_org_ids())` syntax — Postgres there tolerated it at `CREATE POLICY` time. Local Docker Postgres (17.6.1) hard-rejects the identical statement with `set-returning functions are not allowed in policy expressions`. This is not "a statement that can never succeed anywhere" — it succeeded on whatever Postgres version/configuration is live on that remote project. It is not known why local rejects it definitively — possibly a minor version or extension difference — and that has not been resolved.

2. **`audit_logs.user_id` is schema drift, not (only) a migration bug.** Remote's live `audit_logs` table has a `user_id uuid` column. No migration file in this repo creates it — the original `CREATE TABLE` (`20260322_add_core_tables.sql`) only ever defined `user_email`/`user_name`. This means remote's actual schema has diverged from what a fresh `supabase db push` of these migrations would produce — most likely a column added directly via the Supabase dashboard/SQL editor outside the tracked migration history. Practically, this means `approve_lease_workflow`'s *original* (broken-locally) audit_logs insert would **not** have crashed on that remote project — it would have written into the untracked legacy `user_id` column. The "every real approval crashes" conclusion only holds for a database built strictly from these migration files (local, or any brand-new Supabase project) — it does not describe the current state of `cjwdwuqqdokblakheyjb`.

**Decision (this session):** kept the in-place fix for both files. Rationale: `supabase migration list --linked` shows both migrations already marked `applied` on the remote project, so a future `supabase db push` against *that same project* will not attempt to re-run the changed file content regardless of the edit (migrations are tracked and applied once by version, not by content hash) — the practical deployment risk to the existing project is low. Reverting to the original text would not restore the ability to run a fresh `db reset --local` anyway, since local's Postgres rejects the policy syntax independent of what succeeded on remote; the migration runner aborts the entire apply chain on the first error and never reaches a later corrective migration, so "revert + append a later fix" does not by itself unblock fresh environments here — unlike an ordinary "migration ran but computed something wrong" bug, where a later corrective migration works fine.

**Not resolved by this decision, flagged for separate follow-up:**
- The `audit_logs.user_id` drift itself (why remote has a column not in migration history, and whether to add a migration that formally captures/reconciles it, e.g. `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_id uuid` so a fresh environment matches remote's actual shape, or a plan to drop the untracked column from remote instead).
- Why local Postgres rejects the `ANY(set-returning function)` policy syntax that remote's Postgres tolerated — worth confirming Postgres version parity between local Docker and the remote project before assuming this is purely a version difference.
- A broader audit of whether other tables have similar untracked drift from manual dashboard changes, since `audit_logs.user_id` was only found because this specific bug forced a direct remote schema dump.

## 2026-07-08 update: remote-deployment-readiness prep for the enterprise-hardening branch

A second, targeted `supabase db dump --linked --schema public` (plus `supabase migration list --linked`) was run before deciding whether the branch's accumulated migration backlog (`20260706120000` through `20260707030000`, covering Phases 0–5B-2A of the server-owned workflow hardening) is safe to push to the linked remote project. It surfaced more than the `user_id` drift already documented above:

1. **`audit_logs.property_id` is missing on remote** — a *required* column, not an optional/legacy one. Every RPC or edge function this branch added or modified inserts into it: `approve_lease_workflow` (normalized), `delete_lease_cascade`, `save_property_cam_config`/`save_lease_config`, `persist_expense_classification`, `compute-budget`, and the two pre-existing same-pattern RPCs the new ones were modeled on (`send_expense_classification_to_cam_workflow`, `publish_lease_expense_rule_to_cam_workflow`). Like `user_id`, this table pre-dates this repo's migration history on remote, so the original `CREATE TABLE IF NOT EXISTS` (`20260322_add_core_tables.sql`) was a no-op there and `property_id` was never added via `ALTER TABLE`. Pushing the branch backlog to remote without this column first would fail every one of the RPCs above with `42703` on first invocation. (Five other original-schema columns — `user_name`, `property_name`, `building_name`, `unit_number`, `ip_address` — are *also* missing on remote, but nothing in this branch reads or writes them, so they were left alone.)
2. **Remote has an extra, unsafe RLS policy**: `audit_logs_insert_all ON audit_logs FOR INSERT TO authenticated, anon WITH CHECK (true)` — not in any migration, not present locally. Since Postgres RLS policies are OR'd, this makes the properly-restrictive `audit_logs_insert` policy (which checks `actor_user_id = auth.uid()`, `source = 'frontend'`, `severity <> 'critical'`, and an active org membership) moot on remote: any authenticated caller could insert an arbitrary row there today, including a forged `actor_user_id`/`severity`.
3. **`fn_on_expense_added` on remote had already been hand-patched**, independent of any migration: its live body (visible in the schema dump) had `property_id` removed from its `audit_logs` insert, with an in-body comment literally saying `-- Audit Log (removed property_id since the column doesn't exist in audit_logs)`. The migration-tracked version (`20260622000001_fix_remaining_security_definer_search_path.sql`) has always included `property_id`. This means someone hit the `property_id`-missing problem on remote before, patched around it directly via the dashboard/SQL editor rather than fixing the schema, and that patch was never captured in migration history — remote was silently running code no migration produces.

**Prep migrations added (applied to local Docker Postgres, then pushed to remote — see follow-up note below):**
- `20260708000000_capture_audit_logs_user_id_column.sql` — `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_id uuid;` (formally captures the drift from the section above; no-op locally since local never had it missing from this decision's perspective — it adds the column locally too, so local and remote converge).
- `20260708010000_audit_logs_add_property_id.sql` — `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES public.properties(id) ON DELETE SET NULL;` (no-op locally — the column already existed from the original `CREATE TABLE`; this migration's only real effect is on remote).
- `20260708020000_drop_unsafe_audit_logs_insert_all_policy.sql` — `DROP POLICY IF EXISTS "audit_logs_insert_all" ON audit_logs;` (no-op locally — the policy never existed there; only removes the bypass on remote).
- `20260708030000_restore_fn_on_expense_added_property_id.sql` — `CREATE OR REPLACE FUNCTION fn_on_expense_added()`, restoring the migration-tracked body (byte-for-byte the `20260622000001` version) now that `property_id` exists again. No-op re-apply locally; on remote this replaces the hand-patched variant with the tracked one.

All four verified against local Docker Postgres: `audit_logs` now has both `user_id` and `property_id`; only `audit_logs_insert`/`audit_logs_select` policies remain (the `DROP POLICY IF EXISTS` was confirmed harmless); `fn_on_expense_added` compiles with `property_id` restored. Full regression after applying: 31/31 Deno tests (the branch's cumulative suite), 352/352 Vitest, clean `npm run build`.

**Do not push the existing branch backlog (`20260706120000`→`20260707030000`) to remote before these four prep migrations land there first** — pushing the backlog first would break every lease approval, CAM config save, expense classification persist, and CAM-send/publish action on remote the moment they run, for the same `property_id`-missing reason described above.

**2026-07-08, later same day: the four prep migrations were pushed to remote.** Since `supabase db push` has no flag to select a version range (only `--include-all`/`--dry-run`), the 9 backlog migration files were temporarily moved out of `supabase/migrations/` (to a scratch location, not deleted), `supabase db push --linked --dry-run` was used to confirm exactly the 4 prep migrations would apply, then pushed for real, then the 9 backlog files were moved back immediately after. Verified via a fresh `supabase db dump --linked --schema public` and `supabase migration list --linked`: remote's `audit_logs` now has both `user_id` and `property_id`; only `audit_logs_insert`/`audit_logs_select` policies remain (`audit_logs_insert_all` is gone); `fn_on_expense_added`'s live body now matches the migration-tracked version (`property_id` restored, "removed property_id" comment gone); migration history shows `20260708000000`–`20260708030000` applied while `20260706120000`–`20260707030000` remain unapplied, exactly as intended. The branch backlog itself was **not** pushed.

**Still not resolved, flagged for separate follow-up (not touched by this prep):**
- The `tr_lease_changed`/`tr_expense_added`/`tr_budget_changed` triggers (all from `20260322_add_core_tables.sql`) are active on both local and remote and fire independently of this branch's RPC-level audit inserts, producing duplicate `audit_logs` rows for the same logical event (confirmed: one lease approval produces 3 rows — trigger `create`, trigger `update`, RPC `lease_abstract_approved`). Phase 5A's duplicate-audit inventory only covered client-side `logAudit()` call sites and did not account for this. Needs its own reconciliation phase.
- Dropping `audit_logs.user_id` from remote once the branch's migrations are deployed and its data (if any) has been reviewed — deliberately deferred, not part of this prep.
- Actually running `supabase db push` for either the prep migrations or the branch backlog — both remain a separate, explicit decision.

## 2026-07-09: the branch backlog was pushed to remote — two more environment-only incompatibilities found and fixed first

Two additional local/remote divergences surfaced when the first attempt to push the 9-migration backlog (`20260706120000`→`20260707030000`) failed partway, both fixed with narrow, additive compatibility migrations rather than touching the two functions actually responsible for the divergence:

### 1. `get_my_org_ids()` return-type mismatch
The push failed on `20260706130000_lease_abstract_versions.sql`'s `lease_abstract_versions_select` policy: `ERROR: operator does not exist: uuid = uuid[] (SQLSTATE 42883)`. Root cause: `public.get_my_org_ids()` has a different return type on each environment — local `RETURNS SETOF uuid` (matches all three migration-history redefinitions), remote `RETURNS uuid[]` (live-only, created by no migration in this repo). Remote's own 24 existing live policies (`budgets_all`, `leases_all`, `properties_all`, etc.) all use `org_id = ANY(get_my_org_ids())`, which is valid for an array-returning function — so remote was internally self-consistent, just incompatible with this branch's `IN (SELECT get_my_org_ids())` pattern (correct for local's `SETOF uuid`).

**Fix:** rather than changing `get_my_org_ids()` on either side (would mean a `DROP FUNCTION` plus rewriting all 24 live remote policies, or rewriting all 47 local call sites), added one new, narrow helper neither environment had: `public.is_member_of_org(check_org_id uuid) RETURNS boolean` (new migration `20260706125000_add_is_member_of_org_helper.sql`, sequenced before `20260706130000`). Boolean-returning, no array/set ambiguity, valid identically on local, remote, and a future Azure Postgres instance. Only `20260706130000`'s one affected policy was rewritten to use it (`USING (public.is_member_of_org(org_id))`); `get_my_org_ids()` and its other 46 call sites were left untouched.

### 2. `budgets_all` — a leftover permissive policy that would have silently defeated the budget RLS lockdown
Investigation found remote's `budgets` table carries a 6th policy, `budgets_all` (`FOR ALL USING (org_id = ANY(get_my_org_ids()))`), never created by any migration in this repo and never dropped by `20260707000000_budgets_rls_lockdown.sql`/`20260707010000_budgets_delete_lockdown.sql` (those only target policies named `budgets_insert`/`budgets_update`/`budgets_delete`). Since RLS permissive policies OR together, pushing the lockdown migrations without also removing `budgets_all` would have left the table fully writable by any org member regardless of the new `WITH CHECK (false)`/`USING (false)` policies — the lockdown would have silently done nothing.

**Fix:** new migration `20260706165000_budgets_all_policy_compatibility.sql` — a single `DROP POLICY IF EXISTS "budgets_all" ON public.budgets;`, sequenced between `20260706160000` and `20260707000000` so the leftover policy is gone before the lockdown migrations run. Safe no-op on local (the policy never existed there). Did not touch `budgets_select`/`budgets_select_super_admin` or any lease/expense/property policy.

### The push
With both compatibility migrations in place, `supabase db push --linked --include-all` was retried and **all 10 migrations applied cleanly with no errors** (the original 9-file backlog plus the 2 new compatibility migrations, one of which — `is_member_of_org` — folds into the "9" count differently since it's new; total pushed this run: `20260706125000`, `20260706130000`, `20260706140000`, `20260706150000`, `20260706160000`, `20260706165000`, `20260707000000`, `20260707010000`, `20260707020000`, `20260707030000`).

### Final remote verification (read-only: `supabase migration list --linked` + a fresh `supabase db dump --linked --schema public`)
- `supabase migration list --linked` — all 10 now show `remote` populated, matching `local`; every migration in the repo's history is applied on remote.
- `lease_abstract_versions` table — exists.
- `public.is_member_of_org(uuid)` — exists.
- `budgets_all` policy — confirmed absent (0 matches).
- `budgets_insert`/`budgets_update`/`budgets_delete` — confirmed `WITH CHECK (false)`/`USING (false)` — the lockdown is now actually effective.
- `budgets_select`/`budgets_select_super_admin` — unchanged, still present.
- `approve_lease_workflow` — confirmed canonical audit shape (`actor_user_id`/`actor_email`/`severity`/`source`/`workflow_run_id`/`before`/`after`/`metadata`/`property_id`; no legacy `user_id`/`field_changed`/`old_value`/`new_value` in this insert).
- `delete_lease_cascade` — confirmed 3-parameter signature (`target_lease_id`, `p_actor_user_id`, `p_actor_email`) with the `audit_logs` insert immediately following the `DELETE FROM public.leases` inside the same function body (transactional).
- `save_property_cam_config`/`save_lease_config` — both exist.
- `persist_expense_classification` — exists.
- `audit_logs.user_id` and `audit_logs.property_id` — both still present (from the earlier prep migrations, unaffected by this push).

No stop condition was hit: no unexpected migrations, no partial/failed state, no destructive SQL was needed, the budget lockdown is confirmed effective, and nothing in the verification suggested any existing production workflow broke.

**Remaining future-phase risks (not touched by this push, carried forward):**
- Duplicate audit rows from `tr_lease_changed`/`tr_expense_added`/`tr_budget_changed` firing alongside RPC-level audit inserts (documented above) — needs its own reconciliation phase. (`tr_budget_changed`'s piece of this was resolved 2026-07-09, see below; `tr_lease_changed`/`tr_expense_added` remain open.)
- The same `_all`-style leftover-policy pattern likely exists for `leases`/`expenses`/`properties`/`tenants`/`units`/`vendors`/`portfolios`/`buildings`/`documents` on remote (all visible as `_all` policies in the schema dump) — must be checked and reconciled the same way `budgets_all` was, before any future Phase 6 RLS lockdown touches those tables.
- Broader (lease/expense/CAM) RLS lockdown — not started; Phase 6 in the plan file remains not-yet-begun.
- `audit_logs.user_id` — captured, not dropped; the drop decision remains deliberately deferred pending a review of any historical data in that column.
- Azure migration — still entirely paused; no Azure-specific work has been done in this branch.

## 2026-07-09: budget audit-trigger reconciliation (Phase 6A-1) — pushed to remote

`tr_budget_changed` (`AFTER INSERT OR UPDATE ON budgets`, from `20260322_add_core_tables.sql`) wrote its own `audit_logs` row on every budget write, duplicating the canonical rows `compute-budget` already writes for every action (generate/mark_reviewed/approve/lock/reject) now that budgets is fully RPC-owned and direct writes are RLS-blocked. Unlike a purely-audit trigger, `fn_on_budget_changed` also drives real notification side effects (Budget Created/Approved/Locked/Submitted/Reviewed/Sent Back for Rework/Rework Comment Updated), so the trigger itself had to stay — only its `audit_logs` insert was removed.

**Incidental drift found and fixed in the same migration:** inspecting the function ahead of this change found that the linked remote project's *live* `fn_on_budget_changed` was still running the **original 20260322 body** — missing the `Reviewed`/`Sent Back for Rework`/`Rework Comment Updated` notification branches and the `link` column added later by `20260410000000_budget_review_workflow_metadata.sql`, despite that migration showing as `applied` in `supabase migration list --linked`. Same "migration history says one thing, remote runs another" pattern as every prior finding this session. The new migration's `CREATE OR REPLACE FUNCTION` restores the full, currently-tracked notification body (byte-for-byte `20260410000000`'s version) with only the audit insert removed — so this one migration both removed the duplicate audit row and brought remote's live trigger back in line with migration history.

**Migration:** `20260709010000_budget_trigger_audit_reconciliation.sql`. **Test:** new `budget-trigger-audit-reconciliation.property.test.ts` proves (1) `compute-budget` generate (trigger's INSERT path) produces zero trigger-duplicated `Budget`/`create` rows and exactly one canonical `budget_generated` row; (2) `compute-budget` approve (trigger's UPDATE path) produces zero trigger-duplicated `Budget`/`update` rows; (3) both `Budget Created` and `Budget Approved` notifications still fire; (4) direct client INSERT/UPDATE on `budgets` remains rejected by RLS.

**Verification:** local `db reset --local` clean; local Deno regression 32/32 (branch-cumulative, includes the new test); Vitest 352/352; clean build; remote dry-run showed exactly this one migration pending; pushed; verified read-only against a fresh `supabase db dump --linked`: `fn_on_budget_changed` has zero `audit_logs` inserts, all 7 notification inserts intact, the 3 previously-missing branches now present, trigger still attached only to `budgets` (not shared with `leases`/`expenses`).

**Not touched, per scope:** `tr_lease_changed`, `tr_expense_added` (still fire their own duplicate audit rows — flagged for their own future reconciliation, since `expenses` in particular has no write-path RPC yet and its trigger's audit row is still load-bearing), generic audit trigger, broader RLS lockdown, Azure, frontend/app code.

## 2026-07-09: remote-only blanket RLS drift cleanup (Phase 6B-1) — pushed to remote

Phase 6B's inventory pass found the same `budgets_all`-style leftover on eight more tables — `leases_all`, `expenses_all`, `properties_all`, `buildings_all`, `portfolios_all`, `tenants_all`, `units_all`, `vendors_all` (all `FOR ALL USING (org_id = ANY(get_my_org_ids()))`, no page-permission gating) — plus four per-command equivalents on `documents` (`documents_select_own_org`/`_insert_own_org`/`_update_own_org`/`_delete_own_org`). None of these are created by any migration in this repo; all are remote-only, pre-migration-history drift, same root cause as `budgets_all`. Deliberately left untouched: `org_members_documents` and `super_admin_all_documents` — both tracked by `202604130146112_lease_approval_and_documents.sql` and live on both environments (removing those is a separate, deliberate RLS decision, not drift cleanup), and every named per-command policy (`leases_select`/`_insert`/`_update`/`_delete`, etc.), which remain the sole active gate for these tables.

**Migration:** `20260709020000_drop_remote_only_blanket_rls_policies.sql` — twelve `DROP POLICY IF EXISTS` statements, one per listed policy. Safe no-op on local (none of these ever existed there).

**Verification:** local `db reset --local` clean, all twelve drops reported as expected no-ops; local Deno regression 32/32; Vitest 352/352; clean build; remote dry-run showed exactly this one migration pending; pushed; verified read-only against a fresh `supabase db dump --linked`: all twelve target policies confirmed gone, every named per-command policy and `_select_super_admin` policy intact for all eight tables, `documents_select`/`_insert`/`_update`/`_delete`/`_select_super_admin` and `org_members_documents` all untouched (`super_admin_all_documents` remains absent on remote as it already was — unrelated, pre-existing anomaly, not part of this cleanup).

**Not touched, still open:** `org_members_documents` (needs its own confirmation that the named per-command policies fully cover legitimate document-write paths before dropping), the same pattern on any other table not yet inventoried, `tr_lease_changed`/`tr_expense_added` reconciliation, broader per-table RLS lockdown (none of these eight tables have any write-path RPC yet, so lockdown isn't viable for them regardless), Azure, frontend/app code.

## 2026-07-10: `review_expense_classification` RPC — Finalize + Reopen only (Phase 6E-1) — deployed to remote

`src/services/expenseService.js`'s `finalizeExpenseClassification()`/`reopenExpenseClassification()` wrote directly to `expenses`/`expense_classifications` with zero audit logging and zero server-side permission check — Finalize in particular promotes a row to CAM-ready, one of the most consequential state transitions in the app. Full write-path inventory for leases and expenses is in the plan file's Phase 6D section; this migration is the first slice of the resulting RPC architecture plan.

Client-side eligibility gate (`isActualClassificationEligible`/`isRuleClassificationEligible`, ~10 helper functions from the same ~2000-line matching/decision engine Phase 3 already decided not to port server-side) is deliberately left in place, unchanged — the RPC adds its own narrow, complementary checks (org boundary, row existence, actor identity) rather than re-deriving the full eligibility decision, matching `persist_expense_classification`'s established precedent.

Also fixed a latent bug found while reading the current code: `reopenExpenseClassification()`'s first write targeted the `expenses` table with columns (`classification_status`/`finalized_at`/`cam_status`/`next_step`/`reviewed_at`) that don't exist there at all (confirmed via `\d expenses`) — only on `expense_classifications`. The generic factory silently stripped the unknown columns, so that call only ever bumped `updated_at`. The new RPC does not replicate that no-op.

**Security correction during review:** the first draft granted `EXECUTE` to `authenticated, service_role` (matching `persist_expense_classification`'s convention). Caught before push: since this RPC is `SECURITY DEFINER` and does not itself re-check page-level permission, granting `authenticated` would let any org member call it directly via the client SDK, bypassing the edge function's `assertPageAccess` gate entirely (RLS does not apply to `SECURITY DEFINER` functions). Corrected to `GRANT EXECUTE ... TO service_role` only, with `REVOKE ALL ... FROM PUBLIC, anon, authenticated`. Not retroactively applied to `persist_expense_classification` (out of scope, unrelated file — worth a future look).

**Files:** `supabase/migrations/20260710000000_review_expense_classification.sql`; `supabase/functions/review-expense-classification/index.ts`; `src/services/expenseClassificationWorkflowService.js` (new `reviewExpenseClassification()`); `src/services/expenseService.js` (both functions rewritten to call it); new test `supabase/functions/_tests/review-expense-classification.property.test.ts`.

**Local tooling issue hit and resolved:** the npx-cached `supabase` CLI binary was completely broken (`spawnSync ... UNKNOWN`, even on `--version`, in both Bash and PowerShell) — switched to the directly-installed `scoop` copy (v2.105.0) for the rest of this work. The subsequent `db reset --local` also left Kong/edge-runtime unreachable (every route timed out, not just the new function) — resolved with a full `supabase stop` + `supabase start` cycle, which preserved the already-migrated database.

**Verification:** local `db reset --local` clean, function present; Deno regression 37/37 (5 new: finalize success, reopen success, unauthorized user blocked with zero audit rows, missing-classification error, invalid-action atomicity); Vitest 352/352; lint clean; build clean; remote dry-run showed exactly this one migration; pushed; verified read-only via a fresh `supabase db dump --linked`: function exists with the exact signature, `EXECUTE` granted only to `service_role` (no `authenticated`/`anon`/`PUBLIC` grant), canonical `audit_logs` insert shape confirmed in the deployed function body, migration history shows every version applied with no unexpected entries beyond this one. Edge function deployed (`supabase functions deploy review-expense-classification`) and confirmed `ACTIVE` (version 1) via `supabase functions list`.

**Not touched, per scope:** Exception Queue actions (approve/reject/mark_na/resolve), `ExpenseReview.jsx`, lease rule saves, lease extraction edits, RLS lockdown, generic audit trigger, Azure, no live mutating remote smoke test run (structural/read-only verification only, matching the earlier-established policy of not fetching the remote service-role key into this conversation).

## 2026-07-11: `review_expense_classification` extended — Exception Queue actions (Phase 6E-2) — pushed to remote (function v2 deployed)

Extended the same RPC to cover `ExpenseReview.jsx`'s four Exception Queue actions (approve/reject/mark_na/resolve), plus that page's separate main classification-review table (`ExpenseBucketTable`, wired to `reviewMutation` — a different mutation than the Exception Queue's `exceptionMutation`, but calling the identical `expenseService.updateExpenseClassification()` → raw `updateExpenseClassificationRecord()` write with the same `buildClassificationReviewPatch()` shape). Both were still direct, unaudited, permission-check-free writes — same gap Finalize/Reopen had before 6E-1.

`'approve'` ports `buildClassificationReviewPatch()`'s full branching logic verbatim into SQL: `classification_status` depends on both the submitted `recovery_status` *and* `approved_status` (`ExpenseBucketTable`'s five buttons send `approved_status` of `'approved'`, `'needs_review'`, or `'rejected'` — the JS function only branches on `approved_status === 'approved'` vs not, so the other two behave identically). `'reject'`/`'mark_na'`/`'resolve'` are fixed-target transitions ported directly from `exceptionMutation`. None of the four touch the `expenses` table (confirmed: `updateExpenseClassificationRecord` only ever wrote `expense_classifications`).

**Bug caught during local verification (not pushed with the mistake in it):** the first version of this migration added `p_approved_status` as a new trailing parameter via plain `CREATE OR REPLACE FUNCTION` — Postgres does **not** treat an added parameter (even with a `DEFAULT`) as replacing the original signature; it silently created a **second overloaded function**, leaving both the old 6-parameter and new 7-parameter versions coexisting (`\df` showed two rows). Exact same class of bug already hit and fixed once this session for `delete_lease_cascade`. Fixed by adding `DROP FUNCTION IF EXISTS public.review_expense_classification(UUID, UUID, UUID, TEXT, TEXT, TEXT);` before the `CREATE OR REPLACE`, then a full `db reset --local` to get back to a clean single-function state (confirmed via `\df`).

Also removed now-dead code as part of this change: `ExpenseReview.jsx`'s `buildClassificationReviewPatch`/`amountBuckets` helpers (logic moved server-side) and the unreachable dead-code tail after `exceptionMutation`'s four early-return branches (lines ~351-375 of the pre-change file, which could never execute).

**Files:** `supabase/migrations/20260711000000_review_expense_classification_exception_queue.sql`; `supabase/functions/review-expense-classification/index.ts` (new actions + `approved_status` validation, `ExpenseReview` added to the page-access list); `src/services/expenseClassificationWorkflowService.js` (`reviewExpenseClassification()` gains `approvedStatus`); `src/pages/ExpenseReview.jsx` (`reviewMutation`/`exceptionMutation` rewritten to call the RPC); new test `supabase/functions/_tests/review-expense-classification-exception-queue.property.test.ts`.

**Verification:** local `db reset --local` clean (after the DROP FUNCTION fix), single function confirmed via `\df`; Deno regression 43/43 (6 new: approve/finalize-style, approve/Mark-Conditional-style, reject, mark_na, resolve, invalid-`approved_status`-rejected); Vitest 352/352; lint clean; build clean; remote dry-run showed exactly this one migration; pushed; verified read-only (single 7-param function, grants `service_role`-only). Edge function redeployed, confirmed version 2 `ACTIVE` via `supabase functions list`.

**Hit again, same class of issue:** the post-reset "Restarting containers" step failed twice more on unrelated local-only infra flakiness (Kong/edge-runtime unreachable on every route after the first reset — full `stop`+`start` cycle fixed it; a "vector buckets... FeatureNotEnabled" 409 on the second and third resets — schema-level changes had already applied successfully before this step, confirmed via direct `\df` checks each time, so this was not a migration-content problem).

## 2026-07-12: lease audit-trigger reconciliation (Phase 6A-2) — pushed to remote

Unlike `budgets` (fully RPC-covered, so `tr_budget_changed`'s audit insert could simply be dropped — Phase 6A-1) and unlike `expenses` (no RPC touches expense *creation* at all yet, so `tr_expense_added`'s audit row remains the sole audit trail for every expense — Phase 6A-3 has no actionable work right now), `leases` sits in between: `approve_lease_workflow` is the only RPC that `UPDATE`s the `leases` row, while ~12 other call sites (inventoried in the Phase 6D write-path plan) still write directly and rely on `tr_lease_changed` as their only audit trail. Dropping the trigger's audit insert outright — the `budgets` approach — would have silently removed audit coverage for all twelve.

**Mechanism used instead (option (a) from the original Phase 6A-2/6A-3 plan sketch):** a transaction-local GUC. `approve_lease_workflow` calls `PERFORM set_config('app.skip_lease_audit_trigger', 'true', true)` immediately before its `UPDATE public.leases`; `fn_on_lease_changed` wraps its audit insert in `IF current_setting('app.skip_lease_audit_trigger', true) IS DISTINCT FROM 'true' THEN ...`. The third argument to `set_config` (`is_local => true`) gives `SET LOCAL` semantics — the setting automatically reverts at `COMMIT`/`ROLLBACK`, so it can never leak into a later, unrelated transaction or request. `current_setting(..., missing_ok => true)` returns `NULL` for every caller that never sets it (i.e. every one of the twelve still-direct-write paths), so `NULL IS DISTINCT FROM 'true'` is `TRUE` and the audit insert fires exactly as it always has. `delete_lease_cascade` is unaffected — `tr_lease_changed` is `AFTER INSERT OR UPDATE` only, never fires on `DELETE`. Notification side effects (lease-expiry alert, budget-ready alert) are untouched, only the audit insert is conditional.

**Files:** new migration `20260712000000_lease_audit_trigger_reconciliation.sql` — `CREATE OR REPLACE` of `fn_on_lease_changed` (adds the GUC check) and `approve_lease_workflow` (adds the one `set_config` line; body otherwise byte-for-byte identical to `20260707030000`'s version, confirmed by dumping the live function first and diffing before writing this migration — signature unchanged, so no `DROP FUNCTION` needed this time, unlike `review_expense_classification`'s bug above). New test `supabase/functions/_tests/lease-trigger-audit-reconciliation.property.test.ts`.

**Verification:** local `db reset --local` clean, both functions confirmed single-signature via `\df`; Deno regression 44/44 (1 new test covering: lease creation still trigger-audited, approval produces zero trigger-duplicated rows, a later ordinary direct UPDATE after the RPC call is still fully audited by the trigger — proving the GUC doesn't leak across transactions — and the trigger's "Lease Ready for Budget" notification still fires for that direct write); Vitest 352/352; lint clean; build clean; remote dry-run showed exactly this one migration; pushed; verified read-only via a fresh `supabase db dump --linked`: both the trigger's GUC check and the RPC's `set_config` call present in the live remote function bodies.

**Not touched, still open:** `tr_expense_added` (Phase 6A-3) — no actionable work exists yet since no RPC inserts expense rows; revisit once an expense-creation RPC exists. The ~12 still-direct-write lease call sites themselves remain unmigrated (tracked in the Phase 6D plan), Azure, RLS lockdown.
