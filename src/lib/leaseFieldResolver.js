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
  premises_address: ["premises_address", "property_address", "address", "demised_premises_address", "leased_premises_address", "shopping_center_address", "building_address", "premises_location", "property_location"],
  property_address: ["property_address", "address", "premises_address", "demised_premises_address", "leased_premises_address", "shopping_center_address", "building_address", "premises_location", "property_location"],
  suite_number: ["suite_number", "suite", "unit", "premises", "premises_suite", "unit_number", "space_number"],
  floor: ["floor", "floor_number"],
  square_footage: ["square_footage", "rentable_square_feet", "tenant_rsf", "tenant_rentable_area", "rsf", "premises_rsf", "rentable_area", "rentable_area_sqft", "leased_premises_area", "square_feet"],
  building_rsf: ["building_rsf", "building_rentable_area", "building_rentable_area_sf", "property_rentable_area_sf"],
  tenant_pro_rata_share: ["tenant_pro_rata_share", "pro_rata_share", "tenant_share_percent", "tenant_share", "tenant_pro_rata_share_building", "tenant_pro_rata_share_property"],
  premises_use: ["premises_use", "permitted_use", "use"],
  permitted_use: ["permitted_use", "premises_use", "use_clause", "use", "use_of_premises"],

  // Dates
  commencement_date: ["commencement_date", "lease_commencement_date", "start_date", "term_start", "commencement", "lease_start_date", "term_commencement_date", "beginning_of_term"],
  rent_commencement_date: ["rent_commencement_date", "rent_start_date", "rent_commencement"],
  expiration_date: ["expiration_date", "expiry_date", "term_end", "lease_expiration_date", "end_date", "termination_date", "end_of_term"],
  lease_date: ["lease_date", "execution_date", "date_of_lease"],
  lease_term: ["lease_term", "initial_term", "term", "term_months", "lease_term_months"],

  // Rent
  lease_type: ["lease_type", "expense_structure", "lease_structure", "rent_structure"],
  monthly_rent: ["monthly_rent", "base_rent_monthly", "monthly_base_rent", "current_monthly_rent", "base_rent"],
  annual_rent: ["annual_rent", "base_rent_annual", "annual_base_rent", "yearly_rent"],
  billing_frequency: ["billing_frequency", "rent_frequency", "payment_frequency"],
  security_deposit: ["security_deposit", "security_deposit_amount", "deposit"],
  free_rent_months: ["free_rent_months", "free_rent", "rent_abatement_months", "abated_rent_months"],
  escalation_rate: ["escalation_rate", "escalation_percent", "rent_escalation_percent", "annual_increase_percent"],
  escalation_type: ["escalation_type", "rent_escalation_type"],
  renewal_options: ["renewal_options", "renewal_option", "extension_options", "renewal_terms"],
  renewal_notice_days: ["renewal_notice_days", "renewal_notice_period_days", "renewal_notice"],
  holdover_multiplier: ["holdover_multiplier", "holdover_rent", "holdover_rate", "holdover_rent_multiplier"],

  // CAM / Expenses / Base year / Caps / Exclusions
  admin_fee_percent: ["admin_fee_percent", "administrative_fee_percent", "cam_admin_fee_percent", "adminFeePercent", "administrative fee", "admin fee", "administrative expenses not exceeding"],
  admin_fee_pct: ["admin_fee_pct", "admin_fee_percent", "administrative_fee_percent", "cam_admin_fee_percent"],
  management_fee_percent: ["management_fee_percent", "mgmt_fee_percent", "property_management_fee_percent", "management_fee_pct"],
  gross_up_percent: ["gross_up_percent", "gross_up_threshold_percent", "gross_up_threshold", "grossUpPercent", "gross-up", "gross up"],
  gross_up_threshold: ["gross_up_threshold", "gross_up_percent", "gross_up_threshold_percent", "gross_up_target_occupancy_pct"],
  gross_up_enabled: ["gross_up_enabled", "gross_up_applicable", "gross_up_allowed"],
  gross_up_clause: ["gross_up_clause", "gross_up", "gross_up_applicable"],
  cap_percent: ["cam_cap_percent", "cap_percent", "controllable_cap_percent", "controllable_cam_cap_percent", "controllable cap", "controllable expense cap"],
  cam_cap_pct: ["cam_cap_pct", "cam_cap_percent", "cap_percent", "controllable_cap_percent", "controllable_cam_cap_percent"],
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
  responsibility_taxes: ["responsibility_taxes", "tax_responsibility"],
  responsibility_insurance: ["responsibility_insurance", "insurance_responsibility"],
  responsibility_utilities: ["responsibility_utilities", "utilities_responsibility"],
  responsibility_repairs: ["responsibility_repairs", "maintenance_responsibility"],

  // Insurance
  commercial_general_liability: ["commercial_general_liability", "cgl", "general_liability"],
  property_insurance: ["property_insurance"],

  // Legal / Notices
  late_fee_percent: ["late_fee_percent", "late_fee", "late_charge_percent"],
  default_interest_percent: ["default_interest_percent", "default_interest", "default_rate"],
  assignment_rights: ["assignment_rights", "assignment_provisions", "landlord_consent"]
};

export function getFieldAliases(fieldKey) {
  const normalized = normalizeLeaseFieldKey(fieldKey);
  const aliases = FIELD_ALIASES[normalized] || [];
  return [...new Set([normalized, ...aliases])].map(normalizeLeaseFieldKey);
}

function extractValueFromSource(source, aliases) {
  if (!source || typeof source !== "object") return null;

  if (Array.isArray(source)) {
    const normalizedCandidates = new Set(aliases.map(normalizeLeaseFieldKey));
    for (const item of source) {
      if (!item || typeof item !== "object") continue;
      const itemKeys = [
        item.field_key,
        item.key,
        item.name,
        item.item_type,
        item.category,
        item.subcategory,
      ].filter(Boolean).map(normalizeLeaseFieldKey);
      if (!itemKeys.some((key) => normalizedCandidates.has(key))) continue;
      return {
        value: item.normalized_value ?? item.value ?? item.raw_value ?? null,
        raw_value: item.raw_value ?? item.rawValue ?? item.value ?? null,
        source_page: item.source_page ?? item.page_number ?? item.page ?? null,
        source_text: item.source_text ?? item.exact_source_text ?? item.source_clause ?? null,
        exact_source_text: item.exact_source_text ?? item.source_text ?? item.source_clause ?? null,
        source_clause: item.source_clause ?? item.source_text ?? item.exact_source_text ?? null,
        confidence_score: item.confidence_score ?? item.confidence ?? null,
        confidence: item.confidence ?? item.confidence_score ?? null,
        extraction_status: item.extraction_status ?? item.review_status ?? null,
        evidence_type: item.evidence_type ?? item.evidenceType ?? null,
        source_text_quality: item.source_text_quality ?? item.sourceTextQuality ?? null,
        source_field_keys: item.source_field_keys ?? item.sourceFieldKeys ?? null,
        derivation_trace: item.derivation_trace ?? item.derivationTrace ?? null,
        requires_review: item.requires_review ?? item.requiresReview ?? null,
        approval_blocking_reason: item.approval_blocking_reason ?? item.approvalBlockingReason ?? null,
      };
    }
    return null;
  }

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

// Pattern that matches a bare snake_case/identifier string with no spaces or
// digits — e.g. "unit_number" or "tenant_name". These are never real lease
// text; they leak in when a downstream writer accidentally persists a field
// KEY where a clause snippet was expected. Used to scrub evidence before it
// reaches the UI.
const FIELD_KEY_LOOKING_PATTERN = /^[a-z][a-z0-9_]*$/;
function looksLikeFieldKey(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 60) return false;
  return FIELD_KEY_LOOKING_PATTERN.test(trimmed);
}
function scrubEvidenceText(text) {
  if (text == null) return null;
  const trimmed = String(text).trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) return null;
  if (looksLikeFieldKey(trimmed)) return null;
  if (lower.includes("derived from")) return null;
  if (/^[a-z][a-z0-9_]*_[a-z0-9_]*\s*:\s*/i.test(trimmed)) return null;
  if (/^(llm extracted|extracted|manual_review|not found|unknown|n\/a|na|null)$/i.test(trimmed)) return null;
  return trimmed;
}

// UI/page/fallback labels that have historically leaked into lease fields
// when extraction returned no structured data. Treating these as null at
// the resolver layer means even if a downstream writer regresses, the UI
// won't display them as extracted lease data.
const FALLBACK_VALUE_SENTINELS = new Set([
  "lease review draft",
  "lease review",
  "draft",
  "untitled",
  "untitled draft",
  "upload lease",
  "back to leases",
  "cre platform",
  "budgeting & cam",
  "budgeting and cam",
  "unknown type",
  "unknown",
  "review expense rules",
  "request signature",
]);
function isFallbackPlaceholderValue(value) {
  if (typeof value !== "string") return false;
  const lower = value.trim().toLowerCase();
  if (!lower) return false;
  return FALLBACK_VALUE_SENTINELS.has(lower);
}

function cleanPartyAddressValue(fieldKey, value) {
  const normalizedKey = normalizeLeaseFieldKey(fieldKey);
  if (!["landlord_address", "tenant_address"].includes(normalizedKey)) return value;
  let text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return value;

  const ownLabel = normalizedKey === "landlord_address"
    ? /(?:^|\b)(?:\d+\.\s*)?(?:address\s+of\s+landlord|landlord(?:'s)?\s+address)\s*[:;-]?\s*/i
    : /(?:^|\b)(?:\d+\.\s*)?(?:address\s+of\s+tenant|tenant(?:'s)?\s+address)\s*[:;-]?\s*/i;
  const ownMatch = text.match(ownLabel);
  if (ownMatch?.index != null) {
    text = text.slice(ownMatch.index + ownMatch[0].length).trim();
  }

  const stopPatterns = normalizedKey === "landlord_address"
    ? [
        /\b\d+\.\s*(?:tenant|lessee)\b\s*[:;-]?/i,
        /\b(?:tenant|lessee)\b\s*[:;-]/i,
        /\b(?:address\s+of\s+tenant|tenant(?:'s)?\s+address)\b/i,
        /\btenant_contact_/i,
      ]
    : [
        /\b\d+\.\s*(?:landlord|lessor)\b\s*[:;-]?/i,
        /\b(?:landlord|lessor)\b\s*[:;-]/i,
        /\b(?:address\s+of\s+landlord|landlord(?:'s)?\s+address)\b/i,
        /\blandlord_contact_/i,
      ];

  let stopAt = text.length;
  for (const pattern of stopPatterns) {
    const match = text.match(pattern);
    if (match?.index != null && match.index > 4) stopAt = Math.min(stopAt, match.index);
  }

  text = text.slice(0, stopAt).trim()
    .replace(/^(?:\d+\.\s*)?(?:address\s+of\s+(?:landlord|tenant)|landlord(?:'s)?\s+address|tenant(?:'s)?\s+address)\s*[:;-]?\s*/i, "")
    .replace(/\s+\d+\.\s*$/g, "")
    .replace(/[;,\s]+$/g, "")
    .trim();

  return text.length >= 8 ? text : value;
}

const ENTITY_FIELDS = new Set([
  "tenant_name", "landlord_name", "assignor_name", "assignee_name", 
  "guarantor_name", "owner_name", "property_manager", 
  "tenant_contact_name", "landlord_contact_name", 
  "tenant_signatory_name", "landlord_signatory_name", "broker_name"
]);

function isValidEntityField(fieldKey, value, sourceText) {
  if (!fieldKey || !ENTITY_FIELDS.has(normalizeLeaseFieldKey(fieldKey))) return true;
  
  const valStr = String(value || "").trim();
  if (!valStr) return false;
  
  const srcStr = String(sourceText || "").toLowerCase();
  const valLower = valStr.toLowerCase();
  const stopwordNameValues = new Set([
    "and", "or", "in", "of", "the", "a", "an", "by", "to", "for", "with", "as",
    "tenant", "landlord", "assignee", "assignor", "subtenant", "guarantor",
    "owner", "manager", "broker", "agent", "lessor", "lessee",
  ]);

  // 1. Plausible name checks on the value itself
  if (valStr.length > 120) return false;
  if (valStr.length < 2) return false;
  if (stopwordNameValues.has(valLower)) return false;
  if (/^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}$/i.test(valStr)) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(valStr) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(valStr)) return false;
  if (/^\+?\d?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/.test(valStr)) return false;
  if (/\b(?:assumes?\s+in\s+full|obligations?\s+of|transfer\s+shall|prior\s+written\s+consent)\b/i.test(valStr)) return false;
  if (/^(or|and|in|of|the|by)\s+/i.test(valStr)) return false;
  if (/\b(may|shall|without|provided|subject to|consent|transfer|assign|sublet|warrants?|represents?|connection with|real estate broker|negotiation|brokerage fees?)\b/i.test(valLower)) return false;
  if (/[.?!](?:\s|$)|(?:^|\s)(?:Section\s+)?\d+\.\d+(?:\s|$)/i.test(valStr)) return false;

  // 2. Reject if source text or value contains clause/action language
  const clausePattern = /\b(tenant may assign|assign this lease|sublet|subtenant|assignee or subtenant|permitted transfer|affiliate|successor by merger|sale of substantially all assets|prior written consent|transfer to an affiliate|landlord shall not unreasonably withhold|consent|transfer premium|brokerage fees?|real estate broker|negotiation except as set forth)\b/i;
  
  if (clausePattern.test(srcStr) || clausePattern.test(valLower)) {
    return false;
  }

  return true;
}

function hasHardValidationError(errors = []) {
  return errors.some((error) =>
    /failed_validation|not_specific|looks_like_clause|without_.*evidence|not_core|invalid|not_meaningful|not_identifier|unknown|without_context|without_.*source/i.test(String(error || "")),
  );
}

function sourceSupportsValue(value, sourceText) {
  const val = String(value ?? "").trim();
  const src = String(sourceText ?? "").trim();
  if (!val || !src) return false;
  const normalizedValue = val.toLowerCase().replace(/[$,]/g, "").replace(/\s+/g, " ");
  const normalizedSource = src.toLowerCase().replace(/[$,]/g, "").replace(/\s+/g, " ");
  if (normalizedSource.includes(normalizedValue)) return true;
  if (/^\d+(?:\.\d+)?$/.test(normalizedValue) && normalizedSource.includes(normalizedValue)) return true;
  return false;
}

function invalidResolvedField(fieldKey, output) {
  const key = normalizeLeaseFieldKey(fieldKey);
  const valueText = String(output?.value ?? "").trim();
  const sourceText = output?.exactSourceText || output?.sourceClause || output?.rawValue || "";
  const validationErrors = Array.isArray(output?.validationErrors) ? output.validationErrors : [];
  if (hasHardValidationError(validationErrors)) return true;

  if (["property_name", "center_name", "building_name"].includes(key)) {
    if (!valueText || /^(?:tenant has|landlord has|a shopping|shopping|center|building|premises)$/i.test(valueText)) return true;
    if (/\b(?:tenant|landlord)\s+(?:has|shall|may|will|agrees?|acknowledges?)\b/i.test(valueText)) return true;
    if (/\b(?:premises|lease|article|section|obligations?|transfer|consent|hereby)\b/i.test(valueText)) return true;
  }

  if (key === "permitted_use") {
    if (!valueText || valueText.length > 120) return true;
    if (/\b(?:assignment|subletting|prior written consent|common areas|parking|display of merchandise|landlord consent)\b/i.test(valueText)) return true;
  }

  if (key === "lease_term") {
    const hasTrace = Boolean(output?.derivationTrace || (Array.isArray(output?.sourceFieldKeys) && output.sourceFieldKeys.length > 0));
    const sourceHasTermWords = /\b(?:year\s*to\s*year|month|months|year|years|term|commencement|expiration)\b/i.test(String(sourceText));
    if (/^\d{1,3}$/.test(valueText) && !hasTrace && !sourceHasTermWords) return true;
  }

  if (["annual_rent", "rent_per_sf", "base_rent_psf", "base_rent_per_sf", "billing_frequency"].includes(key)) {
    const isDerived = /derived/i.test(String(output?.evidenceType || output?.reviewStatus || ""));
    if (isDerived && !output?.derivationTrace && (!Array.isArray(output?.sourceFieldKeys) || output.sourceFieldKeys.length === 0)) return true;
  }

  if (["cam_amount", "fixed_cam_amount"].includes(key) && /^\$?\s*0(?:\.00)?$/.test(valueText)) {
    if (!/\b(?:\$\s*0|zero|no separate cam|included in (?:base )?rent|full service|gross lease)\b/i.test(String(sourceText))) return true;
  }

  if (["annual_rent", "monthly_rent", "base_rent_monthly", "security_deposit_amount"].includes(key)) {
    const source = String(sourceText || "");
    if (valueText && source && !sourceSupportsValue(valueText, source) && !output?.derivationTrace) return true;
  }

  return false;
}

function missingResolverOutput() {
  return {
    value: null,
    rawValue: null,
    normalizedValue: null,
    sourcePath: null,
    sourcePage: null,
    exactSourceText: null,
    sourceClause: null,
    confidence: null,
    reviewStatus: null,
    evidenceType: null,
    sourceTextQuality: null,
    sourceFieldKeys: [],
    derivationTrace: null,
    requiresReview: false,
    approvalBlockingReason: null,
    validationErrors: [],
    found: false
  };
}

function isAuthoritativeExtractionSource(path) {
  const text = String(path || "");
  return /workflow_output|uf\.records\[0\]|extraction_data\.(?:fields|lease_fields)|uploaded_files\.reviewed_output|lease\.extracted_fields/.test(text)
    && !/lease \(top-level\)|approved_lease_abstracts|abstract_snapshot|extraction_data\.abstract/.test(text);
}

function buildResolverOutput(rawResult, sourcePath, fieldKey) {
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
    sourceClause: null,
    confidence: null,
    reviewStatus: null,
    evidenceType: null,
    sourceTextQuality: null,
    sourceFieldKeys: [],
    derivationTrace: null,
    requiresReview: false,
    approvalBlockingReason: null,
    validationErrors: [],
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
    const normalizedCandidate =
      rawResult.normalized_value !== undefined
        ? rawResult.normalized_value
        : rawResult.normalizedValue !== undefined
          ? rawResult.normalizedValue
          : rawResult.normalized_meaning !== undefined
            ? rawResult.normalized_meaning
            : rawResult.normalizedMeaning !== undefined
              ? rawResult.normalizedMeaning
              : null;
    output.value =
      normalizedCandidate !== null && normalizedCandidate !== ""
        ? normalizedCandidate
        : rawResult.value !== undefined
          ? rawResult.value
          : rawResult.raw_value !== undefined
            ? rawResult.raw_value
            : rawResult.rawValue !== undefined
              ? rawResult.rawValue
              : rawResult.raw !== undefined
                ? rawResult.raw
                : null;
    // Defensive: strip UI/fallback sentinel strings ("Lease Review Draft",
    // "Untitled", etc.) at the resolver layer so even if a downstream
    // writer regresses, the value never displays as extracted lease data.
    if (isFallbackPlaceholderValue(output.value)) {
      output.value = null;
    }
    const candidateRaw =
      rawResult.raw_value ||
      rawResult.rawValue ||
      rawResult.exact_source_text ||
      rawResult.source_text_exact ||
      rawResult.exact_text ||
      rawResult.clause_text ||
      rawResult.source_text ||
      rawResult.source_clause ||
      rawResult.snippet ||
      String(rawResult.value || "");
    output.rawValue = scrubEvidenceText(candidateRaw) ?? (output.value != null ? String(output.value) : null);
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
    const candidateExact =
      rawResult.exact_source_text ||
      rawResult.exactSourceText ||
      rawResult.source_text_exact ||
      rawResult.exact_text ||
      rawResult.clause_text ||
      rawResult.source_clause ||
      rawResult.source_text ||
      rawResult.snippet ||
      rawResult.evidence?.source_clause ||
      rawResult.evidence?.source_text ||
      rawResult.evidence?.exact_source_text ||
      null;
    output.exactSourceText = scrubEvidenceText(candidateExact);
    output.sourceClause = scrubEvidenceText(
      rawResult.source_clause ||
      rawResult.sourceClause ||
      rawResult.evidence?.source_clause ||
      null,
    );
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
    output.evidenceType =
      rawResult.evidence_type ||
      rawResult.evidenceType ||
      rawResult.evidence?.evidence_type ||
      null;
    output.sourceTextQuality =
      rawResult.source_text_quality ||
      rawResult.sourceTextQuality ||
      rawResult.evidence?.source_text_quality ||
      null;
    const sourceFieldKeys =
      rawResult.source_field_keys ||
      rawResult.sourceFieldKeys ||
      rawResult.evidence?.source_field_keys ||
      [];
    output.sourceFieldKeys = Array.isArray(sourceFieldKeys) ? sourceFieldKeys.filter(Boolean) : [];
    output.derivationTrace =
      rawResult.derivation_trace ||
      rawResult.derivationTrace ||
      rawResult.evidence?.derivation_trace ||
      null;
    output.requiresReview = Boolean(rawResult.requires_review ?? rawResult.requiresReview ?? false);
    const rawValidationErrors =
      rawResult.validation_errors ||
      rawResult.validationErrors ||
      rawResult.evidence?.validation_errors ||
      rawResult.evidence?.validationErrors ||
      [];
    output.validationErrors = Array.isArray(rawValidationErrors) ? rawValidationErrors.filter(Boolean) : [];
    output.approvalBlockingReason =
      rawResult.approval_blocking_reason ||
      rawResult.approvalBlockingReason ||
      null;
  } else {
    // Primitive format
    output.value = isFallbackPlaceholderValue(rawResult) ? null : rawResult;
    output.rawValue = output.value != null ? String(output.value) : null;
  }

  // Final sanitization — null/empty values produce no resolver output.
  if (output.value === undefined || output.value === null || output.value === "") {
     return null;
  }
  output.value = cleanPartyAddressValue(fieldKey, output.value);
  output.rawValue = cleanPartyAddressValue(fieldKey, output.rawValue);

  // Enforce entity and field-specific validation. Invalid extracted values stay
  // visible in review rows, but resolver consumers such as headers/summary cards
  // must not treat them as trusted normalized values.
  if (!isValidEntityField(fieldKey, output.value, output.exactSourceText || output.rawValue)) {
    return null;
  }
  if (invalidResolvedField(fieldKey, output)) {
    return null;
  }

  if (["suite_number", "unit_number", "floor"].includes(normalizeLeaseFieldKey(fieldKey))) {
    const lower = String(output.value || "").trim().toLowerCase();
    const fragments = new Set([
      "in", "at", "of", "the", "a", "an", "on", "by", "to", "for",
      "with", "and", "or", "is", "as", "be", "not", "no", "space",
      "suite", "unit", "premises",
    ]);
    if (fragments.has(lower)) return null;
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

  // If this is a full lease (not an assignment), suppress dynamic assignee rows unless source is an explicit label
  if (fieldKey === "assignee_name" && String(lease?.document_subtype || "").toLowerCase() !== "assignment") {
      // We will rely on isValidEntityField to aggressively drop clause language, 
      // but we can also add a runtime check here if we needed to fully drop the fallback search.
  }

  const fallbackHierarchy = [];

  // Resolve the uploaded-file payload once so both mode branches can share it.
  const ufPayload =
    lease?.uploaded_files?.ui_review_payload ||
    lease?.uploaded_file?.ui_review_payload ||
    null;
  const ufRecord0 = ufPayload?.records?.[0] ?? null;

  if (mode === "display") {
    // Display mode is the reviewer surface: trust the workflow evidence payload
    // before stale top-level lease columns. Top-level columns remain only as a
    // legacy fallback when no workflow payload exists.
    fallbackHierarchy.push(
      { path: "lease.extraction_data.workflow_output.lease_fields", data: lease?.extraction_data?.workflow_output?.lease_fields },
      { path: "uf.records[0].workflow_output.lease_fields", data: ufRecord0?.workflow_output?.lease_fields },
      { path: "uf.records[0].standard_fields", data: ufRecord0?.standard_fields },
      { path: "uf.records[0].fields", data: ufRecord0?.fields },
      { path: "lease.extraction_data.fields", data: lease?.extraction_data?.fields },
      { path: "lease.extraction_data.lease_fields", data: lease?.extraction_data?.lease_fields },
      { path: "uploaded_files.reviewed_output", data: lease?.uploaded_files?.reviewed_output || lease?.uploaded_file?.reviewed_output },
      { path: "lease.extraction_data.workflow_output.expense_rules", data: lease?.extraction_data?.workflow_output?.expense_rules },
      { path: "lease.extraction_data.workflow_output.cam_rules", data: lease?.extraction_data?.workflow_output?.cam_rules },
      { path: "lease.extraction_data.workflow_output.lease_clauses", data: lease?.extraction_data?.workflow_output?.lease_clauses },
      { path: "lease.extraction_data.workflow_output.extracted_document_items", data: lease?.extraction_data?.workflow_output?.extracted_document_items },
      { path: "lease.extraction_data.extracted_document_items", data: lease?.extraction_data?.extracted_document_items },
      { path: "lease.extracted_fields", data: lease?.extracted_fields },
      { path: "uf.records[0].custom_fields", data: ufRecord0?.custom_fields },
      { path: "uf.records[0]", data: ufRecord0 },
      { path: "uploaded_files.ui_review_payload", data: ufPayload },
      { path: "approved_lease_abstracts.snapshot_json", data: lease?.approved_lease_abstracts?.snapshot_json },
      { path: "lease.abstract_snapshot", data: lease?.abstract_snapshot },
      { path: "lease.extraction_data.abstract", data: lease?.extraction_data?.abstract },
      { path: "lease (top-level)", data: lease },
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
      { path: "lease.extraction_data.workflow_output.extracted_document_items", data: lease?.extraction_data?.workflow_output?.extracted_document_items },
      { path: "lease.extraction_data.extracted_document_items", data: lease?.extraction_data?.extracted_document_items },
      { path: "lease.extracted_fields", data: lease?.extracted_fields },
      { path: "uploaded_files.reviewed_output", data: lease?.uploaded_files?.reviewed_output || lease?.uploaded_file?.reviewed_output },
      { path: "uf.records[0].workflow_output.lease_fields", data: ufRecord0?.workflow_output?.lease_fields },
      { path: "uf.records[0].fields", data: ufRecord0?.fields },
      { path: "uf.records[0].standard_fields", data: ufRecord0?.standard_fields },
      { path: "uf.records[0].custom_fields", data: ufRecord0?.custom_fields },
      { path: "uf.records[0]", data: ufRecord0 },
      { path: "uploaded_files.ui_review_payload", data: ufPayload },
      { path: "lease (top-level)", data: lease },
    );
  }

  let firstFound = null;
  let rejectedAuthoritativeCandidate = false;
  for (const { path, data } of fallbackHierarchy) {
    if (!data) continue;
    const rawResult = extractValueFromSource(data, aliases);
    const output = buildResolverOutput(rawResult, path, fieldKey);
    if (!output && rawResult !== null && rawResult !== undefined && rawResult !== "" && isAuthoritativeExtractionSource(path)) {
      rejectedAuthoritativeCandidate = true;
      continue;
    }
    if (output && output.found) {
      const hasRealEvidence = Boolean(output.exactSourceText || output.sourcePage);
      if (hasRealEvidence) return output;
      if (!rejectedAuthoritativeCandidate && !firstFound) firstFound = output;
    }
  }

  if (firstFound) return firstFound;
  if (rejectedAuthoritativeCandidate) return missingResolverOutput();

  // Not found
  return missingResolverOutput();
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
