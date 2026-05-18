-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Lease approval signature fields + documents table
-- Patched for safe re-run when documents table already exists with a
-- different/partial schema (a pre-existing documents table on the remote
-- triggered "column 'lease_id' does not exist" on the index CREATE).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add approval/signature columns to leases
ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS signed_by TEXT,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_comments TEXT,
  ADD COLUMN IF NOT EXISTS approval_document_url TEXT;

-- 2. Create documents table (no-op if it exists)
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id UUID REFERENCES properties(id) ON DELETE SET NULL,
  lease_id UUID REFERENCES leases(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'lease',
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  signed_by TEXT,
  signed_at TIMESTAMPTZ,
  comments TEXT,
  document_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2b. If the table existed already with a partial schema (e.g. created by
-- an earlier deploy without lease_id), ensure every column the bundle
-- relies on is present. ADD COLUMN IF NOT EXISTS is a no-op when the
-- column already exists, so this is safe in every case.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS org_id UUID,
  ADD COLUMN IF NOT EXISTS property_id UUID,
  ADD COLUMN IF NOT EXISTS lease_id UUID,
  ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'lease',
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS signed_by TEXT,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS comments TEXT,
  ADD COLUMN IF NOT EXISTS document_url TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 2c. Add FK constraints only if missing. Skip silently if pre-existing rows
-- would violate the constraint (e.g. orphan property_id) — those rows can
-- be cleaned up separately. Bundle should not abort over data quirks.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'documents'
      AND constraint_name = 'documents_lease_id_fkey'
  ) THEN
    BEGIN
      ALTER TABLE documents
        ADD CONSTRAINT documents_lease_id_fkey
        FOREIGN KEY (lease_id) REFERENCES leases(id) ON DELETE SET NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipping documents.lease_id FK: %', SQLERRM;
    END;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'documents'
      AND constraint_name = 'documents_property_id_fkey'
  ) THEN
    BEGIN
      ALTER TABLE documents
        ADD CONSTRAINT documents_property_id_fkey
        FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipping documents.property_id FK: %', SQLERRM;
    END;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'documents'
      AND constraint_name = 'documents_org_id_fkey'
  ) THEN
    BEGIN
      ALTER TABLE documents
        ADD CONSTRAINT documents_org_id_fkey
        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipping documents.org_id FK: %', SQLERRM;
    END;
  END IF;
END $$;

-- Indexes (now safe because lease_id is guaranteed)
CREATE INDEX IF NOT EXISTS idx_documents_org_id ON documents(org_id);
CREATE INDEX IF NOT EXISTS idx_documents_property_id ON documents(property_id);
CREATE INDEX IF NOT EXISTS idx_documents_lease_id ON documents(lease_id);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);

-- RLS
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- Super-admin sees all
DROP POLICY IF EXISTS "super_admin_all_documents" ON documents;
CREATE POLICY "super_admin_all_documents" ON documents
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM auth.users u
      JOIN user_roles ur ON ur.user_id = u.id
      WHERE u.id = auth.uid() AND ur.role = 'super_admin'
    )
  );

-- Org members see their org's documents
DROP POLICY IF EXISTS "org_members_documents" ON documents;
CREATE POLICY "org_members_documents" ON documents
  FOR ALL USING (
    org_id IN (
      SELECT org_id FROM memberships WHERE user_id = auth.uid()
    )
  );

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_documents_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents_updated_at ON documents;
CREATE TRIGGER trg_documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION update_documents_updated_at();
