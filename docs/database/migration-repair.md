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
