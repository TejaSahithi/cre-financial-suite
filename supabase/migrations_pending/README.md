# Pending migrations (NOT auto-applied)

Files in this directory are **not** picked up by `supabase db push` — the
Supabase CLI only applies migrations from `supabase/migrations/`. They are
staged here deliberately because they require a manual precondition check
against the live database before it is safe to apply them.

## 20260857000000_tighten_provider_invocations_check.sql

Tightens `provider_invocations.provider`'s CHECK constraint to only
`('azure_document_intelligence', 'openai')`, removing the deprecated
`'vertex_ai'`, `'gemini_api_key'`, `'docling'` values from the allowed set.

**Before promoting this migration**, run against the live database:

```sql
SELECT provider, count(*) FROM public.provider_invocations
WHERE provider NOT IN ('azure_document_intelligence', 'openai')
GROUP BY provider;
```

If this returns zero rows, move the file into `supabase/migrations/` (its
filename already sorts after every migration currently in that directory)
and run `supabase db push`. If it returns rows, do not apply this migration
until those rows are handled (e.g. backfilled to a canonical provider value
or otherwise reconciled) — applying it while such rows exist will fail the
`ALTER TABLE` at push time (Postgres validates existing rows against a
replaced CHECK constraint), which is the intended safety net.
