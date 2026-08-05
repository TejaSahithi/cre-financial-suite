# Historical Migration Repairs: `unnest(get_my_org_ids())`

**Status:** applied to migration files, verified locally. **No remote database was touched.**

---

## 1. What was wrong

`supabase db reset` (clean bootstrap from an empty database) failed:

```
Applying migration 20260858000000_enterprise_review_payloads_release4.sql...
ERROR: function unnest(uuid) does not exist (SQLSTATE 42883)
```

`public.get_my_org_ids()` is declared `RETURNS SETOF UUID` in all three of its
definitions:

| Migration | Line | Declaration |
|---|---|---|
| `20260321_create_organizations.sql` | 106 | `RETURNS SETOF UUID` |
| `20260404_fix_superadmin_rls.sql` | 12 | `RETURNS SETOF UUID` |
| `20260602014048_security_definer_search_path_hardening.sql` | 3 | `RETURNS SETOF uuid` |

`unnest()` expects an **array**. Applied to a set-returning function it resolves
to `unnest(uuid)`, which does not exist — so the statement is invalid at parse
time and the migration aborts.

The repository already used the correct form in 37 places
(`IN (SELECT public.get_my_org_ids())`) and the invalid form in 29 places,
across 12 migration files, all dated `20260858000000` or later.

---

## 2. Affected migrations

```
20260858000000_enterprise_review_payloads_release4.sql
20260859000000_canonical_review_hybrid_rollout_release4b.sql
20260860000000_document_semantics_release6.sql
20260861000000_portfolio_intelligence_release8.sql
20260862000000_enterprise_integrations_release9.sql
20260863000000_enterprise_control_plane_release10.sql
20260869000000_update_units_schema_and_policies.sql
20260870000000_update_tenants_schema_and_policies.sql
20260871000000_update_vendors_schema_and_policies.sql
20260872000000_update_financial_uploads_bucket_policies.sql
20260873000000_update_leases_schema_and_policies.sql
20260874000000_update_expenses_and_audit_logs.sql
```

---

## 3. Invalid and corrected SQL

**Invalid**

```sql
CREATE POLICY "..." ON public.<table>
  FOR SELECT USING (org_id IN (SELECT unnest(public.get_my_org_ids())));
```

**Corrected**

```sql
CREATE POLICY "..." ON public.<table>
  FOR SELECT USING (org_id IN (SELECT public.get_my_org_ids()));
```

The change is exactly the removal of the `unnest(...)` wrapper. Nothing else in
any of the 12 files was modified: no table, column, policy name, predicate,
role, or ordering changed. Diff: **12 files, 29 insertions, 29 deletions.**

---

## 4. Why the correction is semantically equivalent

`SELECT f()` where `f()` is `RETURNS SETOF UUID` already produces one row per
returned UUID. That is precisely what `unnest()` would have produced from an
array of the same UUIDs. The `IN (...)` predicate therefore receives an
identical row set, so each RLS policy's truth value is unchanged for every
possible input.

Concretely, for a user who is a member of orgs `{A, B}`:

| Form | Rows produced by the subquery | Predicate |
|---|---|---|
| `SELECT unnest(get_my_org_ids())` | *(invalid — never executed)* | — |
| `SELECT get_my_org_ids()` | `A`, `B` | `org_id IN (A, B)` |

There is no input for which the corrected form admits a row the original
intent would have denied. **The correction cannot widen access**; it changes an
unparseable statement into the statement it was always meant to be, and it
matches the form already used by the other 37 call sites in the same codebase.

---

## 5. Why the linked migration ledger must NOT be altered

These 12 migrations are already recorded as applied on the linked project, and
the schema objects they create are live there. That is only possible because
they were originally applied in an environment where the expression resolved —
i.e. the deployed database's policies already exist in their intended form.

Therefore:

- **Do not** re-run these migrations against the linked project.
- **Do not** delete, re-insert, or re-timestamp their rows in
  `supabase_migrations.schema_migrations`.
- **Do not** use `supabase migration repair` for them.

Editing the ledger would either cause the migration tool to re-apply DDL that
already exists, or make an applied migration look pending. The files are edited
purely so that a **new, empty** database can be built; the linked project's
history is untouched and must stay that way.

`supabase db push` is unaffected: it only applies migrations whose version is
absent from the remote ledger, and all 12 of these are present. It will not
re-send them.

---

## 6. Proof: clean bootstrap now passes

Before:

```
Applying migration 20260858000000_enterprise_review_payloads_release4.sql...
ERROR: function unnest(uuid) does not exist (SQLSTATE 42883)
exit=1
```

After:

```
Applying migration 20269900000038_drop_cam_profiles_shell.sql...
Applying migration 20269900000039_cam_expense_inputs_canonical_category_id.sql...
Applying migration 20269900000040_cam_controlled_category_resolution.sql...
exit=0
```

Verified afterwards on the freshly-built database:

- migrations `20269900000037/38/39/40` present in `supabase_migrations.schema_migrations`;
- `cam_expense_inputs.expense_category_id` present with FK, index and trigger;
- `public.cam_profiles` absent;
- 329 CAM tests pass against that database.

This also closes a specification §30.5 release requirement ("clean supported
database bootstrap"), which could not previously be satisfied at all.

---

## 7. Proof that the deployed schema is unchanged by these edits

The edits touch only migration **files on disk**. They are not new migrations
and carry no new version, so nothing is queued for the remote database.

Verification available to the deployer, all read-only:

1. `supabase migration list --linked` — all 12 versions already show a remote
   entry; the pending set contains only `20269900000037`–`20269900000041`.
   Running `db push` therefore cannot re-apply any edited file.
2. Compare the live policy definitions against the corrected files:

   ```sql
   -- READ-ONLY. Expect zero rows containing 'unnest'.
   select schemaname, tablename, policyname, qual
     from pg_policies
    where schemaname = 'public'
      and qual ilike '%unnest%';
   ```

   A live policy has already been stored by PostgreSQL in normalised form; if
   any row returned contained `unnest(...)` over a set-returning function it
   could not have been created in the first place.
3. `supabase db diff --linked` reports no schema drift attributable to these
   files.

Because the corrected expression is semantically identical (section 4), even a
future re-application would produce byte-identical policy semantics.
