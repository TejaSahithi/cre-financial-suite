-- Pass 1: reviewable CPI rent adjustment proposals.
-- This table is not rent authority. Approved rent remains in rent_schedules;
-- these rows preserve the server-owned CPI calculation and evidence needed
-- before an explicit rent schedule versioning command is allowed to post it.

CREATE TABLE IF NOT EXISTS public.cpi_rent_adjustment_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  source_rent_schedule_id UUID NOT NULL REFERENCES public.rent_schedules(id) ON DELETE RESTRICT,
  source_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  index_base_period TEXT,
  index_current_period TEXT,
  base_monthly_amount NUMERIC,
  proposed_monthly_amount NUMERIC,
  proposed_annual_amount NUMERIC,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('draft','pending_review','approved','blocked','resolved','rejected','superseded')),
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  inputs JSONB NOT NULL DEFAULT '{}',
  evidence JSONB NOT NULL DEFAULT '[]',
  calculation_lines JSONB NOT NULL DEFAULT '[]',
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  calculated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cpi_rent_adjustment_proposals_period_check CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_cpi_rent_adjustment_proposals_lease
  ON public.cpi_rent_adjustment_proposals (org_id, lease_id, status, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_cpi_rent_adjustment_proposals_schedule
  ON public.cpi_rent_adjustment_proposals (org_id, source_rent_schedule_id, status);

ALTER TABLE public.cpi_rent_adjustment_proposals
  ADD CONSTRAINT uq_cpi_rent_adjustment_proposals_input
  UNIQUE (org_id, lease_id, source_rent_schedule_id, source_rule_id, index_base_period, index_current_period);

ALTER TABLE public.cpi_rent_adjustment_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cpi_rent_adjustment_proposals_select ON public.cpi_rent_adjustment_proposals;
DROP POLICY IF EXISTS cpi_rent_adjustment_proposals_insert ON public.cpi_rent_adjustment_proposals;
DROP POLICY IF EXISTS cpi_rent_adjustment_proposals_update ON public.cpi_rent_adjustment_proposals;
DROP POLICY IF EXISTS cpi_rent_adjustment_proposals_delete ON public.cpi_rent_adjustment_proposals;
CREATE POLICY cpi_rent_adjustment_proposals_select ON public.cpi_rent_adjustment_proposals
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));
CREATE POLICY cpi_rent_adjustment_proposals_insert ON public.cpi_rent_adjustment_proposals
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY cpi_rent_adjustment_proposals_update ON public.cpi_rent_adjustment_proposals
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id))
  WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY cpi_rent_adjustment_proposals_delete ON public.cpi_rent_adjustment_proposals
  FOR DELETE USING (false);

DROP TRIGGER IF EXISTS set_cpi_rent_adjustment_proposals_updated_at ON public.cpi_rent_adjustment_proposals;
CREATE TRIGGER set_cpi_rent_adjustment_proposals_updated_at
  BEFORE UPDATE ON public.cpi_rent_adjustment_proposals
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();

DROP TRIGGER IF EXISTS audit_cpi_rent_adjustment_proposals_changes ON public.cpi_rent_adjustment_proposals;
CREATE TRIGGER audit_cpi_rent_adjustment_proposals_changes
  AFTER INSERT OR UPDATE ON public.cpi_rent_adjustment_proposals
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

