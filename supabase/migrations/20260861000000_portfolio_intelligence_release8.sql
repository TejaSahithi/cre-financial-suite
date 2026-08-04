-- Release 8: Portfolio Intelligence, multi-lease analytics, and operational insights.

CREATE TABLE IF NOT EXISTS public.portfolio_lease_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  portfolio_id UUID NULL REFERENCES public.portfolios(id) ON DELETE SET NULL,
  property_id UUID NULL REFERENCES public.properties(id) ON DELETE SET NULL,
  lease_id UUID NULL REFERENCES public.leases(id) ON DELETE SET NULL,
  document_family_id UUID NOT NULL,
  source_run_id UUID NULL REFERENCES public.document_intelligence_runs(id) ON DELETE SET NULL,
  source_generation_id TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  review_payload_version TEXT NOT NULL,
  tenant_name TEXT NULL,
  landlord_name TEXT NULL,
  property_name TEXT NULL,
  premises_identifier TEXT NULL,
  lease_status TEXT NOT NULL,
  commencement_date DATE NULL,
  rent_commencement_date DATE NULL,
  expiration_date DATE NULL,
  term_months INTEGER NULL,
  leased_area NUMERIC NULL,
  area_unit TEXT NULL,
  base_rent_current NUMERIC NULL,
  base_rent_currency TEXT NULL,
  base_rent_frequency TEXT NULL,
  security_deposit NUMERIC NULL,
  renewal_options_count INTEGER NULL,
  termination_rights_count INTEGER NULL,
  approval_status TEXT NOT NULL,
  coverage_status TEXT NOT NULL,
  semantic_status TEXT NOT NULL,
  publication_status TEXT NOT NULL DEFAULT 'draft' CHECK (publication_status IN ('draft', 'canonical_ready', 'review_required', 'approved', 'published', 'stale', 'blocked')),
  fact_payload JSONB NOT NULL,
  field_statuses JSONB NOT NULL,
  field_sources JSONB NOT NULL,
  schema_version TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS portfolio_lease_facts_active_generation_unique
  ON public.portfolio_lease_facts (organization_id, document_family_id, source_generation_id, schema_version, algorithm_version)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS portfolio_lease_facts_scope_idx
  ON public.portfolio_lease_facts (organization_id, portfolio_id, property_id, lease_status, publication_status, superseded_at);
CREATE INDEX IF NOT EXISTS portfolio_lease_facts_dates_idx
  ON public.portfolio_lease_facts (organization_id, expiration_date, rent_commencement_date, commencement_date)
  WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS public.portfolio_obligations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_family_id UUID NOT NULL,
  portfolio_lease_fact_id UUID NOT NULL REFERENCES public.portfolio_lease_facts(id) ON DELETE CASCADE,
  portfolio_id UUID NULL REFERENCES public.portfolios(id) ON DELETE SET NULL,
  property_id UUID NULL REFERENCES public.properties(id) ON DELETE SET NULL,
  obligation_type TEXT NOT NULL,
  responsible_party TEXT NULL,
  counterparty TEXT NULL,
  frequency TEXT NULL,
  due_rule JSONB NULL,
  start_date DATE NULL,
  end_date DATE NULL,
  next_due_date DATE NULL,
  amount NUMERIC NULL,
  currency TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('resolved', 'partially_resolved', 'missing_anchor', 'ambiguous', 'not_applicable')),
  materiality TEXT NOT NULL CHECK (materiality IN ('approval_critical', 'financial', 'operational', 'informational')),
  source_field_keys TEXT[] NOT NULL DEFAULT '{}',
  source_projection_ids UUID[] NOT NULL DEFAULT '{}',
  source_evidence_ids UUID[] NOT NULL DEFAULT '{}',
  confidence NUMERIC NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  schema_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portfolio_obligations_scope_idx
  ON public.portfolio_obligations (organization_id, portfolio_lease_fact_id, obligation_type, status, next_due_date);

CREATE TABLE IF NOT EXISTS public.portfolio_financial_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_family_id UUID NOT NULL,
  portfolio_lease_fact_id UUID NOT NULL REFERENCES public.portfolio_lease_facts(id) ON DELETE CASCADE,
  portfolio_id UUID NULL REFERENCES public.portfolios(id) ON DELETE SET NULL,
  property_id UUID NULL REFERENCES public.properties(id) ON DELETE SET NULL,
  term_type TEXT NOT NULL,
  original_amount NUMERIC NULL,
  normalized_amount NUMERIC NULL,
  currency TEXT NULL,
  frequency TEXT NULL,
  area_basis NUMERIC NULL,
  area_unit TEXT NULL,
  start_date DATE NULL,
  end_date DATE NULL,
  escalation_rule JSONB NULL,
  status TEXT NOT NULL,
  source_field_keys TEXT[] NOT NULL DEFAULT '{}',
  source_projection_ids UUID[] NOT NULL DEFAULT '{}',
  source_evidence_ids UUID[] NOT NULL DEFAULT '{}',
  normalization_warnings TEXT[] NOT NULL DEFAULT '{}',
  schema_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portfolio_financial_terms_scope_idx
  ON public.portfolio_financial_terms (organization_id, portfolio_lease_fact_id, term_type, status, start_date);

CREATE TABLE IF NOT EXISTS public.portfolio_critical_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_family_id UUID NOT NULL,
  portfolio_lease_fact_id UUID NOT NULL REFERENCES public.portfolio_lease_facts(id) ON DELETE CASCADE,
  lease_id UUID NULL REFERENCES public.leases(id) ON DELETE SET NULL,
  property_id UUID NULL REFERENCES public.properties(id) ON DELETE SET NULL,
  portfolio_id UUID NULL REFERENCES public.portfolios(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  label TEXT NOT NULL,
  event_date DATE NULL,
  window_start DATE NULL,
  window_end DATE NULL,
  calculation_status TEXT NOT NULL CHECK (calculation_status IN ('resolved', 'partially_resolved', 'missing_anchor', 'ambiguous', 'not_applicable')),
  date_source TEXT NOT NULL,
  materiality TEXT NOT NULL CHECK (materiality IN ('approval_critical', 'financial', 'operational', 'informational')),
  is_estimated BOOLEAN NOT NULL DEFAULT false,
  is_blocking BOOLEAN NOT NULL DEFAULT false,
  source_field_keys TEXT[] NOT NULL DEFAULT '{}',
  source_projection_ids UUID[] NOT NULL DEFAULT '{}',
  source_evidence_ids UUID[] NOT NULL DEFAULT '{}',
  schema_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS portfolio_critical_dates_scope_idx
  ON public.portfolio_critical_dates (organization_id, portfolio_id, property_id, event_type, calculation_status, event_date)
  WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS public.portfolio_risk_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  portfolio_id UUID NULL REFERENCES public.portfolios(id) ON DELETE SET NULL,
  property_id UUID NULL REFERENCES public.properties(id) ON DELETE SET NULL,
  document_family_id UUID NULL,
  portfolio_lease_fact_id UUID NULL REFERENCES public.portfolio_lease_facts(id) ON DELETE CASCADE,
  rule_key TEXT NOT NULL,
  risk_domain TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  score_contribution NUMERIC NOT NULL DEFAULT 0,
  affected_lease_ids UUID[] NOT NULL DEFAULT '{}',
  affected_field_keys TEXT[] NOT NULL DEFAULT '{}',
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  explanation TEXT NOT NULL,
  evidence_ids UUID[] NOT NULL DEFAULT '{}',
  resolution_guidance TEXT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  schema_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS portfolio_risk_findings_scope_idx
  ON public.portfolio_risk_findings (organization_id, portfolio_id, property_id, risk_domain, severity, status);

CREATE TABLE IF NOT EXISTS public.portfolio_analytics_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  portfolio_id UUID NULL REFERENCES public.portfolios(id) ON DELETE SET NULL,
  snapshot_date DATE NOT NULL,
  lease_count INTEGER NOT NULL DEFAULT 0,
  active_lease_count INTEGER NOT NULL DEFAULT 0,
  total_leased_area NUMERIC NULL,
  annualized_base_rent NUMERIC NULL,
  expirations_by_year JSONB NOT NULL DEFAULT '{}'::jsonb,
  rent_by_property JSONB NOT NULL DEFAULT '{}'::jsonb,
  risk_by_domain JSONB NOT NULL DEFAULT '{}'::jsonb,
  coverage_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  review_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  obligation_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_generation_digest TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_analytics_snapshots_active_unique
  ON public.portfolio_analytics_snapshots (organization_id, COALESCE(portfolio_id, '00000000-0000-0000-0000-000000000000'::uuid), snapshot_date, source_generation_digest, schema_version)
  WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS public.portfolio_metric_lineage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  portfolio_id UUID NULL REFERENCES public.portfolios(id) ON DELETE SET NULL,
  snapshot_id UUID NULL REFERENCES public.portfolio_analytics_snapshots(id) ON DELETE CASCADE,
  metric_key TEXT NOT NULL,
  contributing_fact_ids UUID[] NOT NULL DEFAULT '{}',
  excluded_fact_ids UUID[] NOT NULL DEFAULT '{}',
  source_field_keys TEXT[] NOT NULL DEFAULT '{}',
  source_projection_ids UUID[] NOT NULL DEFAULT '{}',
  aggregation_method TEXT NOT NULL,
  normalization_rules TEXT[] NOT NULL DEFAULT '{}',
  warnings TEXT[] NOT NULL DEFAULT '{}',
  schema_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portfolio_metric_lineage_scope_idx
  ON public.portfolio_metric_lineage (organization_id, portfolio_id, metric_key);

CREATE TABLE IF NOT EXISTS public.portfolio_export_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  portfolio_id UUID NULL REFERENCES public.portfolios(id) ON DELETE SET NULL,
  export_type TEXT NOT NULL,
  export_format TEXT NOT NULL CHECK (export_format IN ('csv', 'xlsx', 'json')),
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  coverage_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_generation_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  requested_by UUID NULL,
  include_evidence_text BOOLEAN NOT NULL DEFAULT false,
  result_path TEXT NULL,
  error_message TEXT NULL,
  schema_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS portfolio_export_runs_scope_idx
  ON public.portfolio_export_runs (organization_id, portfolio_id, export_type, status, created_at);

CREATE TABLE IF NOT EXISTS public.portfolio_intelligence_rollout_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  portfolio_id UUID NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  rollout_state TEXT NOT NULL DEFAULT 'disabled' CHECK (rollout_state IN ('disabled', 'internal', 'shadow', 'pilot', 'production')),
  enable_portfolio_intelligence_v8 BOOLEAN NOT NULL DEFAULT false,
  enable_portfolio_fact_materialization BOOLEAN NOT NULL DEFAULT false,
  enable_portfolio_critical_dates BOOLEAN NOT NULL DEFAULT false,
  enable_portfolio_semantic_search BOOLEAN NOT NULL DEFAULT false,
  enable_portfolio_risk_scoring BOOLEAN NOT NULL DEFAULT false,
  enable_rent_roll_reconciliation BOOLEAN NOT NULL DEFAULT false,
  enable_portfolio_exports BOOLEAN NOT NULL DEFAULT false,
  enable_portfolio_integration_api BOOLEAN NOT NULL DEFAULT false,
  reason TEXT NULL,
  updated_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_intelligence_rollout_config_scope_unique
  ON public.portfolio_intelligence_rollout_config (org_id, COALESCE(portfolio_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS public.portfolio_finding_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  portfolio_risk_finding_id UUID NOT NULL REFERENCES public.portfolio_risk_findings(id) ON DELETE CASCADE,
  portfolio_id UUID NULL REFERENCES public.portfolios(id) ON DELETE SET NULL,
  property_id UUID NULL REFERENCES public.properties(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('acknowledge_risk', 'assign_owner', 'set_due_date', 'mark_resolved', 'dismiss_with_reason', 'request_lease_review', 'request_source_document', 'confirm_rent_roll_variance')),
  action_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT NULL,
  actor_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portfolio_finding_actions_scope_idx
  ON public.portfolio_finding_actions (organization_id, portfolio_risk_finding_id, action, created_at);

ALTER TABLE public.portfolio_lease_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_financial_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_critical_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_risk_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_analytics_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_metric_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_export_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_intelligence_rollout_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_finding_actions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'portfolio_lease_facts',
    'portfolio_obligations',
    'portfolio_financial_terms',
    'portfolio_critical_dates',
    'portfolio_risk_findings',
    'portfolio_analytics_snapshots',
    'portfolio_metric_lineage',
    'portfolio_export_runs',
    'portfolio_finding_actions'
  ] LOOP
    EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT USING (organization_id IN (SELECT unnest(public.get_my_org_ids())) AND (portfolio_id IS NULL OR public.can_access_portfolio(portfolio_id)))', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_insert ON public.%I FOR INSERT WITH CHECK (organization_id IN (SELECT unnest(public.get_my_org_ids())) AND (portfolio_id IS NULL OR public.can_access_portfolio(portfolio_id)))', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_update ON public.%I FOR UPDATE USING (organization_id IN (SELECT unnest(public.get_my_org_ids())) AND (portfolio_id IS NULL OR public.can_access_portfolio(portfolio_id)))', table_name, table_name);
  END LOOP;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'portfolio_intelligence_rollout_config' AND policyname = 'portfolio_intelligence_rollout_config_select') THEN
    CREATE POLICY portfolio_intelligence_rollout_config_select ON public.portfolio_intelligence_rollout_config
      FOR SELECT USING (org_id IN (SELECT unnest(public.get_my_org_ids())) AND (portfolio_id IS NULL OR public.can_access_portfolio(portfolio_id)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'portfolio_intelligence_rollout_config' AND policyname = 'portfolio_intelligence_rollout_config_insert') THEN
    CREATE POLICY portfolio_intelligence_rollout_config_insert ON public.portfolio_intelligence_rollout_config
      FOR INSERT WITH CHECK (public.is_org_admin(org_id) AND (portfolio_id IS NULL OR public.can_access_portfolio(portfolio_id)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'portfolio_intelligence_rollout_config' AND policyname = 'portfolio_intelligence_rollout_config_update') THEN
    CREATE POLICY portfolio_intelligence_rollout_config_update ON public.portfolio_intelligence_rollout_config
      FOR UPDATE USING (public.is_org_admin(org_id) AND (portfolio_id IS NULL OR public.can_access_portfolio(portfolio_id)));
  END IF;
END $$;

-- Explicit policy inventory for static Release 8 readiness checks:
-- portfolio_lease_facts_select, portfolio_obligations_select, portfolio_financial_terms_select,
-- portfolio_critical_dates_select, portfolio_risk_findings_select, portfolio_analytics_snapshots_select,
-- portfolio_metric_lineage_select, portfolio_export_runs_select, portfolio_finding_actions_select.
