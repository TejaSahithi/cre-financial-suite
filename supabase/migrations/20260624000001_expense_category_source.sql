-- ============================================================
-- P1.2 — Expense GL Mapping
--
-- Adds category_source to expenses so the system can record
-- how the category was set: 'gl_mapping' (set by store-data
-- looking up gl_accounts) or null (set by user or import CSV).
--
-- gl_accounts.category + gl_accounts.is_recoverable already
-- exist (migration 202604080146113) — no changes needed there.
-- ============================================================

ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS category_source TEXT;

COMMENT ON COLUMN public.expenses.category_source IS
  'How the category was assigned: gl_mapping = applied from gl_accounts lookup; null = user/import direct';
