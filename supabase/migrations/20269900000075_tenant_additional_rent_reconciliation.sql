-- Final Pass 3: tenant additional-rent reconciliation projection.
-- This is a durable workflow result over existing authoritative CAM and lease-charge records.
-- It is not a generalized financial source of truth and does not change CAM V2.

CREATE TABLE IF NOT EXISTS public.tenant_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE RESTRICT,
  fiscal_year INT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  version INT NOT NULL DEFAULT 1,
  supersedes_reconciliation_id UUID REFERENCES public.tenant_reconciliations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'calculated' CHECK (status IN ('draft','calculated','blocked','pending_review','approved','rejected','posted','superseded')),
  actual_responsibility NUMERIC(18,2) NOT NULL DEFAULT 0,
  billed_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  adjustments_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  credits_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  final_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  balance_disposition TEXT NOT NULL DEFAULT 'review_required' CHECK (balance_disposition IN ('tenant_due','tenant_credit','settled','review_required')),
  currency TEXT NOT NULL DEFAULT 'USD',
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  source_hash TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  calculation_lines JSONB NOT NULL DEFAULT '[]',
  input_snapshot JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  calculated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  submitted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  rejected_at TIMESTAMPTZ,
  rejected_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  posted_at TIMESTAMPTZ,
  posted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id, period_start, period_end, version)
);

CREATE INDEX IF NOT EXISTS idx_tenant_reconciliations_org_lease
  ON public.tenant_reconciliations (org_id, lease_id, period_start DESC, status);
CREATE INDEX IF NOT EXISTS idx_tenant_reconciliations_property_status
  ON public.tenant_reconciliations (org_id, property_id, fiscal_year, status);
CREATE INDEX IF NOT EXISTS idx_tenant_reconciliations_source_hash
  ON public.tenant_reconciliations (org_id, lease_id, period_start, period_end, source_hash);

CREATE TABLE IF NOT EXISTS public.tenant_reconciliation_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  tenant_reconciliation_id UUID NOT NULL REFERENCES public.tenant_reconciliations(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE SET NULL,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE RESTRICT,
  line_role TEXT NOT NULL CHECK (line_role IN ('actual','billed','adjustment','credit')),
  charge_type TEXT NOT NULL,
  authoritative_table TEXT NOT NULL,
  source_record_id UUID NOT NULL,
  source_period TEXT NOT NULL,
  charge_key TEXT NOT NULL,
  period_start DATE,
  period_end DATE,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  source_status TEXT,
  explanation TEXT,
  evidence JSONB NOT NULL DEFAULT '{}',
  source_snapshot JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, tenant_reconciliation_id, line_role, charge_key),
  UNIQUE (org_id, tenant_reconciliation_id, line_role, authoritative_table, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_reconciliation_lines_header
  ON public.tenant_reconciliation_lines (org_id, tenant_reconciliation_id);
CREATE INDEX IF NOT EXISTS idx_tenant_reconciliation_lines_source
  ON public.tenant_reconciliation_lines (org_id, authoritative_table, source_record_id, charge_type);

ALTER TABLE public.tenant_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_reconciliation_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_reconciliations_select ON public.tenant_reconciliations;
DROP POLICY IF EXISTS tenant_reconciliations_insert ON public.tenant_reconciliations;
DROP POLICY IF EXISTS tenant_reconciliations_update ON public.tenant_reconciliations;
DROP POLICY IF EXISTS tenant_reconciliations_delete ON public.tenant_reconciliations;
CREATE POLICY tenant_reconciliations_select ON public.tenant_reconciliations
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY tenant_reconciliations_insert ON public.tenant_reconciliations
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY tenant_reconciliations_update ON public.tenant_reconciliations
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id))
  WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY tenant_reconciliations_delete ON public.tenant_reconciliations
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP POLICY IF EXISTS tenant_reconciliation_lines_select ON public.tenant_reconciliation_lines;
DROP POLICY IF EXISTS tenant_reconciliation_lines_insert ON public.tenant_reconciliation_lines;
DROP POLICY IF EXISTS tenant_reconciliation_lines_update ON public.tenant_reconciliation_lines;
DROP POLICY IF EXISTS tenant_reconciliation_lines_delete ON public.tenant_reconciliation_lines;
CREATE POLICY tenant_reconciliation_lines_select ON public.tenant_reconciliation_lines
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY tenant_reconciliation_lines_insert ON public.tenant_reconciliation_lines
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY tenant_reconciliation_lines_update ON public.tenant_reconciliation_lines
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id))
  WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY tenant_reconciliation_lines_delete ON public.tenant_reconciliation_lines
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP TRIGGER IF EXISTS set_tenant_reconciliations_updated_at ON public.tenant_reconciliations;
CREATE TRIGGER set_tenant_reconciliations_updated_at
  BEFORE UPDATE ON public.tenant_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();

CREATE OR REPLACE FUNCTION public.prevent_posted_tenant_reconciliation_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'posted' THEN
    RAISE EXCEPTION 'Posted tenant reconciliation % is immutable', OLD.id;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    RAISE EXCEPTION 'Posted tenant reconciliation % is immutable; create a superseding version or approved adjustment', OLD.id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS tenant_reconciliations_posted_immutable ON public.tenant_reconciliations;
CREATE TRIGGER tenant_reconciliations_posted_immutable
  BEFORE UPDATE OR DELETE ON public.tenant_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_tenant_reconciliation_mutation();

CREATE OR REPLACE FUNCTION public.prevent_posted_tenant_reconciliation_line_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT;
  v_reconciliation_id UUID := COALESCE(NEW.tenant_reconciliation_id, OLD.tenant_reconciliation_id);
BEGIN
  SELECT status INTO v_status FROM public.tenant_reconciliations WHERE id = v_reconciliation_id;
  IF v_status = 'posted' THEN
    RAISE EXCEPTION 'Cannot modify tenant reconciliation lines after posting';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS tenant_reconciliation_lines_posted_immutable ON public.tenant_reconciliation_lines;
CREATE TRIGGER tenant_reconciliation_lines_posted_immutable
  BEFORE UPDATE OR DELETE ON public.tenant_reconciliation_lines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_tenant_reconciliation_line_mutation();

DROP TRIGGER IF EXISTS audit_tenant_reconciliations ON public.tenant_reconciliations;
CREATE TRIGGER audit_tenant_reconciliations
  AFTER INSERT OR UPDATE OR DELETE ON public.tenant_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

DROP TRIGGER IF EXISTS audit_tenant_reconciliation_lines ON public.tenant_reconciliation_lines;
CREATE TRIGGER audit_tenant_reconciliation_lines
  AFTER INSERT OR UPDATE OR DELETE ON public.tenant_reconciliation_lines
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

COMMENT ON TABLE public.tenant_reconciliations IS
  'Durable tenant additional-rent reconciliation workflow result over CAM V2 and lease_charge_read_model authoritative sources. Not a financial source of truth.';
COMMENT ON TABLE public.tenant_reconciliation_lines IS
  'Frozen source-identity lines used by tenant_reconciliations; each line points back to one authoritative source record.';
