-- Enterprise hardening Phase 4 (budgeting): compute-budget's own generate
-- handler has always upserted into `budgets` with
-- ON CONFLICT (org_id, property_id, budget_year) — but no such unique
-- constraint has ever existed on the table, so every call to
-- compute-budget with action="generate" has failed with
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification". Discovered while making compute-budget the sole official
-- persistence path for CreateBudget.jsx (previously nothing exercised this
-- code path against a real onConflict-checking database).
--
-- This constraint matches what compute-budget's code has always assumed:
-- one budget per (org_id, property_id, budget_year). compute-budget always
-- requires property_id (throws if missing), so this does not need a
-- NULLS NOT DISTINCT clause the way property_config's equivalent constraint
-- does — every row compute-budget writes has a non-null property_id.
--
-- Note: if this is ever applied to an environment with pre-existing
-- duplicate (org_id, property_id, budget_year) rows (e.g. from the old
-- CreateBudget.jsx direct-insert path, which had no such constraint either),
-- this ALTER TABLE will fail loudly rather than silently dropping data —
-- that is intentional; resolving such duplicates is a data decision for
-- whoever owns that environment, not something to script here.

ALTER TABLE public.budgets
  ADD CONSTRAINT budgets_org_property_year_key UNIQUE (org_id, property_id, budget_year);
