-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Lease approval signature fields + documents table
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add approval/signature columns to leases
ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS signed_by TEXT,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_comments TEXT,
  ADD COLUMN IF NOT EXISTS approval_document_url TEXT;

-- 2. Create documents table
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id UUID REFERENCES properties(id) ON DELETE SET NULL,
  lease_id UUID REFERENCES leases(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'lease',        -- lease | expense | budget | other
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',      -- draft | approved | archived
  signed_by TEXT,
  signed_at TIMESTAMPTZ,
  comments TEXT,
  document_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_documents_org_id ON documents(org_id);
CREATE INDEX IF NOT EXISTS idx_documents_property_id ON documents(property_id);
CREATE INDEX IF NOT EXISTS idx_documents_lease_id ON documents(lease_id);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);

-- RLS
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- Super-admin sees all
CREATE POLICY "super_admin_all_documents" ON documents
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM auth.users u
      JOIN user_roles ur ON ur.user_id = u.id
      WHERE u.id = auth.uid() AND ur.role = 'super_admin'
    )
  );

-- Org members see their org's documents
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
