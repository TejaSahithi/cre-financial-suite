-- ============================================================
-- Bulk Import Enrichment Columns
--
-- Adds the optional columns the BulkImportModal collects from
-- CSV / PDF / AI extraction so the inserts no longer fail with
-- `column "X" does not exist`. All ALTERs are idempotent.
--
-- After this runs, the per-entity allow-list in `src/services/api.js`
-- (ALLOWED_COLUMNS) matches the actual schema 1:1.
-- ============================================================

-- ── PROPERTIES ────────────────────────────────────────────────
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS purchase_price NUMERIC;
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS market_value   NUMERIC;
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS noi            NUMERIC;
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS cap_rate       NUMERIC;
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS manager        TEXT;
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS owner          TEXT;
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS contact        TEXT;
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS notes          TEXT;

-- ── LEASES ───────────────────vscode-webview://1in2rttj32b8c0clk6135179vkqig6olv89n8p23oease2s1pgn5/cre-financial-suite-main/supabase/migrations/20260408_bulk_import_columns.sql─────────────────────────────────
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS annual_rent       NUMERIC;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS rent_per_sf       NUMERIC;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS lease_term_months INT;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS security_deposit  NUMERIC;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS cam_amount        NUMERIC;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS nnn_amount        NUMERIC;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS escalation_rate   NUMERIC;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS renewal_options   TEXT;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS ti_allowance      NUMERIC;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS free_rent_months  INT;
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS notes             TEXT;

-- ── TENANTS ───────────────────────────────────────────────────
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS contact_name  TEXT;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS industry      TEXT;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS credit_rating TEXT;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS notes         TEXT;

-- ── EXPENSES ──────────────────────────────────────────────────
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS description    TEXT;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS invoice_number TEXT;

-- ── REVENUES ──────────────────────────────────────────────────
ALTER TABLE public.revenues ADD COLUMN IF NOT EXISTS date        DATE;
ALTER TABLE public.revenues ADD COLUMN IF NOT EXISTS tenant_name TEXT;

-- ── GL ACCOUNTS ───────────────────────────────────────────────
ALTER TABLE public.gl_accounts ADD COLUMN IF NOT EXISTS normal_balance TEXT;
ALTER TABLE public.gl_accounts ADD COLUMN IF NOT EXISTS is_recoverable BOOLEAN DEFAULT FALSE;
ALTER TABLE public.gl_accounts ADD COLUMN IF NOT EXISTS notes          TEXT;

-- ── PROPERTIES — `floors` shouldn't have been stripped ────────
-- The legacy translator deletes `floors` for properties, but the
-- column doesn't exist anyway. Add it so floor-count import works.
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS floors INT;
