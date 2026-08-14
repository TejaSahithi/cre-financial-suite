-- Priority 5: policy-driven financial-control resolution.
-- Domain-specific because approval_policies/approval_thresholds model approver
-- chains, not financial-control disposition actions.

CREATE TABLE IF NOT EXISTS public.financial_control_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id UUID REFERENCES public.properties(id) ON DELETE CASCADE,
  workflow TEXT NOT NULL DEFAULT 'budget_approval',
  finding_type TEXT,
  severity TEXT CHECK (severity IS NULL OR severity IN ('low','medium','high','critical')),
  threshold_min NUMERIC,
  threshold_max NUMERIC,
  action TEXT NOT NULL CHECK (action IN ('WARN','REQUIRE_ACKNOWLEDGEMENT','REQUIRE_APPROVAL','BLOCK')),
  missing_policy_behavior TEXT NOT NULL DEFAULT 'fail_open' CHECK (missing_policy_behavior IN ('fail_open','fail_closed')),
  priority INT NOT NULL DEFAULT 0,
  reason TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (threshold_min IS NULL OR threshold_min >= 0),
  CHECK (threshold_max IS NULL OR threshold_max >= 0),
  CHECK (threshold_min IS NULL OR threshold_max IS NULL OR threshold_min <= threshold_max)
);

CREATE INDEX IF NOT EXISTS idx_financial_control_policies_resolution
  ON public.financial_control_policies (org_id, property_id, workflow, finding_type, severity, is_active, priority DESC);

ALTER TABLE public.financial_control_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financial_control_policies_select ON public.financial_control_policies;
DROP POLICY IF EXISTS financial_control_policies_insert ON public.financial_control_policies;
DROP POLICY IF EXISTS financial_control_policies_update ON public.financial_control_policies;
DROP POLICY IF EXISTS financial_control_policies_delete ON public.financial_control_policies;
CREATE POLICY financial_control_policies_select ON public.financial_control_policies
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY financial_control_policies_insert ON public.financial_control_policies
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY financial_control_policies_update ON public.financial_control_policies
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY financial_control_policies_delete ON public.financial_control_policies
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP TRIGGER IF EXISTS set_financial_control_policies_updated_at ON public.financial_control_policies;
CREATE TRIGGER set_financial_control_policies_updated_at
  BEFORE UPDATE ON public.financial_control_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_workflow_updated_at();

ALTER TABLE public.financial_control_findings
  ADD COLUMN IF NOT EXISTS workflow TEXT NOT NULL DEFAULT 'budget_approval',
  ADD COLUMN IF NOT EXISTS policy_action TEXT CHECK (policy_action IS NULL OR policy_action IN ('WARN','REQUIRE_ACKNOWLEDGEMENT','REQUIRE_APPROVAL','BLOCK')),
  ADD COLUMN IF NOT EXISTS policy_blocks BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS policy_decision_snapshot JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS policy_resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS policy_override JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS overridden_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS overridden_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS override_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_financial_control_findings_policy
  ON public.financial_control_findings (org_id, property_id, workflow, policy_blocks, status);

DROP TRIGGER IF EXISTS audit_financial_control_policies ON public.financial_control_policies;
CREATE TRIGGER audit_financial_control_policies
  AFTER INSERT OR UPDATE OR DELETE ON public.financial_control_policies
  FOR EACH ROW EXECUTE FUNCTION public.audit_operational_domain_row_change();

COMMENT ON TABLE public.financial_control_policies IS
  'Priority 5 domain-specific policy config for persisted financial-control finding decisions. Does not replace generic approval_policies.';
COMMENT ON COLUMN public.financial_control_findings.policy_decision_snapshot IS
  'Frozen policy decision evidence used for historical reproducibility even if policy configuration changes later.';
