export function normalizeLeaseFieldKey(key) {
  if (!key) return "";
  return String(key).trim().toLowerCase().replace(/[\s.-]+/g, "_");
}

const FIELD_ALIASES = {
  // Parties
  landlord_name: ["landlord_name", "landlord", "lessor", "owner_landlord", "parties.landlord", "landlordName", "owner_name", "owner"],
  tenant_name: ["tenant_name", "tenant", "lessee", "occupant", "parties.tenant", "tenantName"],
  property_manager: ["property_manager", "management_company", "manager"],
  landlord_address: ["landlord_address", "landlord_notice_address", "lessor_address"],
  tenant_address: ["tenant_address", "tenant_notice_address", "lessee_address"],
  landlord_contact_name: ["landlord_contact_name", "landlord_contact", "lessor_contact"],
  tenant_contact_name: ["tenant_contact_name", "tenant_contact", "lessee_contact"],

  // Premises
  property_name: ["property_name", "building_name", "premises.property_name", "building"],
  property_address: ["property_address", "address", "premises_address", "demised_premises_address", "leased_premises_address", "shopping_center_address", "building_address", "premises_location", "property_location"],
  suite_number: ["suite_number", "suite", "unit", "premises", "premises_suite", "unit_number", "space_number"],
  floor: ["floor", "floor_number"],
  square_footage: ["square_footage", "rentable_square_feet", "tenant_rsf", "tenant_rentable_area", "rsf", "premises_rsf", "rentable_area", "rentable_area_sqft", "leased_premises_area", "square_feet"],
  building_rsf: ["building_rsf", "building_rentable_area"],
  tenant_pro_rata_share: ["tenant_pro_rata_share", "pro_rata_share", "tenant_share_percent", "tenant_share"],
  premises_use: ["premises_use", "permitted_use", "use"],
  permitted_use: ["permitted_use", "premises_use", "use_clause", "use", "use_of_premises"],

  // Dates
  commencement_date: ["commencement_date", "lease_commencement_date", "start_date", "term_start", "commencement", "lease_start_date", "term_commencement_date", "beginning_of_term"],
  rent_commencement_date: ["rent_commencement_date", "rent_start_date", "rent_commencement"],
  expiration_date: ["expiration_date", "expiry_date", "term_end", "lease_expiration_date", "end_date", "termination_date", "end_of_term"],
  lease_date: ["lease_date", "execution_date", "date_of_lease"],

  // Rent
  lease_type: ["lease_type", "expense_structure", "lease_structure", "rent_structure"],
  monthly_rent: ["monthly_rent", "base_rent_monthly", "monthly_base_rent", "current_monthly_rent", "base_rent"],
  annual_rent: ["annual_rent", "base_rent_annual", "annual_base_rent", "yearly_rent"],
  security_deposit: ["security_deposit", "security_deposit_amount", "deposit"],
  free_rent_months: ["free_rent_months", "free_rent", "rent_abatement_months", "abated_rent_months"],
  escalation_rate: ["escalation_rate", "escalation_percent", "rent_escalation_percent", "annual_increase_percent"],
  escalation_type: ["escalation_type", "rent_escalation_type"],
  renewal_options: ["renewal_options", "renewal_option", "extension_options", "renewal_terms"],
  renewal_notice_days: ["renewal_notice_days", "renewal_notice_period_days", "renewal_notice"],
  holdover_multiplier: ["holdover_multiplier", "holdover_rent", "holdover_rate", "holdover_rent_multiplier"],

  // CAM / Expenses / Base year / Caps / Exclusions
  admin_fee_percent: ["admin_fee_percent", "administrative_fee_percent", "cam_admin_fee_percent", "adminFeePercent", "administrative fee", "admin fee", "administrative expenses not exceeding"],
  management_fee_percent: ["management_fee_percent", "mgmt_fee_percent", "property_management_fee_percent", "management_fee_pct"],
  gross_up_percent: ["gross_up_percent", "gross_up_threshold_percent", "gross_up_threshold", "grossUpPercent", "gross-up", "gross up"],
  gross_up_clause: ["gross_up_clause", "gross_up", "gross_up_applicable"],
  cap_percent: ["cam_cap_percent", "cap_percent", "controllable_cap_percent", "controllable_cam_cap_percent", "controllable cap", "controllable expense cap"],
  cam_cap_type: ["cam_cap_type", "cap_type", "expense_cap_type"],
  base_year: ["base_year", "expense_base_year", "tax_base_year", "operating_expense_base_year"],
  base_year_amount: ["base_year_amount", "base_year_stop", "operating_expense_base_amount"],
  expense_stop_amount: ["expense_stop_amount", "expense_stop"],
  cam_amount: ["cam_amount", "common_area_maintenance_amount", "cam_charge"],
  nnn_amount: ["nnn_amount", "triple_net_amount"],
  tax_reimbursement_amount: ["tax_reimbursement_amount", "real_estate_tax_reimbursement", "property_tax_reimbursement"],
  insurance_reimbursement_amount: ["insurance_reimbursement_amount", "property_insurance_reimbursement"],
  utility_reimbursement_amount: ["utility_reimbursement_amount", "utilities_reimbursement"],
  excluded_expenses: ["excluded_expenses", "exclusions", "excluded_operating_expenses", "cam_exclusions"],
  vacancy_handling: ["vacancy_handling", "vacancy_treatment", "vacancy_gross_up"],
  estimated_annual_amount: ["estimated_annual_cam", "cam_estimate_annual", "estimated_annual_amount", "annual_cam_estimate", "estimated annual cam", "annual_additional_rent", "total tenant excess share", "estimated annual amount"],
  estimated_monthly_amount: ["estimated_monthly_cam", "cam_estimate_monthly", "estimated_monthly_amount", "monthly_cam_estimate", "estimated monthly cam", "monthly_additional_rent", "estimated monthly additional rent"],
  reconciliation_required: ["reconciliation_required", "cam_reconciliation_required", "reconciliation"],
  reconciliation_frequency: ["reconciliation_frequency", "cam_reconciliation_frequency"],

  // Insurance
  commercial_general_liability: ["commercial_general_liability", "cgl", "general_liability"],
  property_insurance: ["property_insurance"],

  // Legal / Notices
  late_fee_percent: ["late_fee_percent", "late_fee", "late_charge_percent"],
  default_interest_percent: ["default_interest_percent", "default_interest", "default_rate"]
};

export function getFieldAliases(fieldKey) {
  const normalized = normalizeLeaseFieldKey(fieldKey);
  const aliases = FIELD_ALIASES[normalized] || [];
  return [...new Set([normalized, ...aliases])].map(normalizeLeaseFieldKey);
}

function extractValueFromSource(source, aliases) {
  if (!source || typeof source !== "object") return null;

  for (const alias of aliases) {
    // Check direct property match
    let match = source[alias];
    
    // Check for exact object key match (in case normalization altered it)
    if (match === undefined) {
      const keys = Object.keys(source);
      const exactKey = keys.find(k => normalizeLeaseFieldKey(k) === alias);
      if (exactKey) {
        match = source[exactKey];
      }
    }

    if (match !== undefined && match !== null) {
      return match;
    }

    // Check nested generic fields array (like approvedSnapshot.fields)
    if (source.fields && typeof source.fields === "object") {
      let fieldMatch = source.fields[alias];
      if (fieldMatch === undefined) {
         const fKeys = Object.keys(source.fields);
         const exactFKey = fKeys.find(k => normalizeLeaseFieldKey(k) === alias);
         if (exactFKey) {
            fieldMatch = source.fields[exactFKey];
         }
      }
      if (fieldMatch !== undefined && fieldMatch !== null) {
        return fieldMatch;
      }
    }
  }

  // Deep search fallback for generic objects
  for (const value of Object.values(source)) {
    if (value && typeof value === "object" && value.label) {
      const labelNorm = normalizeLeaseFieldKey(value.label || value.title);
      if (aliases.includes(labelNorm)) {
        return value;
      }
    }
  }

  return null;
}

function buildResolverOutput(rawResult, sourcePath) {
  if (rawResult === null || rawResult === undefined || rawResult === "") {
    return null;
  }

  let output = {
    value: null,
    rawValue: null,
    normalizedValue: null,
    sourcePath: sourcePath,
    sourcePage: null,
    exactSourceText: null,
    confidence: null,
    reviewStatus: null,
    found: true
  };

  if (typeof rawResult === "object" && rawResult !== null) {
    // Rich object format. Lease evidence is persisted under different key
    // names depending on which writer ran:
    //   - workflow_output.lease_fields[k]:        source_page,  source_clause
    //   - ui_review_payload …standard_fields[k]:  evidence.page_number,
    //                                             evidence.source_clause
    //   - review-approve buildPerFieldEvidence:   all aliases pre-mapped
    //   - normalize-pdf-output evidence:          page_number,  source_clause
    // The resolver must accept every key family so Page / Exact Source Text
    // light up regardless of which writer populated the row.
    output.value = rawResult.value !== undefined ? rawResult.value : null;
    output.rawValue =
      rawResult.raw_value ||
      rawResult.rawValue ||
      rawResult.exact_source_text ||
      rawResult.source_text ||
      rawResult.source_clause ||
      rawResult.snippet ||
      String(rawResult.value || "");
    output.normalizedValue = rawResult.normalized_value || rawResult.normalizedValue || null;
    output.sourcePage =
      rawResult.source_page ??
      rawResult.sourcePage ??
      rawResult.page_number ??
      rawResult.page ??
      rawResult.evidence?.source_page ??
      rawResult.evidence?.page_number ??
      rawResult.evidence?.page ??
      null;
    output.exactSourceText =
      rawResult.exact_source_text ||
      rawResult.exactSourceText ||
      rawResult.source_clause ||
      rawResult.source_text ||
      rawResult.snippet ||
      rawResult.evidence?.source_clause ||
      rawResult.evidence?.source_text ||
      rawResult.evidence?.exact_source_text ||
      null;
    output.confidence =
      rawResult.confidence_score ??
      rawResult.confidence ??
      rawResult.evidence?.confidence ??
      null;
    output.reviewStatus =
      rawResult.review_status ||
      rawResult.reviewStatus ||
      rawResult.extraction_status ||
      null;
  } else {
    // Primitive format
    output.value = rawResult;
    output.rawValue = String(rawResult);
  }

  // Final sanitization
  if (output.value === undefined || output.value === null || output.value === "") {
     return null;
  }

  return output;
}

/**
 * Resolves a lease field across various fallback sources based on the provided mode.
 * @param {Object} lease - The lease object (ideally richly populated with joined extraction_data, approved_lease_abstracts, etc.)
 * @param {String} fieldKey - The canonical key for the field to extract.
 * @param {Object} options - Options { mode: 'display' | 'canonical' }
 */
export function resolveLeaseField(lease, fieldKey, options = {}) {
  const mode = options.mode || "display";
  const aliases = getFieldAliases(fieldKey);

  const fallbackHierarchy = [];

  if (mode === "display") {
    // Display mode: top-level columns first, then approved/extracted
    fallbackHierarchy.push(
      { path: "lease (top-level)", data: lease },
      { path: "approved_lease_abstracts.snapshot_json", data: lease?.approved_lease_abstracts?.snapshot_json },
      { path: "lease.abstract_snapshot", data: lease?.abstract_snapshot },
      { path: "lease.extraction_data.abstract", data: lease?.extraction_data?.abstract },
      { path: "lease.extraction_data.workflow_output.lease_fields", data: lease?.extraction_data?.workflow_output?.lease_fields },
      { path: "lease.extraction_data.workflow_output.expense_rules", data: lease?.extraction_data?.workflow_output?.expense_rules },
      { path: "lease.extraction_data.workflow_output.cam_rules", data: lease?.extraction_data?.workflow_output?.cam_rules },
      { path: "lease.extraction_data.workflow_output.lease_clauses", data: lease?.extraction_data?.workflow_output?.lease_clauses },
      { path: "lease.extraction_data.fields", data: lease?.extraction_data?.fields },
      { path: "lease.extraction_data.lease_fields", data: lease?.extraction_data?.lease_fields },
      { path: "lease.extracted_fields", data: lease?.extracted_fields },
      { path: "uploaded_files.reviewed_output", data: lease?.uploaded_files?.reviewed_output || lease?.uploaded_file?.reviewed_output },
      { path: "uploaded_files.ui_review_payload", data: lease?.uploaded_files?.ui_review_payload || lease?.uploaded_file?.ui_review_payload }
    );
  } else {
    // Canonical mode: approved snapshot first, then extracted workflow, then top-level
    fallbackHierarchy.push(
      { path: "approved_lease_abstracts.snapshot_json", data: lease?.approved_lease_abstracts?.snapshot_json },
      { path: "lease.abstract_snapshot", data: lease?.abstract_snapshot },
      { path: "lease.extraction_data.abstract", data: lease?.extraction_data?.abstract },
      { path: "lease.extraction_data.workflow_output.lease_fields", data: lease?.extraction_data?.workflow_output?.lease_fields },
      { path: "lease.extraction_data.workflow_output.expense_rules", data: lease?.extraction_data?.workflow_output?.expense_rules },
      { path: "lease.extraction_data.workflow_output.cam_rules", data: lease?.extraction_data?.workflow_output?.cam_rules },
      { path: "lease.extraction_data.workflow_output.lease_clauses", data: lease?.extraction_data?.workflow_output?.lease_clauses },
      { path: "lease.extraction_data.fields", data: lease?.extraction_data?.fields },
      { path: "lease.extraction_data.lease_fields", data: lease?.extraction_data?.lease_fields },
      { path: "lease.extracted_fields", data: lease?.extracted_fields },
      { path: "uploaded_files.reviewed_output", data: lease?.uploaded_files?.reviewed_output || lease?.uploaded_file?.reviewed_output },
      { path: "uploaded_files.ui_review_payload", data: lease?.uploaded_files?.ui_review_payload || lease?.uploaded_file?.ui_review_payload },
      { path: "lease (top-level)", data: lease }
    );
  }

  for (const { path, data } of fallbackHierarchy) {
    if (!data) continue;
    const rawResult = extractValueFromSource(data, aliases);
    const output = buildResolverOutput(rawResult, path);
    if (output && output.found) {
      return output;
    }
  }

  // Not found
  return {
    value: null,
    rawValue: null,
    normalizedValue: null,
    sourcePath: null,
    sourcePage: null,
    exactSourceText: null,
    confidence: null,
    reviewStatus: null,
    found: false
  };
}

export function resolveLeaseFields(lease, fieldKeys, options = {}) {
  const result = {};
  for (const key of fieldKeys) {
    result[key] = resolveLeaseField(lease, key, options);
  }
  return result;
}

export function getFieldSourcePath(lease, fieldKey, options = {}) {
  return resolveLeaseField(lease, fieldKey, options).sourcePath;
}
