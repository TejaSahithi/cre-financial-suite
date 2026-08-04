-- Expense Classification -> CAM Publication boundary (enterprise hardening PR).
--
-- Scope note: an earlier draft of this migration attempted a much larger
-- rebuild (a new expense_classification_allocations table for multi-rule
-- expense splitting, new lease_expense_rules columns, new
-- expense_classifications columns). That draft was never applied (it failed
-- on an unrelated bug — `public.users` doesn't exist, only `auth.users`,
-- resolved via this DB's default search_path instead — before any
-- statement in it committed; confirmed via \d before writing this version).
-- It was abandoned per explicit instruction: audit first, implement only
-- confirmed gaps, do not rebuild the expense module. This migration is the
-- narrow replacement — see this PR's report, deliverable A, for the full
-- Existing/Partially Existing/Missing/Not Needed classification that
-- justifies exactly what is and isn't here.
--
-- Business rule this migration enforces structurally:
--   actual expense        = source of the financial AMOUNT
--   lease expense rule    = source of the contractual RECOVERY TREATMENT
--   expense classification = the reviewed RELATIONSHIP between the two
--   cam_expense_inputs    = the APPROVED AND PUBLISHED calculation input
--   compute-cam           = consumes cam_expense_inputs ONLY
--
-- Confirmed root cause (this database, before this migration):
-- cam_expense_inputs_org_write (RLS) allowed ANY org member to write this
-- table directly — no version, no withdrawn/superseded state, no
-- publish-time source snapshot. Versioning stays keyed on the existing
-- classification_result_id (one classification = one expense, per the
-- existing UNIQUE(org_id, expense_id) on expense_classifications) — no new
-- allocation-line table is introduced (see deliverable A, item 5).
--
-- Additive only: new nullable/defaulted columns, one new partial unique
-- index replacing an old unconditional one (so republish-after-withdraw
-- doesn't collide with the withdrawn row), and one RLS policy tightened
-- from "any org member" to "service_role only" (matching the existing
-- lockdown pattern already applied to expenses/expense_classifications —
-- 20260804000000/20260806000000).
--
-- Real-database preflight (see this PR's report, deliverable E) confirmed
-- before writing this migration: 52 cam_expense_inputs rows, all with a
-- non-null classification_result_id, zero duplicates, zero bad amounts —
-- the backfill in step 3 has no ambiguous rows.

-- ===========================================================================
-- 1. cam_expense_inputs — publication versioning + immutability metadata.
-- ===========================================================================
ALTER TABLE public.cam_expense_inputs
  ADD COLUMN IF NOT EXISTS publication_status TEXT NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS publication_version INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS previous_version_id UUID REFERENCES public.cam_expense_inputs(id) ON DELETE SET NULL,
  -- Frozen-at-publish-time snapshots of the source rows' updated_at. Used by
  -- the publish RPC's "source records have not changed since finalization"
  -- check: if expenses.updated_at / expense_classifications.updated_at /
  -- lease_expense_rules.updated_at at publish time no longer match what's
  -- stored here, the source has drifted since this version was published.
  ADD COLUMN IF NOT EXISTS source_expense_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_classification_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_rule_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS withdrawn_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS withdrawal_reason TEXT;

ALTER TABLE public.cam_expense_inputs DROP CONSTRAINT IF EXISTS cam_expense_inputs_publication_status_check;
ALTER TABLE public.cam_expense_inputs
  ADD CONSTRAINT cam_expense_inputs_publication_status_check
  CHECK (publication_status IN ('published', 'withdrawn', 'superseded'));

-- Replace the old "at most one row per classification, ever" unique index
-- with a partial one scoped to publication_status='published' — the same
-- "at most one CURRENT row per series" shape as
-- publish_computation_snapshot's own partial unique index
-- (20269900000002_snapshot_publish_rpc.sql), so withdraw-then-republish can
-- create a new version without violating uniqueness against the withdrawn
-- row it replaced.
DROP INDEX IF EXISTS idx_cam_expense_inputs_classification;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cam_expense_inputs_classification_published
  ON public.cam_expense_inputs (classification_result_id)
  WHERE classification_result_id IS NOT NULL AND publication_status = 'published';

DROP INDEX IF EXISTS idx_cam_expense_inputs_rule_amount;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cam_expense_inputs_rule_amount_published
  ON public.cam_expense_inputs (lease_expense_rule_id, fiscal_year)
  WHERE lease_expense_rule_id IS NOT NULL AND fiscal_year IS NOT NULL
    AND cam_input_type = 'lease_rule_amount' AND publication_status = 'published';

CREATE INDEX IF NOT EXISTS idx_cam_expense_inputs_org_scope_published
  ON public.cam_expense_inputs (org_id, property_id, building_id, unit_id, fiscal_year)
  WHERE publication_status = 'published';

-- ---------------------------------------------------------------------------
-- 2. RLS lockdown — this table was previously writable directly by any org
--    member (cam_expense_inputs_org_write, WITH CHECK org membership only,
--    no server-side readiness verification of any kind). That is the exact
--    "direct authoritative path" this PR's boundary requirement closes.
--    From this migration forward, cam_expense_inputs is server-RPC-only,
--    matching expenses/expense_classifications.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "cam_expense_inputs_org_write" ON public.cam_expense_inputs;
DROP POLICY IF EXISTS "cam_expense_inputs_insert" ON public.cam_expense_inputs;
CREATE POLICY "cam_expense_inputs_insert" ON public.cam_expense_inputs
  FOR INSERT WITH CHECK (false);
DROP POLICY IF EXISTS "cam_expense_inputs_update" ON public.cam_expense_inputs;
CREATE POLICY "cam_expense_inputs_update" ON public.cam_expense_inputs
  FOR UPDATE USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "cam_expense_inputs_delete" ON public.cam_expense_inputs;
CREATE POLICY "cam_expense_inputs_delete" ON public.cam_expense_inputs
  FOR DELETE USING (false);
-- cam_expense_inputs_org_select (SELECT) is untouched — reads remain
-- available to org members, only writes are locked down.

-- ===========================================================================
-- 3. Deterministic backfill: populate the new publication metadata for
--    every existing row so they read as "published, version 1" — they were
--    already being treated as CAM-authoritative by compute-cam before this
--    PR, so this preserves that behavior exactly rather than silently
--    un-publishing real historical data.
-- ===========================================================================
UPDATE public.cam_expense_inputs
   SET publication_status = 'published',
       publication_version = 1,
       published_at = COALESCE(sent_to_cam_at, created_at),
       published_by = sent_to_cam_by
 WHERE published_at IS NULL;

-- ===========================================================================
-- 4. computation_snapshots — stale / restatement-required flags, used when
--    a publication is withdrawn or a classification is reopened after
--    publish: an unlocked CAM snapshot computed from the withdrawn input is
--    marked stale; a LOCKED one is never modified (status/outputs/
--    locked_at are untouched) but gets a restatement_required flag instead.
--    Lifecycle metadata only — no other engine (budget/revenue/expense/
--    reconciliation/lease) is affected by these two new, always-false
--    columns, and no existing computation_snapshots column changes meaning.
-- ===========================================================================
ALTER TABLE public.computation_snapshots
  ADD COLUMN IF NOT EXISTS stale BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stale_reason TEXT,
  ADD COLUMN IF NOT EXISTS restatement_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS restatement_reason TEXT;
