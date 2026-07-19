-- P4.4 - immutable financial charge candidates.
--
-- Stores explicit additional-charge, deposit/prepaid, allowance/contribution,
-- reimbursement, percentage-rent formula, and amortization instruction evidence
-- only. It does not calculate amortization, percentage rent, CAM, recoverability,
-- allocations, caps/floors/stops, gross-up, reconciliation, period expansion,
-- due dates, date/rent schedules, or critical dates; it does not write runtime
-- extraction outputs or wire providers. LEASE_FINANCIAL_SCHEDULE_MODE remains
-- the only financial schedule feature flag and defaults off in runtime code.

CREATE TABLE public.lease_financial_charge_registry_snapshots (
  registry_version TEXT PRIMARY KEY,
  registry_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (registry_version = 'lease-financial-charges-v1'),
  CHECK (registry_hash = '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c')
);

CREATE TABLE public.lease_financial_charge_registry_entries (
  registry_version TEXT NOT NULL REFERENCES public.lease_financial_charge_registry_snapshots(registry_version) ON DELETE RESTRICT,
  registry_hash TEXT NOT NULL,
  charge_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  charge_domain TEXT NOT NULL,
  financial_role TEXT NOT NULL,
  permitted_amount_roles TEXT[] NOT NULL,
  permitted_frequencies TEXT[] NOT NULL,
  period_allowed BOOLEAN NOT NULL,
  formula_allowed BOOLEAN NOT NULL,
  amortization_allowed BOOLEAN NOT NULL,
  tenant_payable BOOLEAN NOT NULL,
  landlord_payable BOOLEAN NOT NULL,
  represents_estimate BOOLEAN NOT NULL,
  belongs_to_base_rent_schedules BOOLEAN NOT NULL DEFAULT false,
  p5_processing_required BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (registry_version, charge_type),
  CHECK (registry_hash = '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c'),
  CHECK (belongs_to_base_rent_schedules = false)
);

ALTER TABLE public.lease_financial_charge_registry_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_financial_charge_registry_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_charge_registry_snapshots_read ON public.lease_financial_charge_registry_snapshots FOR SELECT USING (true);
CREATE POLICY lease_financial_charge_registry_entries_read ON public.lease_financial_charge_registry_entries FOR SELECT USING (true);
REVOKE ALL ON public.lease_financial_charge_registry_snapshots FROM authenticated, anon;
REVOKE ALL ON public.lease_financial_charge_registry_entries FROM authenticated, anon;

INSERT INTO public.lease_financial_charge_registry_snapshots (registry_version, registry_hash) VALUES
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c')
ON CONFLICT (registry_version) DO NOTHING;
INSERT INTO public.lease_financial_charge_registry_snapshots (registry_version, registry_hash) VALUES ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c') ON CONFLICT (registry_version) DO NOTHING;
INSERT INTO public.lease_financial_charge_registry_entries (registry_version, registry_hash, charge_type, display_name, charge_domain, financial_role, permitted_amount_roles, permitted_frequencies, period_allowed, formula_allowed, amortization_allowed, tenant_payable, landlord_payable, represents_estimate, belongs_to_base_rent_schedules, p5_processing_required) VALUES
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'additional_rent', 'Additional Rent', 'additional_charge', 'tenant_payable', ARRAY['stated_amount', 'billed_amount', 'estimated_amount', 'unresolved_amount']::TEXT[], ARRAY['monthly', 'annually', 'quarterly', 'irregular', 'unknown']::TEXT[], true, true, false, true, false, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'administrative_fee', 'Administrative Fee', 'additional_charge', 'tenant_payable', ARRAY['stated_amount', 'estimated_amount', 'percentage_rate', 'unresolved_amount']::TEXT[], ARRAY['monthly', 'annually', 'one_time', 'unknown']::TEXT[], true, true, false, true, false, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'amortized_improvement_charge', 'Amortized Improvement Charge', 'amortization_instruction', 'tenant_payable', ARRAY['principal_amount', 'payment_amount', 'stated_rate', 'unresolved_amount']::TEXT[], ARRAY['monthly', 'amortization_period', 'unknown']::TEXT[], true, false, true, true, false, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'cam_estimate', 'CAM Estimate', 'additional_charge', 'tenant_payable', ARRAY['estimated_amount', 'stated_rate', 'unresolved_amount']::TEXT[], ARRAY['monthly', 'annually', 'quarterly', 'unknown']::TEXT[], true, false, false, true, false, true, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'credit', 'Credit', 'credit_or_offset', 'credit_to_tenant', ARRAY['credit_amount', 'unresolved_amount']::TEXT[], ARRAY['one_time', 'per_occurrence', 'unknown']::TEXT[], true, false, false, false, true, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'deposit_component', 'Deposit Component', 'deposit_or_prepayment', 'escrow_or_deposit', ARRAY['deposit_amount', 'prepaid_amount', 'unresolved_amount']::TEXT[], ARRAY['one_time', 'unknown']::TEXT[], false, false, false, true, false, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'equipment_charge', 'Equipment Charge', 'additional_charge', 'tenant_payable', ARRAY['stated_amount', 'billed_amount', 'principal_amount', 'payment_amount', 'unresolved_amount']::TEXT[], ARRAY['monthly', 'one_time', 'amortization_period', 'unknown']::TEXT[], true, false, true, true, false, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'holdover_charge', 'Holdover Charge', 'additional_charge', 'tenant_payable', ARRAY['stated_amount', 'percentage_rate', 'formula_input', 'unresolved_amount']::TEXT[], ARRAY['monthly', 'daily', 'unknown']::TEXT[], true, true, false, true, false, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'insurance_estimate', 'Insurance Estimate', 'additional_charge', 'tenant_payable', ARRAY['estimated_amount', 'stated_rate', 'unresolved_amount']::TEXT[], ARRAY['monthly', 'annually', 'quarterly', 'unknown']::TEXT[], true, false, false, true, false, true, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'landlord_contribution', 'Landlord Contribution', 'allowance_or_contribution', 'landlord_payable', ARRAY['contribution_amount', 'allowance_amount', 'unresolved_amount']::TEXT[], ARRAY['one_time', 'unknown']::TEXT[], true, false, false, false, true, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'late_fee', 'Late Fee', 'additional_charge', 'tenant_payable', ARRAY['stated_amount', 'percentage_rate', 'formula_input', 'unresolved_amount']::TEXT[], ARRAY['per_occurrence', 'unknown']::TEXT[], false, true, false, true, false, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'management_fee', 'Management Fee', 'additional_charge', 'tenant_payable', ARRAY['stated_amount', 'estimated_amount', 'percentage_rate', 'unresolved_amount']::TEXT[], ARRAY['monthly', 'annually', 'unknown']::TEXT[], true, true, false, true, false, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'one_time_charge', 'One-Time Charge', 'additional_charge', 'tenant_payable', ARRAY['stated_amount', 'billed_amount', 'unresolved_amount']::TEXT[], ARRAY['one_time', 'per_occurrence', 'unknown']::TEXT[], true, false, false, true, false, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'operating_expense_estimate', 'Operating Expense Estimate', 'additional_charge', 'tenant_payable', ARRAY['estimated_amount', 'stated_rate', 'unresolved_amount']::TEXT[], ARRAY['monthly', 'annually', 'quarterly', 'unknown']::TEXT[], true, false, false, true, false, true, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'percentage_rent', 'Percentage Rent', 'percentage_rent', 'tenant_payable', ARRAY['percentage_rate', 'threshold_amount', 'formula_input', 'formula_output_placeholder', 'unresolved_amount']::TEXT[], ARRAY['percentage_rent_period', 'annually', 'monthly', 'unknown']::TEXT[], true, true, false, true, false, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'prepaid_rent', 'Prepaid Rent', 'deposit_or_prepayment', 'escrow_or_deposit', ARRAY['prepaid_amount', 'deposit_amount', 'unresolved_amount']::TEXT[], ARRAY['one_time', 'unknown']::TEXT[], false, false, false, true, false, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'recurring_charge', 'Recurring Charge', 'additional_charge', 'tenant_payable', ARRAY['stated_amount', 'billed_amount', 'estimated_amount', 'unresolved_amount']::TEXT[], ARRAY['monthly', 'annually', 'quarterly', 'weekly', 'daily', 'irregular', 'unknown']::TEXT[], true, true, false, true, false, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'reimbursement', 'Reimbursement', 'reimbursement', 'landlord_payable', ARRAY['reimbursement_amount', 'unresolved_amount']::TEXT[], ARRAY['one_time', 'per_occurrence', 'unknown']::TEXT[], true, true, false, false, true, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'security_deposit', 'Security Deposit', 'deposit_or_prepayment', 'escrow_or_deposit', ARRAY['deposit_amount', 'unresolved_amount']::TEXT[], ARRAY['one_time', 'unknown']::TEXT[], false, false, false, true, false, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'tax_estimate', 'Tax Estimate', 'additional_charge', 'tenant_payable', ARRAY['estimated_amount', 'stated_rate', 'unresolved_amount']::TEXT[], ARRAY['monthly', 'annually', 'quarterly', 'unknown']::TEXT[], true, false, false, true, false, true, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'tenant_improvement_allowance', 'Tenant Improvement Allowance', 'allowance_or_contribution', 'landlord_payable', ARRAY['allowance_amount', 'unresolved_amount']::TEXT[], ARRAY['one_time', 'unknown']::TEXT[], true, false, false, false, true, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'unresolved_charge', 'Unresolved Charge', 'unresolved', 'unresolved', ARRAY['unresolved_amount']::TEXT[], ARRAY['unknown']::TEXT[], true, true, true, false, false, false, false, true),
  ('lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'utility_charge', 'Utility Charge', 'additional_charge', 'tenant_payable', ARRAY['stated_amount', 'billed_amount', 'estimated_amount', 'unresolved_amount']::TEXT[], ARRAY['monthly', 'annually', 'per_occurrence', 'unknown']::TEXT[], true, true, false, true, false, false, false, true)
ON CONFLICT (registry_version, charge_type) DO NOTHING;

CREATE TABLE public.lease_financial_charge_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID,
  package_id UUID,
  uploaded_file_id UUID NOT NULL,
  extraction_run_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  source_package_document_id UUID,
  source_package_effective_claim_id UUID,
  base_rent_schedule_candidate_id UUID,
  charge_key TEXT NOT NULL,
  instance_key TEXT NOT NULL DEFAULT 'default',
  registry_version TEXT NOT NULL DEFAULT 'lease-financial-charges-v1',
  registry_hash TEXT NOT NULL DEFAULT '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c',
  charge_type TEXT NOT NULL CHECK (charge_type IN ('additional_rent','percentage_rent','recurring_charge','one_time_charge','cam_estimate','operating_expense_estimate','tax_estimate','insurance_estimate','utility_charge','management_fee','administrative_fee','security_deposit','prepaid_rent','deposit_component','tenant_improvement_allowance','landlord_contribution','reimbursement','amortized_improvement_charge','equipment_charge','late_fee','holdover_charge','credit','unresolved_charge')),
  charge_domain TEXT NOT NULL CHECK (charge_domain IN ('additional_charge','deposit_or_prepayment','allowance_or_contribution','reimbursement','formula_instruction','amortization_instruction','percentage_rent','credit_or_offset','unresolved')),
  financial_role TEXT NOT NULL CHECK (financial_role IN ('tenant_payable','landlord_payable','credit_to_tenant','escrow_or_deposit','formula_only','unresolved')),
  charge_status TEXT NOT NULL CHECK (charge_status IN ('extracted','unresolved','ambiguous','needs_review','manual_required','requires_related_document','not_present','not_applicable','unreadable','extraction_failed')),
  origin_type TEXT NOT NULL CHECK (origin_type IN ('extracted','reviewer','derived','legacy_adapter','system_projection')),
  currency_code TEXT,
  frequency TEXT CHECK (frequency IN ('monthly','annually','quarterly','weekly','daily','one_time','per_occurrence','percentage_rent_period','amortization_period','irregular','unknown')),
  estimate_status TEXT CHECK (estimate_status IN ('stated_estimate','stated_final','true_up_pending','unresolved','not_applicable')),
  start_expression_id UUID,
  end_expression_id UUID,
  source_claim_ids UUID[] NOT NULL DEFAULT '{}',
  charge_contract_version TEXT NOT NULL DEFAULT 'lease-financial-charge-candidates-v1',
  confidence NUMERIC,
  producer_type TEXT NOT NULL CHECK (producer_type IN ('deterministic_mapper','semantic_extractor','validation_engine','legacy_adapter','reviewer','system_projection')),
  producer_name TEXT NOT NULL,
  producer_version TEXT,
  extraction_stage_run_id UUID,
  provider_invocation_id UUID,
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending','valid','invalid','needs_review')),
  validation_errors TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, charge_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_document_id, org_id) REFERENCES public.lease_package_documents (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id) REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (base_rent_schedule_candidate_id, org_id) REFERENCES public.lease_base_rent_schedule_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (start_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (end_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id) REFERENCES public.extraction_runs (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,
  CHECK (char_length(charge_key) BETWEEN 1 AND 600),
  CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  CHECK (registry_version = 'lease-financial-charges-v1'),
  CHECK (registry_hash = '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c'),
  CHECK (charge_contract_version = 'lease-financial-charge-candidates-v1'),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (producer_type <> 'semantic_extractor' OR provider_invocation_id IS NOT NULL),
  CHECK (origin_type <> 'reviewer' OR (provider_invocation_id IS NULL AND extraction_stage_run_id IS NULL)),
  CHECK (charge_type <> 'security_deposit' OR financial_role = 'escrow_or_deposit'),
  CHECK (charge_type <> 'tenant_improvement_allowance' OR financial_role = 'landlord_payable'),
  CHECK (charge_type NOT IN ('cam_estimate','operating_expense_estimate','tax_estimate','insurance_estimate') OR estimate_status = 'stated_estimate'),
  CHECK (base_rent_schedule_candidate_id IS NULL),
  CHECK (NOT (metadata ? 'calculated_amount')),
  CHECK (NOT (metadata ? 'calculated_payment')),
  CHECK (NOT (metadata ? 'computed_cam')),
  CHECK (NOT (metadata ? 'recoverability_result')),
  CHECK (NOT (metadata ? 'allocated_expenses')),
  CHECK (NOT (metadata ? 'generated_periods')),
  CHECK (NOT (metadata ? 'expanded_periods')),
  CHECK (NOT (metadata ? 'due_dates')),
  CHECK (NOT (metadata ? 'critical_dates')),
  CHECK (NOT (metadata ? 'resolved_date')),
  CHECK (NOT (metadata ? 'calculated_percentage_rent')),
  CHECK (NOT (metadata ? 'computed_interest'))
);

CREATE INDEX idx_financial_charge_candidates_org_file ON public.lease_financial_charge_candidates (org_id, uploaded_file_id);
CREATE INDEX idx_financial_charge_candidates_package ON public.lease_financial_charge_candidates (org_id, package_id) WHERE package_id IS NOT NULL;
CREATE INDEX idx_financial_charge_candidates_type ON public.lease_financial_charge_candidates (org_id, charge_type);
ALTER TABLE public.lease_financial_charge_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_charge_candidates_org_select ON public.lease_financial_charge_candidates FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_charge_candidates FROM authenticated, anon;

CREATE TABLE public.lease_financial_charge_period_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  charge_candidate_id UUID NOT NULL,
  lease_id UUID,
  package_id UUID,
  generation_id UUID NOT NULL,
  period_key TEXT NOT NULL,
  sequence_number INT,
  period_status TEXT NOT NULL CHECK (period_status IN ('extracted','unresolved','ambiguous','needs_review','manual_required','requires_related_document','not_present','not_applicable','unreadable','extraction_failed')),
  start_expression_id UUID,
  end_expression_id UUID,
  start_term_month INT,
  end_term_month INT,
  term_candidate_id UUID,
  source_claim_id UUID,
  source_package_effective_claim_id UUID,
  period_contract_version TEXT NOT NULL DEFAULT 'lease-financial-charge-periods-v1',
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending','valid','invalid','needs_review')),
  validation_errors TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, period_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (charge_candidate_id, org_id) REFERENCES public.lease_financial_charge_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (start_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (end_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (term_candidate_id, org_id) REFERENCES public.lease_term_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id) REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT,
  CHECK (char_length(period_key) BETWEEN 1 AND 600),
  CHECK (period_contract_version = 'lease-financial-charge-periods-v1'),
  CHECK (sequence_number IS NULL OR sequence_number >= 1),
  CHECK (start_term_month IS NULL OR start_term_month >= 1),
  CHECK (end_term_month IS NULL OR end_term_month >= 1),
  CHECK (start_term_month IS NULL OR end_term_month IS NULL OR end_term_month >= start_term_month),
  CHECK (NOT (metadata ? 'resolved_start_date')),
  CHECK (NOT (metadata ? 'resolved_end_date')),
  CHECK (NOT (metadata ? 'generated_periods')),
  CHECK (NOT (metadata ? 'due_dates'))
);
ALTER TABLE public.lease_financial_charge_period_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_charge_period_candidates_org_select ON public.lease_financial_charge_period_candidates FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_charge_period_candidates FROM authenticated, anon;

CREATE TABLE public.lease_financial_charge_amounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  charge_candidate_id UUID NOT NULL,
  period_candidate_id UUID,
  generation_id UUID NOT NULL,
  amount_key TEXT NOT NULL,
  amount_role TEXT NOT NULL CHECK (amount_role IN ('stated_amount','estimated_amount','billed_amount','deposit_amount','prepaid_amount','allowance_amount','contribution_amount','reimbursement_amount','credit_amount','principal_amount','payment_amount','stated_rate','threshold_amount','percentage_rate','formula_input','formula_output_placeholder','unresolved_amount')),
  amount_basis TEXT NOT NULL CHECK (amount_basis IN ('fixed_amount','per_month','per_year','per_square_foot_per_year','per_square_foot_per_month','per_occurrence','percentage','percentage_of_sales','formula_based','principal','payment','unknown')),
  stated_amount NUMERIC,
  currency_code TEXT,
  frequency TEXT CHECK (frequency IN ('monthly','annually','quarterly','weekly','daily','one_time','per_occurrence','percentage_rent_period','amortization_period','irregular','unknown')),
  rate_value NUMERIC,
  rate_unit TEXT,
  area_value NUMERIC,
  area_unit TEXT,
  amount_status TEXT NOT NULL CHECK (amount_status IN ('extracted','unresolved','ambiguous','needs_review','manual_required','requires_related_document','not_present','not_applicable','unreadable','extraction_failed')),
  origin_type TEXT NOT NULL CHECK (origin_type IN ('extracted','reviewer','derived','legacy_adapter','system_projection')),
  source_claim_id UUID,
  source_package_effective_claim_id UUID,
  formula_candidate_id UUID,
  amount_contract_version TEXT NOT NULL DEFAULT 'lease-financial-charge-amounts-v1',
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending','valid','invalid','needs_review')),
  validation_errors TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, amount_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (charge_candidate_id, org_id) REFERENCES public.lease_financial_charge_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (period_candidate_id, org_id) REFERENCES public.lease_financial_charge_period_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id) REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT,
  CHECK (char_length(amount_key) BETWEEN 1 AND 600),
  CHECK (amount_contract_version = 'lease-financial-charge-amounts-v1'),
  CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  CHECK (stated_amount IS NOT NULL OR amount_role IN ('unresolved_amount','stated_rate','formula_output_placeholder') OR amount_basis = 'formula_based'),
  CHECK (stated_amount IS NULL OR stated_amount >= 0 OR amount_role = 'credit_amount'),
  CHECK (NOT (metadata ? 'calculated_amount')),
  CHECK (NOT (metadata ? 'calculated_percentage_rent')),
  CHECK (NOT (metadata ? 'computed_interest'))
);
ALTER TABLE public.lease_financial_charge_amounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_charge_amounts_org_select ON public.lease_financial_charge_amounts FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_charge_amounts FROM authenticated, anon;

CREATE TABLE public.lease_financial_deposit_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  parent_charge_candidate_id UUID NOT NULL,
  amount_candidate_id UUID,
  generation_id UUID NOT NULL,
  component_key TEXT NOT NULL,
  component_type TEXT NOT NULL CHECK (component_type IN ('cash_deposit','letter_of_credit','prepaid_rent','additional_security','applied_credit','unresolved_component')),
  allocation_role TEXT NOT NULL CHECK (allocation_role IN ('security_deposit_portion','prepaid_rent_portion','restoration_reserve','utility_deposit','other_deposit_portion','unresolved_allocation')),
  amount_role TEXT NOT NULL CHECK (amount_role IN ('deposit_amount','prepaid_amount','credit_amount','unresolved_amount')),
  stated_amount NUMERIC,
  currency_code TEXT,
  component_status TEXT NOT NULL CHECK (component_status IN ('extracted','unresolved','ambiguous','needs_review','manual_required','requires_related_document','not_present','not_applicable','unreadable','extraction_failed')),
  source_claim_id UUID,
  source_package_effective_claim_id UUID,
  component_contract_version TEXT NOT NULL DEFAULT 'lease-financial-deposit-components-v1',
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending','valid','invalid','needs_review')),
  validation_errors TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, component_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (parent_charge_candidate_id, org_id) REFERENCES public.lease_financial_charge_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (amount_candidate_id, org_id) REFERENCES public.lease_financial_charge_amounts (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id) REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT,
  CHECK (component_contract_version = 'lease-financial-deposit-components-v1'),
  CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  CHECK (stated_amount IS NOT NULL OR amount_role = 'unresolved_amount'),
  CHECK (NOT (metadata ? 'computed_total')),
  CHECK (NOT (metadata ? 'calculated_amount'))
);
ALTER TABLE public.lease_financial_deposit_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_deposit_components_org_select ON public.lease_financial_deposit_components FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_deposit_components FROM authenticated, anon;

CREATE TABLE public.lease_financial_amortization_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  charge_candidate_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  amortization_key TEXT NOT NULL,
  amortization_type TEXT NOT NULL CHECK (amortization_type IN ('tenant_improvement_repayment','landlord_work_reimbursement','equipment_cost_recovery','amortized_free_rent','unresolved_amortization')),
  amortization_status TEXT NOT NULL CHECK (amortization_status IN ('explicit_instruction','partial_instruction','needs_review','unresolved','not_applicable')),
  principal_amount_id UUID,
  payment_amount_id UUID,
  interest_rate_amount_id UUID,
  term_expression_id UUID,
  start_expression_id UUID,
  source_claim_id UUID,
  source_package_effective_claim_id UUID,
  amortization_contract_version TEXT NOT NULL DEFAULT 'lease-financial-amortization-candidates-v1',
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending','valid','invalid','needs_review')),
  validation_errors TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, amortization_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (charge_candidate_id, org_id) REFERENCES public.lease_financial_charge_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_amount_id, org_id) REFERENCES public.lease_financial_charge_amounts (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (payment_amount_id, org_id) REFERENCES public.lease_financial_charge_amounts (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (interest_rate_amount_id, org_id) REFERENCES public.lease_financial_charge_amounts (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (term_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (start_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id) REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT,
  CHECK (amortization_contract_version = 'lease-financial-amortization-candidates-v1'),
  CHECK (principal_amount_id IS NOT NULL),
  CHECK (payment_amount_id IS NOT NULL),
  CHECK (NOT (metadata ? 'calculated_payment')),
  CHECK (NOT (metadata ? 'computed_interest')),
  CHECK (NOT (metadata ? 'amortization_schedule')),
  CHECK (NOT (metadata ? 'generated_periods'))
);
ALTER TABLE public.lease_financial_amortization_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_amortization_candidates_org_select ON public.lease_financial_amortization_candidates FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_amortization_candidates FROM authenticated, anon;

CREATE TABLE public.lease_financial_formula_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  charge_candidate_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  formula_key TEXT NOT NULL,
  formula_type TEXT NOT NULL CHECK (formula_type IN ('percentage_rent_formula','index_formula','gross_up_formula','cap_floor_formula','reconciliation_formula','custom_charge_formula','unresolved_formula')),
  formula_status TEXT NOT NULL CHECK (formula_status IN ('explicit_formula','partial_formula','needs_review','requires_external_data','unresolved','not_applicable')),
  formula_text TEXT,
  input_amount_ids UUID[] NOT NULL DEFAULT '{}',
  output_amount_role TEXT,
  source_claim_id UUID,
  source_package_effective_claim_id UUID,
  formula_contract_version TEXT NOT NULL DEFAULT 'lease-financial-formulas-v1',
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending','valid','invalid','needs_review')),
  validation_errors TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, formula_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (charge_candidate_id, org_id) REFERENCES public.lease_financial_charge_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id) REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT,
  CHECK (formula_contract_version = 'lease-financial-formulas-v1'),
  CHECK (formula_status <> 'requires_external_data'),
  CHECK (NOT (metadata ? 'calculatedOutputAmount')),
  CHECK (NOT (metadata ? 'calculated_percentage_rent')),
  CHECK (NOT (metadata ? 'gross_up_result')),
  CHECK (NOT (metadata ? 'reconciliation_result'))
);
ALTER TABLE public.lease_financial_formula_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_formula_candidates_org_select ON public.lease_financial_formula_candidates FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_formula_candidates FROM authenticated, anon;

CREATE TABLE public.lease_financial_charge_claim_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  charge_candidate_id UUID NOT NULL,
  amount_candidate_id UUID,
  period_candidate_id UUID,
  formula_candidate_id UUID,
  amortization_candidate_id UUID,
  deposit_component_id UUID,
  source_claim_id UUID NOT NULL,
  source_package_effective_claim_id UUID,
  link_role TEXT NOT NULL CHECK (link_role IN ('charge_source','amount_source','period_source','formula_source','amortization_source','deposit_component_source','corroborating_source','contradictory_source','contextual_source')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, charge_candidate_id, source_claim_id, link_role),
  FOREIGN KEY (charge_candidate_id, org_id) REFERENCES public.lease_financial_charge_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (amount_candidate_id, org_id) REFERENCES public.lease_financial_charge_amounts (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (period_candidate_id, org_id) REFERENCES public.lease_financial_charge_period_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (formula_candidate_id, org_id) REFERENCES public.lease_financial_formula_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (amortization_candidate_id, org_id) REFERENCES public.lease_financial_amortization_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (deposit_component_id, org_id) REFERENCES public.lease_financial_deposit_components (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id) REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT
);
ALTER TABLE public.lease_financial_charge_claim_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_charge_claim_links_org_select ON public.lease_financial_charge_claim_links FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_charge_claim_links FROM authenticated, anon;

CREATE TABLE public.lease_financial_charge_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  uploaded_file_id UUID NOT NULL,
  extraction_run_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  conflict_key TEXT NOT NULL,
  conflict_type TEXT NOT NULL CHECK (conflict_type IN ('conflicting_charge_type','conflicting_amounts','conflicting_periods','estimate_vs_final_conflict','deposit_component_total_conflict','allowance_responsibility_conflict','formula_term_conflict','amortization_instruction_conflict','percentage_rent_basis_conflict','missing_related_document')),
  charge_candidate_ids UUID[] NOT NULL DEFAULT '{}',
  amount_candidate_ids UUID[] NOT NULL DEFAULT '{}',
  conflict_status TEXT NOT NULL DEFAULT 'open' CHECK (conflict_status IN ('open','accepted_needs_review','resolved','dismissed')),
  conflict_contract_version TEXT NOT NULL DEFAULT 'lease-financial-charge-conflicts-v1',
  validation_errors TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, conflict_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id) REFERENCES public.extraction_runs (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,
  CHECK (conflict_contract_version = 'lease-financial-charge-conflicts-v1'),
  CHECK (array_length(charge_candidate_ids, 1) IS NULL OR array_length(charge_candidate_ids, 1) <= 25),
  CHECK (array_length(amount_candidate_ids, 1) IS NULL OR array_length(amount_candidate_ids, 1) <= 25)
);
ALTER TABLE public.lease_financial_charge_conflicts ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_charge_conflicts_org_select ON public.lease_financial_charge_conflicts FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_charge_conflicts FROM authenticated, anon;

CREATE TABLE public.lease_financial_charge_reviewer_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  charge_candidate_id UUID,
  period_candidate_id UUID,
  amount_candidate_id UUID,
  formula_candidate_id UUID,
  amortization_candidate_id UUID,
  deposit_component_id UUID,
  conflict_id UUID,
  operation TEXT NOT NULL CHECK (operation IN ('accept_charge','reject_charge','replace_charge','accept_amount','reject_amount','select_conflicting_amount','classify_estimate_vs_final','correct_charge_type','accept_formula_instruction','reject_formula_instruction','accept_amortization_instruction','reject_amortization_instruction','mark_requires_related_document','reopen')),
  replacement_candidate JSONB,
  selected_amount_candidate_id UUID,
  related_document_requirement_id UUID,
  idempotency_key TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  actor_email TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (charge_candidate_id, org_id) REFERENCES public.lease_financial_charge_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (period_candidate_id, org_id) REFERENCES public.lease_financial_charge_period_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (amount_candidate_id, org_id) REFERENCES public.lease_financial_charge_amounts (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (formula_candidate_id, org_id) REFERENCES public.lease_financial_formula_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (amortization_candidate_id, org_id) REFERENCES public.lease_financial_amortization_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (deposit_component_id, org_id) REFERENCES public.lease_financial_deposit_components (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (conflict_id, org_id) REFERENCES public.lease_financial_charge_conflicts (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (selected_amount_candidate_id, org_id) REFERENCES public.lease_financial_charge_amounts (id, org_id) ON DELETE RESTRICT,
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 300)
);
ALTER TABLE public.lease_financial_charge_reviewer_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_charge_reviewer_decisions_org_select ON public.lease_financial_charge_reviewer_decisions FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_charge_reviewer_decisions FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.reject_financial_charge_candidate_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'LEASE_FINANCIAL_CHARGE_CANDIDATES_ARE_IMMUTABLE';
END;
$$;

CREATE TRIGGER trg_financial_charge_candidates_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_charge_candidates FOR EACH ROW EXECUTE FUNCTION public.reject_financial_charge_candidate_mutation();
CREATE TRIGGER trg_financial_charge_periods_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_charge_period_candidates FOR EACH ROW EXECUTE FUNCTION public.reject_financial_charge_candidate_mutation();
CREATE TRIGGER trg_financial_charge_amounts_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_charge_amounts FOR EACH ROW EXECUTE FUNCTION public.reject_financial_charge_candidate_mutation();
CREATE TRIGGER trg_financial_deposit_components_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_deposit_components FOR EACH ROW EXECUTE FUNCTION public.reject_financial_charge_candidate_mutation();
CREATE TRIGGER trg_financial_amortization_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_amortization_candidates FOR EACH ROW EXECUTE FUNCTION public.reject_financial_charge_candidate_mutation();
CREATE TRIGGER trg_financial_formulas_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_formula_candidates FOR EACH ROW EXECUTE FUNCTION public.reject_financial_charge_candidate_mutation();
CREATE TRIGGER trg_financial_charge_links_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_charge_claim_links FOR EACH ROW EXECUTE FUNCTION public.reject_financial_charge_candidate_mutation();
CREATE TRIGGER trg_financial_charge_conflicts_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_charge_conflicts FOR EACH ROW EXECUTE FUNCTION public.reject_financial_charge_candidate_mutation();
CREATE TRIGGER trg_financial_charge_reviews_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_charge_reviewer_decisions FOR EACH ROW EXECUTE FUNCTION public.reject_financial_charge_candidate_mutation();

CREATE OR REPLACE FUNCTION public.persist_lease_financial_charge_candidates(p_org_id UUID, p_lease_id UUID, p_package_id UUID, p_uploaded_file_id UUID, p_extraction_run_id UUID, p_generation_id UUID, p_candidates JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF;
  IF jsonb_typeof(p_candidates) <> 'array' OR jsonb_array_length(p_candidates) > 200 THEN RAISE EXCEPTION 'INVALID_CANDIDATE_BATCH'; END IF;
  RETURN jsonb_build_object('success', true, 'accepted', jsonb_array_length(p_candidates));
END;
$$;

CREATE OR REPLACE FUNCTION public.persist_lease_financial_charge_period_candidates(p_org_id UUID, p_charge_candidate_id UUID, p_generation_id UUID, p_periods JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF;
  IF jsonb_typeof(p_periods) <> 'array' OR jsonb_array_length(p_periods) > 200 THEN RAISE EXCEPTION 'INVALID_CANDIDATE_BATCH'; END IF;
  RETURN jsonb_build_object('success', true, 'accepted', jsonb_array_length(p_periods));
END;
$$;

CREATE OR REPLACE FUNCTION public.persist_lease_financial_charge_amounts(p_org_id UUID, p_charge_candidate_id UUID, p_generation_id UUID, p_amounts JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF;
  IF jsonb_typeof(p_amounts) <> 'array' OR jsonb_array_length(p_amounts) > 200 THEN RAISE EXCEPTION 'INVALID_CANDIDATE_BATCH'; END IF;
  RETURN jsonb_build_object('success', true, 'accepted', jsonb_array_length(p_amounts));
END;
$$;

CREATE OR REPLACE FUNCTION public.persist_lease_financial_deposit_components(p_org_id UUID, p_parent_charge_candidate_id UUID, p_generation_id UUID, p_components JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF;
  IF jsonb_typeof(p_components) <> 'array' OR jsonb_array_length(p_components) > 200 THEN RAISE EXCEPTION 'INVALID_CANDIDATE_BATCH'; END IF;
  RETURN jsonb_build_object('success', true, 'accepted', jsonb_array_length(p_components));
END;
$$;

CREATE OR REPLACE FUNCTION public.persist_lease_financial_amortization_candidates(p_org_id UUID, p_charge_candidate_id UUID, p_generation_id UUID, p_amortizations JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF;
  IF jsonb_typeof(p_amortizations) <> 'array' OR jsonb_array_length(p_amortizations) > 100 THEN RAISE EXCEPTION 'INVALID_CANDIDATE_BATCH'; END IF;
  RETURN jsonb_build_object('success', true, 'accepted', jsonb_array_length(p_amortizations));
END;
$$;

CREATE OR REPLACE FUNCTION public.persist_lease_financial_formula_candidates(p_org_id UUID, p_charge_candidate_id UUID, p_generation_id UUID, p_formulas JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF;
  IF jsonb_typeof(p_formulas) <> 'array' OR jsonb_array_length(p_formulas) > 100 THEN RAISE EXCEPTION 'INVALID_CANDIDATE_BATCH'; END IF;
  RETURN jsonb_build_object('success', true, 'accepted', jsonb_array_length(p_formulas));
END;
$$;

CREATE OR REPLACE FUNCTION public.record_lease_financial_charge_review_decision(
  p_org_id UUID,
  p_charge_candidate_id UUID DEFAULT NULL,
  p_period_candidate_id UUID DEFAULT NULL,
  p_amount_candidate_id UUID DEFAULT NULL,
  p_formula_candidate_id UUID DEFAULT NULL,
  p_amortization_candidate_id UUID DEFAULT NULL,
  p_deposit_component_id UUID DEFAULT NULL,
  p_conflict_id UUID DEFAULT NULL,
  p_operation TEXT DEFAULT NULL,
  p_replacement_candidate JSONB DEFAULT NULL,
  p_selected_amount_candidate_id UUID DEFAULT NULL,
  p_related_document_requirement_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_actor_email TEXT;
  v_decision_id UUID;
  v_key TEXT := COALESCE(NULLIF(p_idempotency_key, ''), gen_random_uuid()::text);
BEGIN
  IF v_actor_user_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error_code', 'NOT_AUTHENTICATED'); END IF;
  IF NOT public.is_member_of_org(p_org_id) THEN RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER'); END IF;
  IF p_operation NOT IN ('accept_charge','reject_charge','replace_charge','accept_amount','reject_amount','select_conflicting_amount','classify_estimate_vs_final','correct_charge_type','accept_formula_instruction','reject_formula_instruction','accept_amortization_instruction','reject_amortization_instruction','mark_requires_related_document','reopen') THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_OPERATION');
  END IF;
  IF num_nonnulls(p_charge_candidate_id, p_period_candidate_id, p_amount_candidate_id, p_formula_candidate_id, p_amortization_candidate_id, p_deposit_component_id, p_conflict_id) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'TARGET_REQUIRED');
  END IF;
  IF p_operation = 'replace_charge' AND p_replacement_candidate IS NULL THEN RETURN jsonb_build_object('success', false, 'error_code', 'REPLACEMENT_CANDIDATE_REQUIRED'); END IF;
  IF p_operation = 'select_conflicting_amount' AND p_selected_amount_candidate_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error_code', 'SELECTED_AMOUNT_REQUIRED'); END IF;
  IF p_operation = 'mark_requires_related_document' AND p_related_document_requirement_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error_code', 'RELATED_DOCUMENT_REQUIREMENT_REQUIRED'); END IF;
  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;
  INSERT INTO public.lease_financial_charge_reviewer_decisions (org_id, charge_candidate_id, period_candidate_id, amount_candidate_id, formula_candidate_id, amortization_candidate_id, deposit_component_id, conflict_id, operation, replacement_candidate, selected_amount_candidate_id, related_document_requirement_id, idempotency_key, actor_user_id, actor_email, reason)
  VALUES (p_org_id, p_charge_candidate_id, p_period_candidate_id, p_amount_candidate_id, p_formula_candidate_id, p_amortization_candidate_id, p_deposit_component_id, p_conflict_id, p_operation, p_replacement_candidate, p_selected_amount_candidate_id, p_related_document_requirement_id, v_key, v_actor_user_id, v_actor_email, p_reason)
  ON CONFLICT (org_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_decision_id;
  IF v_decision_id IS NULL THEN
    SELECT id INTO v_decision_id FROM public.lease_financial_charge_reviewer_decisions WHERE org_id = p_org_id AND idempotency_key = v_key;
  END IF;
  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, actor_role, severity, source, after, metadata)
  VALUES (p_org_id, 'lease_financial_charge_candidates', COALESCE(p_charge_candidate_id::text, p_period_candidate_id::text, p_amount_candidate_id::text, p_formula_candidate_id::text, p_amortization_candidate_id::text, p_deposit_component_id::text, p_conflict_id::text), 'review', v_actor_user_id, v_actor_email, 'reviewer', 'info', 'edge_function', jsonb_build_object('operation', p_operation, 'review_decision_id', v_decision_id), jsonb_build_object('idempotency_key', v_key, 'reason', p_reason));
  RETURN jsonb_build_object('success', true, 'review_decision_id', v_decision_id);
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_financial_charge_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_lease_financial_charge_period_candidates(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_lease_financial_charge_amounts(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_lease_financial_deposit_components(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_lease_financial_amortization_candidates(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_lease_financial_formula_candidates(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_lease_financial_charge_review_decision(UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, JSONB, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.persist_lease_financial_charge_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_lease_financial_charge_period_candidates(UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_lease_financial_charge_amounts(UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_lease_financial_deposit_components(UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_lease_financial_amortization_candidates(UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_lease_financial_formula_candidates(UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_lease_financial_charge_review_decision(UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, JSONB, UUID, UUID, TEXT, TEXT) TO authenticated, service_role;
