CREATE TABLE IF NOT EXISTS public.organization_security_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  policy_version TEXT NOT NULL DEFAULT 'release10-security-policy-v1',
  mfa_required BOOLEAN NOT NULL DEFAULT true,
  support_access_requires_approval BOOLEAN NOT NULL DEFAULT true,
  privileged_actions_require_audit BOOLEAN NOT NULL DEFAULT true,
  reason_code TEXT NOT NULL DEFAULT 'initial_policy',
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.organization_data_residency_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  primary_region TEXT NOT NULL,
  allowed_processing_regions TEXT[] NOT NULL DEFAULT '{}',
  allowed_storage_regions TEXT[] NOT NULL DEFAULT '{}',
  azure_region TEXT NOT NULL,
  openai_processing_policy TEXT NOT NULL DEFAULT 'same_region_or_approved_subprocessor',
  cross_region_backup_allowed BOOLEAN NOT NULL DEFAULT false,
  cross_region_failover_allowed BOOLEAN NOT NULL DEFAULT false,
  policy_version TEXT NOT NULL DEFAULT 'release10-residency-policy-v1',
  reason_code TEXT NOT NULL DEFAULT 'initial_policy',
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.organization_retention_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  artifact_class TEXT NOT NULL,
  retention_days INTEGER NOT NULL,
  minimum_compliance_days INTEGER NOT NULL DEFAULT 0,
  legal_hold BOOLEAN NOT NULL DEFAULT false,
  deletion_mode TEXT NOT NULL DEFAULT 'scheduled',
  policy_version TEXT NOT NULL DEFAULT 'release10-retention-policy-v1',
  reason_code TEXT NOT NULL DEFAULT 'initial_policy',
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, artifact_class)
);
CREATE TABLE IF NOT EXISTS public.organization_feature_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  capability TEXT NOT NULL,
  rollout_mode TEXT NOT NULL DEFAULT 'disabled',
  enabled BOOLEAN NOT NULL DEFAULT false,
  policy_version TEXT NOT NULL DEFAULT 'release10-entitlement-v1',
  reason_code TEXT NOT NULL DEFAULT 'initial_entitlement',
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, capability)
);
CREATE TABLE IF NOT EXISTS public.organization_usage_quotas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  quota_key TEXT NOT NULL,
  soft_limit NUMERIC NOT NULL,
  hard_limit NUMERIC NOT NULL,
  quota_window TEXT NOT NULL DEFAULT 'monthly',
  policy_version TEXT NOT NULL DEFAULT 'release10-quota-policy-v1',
  reason_code TEXT NOT NULL DEFAULT 'initial_quota',
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, quota_key, quota_window)
);
CREATE TABLE IF NOT EXISTS public.organization_usage_counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  quota_key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  current_value NUMERIC NOT NULL DEFAULT 0,
  cost_stage TEXT,
  policy_version TEXT NOT NULL DEFAULT 'release10-usage-counter-v1',
  reason_code TEXT NOT NULL DEFAULT 'usage_metered',
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, quota_key, window_start)
);
CREATE TABLE IF NOT EXISTS public.organization_support_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  tier TEXT NOT NULL DEFAULT 'standard',
  response_slo_minutes INTEGER NOT NULL DEFAULT 240,
  support_contacts JSONB NOT NULL DEFAULT '[]'::jsonb,
  escalation_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_version TEXT NOT NULL DEFAULT 'release10-support-tier-v1',
  reason_code TEXT NOT NULL DEFAULT 'initial_support_tier',
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id)
);
CREATE TABLE IF NOT EXISTS public.organization_rollout_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  capability TEXT NOT NULL,
  rollout_stage TEXT NOT NULL DEFAULT 'internal',
  reversible BOOLEAN NOT NULL DEFAULT true,
  error_budget_required BOOLEAN NOT NULL DEFAULT true,
  policy_version TEXT NOT NULL DEFAULT 'release10-rollout-state-v1',
  reason_code TEXT NOT NULL DEFAULT 'initial_rollout',
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, capability)
);
CREATE TABLE IF NOT EXISTS public.enterprise_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID,
  actor_type TEXT NOT NULL,
  actor_id UUID,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  outcome TEXT NOT NULL,
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  request_id TEXT,
  correlation_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version TEXT NOT NULL DEFAULT 'enterprise-audit-event-v1',
  policy_version TEXT NOT NULL DEFAULT 'release10-audit-policy-v1',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.compliance_evidence_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID,
  control_identifier TEXT NOT NULL,
  execution_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  environment TEXT NOT NULL DEFAULT 'local',
  result TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  responsible_owner TEXT NOT NULL,
  review_due_at TIMESTAMPTZ,
  evidence_uri TEXT,
  policy_version TEXT NOT NULL DEFAULT 'release10-compliance-evidence-v1',
  reason_code TEXT NOT NULL DEFAULT 'evidence_generated',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.backup_verification_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID,
  source_environment TEXT NOT NULL,
  backup_identifier TEXT NOT NULL,
  restoration_target TEXT NOT NULL,
  row_count_comparison JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_comparison JSONB NOT NULL DEFAULT '{}'::jsonb,
  integrity_checks JSONB NOT NULL DEFAULT '{}'::jsonb,
  result TEXT NOT NULL,
  failures TEXT[] NOT NULL DEFAULT '{}',
  policy_version TEXT NOT NULL DEFAULT 'release10-backup-verification-v1',
  reason_code TEXT NOT NULL DEFAULT 'backup_verified',
  created_by UUID,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.disaster_recovery_exercises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID,
  exercise_type TEXT NOT NULL,
  target_tier TEXT NOT NULL,
  rpo_minutes INTEGER NOT NULL,
  rto_minutes INTEGER NOT NULL,
  observed_rpo_minutes INTEGER NOT NULL,
  observed_rto_minutes INTEGER NOT NULL,
  result TEXT NOT NULL,
  failures TEXT[] NOT NULL DEFAULT '{}',
  policy_version TEXT NOT NULL DEFAULT 'release10-dr-exercise-v1',
  reason_code TEXT NOT NULL DEFAULT 'dr_exercise_recorded',
  created_by UUID,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.service_level_measurements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID,
  service TEXT NOT NULL,
  indicator TEXT NOT NULL,
  measurement_window TEXT NOT NULL,
  observed_value NUMERIC NOT NULL,
  objective NUMERIC NOT NULL,
  unit TEXT NOT NULL DEFAULT 'ratio',
  policy_version TEXT NOT NULL DEFAULT 'release10-sli-v1',
  reason_code TEXT NOT NULL DEFAULT 'sli_measured',
  created_by UUID,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.error_budget_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID,
  service TEXT NOT NULL,
  budget_window TEXT NOT NULL,
  objective NUMERIC NOT NULL,
  observed_reliability NUMERIC NOT NULL,
  budget_consumed NUMERIC NOT NULL,
  remaining_budget NUMERIC NOT NULL,
  rollout_allowed BOOLEAN NOT NULL,
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  policy_version TEXT NOT NULL DEFAULT 'release10-error-budget-v1',
  reason_code TEXT NOT NULL DEFAULT 'error_budget_calculated',
  created_by UUID,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.legacy_path_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  path_key TEXT NOT NULL,
  fallback_trigger TEXT,
  request_count BIGINT NOT NULL DEFAULT 1,
  replacement_readiness TEXT NOT NULL DEFAULT 'unknown',
  reason_code TEXT NOT NULL DEFAULT 'legacy_usage_observed',
  policy_version TEXT NOT NULL DEFAULT 'release10-legacy-usage-v1',
  created_by UUID,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, path_key, fallback_trigger)
);
CREATE TABLE IF NOT EXISTS public.legacy_retirement_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  path_key TEXT NOT NULL,
  exception_reason TEXT NOT NULL,
  approved_by UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  policy_version TEXT NOT NULL DEFAULT 'release10-legacy-exception-v1',
  reason_code TEXT NOT NULL DEFAULT 'legacy_exception_approved',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.production_change_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID,
  change_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  impact_assessment TEXT NOT NULL,
  rollback_plan TEXT NOT NULL,
  verification_plan TEXT NOT NULL,
  owner TEXT NOT NULL,
  approver TEXT,
  maintenance_window_start TIMESTAMPTZ,
  maintenance_window_end TIMESTAMPTZ,
  policy_version TEXT NOT NULL DEFAULT 'release10-change-governance-v1',
  reason_code TEXT NOT NULL DEFAULT 'change_record_created',
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.prevent_release10_append_only_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'release10_append_only_record_cannot_be_modified';
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'enterprise_audit_events',
    'compliance_evidence_records',
    'backup_verification_runs',
    'disaster_recovery_exercises',
    'service_level_measurements',
    'error_budget_snapshots',
    'legacy_path_usage'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_append_only_update ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER %I_append_only_update BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.prevent_release10_append_only_mutation()', t, t);
  END LOOP;
END $$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organization_security_policies',
    'organization_data_residency_policies',
    'organization_retention_policies',
    'organization_feature_entitlements',
    'organization_usage_quotas',
    'organization_usage_counters',
    'organization_support_tiers',
    'organization_rollout_states',
    'enterprise_audit_events',
    'compliance_evidence_records',
    'backup_verification_runs',
    'disaster_recovery_exercises',
    'service_level_measurements',
    'error_budget_snapshots',
    'legacy_path_usage',
    'legacy_retirement_exceptions',
    'production_change_records'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT USING (organization_id IS NULL OR organization_id IN (SELECT public.get_my_org_ids()))', t, t);
      EXECUTE format('CREATE POLICY %I_insert ON public.%I FOR INSERT WITH CHECK (organization_id IS NULL OR organization_id IN (SELECT public.get_my_org_ids()))', t, t);
      EXECUTE format('CREATE POLICY %I_update ON public.%I FOR UPDATE USING (organization_id IS NULL OR organization_id IN (SELECT public.get_my_org_ids())) WITH CHECK (organization_id IS NULL OR organization_id IN (SELECT public.get_my_org_ids()))', t, t);
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_enterprise_audit_events_org_time ON public.enterprise_audit_events (organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_budget_snapshots_service_window ON public.error_budget_snapshots (organization_id, service, budget_window, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_path_usage_org_path ON public.legacy_path_usage (organization_id, path_key, last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_org_usage_counters_org_key ON public.organization_usage_counters (organization_id, quota_key, window_start DESC);

COMMENT ON TABLE public.enterprise_audit_events IS 'Release 10 append-only audit stream. RLS policies: enterprise_audit_events_select, enterprise_audit_events_insert, enterprise_audit_events_update.';
COMMENT ON TABLE public.organization_security_policies IS 'Release 10 RLS policy inventory: organization_security_policies_select, organization_security_policies_insert, organization_security_policies_update.';
COMMENT ON TABLE public.organization_data_residency_policies IS 'Release 10 RLS policy inventory: organization_data_residency_policies_select, organization_data_residency_policies_insert, organization_data_residency_policies_update.';
COMMENT ON TABLE public.organization_retention_policies IS 'Release 10 RLS policy inventory: organization_retention_policies_select, organization_retention_policies_insert, organization_retention_policies_update.';
COMMENT ON TABLE public.organization_feature_entitlements IS 'Release 10 RLS policy inventory: organization_feature_entitlements_select, organization_feature_entitlements_insert, organization_feature_entitlements_update.';
COMMENT ON TABLE public.organization_usage_quotas IS 'Release 10 RLS policy inventory: organization_usage_quotas_select, organization_usage_quotas_insert, organization_usage_quotas_update.';
COMMENT ON TABLE public.organization_usage_counters IS 'Release 10 RLS policy inventory: organization_usage_counters_select, organization_usage_counters_insert, organization_usage_counters_update.';
COMMENT ON TABLE public.organization_support_tiers IS 'Release 10 RLS policy inventory: organization_support_tiers_select, organization_support_tiers_insert, organization_support_tiers_update.';
COMMENT ON TABLE public.organization_rollout_states IS 'Release 10 RLS policy inventory: organization_rollout_states_select, organization_rollout_states_insert, organization_rollout_states_update.';
COMMENT ON TABLE public.compliance_evidence_records IS 'Release 10 RLS policy inventory: compliance_evidence_records_select, compliance_evidence_records_insert, compliance_evidence_records_update.';
COMMENT ON TABLE public.backup_verification_runs IS 'Release 10 RLS policy inventory: backup_verification_runs_select, backup_verification_runs_insert, backup_verification_runs_update.';
COMMENT ON TABLE public.disaster_recovery_exercises IS 'Release 10 RLS policy inventory: disaster_recovery_exercises_select, disaster_recovery_exercises_insert, disaster_recovery_exercises_update.';
COMMENT ON TABLE public.service_level_measurements IS 'Release 10 RLS policy inventory: service_level_measurements_select, service_level_measurements_insert, service_level_measurements_update.';
COMMENT ON TABLE public.error_budget_snapshots IS 'Release 10 RLS policy inventory: error_budget_snapshots_select, error_budget_snapshots_insert, error_budget_snapshots_update.';
COMMENT ON TABLE public.legacy_path_usage IS 'Release 10 RLS policy inventory: legacy_path_usage_select, legacy_path_usage_insert, legacy_path_usage_update.';
COMMENT ON TABLE public.legacy_retirement_exceptions IS 'Release 10 RLS policy inventory: legacy_retirement_exceptions_select, legacy_retirement_exceptions_insert, legacy_retirement_exceptions_update.';
COMMENT ON TABLE public.production_change_records IS 'Release 10 RLS policy inventory: production_change_records_select, production_change_records_insert, production_change_records_update.';