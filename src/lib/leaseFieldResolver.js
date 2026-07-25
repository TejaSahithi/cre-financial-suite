export function normalizeLeaseFieldKey(key) {
  if (!key) return "";
  return String(key).trim().toLowerCase().replace(/[\s.-]+/g, "_");
}

// Exported (in addition to the normal getFieldAliases lookup) so external
// auditors -- e.g. the P2.1 claims-concept-registry cross-check test -- can
// enumerate every entry directly, rather than only being able to query one
// key at a time.
export const FIELD_ALIASES = {
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
  // Reverse aliases for the two OR-alternate pairs above. Without these,
  // getFieldAliases("tax_responsibility") / getFieldAliases("insurance_responsibility")
  // normalize to themselves with no FIELD_ALIASES entry, so they never see
  // data stored under responsibility_taxes/responsibility_insurance — even
  // though the reverse direction already worked. Both LEASE_SCHEMA fields in
  // each pair are independently extractable (field-contract.ts), so both
  // review-table rows need to read either name.
  tax_responsibility: ["tax_responsibility", "responsibility_taxes"],
  insurance_responsibility: ["insurance_responsibility", "responsibility_insurance"],

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
  if (!text) return null;

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

  const hasStreetShape =
    /\b\d{1,6}\s+/.test(text) &&
    /\b(?:road|rd\.?|street|st\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?|suite|ste\.?|knoxville|tn|[A-Z]{2}\s+\d{5})\b/i.test(text);

  return text.length >= 8 && hasStreetShape ? text : null;
}

const COMPANY_ENTITY_PATTERN = /\b([A-Z0-9][A-Za-z0-9&.'\-\s,]{1,140}?\b(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|LLP|Realty)\b)/gi;
const STREET_ADDRESS_PATTERN = /\b\d{1,6}\s+[A-Za-z0-9.'#\-\s]+?\s+(?:Road|Rd\.?|Street|St\.?|Avenue|Ave\.?|Lane|Ln\.?|Drive|Dr\.?|Boulevard|Blvd\.?)\b(?:,?\s*(?:Suite|Ste\.?|#)\s*[A-Za-z0-9-]+)?(?:,?\s+[A-Za-z.'\-\s]+,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)?/i;

function compactEvidenceText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanRecoveredEntityCandidate(value, fieldKey) {
  let text = compactEvidenceText(value)
    .replace(/^\s*(?:\d+\.\s*)?(?:tenant|landlord|lessor|lessee|broker|brokers?)\s*[:;-]?\s*/i, "")
    .replace(/\(\s*["']?(?:tenant|landlord|lessor|lessee|broker)["']?\s*\)/gi, "")
    .replace(/\b(?:phone|tel|telephone|email)\b[\s\S]*$/i, "")
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b.*$/i, "")
    .replace(/[.,;:\s]+$/g, "")
    .trim();

  if (normalizeLeaseFieldKey(fieldKey) === "tenant_name") {
    text = text.replace(/\s+-\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3}\b[\s\S]*$/i, "").trim();
  }

  return text;
}

function extractCompanyCandidatesFromEvidence(text) {
  const seen = new Set();
  const candidates = [];
  COMPANY_ENTITY_PATTERN.lastIndex = 0;
  for (const match of compactEvidenceText(text).matchAll(COMPANY_ENTITY_PATTERN)) {
    const value = cleanRecoveredEntityCandidate(match[1], "tenant_name");
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ value, index: match.index ?? 0 });
  }
  return candidates;
}

function recoverEntityValueFromEvidence(fieldKey, output) {
  const key = normalizeLeaseFieldKey(fieldKey);
  if (!["tenant_name", "landlord_name", "broker_name"].includes(key)) return null;
  const evidence = compactEvidenceText([output.exactSourceText, output.sourceClause, output.rawValue].filter(Boolean).join(" "));
  if (!evidence) return null;

  let match = null;
  if (key === "landlord_name") {
    match = evidence.match(/([A-Z0-9][A-Za-z0-9&.'\-\s,]{1,140}?\b(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|LLP|Realty)\b)\s*\(\s*["']?(?:Landlord|Lessor)["']?\s*\)/i);
  } else if (key === "tenant_name") {
    match = evidence.match(/([A-Z0-9][A-Za-z0-9&.'\-\s,]{1,140}?\b(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|LLP|Realty)\b)(?:\s+-\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})?\s*\(\s*["']?(?:Tenant|Lessee)["']?\s*\)/i);
  } else {
    match = evidence.match(/\bBrokers?\s*[:;-]\s*([A-Z0-9][A-Za-z0-9&.'\-\s,]{1,140}?\b(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|LLP|Realty)\b)/i);
  }

  let candidate = cleanRecoveredEntityCandidate(match?.[1], key);
  if (!candidate) {
    const companies = extractCompanyCandidatesFromEvidence(evidence);
    if (key === "landlord_name") candidate = companies[0]?.value || null;
    if (key === "tenant_name") candidate = companies[1]?.value || companies[0]?.value || null;
    if (key === "broker_name") candidate = companies.find((company) => /realty|broker/i.test(company.value))?.value || companies[0]?.value || null;
  }

  if (!candidate || !isValidEntityField(key, candidate, evidence)) return null;
  return { value: candidate, sourceText: evidence };
}

function recoverAddressValueFromEvidence(fieldKey, output) {
  const key = normalizeLeaseFieldKey(fieldKey);
  if (!["landlord_address", "tenant_address"].includes(key)) return null;
  const evidence = compactEvidenceText([output.exactSourceText, output.sourceClause, output.rawValue].filter(Boolean).join(" "));
  if (!evidence) return null;
  const label = key === "landlord_address"
    ? /(?:address\s+of\s+landlord|landlord(?:'s)?\s+address)\s*[:;-]?\s*([\s\S]{0,220})/i
    : /(?:address\s+of\s+tenant|tenant(?:'s)?\s+address)\s*[:;-]?\s*([\s\S]{0,220})/i;
  const labelled = evidence.match(label)?.[1] || "";
  const fromLabel = labelled.match(STREET_ADDRESS_PATTERN)?.[0];
  const fallback = evidence.match(STREET_ADDRESS_PATTERN)?.[0];
  const candidate = cleanPartyAddressValue(key, fromLabel || fallback || "");
  return candidate ? { value: candidate, sourceText: evidence } : null;
}

function recoverPermittedUseValueFromEvidence(output) {
  const evidence = compactEvidenceText([output.exactSourceText, output.sourceClause, output.rawValue].filter(Boolean).join(" "));
  if (!evidence) return null;
  const match = evidence.match(/\b(?:permitted\s+use|use)\s*[:;-]\s*([\s\S]{1,160}?)(?=\s+(?:\d{1,2}\.\s*)?(?:brokers?|security\s+deposit|rent|lease\s+term|commencement|expiration)\b|$)/i);
  const value = compactEvidenceText(match?.[1])
    .replace(/[.;,\s]+$/g, "")
    .trim();
  if (!value || value.length > 80) return null;
  if (/\b(?:summary of basic lease information|landlord|tenant|lease|premises|consent|assignment|subletting)\b/i.test(value)) return null;
  return { value, sourceText: match?.[0] || evidence };
}

function clearResolvedValidationErrors(output) {
  output.validationErrors = (output.validationErrors || []).filter((error) =>
    !/failed_validation|required field was not found|no valid supporting source|not_specific|looks_like_clause|without_.*source/i.test(String(error || "")),
  );
}

function markRecoveredOutput(output, recovered) {
  output.value = recovered.value;
  output.normalizedValue = recovered.value;
  output.rawValue = String(recovered.value);
  output.exactSourceText = scrubEvidenceText(recovered.sourceText) || output.exactSourceText;
  output.sourceClause = output.sourceClause || output.exactSourceText;
  output.evidenceType = "extracted";
  output.reviewStatus = output.reviewStatus || "extracted";
  output.sourceTextQuality = "exact";
  output.requiresReview = false;
  output.approvalBlockingReason = null;
  clearResolvedValidationErrors(output);
}

function maybeRescueResolverOutput(fieldKey, output) {
  const key = normalizeLeaseFieldKey(fieldKey);
  const hardInvalid = hasHardValidationError(output.validationErrors) || invalidResolvedField(fieldKey, output);
  const missingValue = output.value === undefined || output.value === null || output.value === "";
  const entityInvalid = ENTITY_FIELDS.has(key) && !isValidEntityField(key, output.value, output.exactSourceText || output.rawValue);

  let recovered = null;
  if (["tenant_name", "landlord_name", "broker_name"].includes(key) && (missingValue || hardInvalid || entityInvalid)) {
    recovered = recoverEntityValueFromEvidence(key, output);
  } else if (["landlord_address", "tenant_address"].includes(key) && (missingValue || hardInvalid || !cleanPartyAddressValue(key, output.value))) {
    recovered = recoverAddressValueFromEvidence(key, output);
  } else if (key === "permitted_use" && (missingValue || hardInvalid || invalidResolvedField(fieldKey, output))) {
    recovered = recoverPermittedUseValueFromEvidence(output);
  }

  if (recovered) markRecoveredOutput(output, recovered);
  return output;
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

  if (["landlord_consent", "landlord_consent_for_transfer", "assignment_provisions"].includes(key)) {
    const source = String(sourceText || "");
    if (/\b(?:in\s+the\s+event|if|when)\s+the\s+landlord\s+shall\s+consent\b|\bif\s+landlord\s+consents?\b|\bsubject\s+to\s+landlord'?s\s+consent\b/i.test(source)
      && /\b(?:shall|must)\s+consent\b/i.test(valueText)) {
      return true;
    }
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
      rawResult.canonical_status ||
      rawResult.canonicalStatus ||
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
    output.canonicalStatus = rawResult.canonical_status ?? rawResult.canonicalStatus ?? rawResult.evidence?.canonical_status ?? null;
    output.resolutionState = rawResult.resolution_state ?? rawResult.resolutionState ?? rawResult.evidence?.resolution_state ?? null;
    output.conflictCandidateIds = rawResult.conflict_candidate_ids ?? rawResult.conflictCandidateIds ?? rawResult.evidence?.conflict_candidate_ids ?? [];
    output.decision = rawResult.decision ?? rawResult.evidence?.decision ?? null;
    output.requiresReview = Boolean(rawResult.requires_review ?? rawResult.requiresReview ?? rawResult.evidence?.requires_review ?? false);
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

  // Final sanitization. Try evidence rescue before declaring a value missing:
  // OCR often captures the right party in source text while the normalized value
  // is a summary-row number or neighboring label.
  maybeRescueResolverOutput(fieldKey, output);
  output.value = cleanPartyAddressValue(fieldKey, output.value);
  output.rawValue = cleanPartyAddressValue(fieldKey, output.rawValue);
  maybeRescueResolverOutput(fieldKey, output);

  if (output.value === undefined || output.value === null || output.value === "") {
     return null;
  }
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

  // §1/§2 fallback rendering cascade: uploaded_files.normalized_output.rows[0]
  // and .parsed_data[0] are plain flat {fieldKey: value} objects — durable as
  // soon as the pipeline's fast minimal persist lands, even before
  // ui_review_payload's evidence enrichment finishes. extractionDebug's
  // merged_field_sources/llm_returned_field_details carry per-field
  // source_page/source_text/confidence computed during extraction itself
  // (always present) but were previously never consulted anywhere in the
  // frontend — surfaced here as a last-resort, richly-annotated fallback so
  // a field can still show its evidence even if it never made it onto
  // ui_review_payload's own field-level `evidence` key.
  const uploadedFileForFallback = lease?.uploaded_files || lease?.uploaded_file || null;
  const normalizedOutputRow0 = Array.isArray(uploadedFileForFallback?.normalized_output?.rows)
    ? uploadedFileForFallback.normalized_output.rows[0]
    : null;
  const parsedDataRow0 = Array.isArray(uploadedFileForFallback?.parsed_data)
    ? uploadedFileForFallback.parsed_data[0]
    : null;
  const extractionDebugForFallback = ufPayload?.metadata?.extractionDebug ?? {};
  const debugEvidenceEntries = [
    ...Object.entries(extractionDebugForFallback.merged_field_sources ?? {}),
    ...Object.entries(extractionDebugForFallback.llm_returned_field_details ?? {}),
  ].map(([field_key, v]) => ({ field_key, ...v }));

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
      { path: "uploaded_files.normalized_output.rows[0]", data: normalizedOutputRow0 },
      { path: "uploaded_files.parsed_data[0]", data: parsedDataRow0 },
      { path: "uploaded_files.ui_review_payload.metadata.extractionDebug", data: debugEvidenceEntries },
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

// ── Micro-step 0: display-resolution provenance (additive, debug-only) ─────
// Everything below is new, read-only, and does not change resolveLeaseField's
// behavior, return shape, or fallback order in any way — it answers "why is
// THIS particular value displayed?" (as distinct from fact-field-mapper.ts's
// FieldSelectionProvenance, which answers "why did this candidate win on the
// backend?"). See LEASE_EXTRACTION_UI_PIPELINE_AUDIT.md Section 16.3.

// Mirrors resolveLeaseField's own two fallbackHierarchy orderings (lines
// ~791-840 above) so a resolved `sourcePath` string can be turned into a
// position index for display. Duplicated rather than refactoring
// resolveLeaseField to expose it, to keep this Micro-step's change to that
// function at zero — if resolveLeaseField's hierarchy ever changes, these
// two lists need updating too; a mismatch only degrades
// frontendFallbackIndex to -1 (unknown position), it cannot affect which
// value is displayed.
const DISPLAY_FALLBACK_PATHS = [
  "lease.extraction_data.workflow_output.lease_fields",
  "uf.records[0].workflow_output.lease_fields",
  "uf.records[0].standard_fields",
  "uf.records[0].fields",
  "lease.extraction_data.fields",
  "lease.extraction_data.lease_fields",
  "uploaded_files.reviewed_output",
  "lease.extraction_data.workflow_output.expense_rules",
  "lease.extraction_data.workflow_output.cam_rules",
  "lease.extraction_data.workflow_output.lease_clauses",
  "lease.extraction_data.workflow_output.extracted_document_items",
  "lease.extraction_data.extracted_document_items",
  "lease.extracted_fields",
  "uf.records[0].custom_fields",
  "uf.records[0]",
  "uploaded_files.ui_review_payload",
  "approved_lease_abstracts.snapshot_json",
  "lease.abstract_snapshot",
  "lease.extraction_data.abstract",
  "lease (top-level)",
];
const CANONICAL_FALLBACK_PATHS = [
  "approved_lease_abstracts.snapshot_json",
  "lease.abstract_snapshot",
  "lease.extraction_data.abstract",
  "lease.extraction_data.workflow_output.lease_fields",
  "lease.extraction_data.workflow_output.expense_rules",
  "lease.extraction_data.workflow_output.cam_rules",
  "lease.extraction_data.workflow_output.lease_clauses",
  "lease.extraction_data.fields",
  "lease.extraction_data.lease_fields",
  "lease.extraction_data.workflow_output.extracted_document_items",
  "lease.extraction_data.extracted_document_items",
  "lease.extracted_fields",
  "uploaded_files.reviewed_output",
  "uf.records[0].workflow_output.lease_fields",
  "uf.records[0].fields",
  "uf.records[0].standard_fields",
  "uf.records[0].custom_fields",
  "uf.records[0]",
  "uploaded_files.ui_review_payload",
  "uploaded_files.normalized_output.rows[0]",
  "uploaded_files.parsed_data[0]",
  "uploaded_files.ui_review_payload.metadata.extractionDebug",
  "lease (top-level)",
];

/**
 * Best-effort (not exhaustive) check for whether a NON-requested alias key
 * has raw data present under a few of the most common containers actually
 * used by resolveLeaseField's fallback hierarchy. This is deliberately NOT
 * a full re-implementation of extractValueFromSource — after this session's
 * earlier fix making FIELD_ALIASES bidirectional, every alias in
 * getFieldAliases(fieldKey) already resolves identically via
 * resolveLeaseField (each alias's own alias list now includes all the
 * others), so comparing resolveLeaseField outputs across aliases can no
 * longer distinguish "which literal key actually had the data" -- only a
 * raw, unaliased presence check can. This checks presence only, not
 * precedence, and only in the containers most relevant to the fields this
 * Micro-step tracks (see fact-field-mapper.ts's TRACKED_PROVENANCE_FIELDS).
 */
function bestEffortRawKeyForField(lease, fieldKey) {
  const requestedFieldKey = normalizeLeaseFieldKey(fieldKey);
  const aliases = getFieldAliases(fieldKey); // includes requestedFieldKey itself
  const containers = [
    lease?.extraction_data?.workflow_output?.lease_fields,
    lease?.extraction_data?.fields,
    lease?.extraction_data?.lease_fields,
    lease?.uploaded_files?.ui_review_payload?.records?.[0]?.fields,
    lease?.uploaded_files?.ui_review_payload?.records?.[0]?.standard_fields,
  ].filter((c) => c && typeof c === "object");

  const hasRawPresence = (key) =>
    containers.some((container) => {
      if (container[key] !== undefined && container[key] !== null) return true;
      const exactKey = Object.keys(container).find((k) => normalizeLeaseFieldKey(k) === key);
      return exactKey !== undefined && container[exactKey] !== undefined && container[exactKey] !== null;
    });

  // Requested key itself first -- only report an alias switch when the
  // canonical key has NO raw presence but a different alias does.
  if (hasRawPresence(requestedFieldKey)) {
    return { resolvedFieldKey: requestedFieldKey, aliasUsed: false };
  }
  const matchedAlias = aliases.find((alias) => alias !== requestedFieldKey && hasRawPresence(alias));
  if (matchedAlias) {
    return { resolvedFieldKey: matchedAlias, aliasUsed: true };
  }
  return { resolvedFieldKey: requestedFieldKey, aliasUsed: false };
}

/**
 * Additive, debug-only diagnostic: explains WHERE a field's displayed value
 * actually came from (which of resolveLeaseField's ~17-23 fallback sources
 * won, and its position), whether an alias key supplied the underlying data,
 * and whether the file's currently-active generation matches what's on the
 * lease object passed in. Does not affect rendering, does not change
 * resolution order, and calling this alongside resolveLeaseField for the
 * same field is safe (resolveLeaseField itself is side-effect-free).
 *
 * generationMatch is intentionally `null` (unknown, not "false") when
 * payloadGenerationId can't be determined -- ui_review_payload does not
 * currently carry its own generation-of-origin stamp (see
 * LEASE_EXTRACTION_UI_PIPELINE_AUDIT.md Section 16.3's known limitation);
 * this only diagnoses a mismatch when one is actually detectable, per the
 * guardrail that this step must not fabricate a comparison.
 */
export function getFieldDisplayProvenance(lease, fieldKey, options = {}) {
  const mode = options.mode || "display";
  const output = resolveLeaseField(lease, fieldKey, options);
  const pathList = mode === "canonical" ? CANONICAL_FALLBACK_PATHS : DISPLAY_FALLBACK_PATHS;
  const frontendFallbackIndex = output?.sourcePath ? pathList.indexOf(output.sourcePath) : -1;
  const { resolvedFieldKey, aliasUsed } = bestEffortRawKeyForField(lease, fieldKey);
  const activeGenerationId =
    lease?.uploaded_files?.active_generation_id ?? lease?.uploaded_file?.active_generation_id ?? null;
  // Not currently stamped per-payload anywhere this resolver reads from —
  // see the comment above. Kept as an explicit, honest null rather than
  // reusing activeGenerationId, which would fabricate a guaranteed "match".
  const payloadGenerationId = null;

  return {
    requestedFieldKey: normalizeLeaseFieldKey(fieldKey),
    resolvedFieldKey,
    aliasUsed,
    frontendResolutionSource: output?.sourcePath ?? null,
    frontendFallbackIndex: frontendFallbackIndex >= 0 ? frontendFallbackIndex : null,
    payloadGenerationId,
    activeGenerationId,
    generationMatch: payloadGenerationId != null ? payloadGenerationId === activeGenerationId : null,
  };
}
