# Schema Sync Checklist — ProForma OS

Use this checklist before every staging/production deployment to ensure the
database schema matches what the application code expects.

---

## Quick verification commands

```bash
# Reset local DB and confirm all migrations apply cleanly
supabase db reset --local

# List migrations in order (local)
supabase migration list --local

# Compare local vs remote (staging)
supabase migration list --linked

# Push any missing migrations to the linked project
supabase db push --linked
```

---

## Required migrations (must be applied in order)

| Migration | File | What it adds |
|-----------|------|--------------|
| Core tables | `20260322_add_core_tables.sql` | `audit_logs`, `organizations`, base tables |
| Core business | `20260401_add_missing_business_tables.sql` | `leases`, `expenses`, `revenues` |
| Pipeline uploads | `202604010146112_pipeline_uploaded_files.sql` | `uploaded_files` table |
| Lease approval | `202604130146112_lease_approval_and_documents.sql` | `uploaded_files.lease_id` FK |
| Expense classifications | `20260424000000_expense_classifications.sql` | `expense_classification_templates` |
| Lease workflow | `20260512090000_lease_workflow_foundation.sql` | `lease_expense_rules` |
| CAM persistence | `20260519120000_expense_workflow_persistence_and_cam.sql` | `cam_expense_inputs` |
| Lease cascade RPC | `20260527120000_lease_cascade_rpc.sql` | `delete_lease_cascade()` function |
| Audit nullable org | `20260531000000_audit_logs_nullable_org_id.sql` | `audit_logs.org_id` nullable |
| Audit hardening | `20260602004050_audit_logging_hardening.sql` | `audit_logs` enhanced columns |
| Stripe billing | `20260601221738_stripe_billing_stage_2.sql` | `processing_status` column |
| Lease approval workflow | `20260602170000_lease_approval_workflow.sql` | Approval workflow tables |

---

## Per-issue verification

### 1. `delete_lease_cascade` RPC missing

```sql
-- Check if the RPC exists
SELECT routine_name FROM information_schema.routines
WHERE routine_name = 'delete_lease_cascade';
```

Expected: 1 row. If 0 rows, apply `20260527120000_lease_cascade_rpc.sql`.

The application has a client-side fallback (`deleteLeaseCascadeFallback` in
`leaseService.js`) so missing RPC does not break deletes — it just logs a warning.

---

### 2. `uploaded_files.lease_id` column missing

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'uploaded_files' AND column_name = 'lease_id';
```

Expected: 1 row. If 0, apply `202604130146112_lease_approval_and_documents.sql`.

The application guards against this via `ignoreMissingSchema()` in `leaseService.js`.

---

### 3. `expense_classification_templates` table missing

```sql
SELECT table_name FROM information_schema.tables
WHERE table_name = 'expense_classification_templates';
```

Expected: 1 row. If 0, apply `20260424000000_expense_classifications.sql`.

---

### 4. `cam_expense_inputs` table missing

```sql
SELECT table_name FROM information_schema.tables
WHERE table_name = 'cam_expense_inputs';
```

Expected: 1 row. If 0, apply `20260519120000_expense_workflow_persistence_and_cam.sql`.

---

### 5. `audit_logs` 400 errors — enhanced columns missing

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'audit_logs'
ORDER BY ordinal_position;
```

The enhanced schema (required for frontend audit inserts) adds:
`actor_user_id`, `actor_email`, `actor_role`, `target_user_id`, `severity`,
`source`, `request_id`, `user_agent`, `before`, `after`, `metadata`, `error_message`.

If these columns are absent, apply:
1. `20260531000000_audit_logs_nullable_org_id.sql` (makes `org_id` nullable)
2. `20260602004050_audit_logging_hardening.sql` (adds enhanced columns)

The application now has a schema-compat fallback in `audit.js` — it retries with
core columns only when the enhanced insert returns a schema error (PGRST204/42703).

---

### 6. `processing_status` column on `uploaded_files`

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'uploaded_files' AND column_name = 'processing_status';
```

If absent, the pipeline-status code logs a warning and retries without it.
Apply `20260601221738_stripe_billing_stage_2.sql` to add the column.

---

## After applying migrations

```bash
# Reload the PostgREST schema cache so new columns are visible immediately
# (avoids "could not find column in schema cache" errors)
SELECT pg_notify('pgrst', 'reload schema');

# Or via Supabase dashboard:
# Settings → API → Reload schema cache
```

---

## Rollback notes

All migrations in this project are additive (no DROP TABLE or DROP COLUMN).
Rolling back requires running manual ALTER/DROP statements — coordinate with
engineering before doing so in production.
