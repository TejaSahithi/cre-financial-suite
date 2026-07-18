-- P2.1 — generated, immutable DB snapshot of the TS claim concept registry
-- (supabase/functions/_shared/extraction/claims/concept-registry.ts).
--
-- The TS file is the AUTHORING source; these two tables are a deterministic,
-- generated ARTIFACT of it, never a second independently-maintained
-- registry (round-2 external review correction #1). A SQL SECURITY DEFINER
-- RPC cannot consult a TS file directly, so P2.3's claim-persistence RPC
-- validates an incoming claim's concept_key against lease_claim_concepts,
-- not against the TS file. The rows below were produced by
-- scripts/generate-lease-claim-registry-snapshot.ts — re-run that script and
-- paste its output into a new additive migration whenever the TS registry
-- changes; never hand-edit these INSERT statements directly.
--
-- registry_hash is the deterministic SHA-256 fingerprint computed by the
-- TS registry's own computeRegistryHash() — a schema-contract test asserts
-- these stay equal, catching any drift between the authoring source and
-- this snapshot.

CREATE TABLE public.lease_claim_registry_versions (
  registry_version TEXT PRIMARY KEY,
  registry_hash     TEXT NOT NULL,
  published_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (registry_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE public.lease_claim_concepts (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registry_version       TEXT NOT NULL REFERENCES public.lease_claim_registry_versions(registry_version) ON DELETE RESTRICT,
  concept_key            TEXT NOT NULL,
  domain                 TEXT NOT NULL,
  value_type             TEXT NOT NULL CHECK (value_type IN ('string','money','decimal','integer','percentage','boolean','date','duration_months','address','object','array')),
  cardinality            TEXT NOT NULL CHECK (cardinality IN ('single','multiple')),
  instance_strategy      TEXT NOT NULL CHECK (instance_strategy IN ('singleton','source_ordinal','semantic_role','normalized_identifier','evidence_position')),
  evidence_required      BOOLEAN NOT NULL,
  projection_field_key   TEXT,
  compatibility_section  TEXT,
  aliases                TEXT[] NOT NULL DEFAULT '{}',
  normalization_strategy TEXT NOT NULL,
  comparison_strategy    TEXT NOT NULL,
  active                 BOOLEAN NOT NULL DEFAULT true,
  introduced_in          TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (registry_version, concept_key),
  -- Every registered concept must use the standard namespace -- the
  -- dynamic.* namespace is reserved for unregistered/discovered claims
  -- (P2.4) and must never appear as a snapshot row here.
  CHECK (concept_key NOT LIKE 'dynamic.%')
);

CREATE INDEX lease_claim_concepts_registry_version_idx ON public.lease_claim_concepts(registry_version);
CREATE INDEX lease_claim_concepts_concept_key_idx ON public.lease_claim_concepts(concept_key);

-- Read-only reference data for the P2.3 persistence RPC (SECURITY DEFINER,
-- service_role) and any future migration-time regeneration tooling. No
-- ordinary client role needs direct access -- nothing here is
-- lease/org-scoped, and it carries no tenant or document content.
REVOKE ALL ON public.lease_claim_registry_versions FROM authenticated, anon;
REVOKE ALL ON public.lease_claim_concepts FROM authenticated, anon;

INSERT INTO public.lease_claim_registry_versions (registry_version, registry_hash) VALUES
  ('lease-claims-v1', '4dd86ea371a473e68bb0930b3716740fffdfd3bbcf4979ba2643d9f8e2480a9a');

INSERT INTO public.lease_claim_concepts
  (registry_version, concept_key, domain, value_type, cardinality, instance_strategy, evidence_required, projection_field_key, compatibility_section, aliases, normalization_strategy, comparison_strategy, active, introduced_in)
VALUES
  ('lease-claims-v1', 'lease_date', 'document', 'date', 'single', 'singleton', true, 'lease_date', 'document_identity', '{"effective_date","date_of_lease"}', 'date_to_iso', 'date_normalized_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'lease_type', 'document', 'string', 'single', 'singleton', true, 'lease_type', 'document_identity', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'status', 'document', 'string', 'single', 'singleton', false, 'status', 'document_identity', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'notes', 'document', 'string', 'single', 'singleton', false, 'notes', 'document_identity', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'tenant_name', 'parties', 'string', 'single', 'singleton', true, 'tenant_name', 'parties', '{"tenant","lessee","occupant"}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'landlord_name', 'parties', 'string', 'single', 'singleton', true, 'landlord_name', 'parties', '{"landlord","lessor","owner_landlord"}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'tenant_signatory_name', 'parties', 'string', 'single', 'singleton', true, 'tenant_signatory_name', 'parties', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'landlord_signatory_name', 'parties', 'string', 'single', 'singleton', true, 'landlord_signatory_name', 'parties', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'broker_name', 'parties', 'string', 'single', 'singleton', true, 'broker_name', 'parties', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'assignor_name', 'parties', 'string', 'single', 'singleton', true, 'assignor_name', 'parties', '{"original_tenant","transferor"}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'assignee_name', 'parties', 'string', 'single', 'singleton', true, 'assignee_name', 'parties', '{"new_tenant","transferee"}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'property_address', 'premises', 'address', 'single', 'singleton', true, 'property_address', 'property_premises', '{}', 'address_normalize', 'address_conservative_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'property_name', 'premises', 'string', 'single', 'singleton', true, 'property_name', 'property_premises', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'unit_number', 'premises', 'string', 'single', 'singleton', true, 'unit_number', 'property_premises', '{"unit","suite","space"}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'square_footage', 'premises', 'decimal', 'single', 'singleton', true, 'square_footage', 'property_premises', '{"tenant_rsf","rentable_area_sqft"}', 'decimal_parse', 'decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'permitted_use', 'premises', 'string', 'single', 'singleton', true, 'permitted_use', 'property_premises', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'start_date', 'term', 'date', 'single', 'singleton', true, 'start_date', 'term_dates', '{}', 'date_to_iso', 'date_normalized_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'end_date', 'term', 'date', 'single', 'singleton', true, 'end_date', 'term_dates', '{}', 'date_to_iso', 'date_normalized_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'commencement_date', 'term', 'date', 'single', 'singleton', true, 'commencement_date', 'term_dates', '{}', 'date_to_iso', 'date_normalized_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'expiration_date', 'term', 'date', 'single', 'singleton', true, 'expiration_date', 'term_dates', '{}', 'date_to_iso', 'date_normalized_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'rent_commencement_date', 'term', 'date', 'single', 'singleton', true, 'rent_commencement_date', 'term_dates', '{}', 'date_to_iso', 'date_normalized_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'lease_term_months', 'term', 'integer', 'single', 'singleton', false, 'lease_term_months', 'term_dates', '{}', 'integer_parse', 'integer_exact_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'assignment_effective_date', 'term', 'date', 'single', 'singleton', true, 'assignment_effective_date', 'term_dates', '{"assignment_date"}', 'date_to_iso', 'date_normalized_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'monthly_rent', 'rent', 'money', 'single', 'singleton', true, 'monthly_rent', 'rent_charges', '{"base_rent_monthly","base_rent"}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'annual_rent', 'rent', 'money', 'single', 'singleton', false, 'annual_rent', 'rent_charges', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'rent_per_sf', 'rent', 'string', 'single', 'singleton', false, 'rent_per_sf', 'rent_charges', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'billing_frequency', 'rent', 'string', 'single', 'singleton', true, 'billing_frequency', 'rent_charges', '{"rent_frequency"}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'escalation_rate', 'rent', 'percentage', 'single', 'singleton', true, 'escalation_rate', 'rent_charges', '{}', 'percentage_to_decimal', 'percentage_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'escalation_type', 'rent', 'string', 'single', 'singleton', true, 'escalation_type', 'rent_charges', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'escalation_timing', 'rent', 'string', 'single', 'singleton', true, 'escalation_timing', 'rent_charges', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'security_deposit', 'rent', 'money', 'single', 'singleton', true, 'security_deposit', 'rent_charges', '{"security_deposit_amount"}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'late_fee_amount', 'rent', 'money', 'single', 'singleton', true, 'late_fee_amount', 'rent_charges', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'returned_payment_fee_amount', 'rent', 'money', 'single', 'singleton', true, 'returned_payment_fee_amount', 'rent_charges', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'application_fee_amount', 'rent', 'money', 'single', 'singleton', true, 'application_fee_amount', 'rent_charges', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'administrative_fee_amount', 'rent', 'money', 'single', 'singleton', true, 'administrative_fee_amount', 'rent_charges', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'pet_fee_amount', 'rent', 'money', 'single', 'singleton', true, 'pet_fee_amount', 'rent_charges', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'pet_rent_amount', 'rent', 'money', 'single', 'singleton', true, 'pet_rent_amount', 'rent_charges', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'parking_fee_amount', 'rent', 'money', 'single', 'singleton', true, 'parking_fee_amount', 'rent_charges', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'ti_allowance', 'rent', 'money', 'single', 'singleton', true, 'ti_allowance', 'rent_charges', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'free_rent_months', 'rent', 'integer', 'single', 'singleton', true, 'free_rent_months', 'rent_charges', '{}', 'integer_parse', 'integer_exact_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'assignment_consideration', 'rent', 'money', 'single', 'singleton', true, 'assignment_consideration', 'rent_charges', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'amended_base_rent_for_additional_year', 'rent', 'string', 'single', 'singleton', true, 'amended_base_rent_for_additional_year', 'rent_charges', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'base_year', 'expenses', 'string', 'single', 'singleton', true, 'base_year', 'expenses_recoveries', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'expense_stop', 'expenses', 'money', 'single', 'singleton', true, 'expense_stop', 'expenses_recoveries', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'cam_amount', 'cam', 'money', 'single', 'singleton', true, 'cam_amount', 'cam_rules', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'cam_cap_type', 'cam', 'string', 'single', 'singleton', true, 'cam_cap_type', 'cam_rules', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'cam_cap_pct', 'cam', 'percentage', 'single', 'singleton', true, 'cam_cap_pct', 'cam_rules', '{}', 'percentage_to_decimal', 'percentage_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'admin_fee_pct', 'cam', 'percentage', 'single', 'singleton', true, 'admin_fee_pct', 'cam_rules', '{}', 'percentage_to_decimal', 'percentage_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'management_fee_basis', 'cam', 'string', 'single', 'singleton', true, 'management_fee_basis', 'cam_rules', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'gross_up_enabled', 'cam', 'boolean', 'single', 'singleton', true, 'gross_up_enabled', 'cam_rules', '{}', 'boolean_parse', 'boolean_canonical_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'gross_up_threshold', 'cam', 'money', 'single', 'singleton', true, 'gross_up_threshold', 'cam_rules', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'tax_responsibility', 'taxes', 'string', 'single', 'singleton', true, 'tax_responsibility', 'taxes', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'responsibility_taxes', 'taxes', 'string', 'single', 'singleton', true, 'responsibility_taxes', 'taxes', '{"responsibility_taxes"}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'insurance_responsibility', 'insurance', 'string', 'single', 'singleton', true, 'insurance_responsibility', 'insurance', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'responsibility_insurance', 'insurance', 'string', 'single', 'singleton', true, 'responsibility_insurance', 'insurance', '{"responsibility_insurance"}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'property_insurance_responsibility', 'insurance', 'string', 'single', 'singleton', true, 'property_insurance_responsibility', 'insurance', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'tenant_insurance_required', 'insurance', 'boolean', 'single', 'singleton', true, 'tenant_insurance_required', 'insurance', '{}', 'boolean_parse', 'boolean_canonical_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'general_liability_min', 'insurance', 'string', 'single', 'singleton', true, 'general_liability_min', 'insurance', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'waiver_of_subrogation', 'insurance', 'string', 'single', 'singleton', true, 'waiver_of_subrogation', 'insurance', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'additional_insureds_required', 'insurance', 'boolean', 'single', 'singleton', true, 'additional_insureds_required', 'insurance', '{}', 'boolean_parse', 'boolean_canonical_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'responsibility_utilities', 'utilities', 'string', 'single', 'singleton', true, 'responsibility_utilities', 'utilities', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'electric_responsibility', 'utilities', 'string', 'single', 'singleton', true, 'electric_responsibility', 'utilities', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'water_sewer_responsibility', 'utilities', 'string', 'single', 'singleton', true, 'water_sewer_responsibility', 'utilities', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'utility_reimbursement_amount', 'utilities', 'money', 'single', 'singleton', true, 'utility_reimbursement_amount', 'utilities', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'water_sewer_reimbursement_amount', 'utilities', 'money', 'single', 'singleton', true, 'water_sewer_reimbursement_amount', 'utilities', '{}', 'money_to_decimal', 'money_decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'responsibility_repairs', 'repairs', 'string', 'single', 'singleton', true, 'responsibility_repairs', 'repairs_maintenance', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'hvac_responsibility', 'repairs', 'string', 'single', 'singleton', true, 'hvac_responsibility', 'repairs_maintenance', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'renewal_options', 'options', 'string', 'single', 'singleton', true, 'renewal_options', 'legal_options', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'renewal_type', 'options', 'string', 'single', 'singleton', true, 'renewal_type', 'legal_options', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'right_of_first_refusal', 'options', 'string', 'single', 'singleton', true, 'right_of_first_refusal', 'legal_options', '{"rofr"}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'early_termination_option', 'options', 'string', 'single', 'singleton', true, 'early_termination_option', 'legal_options', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'assignment_provisions', 'options', 'string', 'single', 'singleton', true, 'assignment_provisions', 'legal_options', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'default_cure_period', 'options', 'string', 'single', 'singleton', true, 'default_cure_period', 'legal_options', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'landlord_consent', 'options', 'string', 'single', 'singleton', true, 'landlord_consent', 'legal_options', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'assumption_scope', 'options', 'string', 'single', 'singleton', true, 'assumption_scope', 'legal_options', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'all_other_terms_remain_same', 'options', 'string', 'single', 'singleton', true, 'all_other_terms_remain_same', 'legal_options', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'option_exercise_deadline', 'critical_dates', 'string', 'single', 'singleton', true, 'option_exercise_deadline', 'critical_dates', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'renewal_notice_months', 'notices', 'integer', 'single', 'singleton', true, 'renewal_notice_months', 'notices', '{}', 'integer_parse', 'integer_exact_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'termination_notice_months', 'notices', 'integer', 'single', 'singleton', true, 'termination_notice_months', 'notices', '{}', 'integer_parse', 'integer_exact_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'assignee_notice_address', 'notices', 'address', 'single', 'singleton', true, 'assignee_notice_address', 'notices', '{}', 'address_normalize', 'address_conservative_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'tenant_signature_date', 'signatures', 'date', 'single', 'singleton', true, 'tenant_signature_date', 'signatures', '{}', 'date_to_iso', 'date_normalized_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'landlord_signature_date', 'signatures', 'date', 'single', 'singleton', true, 'landlord_signature_date', 'signatures', '{}', 'date_to_iso', 'date_normalized_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'building_rsf', 'budget', 'decimal', 'single', 'singleton', true, 'building_rsf', 'budget_inputs', '{"building_square_footage"}', 'decimal_parse', 'decimal_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'landlord_address', 'parties', 'address', 'single', 'singleton', true, 'landlord_address', 'parties', '{"landlord_notice_address","lessor_address"}', 'address_normalize', 'address_conservative_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'tenant_address', 'parties', 'address', 'single', 'singleton', true, 'tenant_address', 'parties', '{}', 'address_normalize', 'address_conservative_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'tenant_contact_name', 'parties', 'string', 'single', 'singleton', true, 'tenant_contact_name', 'parties', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'tenant_contact_phone', 'parties', 'string', 'single', 'singleton', true, 'tenant_contact_phone', 'parties', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1'),
  ('lease-claims-v1', 'landlord_consent_for_transfer', 'options', 'string', 'single', 'singleton', true, 'landlord_consent_for_transfer', 'legal_options', '{}', 'string_trim', 'string_trimmed_case_aware_equal', true, 'lease-claims-v1');
