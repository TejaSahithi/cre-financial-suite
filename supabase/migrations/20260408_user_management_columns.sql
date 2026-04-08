-- ============================================================
-- User Management columns
--
-- The UserManagement page and the invite-user edge function
-- read/write columns that were never added to `memberships`
-- and `profiles`. Without these, the org-members query 400s
-- and the membership upsert inside invite-user silently fails,
-- so invited users end up with no role / no access scope.
--
-- All ALTERs are idempotent.
-- ============================================================

-- ── PROFILES ───────────────────────────────────────────────────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone             TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_sign_in_at   TIMESTAMPTZ;

-- ── MEMBERSHIPS ────────────────────────────────────────────────
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS status              TEXT DEFAULT 'active';
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS phone               TEXT;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS custom_role         TEXT;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS module_permissions  JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS page_permissions    JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS capabilities        JSONB DEFAULT '{}'::jsonb;

-- Status values used by the UI: 'active' | 'invited' | 'no_access'
-- (no CHECK constraint on purpose — keeps it forward-compatible)
