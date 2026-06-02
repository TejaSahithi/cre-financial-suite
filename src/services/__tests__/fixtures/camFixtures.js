export const MOCK_APPROVED_CAM_RULE = {
  id: "rule-cam-1",
  lease_id: "lease-1",
  category_name: "Common Area Maintenance",
  expense_category: "common_area_maintenance",
  payment_treatment: "reimbursable",
  recovery_method: "pro_rata_share",
  approval_status: "approved",
  review_status: "approved",
  exact_source_text: "Tenant shall pay its pro rata share of Common Area Maintenance expenses.",
  confidence: 0.9,
};

export const MOCK_TEMPLATE_RULE = {
  ...MOCK_APPROVED_CAM_RULE,
  id: "rule-tpl-1",
  generation_source: "template_checklist",
  exact_source_text: null,
  source: null,
};

export const MOCK_EXCLUDED_RULE = {
  ...MOCK_APPROVED_CAM_RULE,
  id: "rule-ex-1",
  payment_treatment: "not_applicable",
  is_excluded: true,
  exact_source_text: "Excluded from operating expenses.",
};

export const MOCK_TENANT_DIRECT_RULE = {
  ...MOCK_APPROVED_CAM_RULE,
  id: "rule-dir-1",
  category_name: "Utilities",
  expense_category: "utilities",
  payment_treatment: "tenant_direct_contract",
  exact_source_text: "Tenant shall contract directly with the utility provider.",
};

export const MOCK_ACTUAL_EXPENSE = {
  id: "exp-1",
  lease_id: "lease-1",
  category: "common_area_maintenance",
  amount: 1000,
  date: "2026-01-01",
};

export const MOCK_CLASSIFICATION_RECORD = {
  id: "class-1",
  expense_id: "exp-1",
  lease_expense_rule_id: "rule-cam-1",
  classification_status: "finalized",
  recoverability_result: "recoverable",
  cam_eligible: "yes",
  recoverable_amount: 1000,
  cam_status: "cam_ready",
};
