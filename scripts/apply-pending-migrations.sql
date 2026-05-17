-- =====================================================================
-- Bundled migration: extraction + abstract + workflow + permissions
-- Generated on 2026-05-17T21:47:54Z
-- 
-- Paste this entire file into the Supabase SQL editor and Run.
-- Every statement is idempotent (CREATE IF NOT EXISTS / OR REPLACE)
-- so re-running is safe.
-- =====================================================================


-- ─── 202604130146112_lease_approval_and_documents.sql ─────────────────────────────────────

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


-- ─── 20260512090000_lease_workflow_foundation.sql ─────────────────────────────────────

-- Migration: 20260512090000_lease_workflow_foundation.sql
-- Description: Adds workflow tables and enrichment columns for lease -> expense -> CAM -> budget orchestration

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tenant_name TEXT,
  ADD COLUMN IF NOT EXISTS vendor_name TEXT,
  ADD COLUMN IF NOT EXISTS expense_subcategory TEXT,
  ADD COLUMN IF NOT EXISTS expense_date DATE,
  ADD COLUMN IF NOT EXISTS billing_period_start DATE,
  ADD COLUMN IF NOT EXISTS billing_period_end DATE,
  ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS recovery_status TEXT DEFAULT 'needs_review',
  ADD COLUMN IF NOT EXISTS recovery_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rule_source TEXT,
  ADD COLUMN IF NOT EXISTS confidence_score NUMERIC,
  ADD COLUMN IF NOT EXISTS evidence_text TEXT,
  ADD COLUMN IF NOT EXISTS evidence_page_number INT,
  ADD COLUMN IF NOT EXISTS approved_status TEXT DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS allocation_method TEXT,
  ADD COLUMN IF NOT EXISTS recovery_meta JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS classification_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS classification_updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_org_scope_workflow
  ON public.expenses(org_id, property_id, building_id, unit_id, lease_id, fiscal_year);

CREATE INDEX IF NOT EXISTS idx_expenses_recovery_status
  ON public.expenses(org_id, recovery_status, approved_status);

CREATE TABLE IF NOT EXISTS public.expense_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE CASCADE,
  building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL,
  lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  rule_set_id UUID REFERENCES public.lease_expense_rule_sets(id) ON DELETE SET NULL,
  recovery_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  recovery_status TEXT NOT NULL DEFAULT 'needs_review',
  allocation_method TEXT,
  cap_applied BOOLEAN DEFAULT false,
  exclusion_applied BOOLEAN DEFAULT false,
  condition_applied BOOLEAN DEFAULT false,
  condition_reason TEXT,
  rule_source TEXT,
  confidence_score NUMERIC,
  evidence_text TEXT,
  evidence_page_number INT,
  approved_status TEXT NOT NULL DEFAULT 'draft',
  notes TEXT,
  classified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  classified_at TIMESTAMPTZ DEFAULT now(),
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, expense_id)
);

CREATE INDEX IF NOT EXISTS idx_expense_classifications_scope
  ON public.expense_classifications(org_id, property_id, building_id, unit_id, lease_id, recovery_status);

ALTER TABLE public.expense_classifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense_classifications_select" ON public.expense_classifications;
DROP POLICY IF EXISTS "expense_classifications_insert" ON public.expense_classifications;
DROP POLICY IF EXISTS "expense_classifications_update" ON public.expense_classifications;
DROP POLICY IF EXISTS "expense_classifications_delete" ON public.expense_classifications;

DROP POLICY IF EXISTS "expense_classifications_select" ON public.expense_classifications;
CREATE POLICY "expense_classifications_select" ON public.expense_classifications
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));

DROP POLICY IF EXISTS "expense_classifications_insert" ON public.expense_classifications;
CREATE POLICY "expense_classifications_insert" ON public.expense_classifications
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP POLICY IF EXISTS "expense_classifications_update" ON public.expense_classifications;
CREATE POLICY "expense_classifications_update" ON public.expense_classifications
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP POLICY IF EXISTS "expense_classifications_delete" ON public.expense_classifications;
CREATE POLICY "expense_classifications_delete" ON public.expense_classifications
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE TABLE IF NOT EXISTS public.budget_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  budget_id UUID NOT NULL REFERENCES public.budgets(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE CASCADE,
  building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL,
  lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  subcategory TEXT,
  line_type TEXT NOT NULL DEFAULT 'expense',
  amount NUMERIC NOT NULL DEFAULT 0,
  source_type TEXT DEFAULT 'system_calculated',
  source_snapshot_id UUID REFERENCES public.computation_snapshots(id) ON DELETE SET NULL,
  notes TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_budget_line_items_budget
  ON public.budget_line_items(org_id, budget_id, line_type, category);

ALTER TABLE public.budget_line_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "budget_line_items_select" ON public.budget_line_items;
DROP POLICY IF EXISTS "budget_line_items_insert" ON public.budget_line_items;
DROP POLICY IF EXISTS "budget_line_items_update" ON public.budget_line_items;
DROP POLICY IF EXISTS "budget_line_items_delete" ON public.budget_line_items;

DROP POLICY IF EXISTS "budget_line_items_select" ON public.budget_line_items;
CREATE POLICY "budget_line_items_select" ON public.budget_line_items
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));

DROP POLICY IF EXISTS "budget_line_items_insert" ON public.budget_line_items;
CREATE POLICY "budget_line_items_insert" ON public.budget_line_items
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP POLICY IF EXISTS "budget_line_items_update" ON public.budget_line_items;
CREATE POLICY "budget_line_items_update" ON public.budget_line_items
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP POLICY IF EXISTS "budget_line_items_delete" ON public.budget_line_items;
CREATE POLICY "budget_line_items_delete" ON public.budget_line_items
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE OR REPLACE FUNCTION public.set_workflow_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_expense_classifications_updated_at ON public.expense_classifications;
CREATE TRIGGER set_expense_classifications_updated_at
  BEFORE UPDATE ON public.expense_classifications
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

DROP TRIGGER IF EXISTS set_budget_line_items_updated_at ON public.budget_line_items;
CREATE TRIGGER set_budget_line_items_updated_at
  BEFORE UPDATE ON public.budget_line_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();


-- ─── 20260513133000_lease_workflow_abstraction.sql ─────────────────────────────────────

-- Migration: 20260513133000_lease_workflow_abstraction.sql
-- Description: Expands lease workflow persistence for structured lease fields,
-- clause storage, and CAM profile generation from uploaded leases.

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS lease_date DATE,
  ADD COLUMN IF NOT EXISTS property_name TEXT,
  ADD COLUMN IF NOT EXISTS property_address TEXT,
  ADD COLUMN IF NOT EXISTS landlord_address TEXT,
  ADD COLUMN IF NOT EXISTS tenant_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS tenant_address TEXT,
  ADD COLUMN IF NOT EXISTS suite_number TEXT,
  ADD COLUMN IF NOT EXISTS rentable_area_sqft NUMERIC,
  ADD COLUMN IF NOT EXISTS permitted_use TEXT,
  ADD COLUMN IF NOT EXISTS broker_name TEXT,
  ADD COLUMN IF NOT EXISTS lease_term TEXT,
  ADD COLUMN IF NOT EXISTS commencement_date DATE,
  ADD COLUMN IF NOT EXISTS expiration_date DATE,
  ADD COLUMN IF NOT EXISTS renewal_notice_days INT,
  ADD COLUMN IF NOT EXISTS renewal_escalation_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS holdover_rent_multiplier NUMERIC,
  ADD COLUMN IF NOT EXISTS base_rent_monthly NUMERIC,
  ADD COLUMN IF NOT EXISTS rent_due_day INT,
  ADD COLUMN IF NOT EXISTS rent_frequency TEXT,
  ADD COLUMN IF NOT EXISTS rent_payment_timing TEXT,
  ADD COLUMN IF NOT EXISTS late_fee_grace_days INT,
  ADD COLUMN IF NOT EXISTS late_fee_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS default_interest_rate_formula TEXT,
  ADD COLUMN IF NOT EXISTS building_rsf NUMERIC,
  ADD COLUMN IF NOT EXISTS tenant_rsf NUMERIC,
  ADD COLUMN IF NOT EXISTS tenant_pro_rata_share NUMERIC,
  ADD COLUMN IF NOT EXISTS floor_plan_reference TEXT,
  ADD COLUMN IF NOT EXISTS parking_rights TEXT,
  ADD COLUMN IF NOT EXISTS common_area_description TEXT;

CREATE TABLE IF NOT EXISTS public.lease_clauses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  clause_type TEXT NOT NULL,
  clause_title TEXT,
  clause_text TEXT,
  source_page INT,
  confidence_score NUMERIC,
  structured_fields_json JSONB DEFAULT '{}'::jsonb,
  source TEXT DEFAULT 'document_review',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_clauses_lease
  ON public.lease_clauses(org_id, lease_id, clause_type);

ALTER TABLE public.lease_clauses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lease_clauses_select" ON public.lease_clauses;
DROP POLICY IF EXISTS "lease_clauses_insert" ON public.lease_clauses;
DROP POLICY IF EXISTS "lease_clauses_update" ON public.lease_clauses;
DROP POLICY IF EXISTS "lease_clauses_delete" ON public.lease_clauses;

DROP POLICY IF EXISTS "lease_clauses_select" ON public.lease_clauses;
CREATE POLICY "lease_clauses_select" ON public.lease_clauses
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));

DROP POLICY IF EXISTS "lease_clauses_insert" ON public.lease_clauses;
CREATE POLICY "lease_clauses_insert" ON public.lease_clauses
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP POLICY IF EXISTS "lease_clauses_update" ON public.lease_clauses;
CREATE POLICY "lease_clauses_update" ON public.lease_clauses
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP POLICY IF EXISTS "lease_clauses_delete" ON public.lease_clauses;
CREATE POLICY "lease_clauses_delete" ON public.lease_clauses
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE TABLE IF NOT EXISTS public.cam_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE CASCADE,
  cam_structure TEXT,
  recovery_status TEXT,
  cam_start_date DATE,
  cam_end_date DATE,
  estimate_frequency TEXT,
  reconciliation_frequency TEXT,
  tenant_rsf NUMERIC,
  building_rsf NUMERIC,
  tenant_pro_rata_share NUMERIC,
  cam_cap_type TEXT,
  cam_cap_percent NUMERIC,
  admin_fee_percent NUMERIC,
  gross_up_percent NUMERIC,
  included_expenses JSONB DEFAULT '[]'::jsonb,
  excluded_expenses JSONB DEFAULT '[]'::jsonb,
  actual_cam_expense NUMERIC,
  estimated_cam_billed NUMERIC,
  reconciliation_amount NUMERIC,
  tenant_balance_due_or_credit NUMERIC,
  status TEXT DEFAULT 'draft',
  source TEXT DEFAULT 'document_review',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (lease_id)
);

CREATE INDEX IF NOT EXISTS idx_cam_profiles_lease
  ON public.cam_profiles(org_id, lease_id, property_id);

ALTER TABLE public.cam_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cam_profiles_select" ON public.cam_profiles;
DROP POLICY IF EXISTS "cam_profiles_insert" ON public.cam_profiles;
DROP POLICY IF EXISTS "cam_profiles_update" ON public.cam_profiles;
DROP POLICY IF EXISTS "cam_profiles_delete" ON public.cam_profiles;

DROP POLICY IF EXISTS "cam_profiles_select" ON public.cam_profiles;
CREATE POLICY "cam_profiles_select" ON public.cam_profiles
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));

DROP POLICY IF EXISTS "cam_profiles_insert" ON public.cam_profiles;
CREATE POLICY "cam_profiles_insert" ON public.cam_profiles
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP POLICY IF EXISTS "cam_profiles_update" ON public.cam_profiles;
CREATE POLICY "cam_profiles_update" ON public.cam_profiles
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP POLICY IF EXISTS "cam_profiles_delete" ON public.cam_profiles;
CREATE POLICY "cam_profiles_delete" ON public.cam_profiles
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP TRIGGER IF EXISTS set_lease_clauses_updated_at ON public.lease_clauses;
CREATE TRIGGER set_lease_clauses_updated_at
  BEFORE UPDATE ON public.lease_clauses
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

DROP TRIGGER IF EXISTS set_cam_profiles_updated_at ON public.cam_profiles;
CREATE TRIGGER set_cam_profiles_updated_at
  BEFORE UPDATE ON public.cam_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();


-- ─── 20260514120000_approved_lease_abstract.sql ─────────────────────────────────────

-- Migration: 20260514120000_approved_lease_abstract.sql
-- Description: Promotes the lease-review JSONB workflow into first-class
--              columns and a dedicated audit table. Additive only — existing
--              extraction_data.field_reviews / extraction_data.abstract values
--              from Phase 2 keep working and are backfilled into the new
--              structures so downstream queries are SQL-indexable.

-- 1. Add approved-lease-abstract columns to leases. The existing `status`
--    column already carries draft/approved/rejected; abstract_status is the
--    workflow-specific lifecycle for the lease abstract itself.
ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS abstract_status       TEXT,
  ADD COLUMN IF NOT EXISTS abstract_version      INT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS abstract_approved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS abstract_approved_by  TEXT,
  ADD COLUMN IF NOT EXISTS abstract_snapshot     JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.leases.abstract_status IS
  'Lease abstract lifecycle: draft | pending_review | approved | rejected | superseded.';
COMMENT ON COLUMN public.leases.abstract_snapshot IS
  'Frozen snapshot of the approved lease abstract (field values + review metadata) so downstream modules read from an immutable record per abstract_version.';

CREATE INDEX IF NOT EXISTS idx_leases_abstract_status
  ON public.leases (abstract_status)
  WHERE abstract_status IS NOT NULL;

-- 2. Backfill abstract_status from existing data so downstream queries can
--    filter for approved abstracts immediately. Leases approved before this
--    migration (status='approved') become abstract_status='approved' at
--    version 1; everything else is a draft.
UPDATE public.leases
   SET abstract_status      = 'approved',
       abstract_version     = COALESCE(NULLIF(abstract_version, 0), 1),
       abstract_approved_at = COALESCE(abstract_approved_at, signed_at, updated_at),
       abstract_approved_by = COALESCE(abstract_approved_by, signed_by)
 WHERE abstract_status IS NULL
   AND status = 'approved';

UPDATE public.leases
   SET abstract_status = 'draft'
 WHERE abstract_status IS NULL;

-- 3. Per-field review audit table. One row per (lease_id, field_key) — the
--    latest decision wins. History is preserved via abstract_snapshot on the
--    lease (each approved version freezes a copy).
CREATE TABLE IF NOT EXISTS public.lease_field_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id        UUID NOT NULL REFERENCES public.leases(id)        ON DELETE CASCADE,
  field_key       TEXT NOT NULL,
  status          TEXT NOT NULL,            -- pending | accepted | edited | rejected | not_applicable | needs_legal_review | manual_required
  normalized_value TEXT,                    -- stored as text to keep the table polymorphic
  raw_value       TEXT,
  source_page     INT,
  source_text     TEXT,
  confidence      NUMERIC,
  note            TEXT,
  reviewer        TEXT,
  reviewed_at     TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (lease_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_lease_field_reviews_lease
  ON public.lease_field_reviews (org_id, lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_field_reviews_status
  ON public.lease_field_reviews (lease_id, status);

ALTER TABLE public.lease_field_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lease_field_reviews_select" ON public.lease_field_reviews;
DROP POLICY IF EXISTS "lease_field_reviews_insert" ON public.lease_field_reviews;
DROP POLICY IF EXISTS "lease_field_reviews_update" ON public.lease_field_reviews;
DROP POLICY IF EXISTS "lease_field_reviews_delete" ON public.lease_field_reviews;

DROP POLICY IF EXISTS "lease_field_reviews_select" ON public.lease_field_reviews;
CREATE POLICY "lease_field_reviews_select" ON public.lease_field_reviews
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));
DROP POLICY IF EXISTS "lease_field_reviews_insert" ON public.lease_field_reviews;
CREATE POLICY "lease_field_reviews_insert" ON public.lease_field_reviews
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
DROP POLICY IF EXISTS "lease_field_reviews_update" ON public.lease_field_reviews;
CREATE POLICY "lease_field_reviews_update" ON public.lease_field_reviews
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
DROP POLICY IF EXISTS "lease_field_reviews_delete" ON public.lease_field_reviews;
CREATE POLICY "lease_field_reviews_delete" ON public.lease_field_reviews
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP TRIGGER IF EXISTS set_lease_field_reviews_updated_at ON public.lease_field_reviews;
CREATE TRIGGER set_lease_field_reviews_updated_at
  BEFORE UPDATE ON public.lease_field_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

-- 4. Backfill the new audit table from existing extraction_data.field_reviews
--    so leases that were reviewed under the Phase 2 JSONB scheme keep their
--    history. Only inserts where no row exists yet for the (lease_id,
--    field_key) pair so re-running this migration is idempotent.
INSERT INTO public.lease_field_reviews
  (org_id, lease_id, field_key, status, normalized_value, raw_value,
   source_page, source_text, confidence, note, reviewer, reviewed_at)
SELECT
  l.org_id,
  l.id,
  fr.key                                          AS field_key,
  COALESCE(fr.value->>'status', 'pending')        AS status,
  fr.value->>'value'                              AS normalized_value,
  fr.value->>'raw_value'                          AS raw_value,
  NULLIF(fr.value->>'source_page','')::int        AS source_page,
  fr.value->>'source_text'                        AS source_text,
  NULLIF(fr.value->>'confidence','')::numeric     AS confidence,
  fr.value->>'note'                               AS note,
  COALESCE(fr.value->>'reviewer', l.signed_by)    AS reviewer,
  COALESCE(NULLIF(fr.value->>'reviewed_at','')::timestamptz, l.updated_at) AS reviewed_at
FROM public.leases l
CROSS JOIN LATERAL jsonb_each(COALESCE(l.extraction_data -> 'field_reviews', '{}'::jsonb)) AS fr(key, value)
ON CONFLICT (lease_id, field_key) DO NOTHING;

-- 5. Backfill abstract_snapshot from existing extraction_data.abstract for any
--    lease that already carries the JSONB shape from Phase 2.
UPDATE public.leases
   SET abstract_snapshot = jsonb_build_object(
         'version',        COALESCE((extraction_data->'abstract'->>'version')::int, 1),
         'approved_at',    extraction_data->'abstract'->>'approved_at',
         'approved_by',    extraction_data->'abstract'->>'approved_by',
         'fields',         extraction_data->'fields',
         'field_reviews',  extraction_data->'field_reviews'
       )
 WHERE abstract_snapshot = '{}'::jsonb
   AND extraction_data ? 'abstract';


-- ─── 20260514130000_lease_critical_dates.sql ─────────────────────────────────────

-- Migration: 20260514130000_lease_critical_dates.sql
-- Description: Adds a per-lease critical-dates audit table so reviewers can
--              track lease milestones (commencement, expiration, renewal
--              notice, option deadlines, insurance certificate due dates,
--              termination notice deadlines, etc.), assign owners, and mark
--              them complete. Additive only.

CREATE TABLE IF NOT EXISTS public.lease_critical_dates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id             UUID NOT NULL REFERENCES public.leases(id)        ON DELETE CASCADE,
  property_id          UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  date_type            TEXT NOT NULL,        -- lease_date | commencement | rent_commencement | expiration | renewal_notice | option_exercise | insurance_certificate | termination_notice | custom
  due_date             DATE NOT NULL,
  owner_email          TEXT,
  owner_name           TEXT,
  status               TEXT NOT NULL DEFAULT 'open',  -- open | completed | dismissed
  completed_at         TIMESTAMPTZ,
  completed_by         TEXT,
  reminder_days_before INT,
  note                 TEXT,
  source               TEXT NOT NULL DEFAULT 'manual',  -- manual | derived | imported
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now(),
  UNIQUE (lease_id, date_type, due_date)
);

COMMENT ON TABLE public.lease_critical_dates IS
  'Tracked critical dates per lease (renewal notice, option exercise, expiration, etc.) with owners and completion status.';

CREATE INDEX IF NOT EXISTS idx_lease_critical_dates_lease
  ON public.lease_critical_dates (org_id, lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_critical_dates_due
  ON public.lease_critical_dates (org_id, due_date, status);
CREATE INDEX IF NOT EXISTS idx_lease_critical_dates_owner
  ON public.lease_critical_dates (owner_email)
  WHERE owner_email IS NOT NULL;

ALTER TABLE public.lease_critical_dates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lease_critical_dates_select" ON public.lease_critical_dates;
DROP POLICY IF EXISTS "lease_critical_dates_insert" ON public.lease_critical_dates;
DROP POLICY IF EXISTS "lease_critical_dates_update" ON public.lease_critical_dates;
DROP POLICY IF EXISTS "lease_critical_dates_delete" ON public.lease_critical_dates;

DROP POLICY IF EXISTS "lease_critical_dates_select" ON public.lease_critical_dates;
CREATE POLICY "lease_critical_dates_select" ON public.lease_critical_dates
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));
DROP POLICY IF EXISTS "lease_critical_dates_insert" ON public.lease_critical_dates;
CREATE POLICY "lease_critical_dates_insert" ON public.lease_critical_dates
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
DROP POLICY IF EXISTS "lease_critical_dates_update" ON public.lease_critical_dates;
CREATE POLICY "lease_critical_dates_update" ON public.lease_critical_dates
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
DROP POLICY IF EXISTS "lease_critical_dates_delete" ON public.lease_critical_dates;
CREATE POLICY "lease_critical_dates_delete" ON public.lease_critical_dates
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP TRIGGER IF EXISTS set_lease_critical_dates_updated_at ON public.lease_critical_dates;
CREATE TRIGGER set_lease_critical_dates_updated_at
  BEFORE UPDATE ON public.lease_critical_dates
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

-- Backfill: seed derived rows for existing leases so the dashboard is not
-- empty for orgs that approved leases before this migration. Each insert is
-- conditional on the source column being present and the unique constraint
-- prevents duplicates.
INSERT INTO public.lease_critical_dates
  (org_id, lease_id, property_id, date_type, due_date, source, status)
SELECT l.org_id, l.id, l.property_id, 'commencement', l.start_date, 'derived', 'open'
FROM public.leases l
WHERE l.start_date IS NOT NULL
ON CONFLICT (lease_id, date_type, due_date) DO NOTHING;

INSERT INTO public.lease_critical_dates
  (org_id, lease_id, property_id, date_type, due_date, source, status)
SELECT l.org_id, l.id, l.property_id, 'expiration', l.end_date, 'derived',
       CASE WHEN l.end_date < CURRENT_DATE THEN 'completed' ELSE 'open' END
FROM public.leases l
WHERE l.end_date IS NOT NULL
ON CONFLICT (lease_id, date_type, due_date) DO NOTHING;

-- Renewal notice deadline = expiration - renewal_notice_days. Existing
-- column on leases is renewal_notice_days (added in
-- 20260513133000_lease_workflow_abstraction.sql). Only insert when both
-- pieces are present.
INSERT INTO public.lease_critical_dates
  (org_id, lease_id, property_id, date_type, due_date, source, status, reminder_days_before)
SELECT
  l.org_id,
  l.id,
  l.property_id,
  'renewal_notice',
  (l.end_date - (COALESCE(l.renewal_notice_days, 0) || ' days')::interval)::date,
  'derived',
  'open',
  30
FROM public.leases l
WHERE l.end_date IS NOT NULL
  AND l.renewal_notice_days IS NOT NULL
  AND l.renewal_notice_days > 0
ON CONFLICT (lease_id, date_type, due_date) DO NOTHING;


-- ─── 20260514140000_cam_profile_approval.sql ─────────────────────────────────────

-- Migration: 20260514140000_cam_profile_approval.sql
-- Description: Adds approval lifecycle and validation-warning fields to
--              cam_profiles so the new CAM Setup page can gate downstream
--              CAM Calculation on an approved profile. Additive only.

ALTER TABLE public.cam_profiles
  ADD COLUMN IF NOT EXISTS approved_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by         TEXT,
  ADD COLUMN IF NOT EXISTS validation_warnings JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS notes               TEXT;

COMMENT ON COLUMN public.cam_profiles.validation_warnings IS
  'List of reasons the CAM profile is not ready (e.g. missing building RSF, missing tenant share, no approved rule set).';

CREATE INDEX IF NOT EXISTS idx_cam_profiles_status
  ON public.cam_profiles (status);


-- ─── 20260516153000_rent_schedule_authority_and_permission_fix.sql ─────────────────────────────────────

-- Authoritative approved rent schedules for lease projection plus a
-- compatibility repair for page-write permission checks used by compute-lease.

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS rent_commencement_date DATE;

CREATE OR REPLACE FUNCTION public.can_write_any_page(check_org_id UUID, page_names TEXT[])
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM unnest(COALESCE(page_names, ARRAY[]::TEXT[])) AS page_name
    WHERE public.can_write_page(check_org_id, page_name)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE TABLE IF NOT EXISTS public.rent_schedules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id          UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  property_id       UUID REFERENCES public.properties(id) ON DELETE CASCADE,
  building_id       UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  unit_id           UUID REFERENCES public.units(id) ON DELETE SET NULL,
  abstract_version  INT NOT NULL DEFAULT 1,
  row_type          TEXT NOT NULL DEFAULT 'base_rent',      -- base_rent | ground_rent | percentage_rent | abatement | renewal_base_rent | holdover_rent | manual
  phase             TEXT NOT NULL DEFAULT 'contracted',     -- contracted | approved_renewal | assumed_renewal | holdover
  charge_frequency  TEXT NOT NULL DEFAULT 'monthly',        -- monthly | annual | one_time
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  monthly_amount    NUMERIC,
  annual_amount     NUMERIC,
  rent_per_sf       NUMERIC,
  rsf               NUMERIC,
  proration_method  TEXT DEFAULT 'actual_days',
  is_abatement      BOOLEAN NOT NULL DEFAULT FALSE,
  abatement_percent NUMERIC,
  escalation_type   TEXT,
  escalation_rate   NUMERIC,
  escalation_amount NUMERIC,
  escalation_index  TEXT,
  status            TEXT NOT NULL DEFAULT 'approved',       -- draft | approved | superseded | archived
  approved_at       TIMESTAMPTZ,
  approved_by       TEXT,
  source            TEXT NOT NULL DEFAULT 'approved_abstract',
  assumption_reason TEXT,
  notes             TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_schedules_period_check CHECK (period_end >= period_start)
);

COMMENT ON TABLE public.rent_schedules IS
  'Approved rent schedule rows used as the authoritative source for rent projection. Rows may be contracted, approved renewal, or modeled assumptions.';

CREATE INDEX IF NOT EXISTS idx_rent_schedules_lease
  ON public.rent_schedules (org_id, lease_id, abstract_version, status);
CREATE INDEX IF NOT EXISTS idx_rent_schedules_scope
  ON public.rent_schedules (org_id, property_id, building_id, unit_id, status);
CREATE INDEX IF NOT EXISTS idx_rent_schedules_period
  ON public.rent_schedules (lease_id, period_start, period_end);

ALTER TABLE public.rent_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rent_schedules_select" ON public.rent_schedules;
DROP POLICY IF EXISTS "rent_schedules_insert" ON public.rent_schedules;
DROP POLICY IF EXISTS "rent_schedules_update" ON public.rent_schedules;
DROP POLICY IF EXISTS "rent_schedules_delete" ON public.rent_schedules;

DROP POLICY IF EXISTS "rent_schedules_select" ON public.rent_schedules;
CREATE POLICY "rent_schedules_select" ON public.rent_schedules
  FOR SELECT USING (
    public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids())
  );

DROP POLICY IF EXISTS "rent_schedules_insert" ON public.rent_schedules;
CREATE POLICY "rent_schedules_insert" ON public.rent_schedules
  FOR INSERT WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseReview', 'RentProjection'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP POLICY IF EXISTS "rent_schedules_update" ON public.rent_schedules;
CREATE POLICY "rent_schedules_update" ON public.rent_schedules
  FOR UPDATE USING (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseReview', 'RentProjection'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  )
  WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseReview', 'RentProjection'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP POLICY IF EXISTS "rent_schedules_delete" ON public.rent_schedules;
CREATE POLICY "rent_schedules_delete" ON public.rent_schedules
  FOR DELETE USING (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseReview', 'RentProjection'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP TRIGGER IF EXISTS set_rent_schedules_updated_at ON public.rent_schedules;
CREATE TRIGGER set_rent_schedules_updated_at
  BEFORE UPDATE ON public.rent_schedules
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();


-- ─── 20260516170000_align_new_page_permissions.sql ─────────────────────────────────────

-- Keep backend page/module permission helpers aligned with the frontend nav
-- and module configuration for newly surfaced pages.

CREATE OR REPLACE FUNCTION public.page_module_key(page_name TEXT)
RETURNS TEXT AS $$
  SELECT CASE
    WHEN page_name = ANY (ARRAY['Dashboard']) THEN 'dashboard'
    WHEN page_name = ANY (ARRAY['Portfolios']) THEN 'portfolio'
    WHEN page_name = ANY (ARRAY['Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail']) THEN 'properties'
    WHEN page_name = ANY (ARRAY['Tenants', 'TenantDetail']) THEN 'tenants'
    WHEN page_name = ANY (ARRAY['Vendors']) THEN 'vendors'
    WHEN page_name = ANY (ARRAY['Leases', 'LeaseUpload', 'LeaseReview', 'RentProjection', 'CriticalDates']) THEN 'leases'
    WHEN page_name = ANY (ARRAY['Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules']) THEN 'expenses'
    WHEN page_name = ANY (ARRAY['CAMDashboard', 'CAMSetup', 'CAMCalculation']) THEN 'cam'
    WHEN page_name = ANY (ARRAY['Billing']) THEN 'billing'
    WHEN page_name = ANY (ARRAY['Revenue']) THEN 'revenue'
    WHEN page_name = ANY (ARRAY['BudgetDashboard', 'CreateBudget', 'BudgetReview']) THEN 'budgets'
    WHEN page_name = ANY (ARRAY['ActualsVariance', 'Actuals', 'Variance']) THEN 'actuals_variance'
    WHEN page_name = ANY (ARRAY['Comparison']) THEN 'comparison'
    WHEN page_name = ANY (ARRAY['Reconciliation']) THEN 'reconciliation'
    WHEN page_name = ANY (ARRAY['AnalyticsReports', 'Reports', 'Analytics', 'PortfolioInsights']) THEN 'analytics_reports'
    WHEN page_name = ANY (ARRAY['Workflows']) THEN 'workflows'
    WHEN page_name = ANY (ARRAY['Notifications']) THEN 'notifications'
    WHEN page_name = ANY (ARRAY['Documents']) THEN 'documents'
    WHEN page_name = ANY (ARRAY['Integrations']) THEN 'integrations'
    WHEN page_name = ANY (ARRAY['SuperAdmin', 'Stakeholders', 'OrgSettings', 'ChartOfAccounts', 'AuditLog', 'UserManagement', 'FieldMappingRules', 'ApprovalWorkflows']) THEN 'admin'
    ELSE NULL
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.role_default_page_access(role_name TEXT, page_name TEXT)
RETURNS TEXT AS $$
  WITH normalized AS (
    SELECT lower(COALESCE(role_name, '')) AS role_key
  )
  SELECT CASE
    WHEN role_key IN ('admin', 'super_admin', 'org_admin') THEN 'admin'
    WHEN role_key IN ('manager', 'asset_manager', 'portfolio_manager', 'operations_director', 'facility_manager', 'construction_manager', 'acquisitions_mgr', 'leasing_director')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'Portfolios', 'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Vendors', 'Leases', 'LeaseUpload', 'LeaseReview', 'RentProjection', 'CriticalDates',
        'Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'CAMDashboard', 'CAMSetup', 'CAMCalculation', 'Billing',
        'BudgetDashboard', 'CreateBudget', 'BudgetReview', 'Documents', 'Notifications'
      ]) THEN 'write'
    WHEN role_key = 'property_manager'
      AND page_name = ANY (ARRAY[
        'Dashboard', 'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Vendors', 'Leases', 'LeaseUpload', 'LeaseReview', 'RentProjection', 'CriticalDates',
        'Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'CAMDashboard', 'CAMSetup', 'CAMCalculation', 'Billing',
        'Documents', 'Notifications'
      ]) THEN 'write'
    WHEN role_key IN ('editor', 'financial_analyst', 'leasing_agent', 'lease_admin', 'finance', 'cfo_controller', 'accounts_manager')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights', 'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Leases', 'LeaseUpload', 'LeaseReview', 'CriticalDates',
        'Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'BudgetDashboard', 'CreateBudget', 'BudgetReview',
        'Billing', 'Revenue', 'ActualsVariance', 'Actuals', 'Variance', 'Comparison',
        'Reconciliation', 'CAMDashboard', 'CAMSetup', 'CAMCalculation', 'ChartOfAccounts',
        'Vendors', 'Notifications', 'Documents'
      ]) THEN 'write'
    WHEN role_key IN ('viewer', 'read_only', 'investor_relations')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights', 'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Leases', 'LeaseReview', 'CriticalDates',
        'Expenses', 'Billing', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'BudgetDashboard', 'Revenue', 'ActualsVariance', 'Actuals', 'Variance',
        'Comparison', 'AnalyticsReports', 'Reports', 'Analytics', 'CAMDashboard', 'CAMSetup',
        'Notifications', 'Documents'
      ]) THEN 'read'
    WHEN role_key IN ('auditor', 'compliance_officer', 'internal_auditor')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights', 'AuditLog', 'Expenses', 'Billing',
        'ChartOfAccounts', 'BudgetDashboard', 'BudgetReview', 'Revenue',
        'ActualsVariance', 'Actuals', 'Variance', 'Comparison', 'Reconciliation',
        'AnalyticsReports', 'Reports', 'Analytics', 'CAMDashboard', 'CAMSetup', 'Documents',
        'Notifications', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules'
      ]) THEN 'read'
    ELSE 'none'
  END
  FROM normalized;
$$ LANGUAGE sql IMMUTABLE;

