-- ============================================================
-- P1.3 — Backend Duplicate Expense Detection
--
-- Adds source_file_id (uploaded_files reference) and
-- import_row_hash (SHA-256 of amount|date|vendor|category|gl_code)
-- to expenses for idempotent file re-upload protection.
--
-- Unique index on (org_id, source_file_id, import_row_hash)
-- enables the hard-block in store-data before any INSERT.
-- ============================================================

ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS source_file_id UUID;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS import_row_hash TEXT;

-- Hard-block index: same file, same row → guaranteed duplicate
CREATE UNIQUE INDEX IF NOT EXISTS expenses_source_file_row_hash_key
  ON public.expenses (org_id, source_file_id, import_row_hash)
  WHERE source_file_id IS NOT NULL AND import_row_hash IS NOT NULL;

-- Support index for invoice_number lookups in duplicate detection
CREATE INDEX IF NOT EXISTS expenses_org_invoice_number_idx
  ON public.expenses (org_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

-- Support index for source_file_id queries
CREATE INDEX IF NOT EXISTS expenses_source_file_id_idx
  ON public.expenses (source_file_id)
  WHERE source_file_id IS NOT NULL;
