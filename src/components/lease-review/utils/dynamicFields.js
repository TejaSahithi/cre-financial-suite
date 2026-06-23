import {
  FIELDS_BY_TAB,
  LEASE_REVIEW_FIELDS,
  hasValidSourceEvidence,
  isMeaningfulValue,
  isCalculatedExtractionStatus,
  isManualExtractionStatus,
  canAcceptCalculatedReviewField,
  cleanSourceEvidenceText,
  normalizeSourcePage,
  normalizeEvidenceType,
  readFieldConfidence,
  readFieldEvidence,
  readFieldValue,
  resolveSourceTextQuality,
  resolveExtractionStatus,
} from "@/lib/leaseReviewSchema";
import { getFieldAliases } from "@/lib/leaseFieldResolver";
import { entryValue, entrySourceText, entrySourcePage } from "@/components/lease-review/utils/fieldExtractors";

// Single canonical implementation - delegates to leaseReviewSchema so both
// call sites (dynamicFields and LeaseReview) use identical filtering logic.
export const cleanExtractedSourceText = cleanSourceEvidenceText;

export function isGenericExtractedSourceText(value) {
  return cleanSourceEvidenceText(value) === null;
}

export function titleizeFieldKey(value) {
  return String(value || "Discovered Field")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function normalizeDynamicKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function collectExtractedDocumentItems(lease) {
  // Primary source: extraction_data.workflow_output (post-backfill / post-approve).
  // Fallback: ui_review_payload.metadata.workflow_output from the most recently
  // uploaded file - available immediately after extraction, before any backfill
  // or approval has written workflow data back onto the lease row.
  const ufPayload =
    lease?.uploaded_files?.ui_review_payload ||
    lease?.uploaded_file?.ui_review_payload;
  const ufWfMeta = ufPayload?.metadata?.workflow_output;
  const ufWfRecord = (ufPayload?.records || ufPayload?.rows || [])[0]?.workflow_output;
  const ufWf = ufWfRecord || ufWfMeta || {};

  const rawWorkflowOutput = (
    Object.keys(lease?.extraction_data?.workflow_output || {}).length > 0
      ? lease.extraction_data.workflow_output
      : ufWf
  );
  const workflowOutput = rawWorkflowOutput.workflow_output || rawWorkflowOutput;
  const recordOutput = Array.isArray(rawWorkflowOutput.records) ? rawWorkflowOutput.records[0] || {} : {};
  const fieldMapItems = [];
  const addFieldMapItems = (map, sourceName) => {
    if (!map || typeof map !== "object" || Array.isArray(map)) return;
    for (const [key, entry] of Object.entries(map)) {
      const value = entryValue(entry);
      const sourceText = entrySourceText(entry);
      const sourcePage = entrySourcePage(entry);
      const extractionStatus = typeof entry === "object" && entry
        ? entry.extraction_status ?? entry.extractionStatus ?? entry.review_status ?? entry.reviewStatus ?? null
        : null;
      const confidence = typeof entry === "object" && entry
        ? entry.confidence_score ?? entry.confidence ?? null
        : null;
      const rawValue = typeof entry === "object" && entry ? entry.raw_value ?? entry.rawValue ?? value : value;
      const evidenceType = typeof entry === "object" && entry ? entry.evidence_type ?? entry.evidenceType ?? null : null;
      const derivationTrace = typeof entry === "object" && entry ? entry.derivation_trace ?? entry.derivationTrace ?? null : null;
      const sourceFieldKeys = typeof entry === "object" && entry
        ? entry.source_field_keys ?? entry.sourceFieldKeys ?? []
        : [];
      const reviewReason = typeof entry === "object" && entry
        ? entry.review_reason ?? entry.reviewReason ?? entry.requires_review_reason ?? entry.requiresReviewReason ?? null
        : null;
      const approvalBlockingReason = typeof entry === "object" && entry
        ? entry.approval_blocking_reason ?? entry.approvalBlockingReason ?? null
        : null;
      const statusEvidence = {
        sourcePage,
        sourceText,
        value,
        rawValue,
        extractionStatus,
        evidenceType,
        sourceFieldKeys,
        derivationTrace,
      };
      const sourceTextQuality = resolveSourceTextQuality(statusEvidence);
      const effectiveStatus = isCalculatedExtractionStatus(extractionStatus)
        ? "calculated"
        : isManualExtractionStatus(extractionStatus)
          ? String(extractionStatus).toLowerCase()
          : hasValidSourceEvidence(statusEvidence)
            ? (typeof confidence === "number" ? "extracted" : "extracted_no_confidence")
            : "missing_source_evidence";
      if ((value === null || value === undefined || value === "") && !sourceText) continue;
      fieldMapItems.push({
        item_id: `${sourceName}:${key}`,
        label: titleizeFieldKey(key),
        item_type: key,
        field_key: key,
        business_area: inferDynamicItemTab({ business_area: "" }, key) || "unknown_needs_review",
        display_tab: inferDynamicItemTab({ business_area: "" }, key),
        value,
        normalized_value: value,
        raw_value: rawValue,
        source_text: sourceText,
        source_page: sourcePage,
        confidence,
        evidence_type: normalizeEvidenceType(evidenceType ?? extractionStatus, {
          value,
          sourceText,
          sourceTextQuality,
          sourceFieldKeys,
          derivationTrace,
        }),
        source_text_quality: sourceTextQuality,
        source_field_keys: sourceFieldKeys,
        derivation_trace: derivationTrace,
        requires_review: Boolean(entry?.requires_review ?? entry?.requiresReview ?? reviewReason ?? approvalBlockingReason),
        review_reason: reviewReason,
        approval_blocking_reason: approvalBlockingReason,
        extraction_method: sourceName,
        extraction_status: effectiveStatus,
        maps_to_existing_field: false,
        maps_to_fixed_field: false,
        creates_dynamic_row: true,
        review_status: "needs_review",
      });
    }
  };
  addFieldMapItems(workflowOutput.lease_fields, "workflow_lease_fields");
  addFieldMapItems(recordOutput.lease_fields, "workflow_record_lease_fields");
  addFieldMapItems(lease?.extraction_data?.fields, "extraction_data_fields");
  addFieldMapItems(lease?.extraction_data?.field_evidence, "extraction_data_field_evidence");

  // Map lease_clauses arrays to dynamic document items. Each clause becomes a
  // reviewable row with its own source text and tab assignment.
  const addLeaseClauses = (clauses, sourceName) => {
    if (!Array.isArray(clauses)) return;
    for (const clause of clauses) {
      const clauseType = String(clause?.clause_type || clause?.type || "").trim();
      if (!clauseType) continue;
      // Prefix with "clause_" so static field keys are never accidentally
      // overwritten (e.g. "landlord_consent" exists as a standard field).
      const key = `clause_${normalizeDynamicKey(clauseType)}`;
      const value = clause?.value ?? clause?.clause_text ?? null;
      const sourceText = entrySourceText(clause);
      const sourcePage = entrySourcePage(clause);
      if ((value === null || value === undefined || value === "") && !sourceText) continue;
      const category = String(clause?.category || clause?.business_area || "").toLowerCase();
      const typedTab = inferDynamicItemTab({ business_area: category }, key) || inferDynamicItemTab({}, clauseType);
      const displayTab = category && category !== "clause_records"
        ? typedTab || category
        : typedTab || "clause_records";
      fieldMapItems.push({
        item_id: `${sourceName}:${key}:${sourcePage ?? "p0"}:${normalizeDynamicKey(String(sourceText || value || "")).slice(0, 80)}`,
        label: clause?.label || clause?.clause_label || titleizeFieldKey(clauseType),
        item_type: clauseType,
        field_key: key,
        business_area: category,
        // Pure clause records stay in clause_records, but typed clauses with
        // a business area (for example legal_options landlord-consent terms)
        // should also surface as reviewable dynamic rows.
        display_tab: displayTab,
        value,
        normalized_value: value,
        raw_value: clause?.raw_value ?? value,
        source_text: sourceText,
        source_page: sourcePage,
        confidence: typeof clause?.confidence === "number" ? clause.confidence : null,
        extraction_method: sourceName,
        extraction_status: sourceText ? "extracted" : "missing_source_evidence",
        evidence_type: sourceText ? "extracted" : "missing",
        source_text_quality: resolveSourceTextQuality({
          value,
          sourceText,
          sourcePage,
          extractionStatus: sourceText ? "extracted" : "missing_source_evidence",
        }),
        requires_review: !sourceText,
        review_reason: sourceText ? null : "Clause row has no supporting source text.",
        maps_to_existing_field: false,
        maps_to_fixed_field: false,
        creates_dynamic_row: true,
        review_status: "pending",
      });
    }
  };
  addLeaseClauses(workflowOutput.lease_clauses, "workflow_lease_clauses");
  addLeaseClauses(recordOutput.lease_clauses, "workflow_record_lease_clauses");
  addLeaseClauses(lease?.extraction_data?.lease_clauses, "extraction_data_lease_clauses");

  // Supplement from ui_review_payload when it contains a different workflow
  // output than extraction_data (i.e. backfill hasn't run yet). This ensures
  // non-standard fields are visible as dynamic rows immediately after upload.
  if (ufWf && ufWf !== workflowOutput) {
    addFieldMapItems(ufWf?.lease_fields, "uf_payload_lease_fields");
    addLeaseClauses(ufWf?.lease_clauses, "uf_payload_lease_clauses");
  }

  const sources = [
    workflowOutput.extracted_document_items,
    workflowOutput.clause_records,
    recordOutput.extracted_document_items,
    recordOutput.clause_records,
    lease?.extraction_data?.extracted_document_items,
    lease?.extraction_data?.clause_records,
    ufWf?.extracted_document_items,
    ufWf?.clause_records,
    ufWfRecord?.extracted_document_items,
    ufWfRecord?.clause_records,
    fieldMapItems,
  ];
  return sources.flatMap((rows) => (Array.isArray(rows) ? rows : []));
}

export function inferDynamicItemTab(item, key) {
  if (item?.display_tab) return String(item.display_tab);
  const businessArea = String(item?.business_area || "").toLowerCase();
  if (businessArea === "assignment_amendment") {
    if (/(assignor|assignee|tenant|landlord|notice_address|address|premises)/i.test(key)) return "parties_premises";
    if (/(date|term|expiration|commencement|effective)/i.test(key)) return "dates_term";
    if (/(rent|consideration|fee|charge|amount|deposit)/i.test(key)) return "rent_charges";
    return "legal_options";
  }
  const knownTabs = new Set([
    "parties_premises",
    "dates_term",
    "rent_charges",
    "expenses_recoveries",
    "cam_rules",
    "insurance",
    "legal_options",
  ]);
  if (knownTabs.has(businessArea)) return businessArea;
  if (businessArea === "critical_dates") return "dates_term";
  if (/(tenant|landlord|property|premises|address|suite|unit|floor|rsf|sqft|square|footage|signatory|contact|building|use_permitted|permitted_use)/i.test(key)) return "parties_premises";
  if (/(date|term|expiration|commencement|effective|start_date|end_date|renewal_notice|signature|lease_date)/i.test(key)) return "dates_term";
  // Insurance - must come before rent_charges so "liability" and "certificate"
  // are not swallowed by the generic "fee/charge" pattern.
  if (/(insurance|insured|deductible|liability|subrogation|waiver_of_sub|additional_insured|certificate)/i.test(key)) return "insurance";
  // CAM - must come before rent_charges so "admin_fee" / "management_fee" /
  // "gross_up" are not swallowed by the generic "fee/percent" pattern.
  if (/(gross_up|cam_|admin_fee|management_fee|base_year|reconciliation|controllable|cam.cap|cam.pool)/i.test(key)) return "cam_rules";
  // Rent & charges: rent, deposit, allowance, late fees, holdover, etc.
  if (/(rent|fee|deposit|allowance|charge|amount|payment|holdover|interest|premium|breakpoint|percentage|consideration|security)/i.test(key)) return "rent_charges";
  // Expense / recovery terms: taxes, utilities, maintenance, repairs, janitorial,
  // full-service/gross/NNN/net lease structure, operating expenses, reimbursements.
  if (/(tax|utilit|maintenance|repair|expense|operating|reimburs|recovery|recoveries|janitorial|cleaning|sanitation|full.service|gross.lease|full_service|nnn|triple.net|net.lease|modified.gross|lease.structure|lease.type|expense.structure|responsibility)/i.test(key)) return "expenses_recoveries";
  if (/(assign|consent|assumption|default|remed|surrender|alteration|sublet|subletting|broker|estoppel|subordination|snda|notice|rofr|termination|exclusive|noncompete|non_compete|co_tenancy|relocation|force_majeure|force majeure|casualty|condemnation|compliance|quiet_enjoyment|quiet enjoyment|signage|signs|guaranty|guarantee|indemnity|jury|governing_law|governing law|successors|hazardous|environmental|waiver|holdover)/i.test(key)) return "legal_options";
  return null;
}

export function inferDynamicItemType(item, key) {
  const value = item?.normalized_value ?? item?.value ?? item?.raw_value;
  if (typeof value === "boolean") return "boolean";
  if (/date|deadline|expiration|commencement|effective/i.test(key)) return "date";
  if (/rent|amount|fee|deposit|consideration|allowance|cost|charge/i.test(key)) return "currency";
  if (/percent|pct|share|rate|multiplier|months|days|sqft|rsf|square_footage|area/i.test(key)) return "number";
  return "text";
}

export function buildDynamicDocumentFieldsByTab(lease) {
  const staticKeys = new Set(
    LEASE_REVIEW_FIELDS.flatMap((field) => getFieldAliases(field.key)).map(normalizeDynamicKey),
  );
  const byTab = {};
  const seenSignatures = new Set();
  const keyCounts = new Map();
  for (const item of collectExtractedDocumentItems(lease)) {
    const sourceText = cleanExtractedSourceText(
      item?.source_text || item?.exact_source_text || item?.source_clause,
    );
    const value = item?.normalized_value ?? item?.value ?? item?.raw_value;
    const hasValue = value !== undefined && value !== null && value !== "";
    // Show the row if EITHER a value OR a source clause is present. Earlier
    // gate required both, which silently dropped clause-only items (e.g.
    // "Landlord Consent", "All Other Terms Remain Same") that the
    // assignment-pipeline extracts as boolean facts without a normalized
    // value. Reviewer can fill the value once the row is visible.
    if (!hasValue && !sourceText) continue;
    const key = normalizeDynamicKey(item?.field_key || item?.key || item?.item_type);
    const mapsToFixedField = item?.maps_to_fixed_field === true || staticKeys.has(key);
    const createsDynamicRow = item?.creates_dynamic_row !== false && !mapsToFixedField;
    if (!key || !createsDynamicRow) continue;
    // Skip clause-title placeholder items whose item_id is "clause:<type>".
    // These are routing markers for the Clause Records tab, not field values.
    // The backend sets display_tab:"clause_records" for new extractions; this
    // handles older stored payloads where that field wasn't set yet.
    if (item?.item_id && String(item.item_id).startsWith("clause:")) continue;
    // Fall back to legal_options for any item inferDynamicItemTab can't route.
    // This prevents extracted fields (e.g. force_majeure, jury_trial_waiver,
    // attorneys_fees) from being silently dropped - every extracted item with
    // a value or source text must be visible somewhere.
    const tab = inferDynamicItemTab(item, key) || "legal_options";
    if (tab === "clause_records") continue;
    // Dedup by key + value only. Dropping item_id prevents the same field from
    // being shown twice when it appears in both extracted_document_items and
    // the lease_fields map (which addFieldMapItems also surfaced as dynamic rows).
    // Different values for the same key are still shown (keyCounts renames them
    // key_2, key_3 etc.) so genuine conflicts remain visible.
    const signature = [key, String(value ?? "").slice(0, 100)].join("|");
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    const count = (keyCounts.get(key) || 0) + 1;
    keyCounts.set(key, count);
    const uniqueKey = count === 1 ? key : `${key}_${count}`;
    if (!byTab[tab]) byTab[tab] = [];
    byTab[tab].push({
      key: uniqueKey,
      id: uniqueKey,
      field_key: uniqueKey,
      original_field_key: key,
      label: item?.label || titleizeFieldKey(item?.section_title || item?.field_key || item?.item_type || key),
      field_label: item?.label || titleizeFieldKey(item?.section_title || item?.field_key || item?.item_type || key),
      tab,
      category: tab,
      type: inferDynamicItemType(item, key),
      allowNA: true,
      allowCalculatedAccept: canAcceptCalculatedReviewField({ key }),
      dynamic_document_item: true,
      is_dynamic: true,
      normalized_value: value,
      raw_value: item?.raw_value ?? item?.rawValue ?? value,
      page_number: normalizeSourcePage(item?.source_page ?? item?.page_number ?? item?.page),
      source_text: sourceText,
      confidence: typeof item?.confidence === "number" ? item.confidence : null,
      status: item?.extraction_status ?? item?.review_status ?? null,
      extraction_status: item?.extraction_status ?? item?.review_status ?? null,
      source_file_id: lease?.source_file_id ?? lease?.extraction_data?.source_file_id ?? lease?.uploaded_files?.id ?? lease?.uploaded_file?.id ?? null,
      evidence_type: normalizeEvidenceType(item?.evidence_type ?? item?.extraction_status ?? item?.review_status, { value, sourceText }),
      source_text_quality: resolveSourceTextQuality({
        value,
        rawValue: item?.raw_value ?? item?.rawValue ?? value,
        sourceText,
        sourcePage: item?.source_page ?? item?.page_number ?? item?.page,
        extractionStatus: item?.extraction_status ?? item?.review_status ?? null,
        evidenceType: item?.evidence_type,
        sourceTextQuality: item?.source_text_quality ?? item?.sourceTextQuality,
        sourceFieldKeys: item?.source_field_keys ?? item?.sourceFieldKeys ?? [],
        derivationTrace: item?.derivation_trace ?? item?.derivationTrace ?? null,
      }),
      source_field_keys: item?.source_field_keys ?? item?.sourceFieldKeys ?? [],
      derivation_trace: item?.derivation_trace ?? item?.derivationTrace ?? null,
      requires_review: Boolean(item?.requires_review ?? item?.requiresReview ?? false),
      review_reason: item?.review_reason ?? item?.reviewReason ?? item?.requires_review_reason ?? item?.requiresReviewReason ?? null,
      approval_blocking_reason: item?.approval_blocking_reason ?? item?.approvalBlockingReason ?? null,
    });
  }
  return byTab;
}

function parseNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function extractFirstMoneyNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "");
  const money = text.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  if (money?.[1]) return parseNumber(money[1]);
  return parseNumber(text);
}

function combineSourceText(...items) {
  const texts = items
    .map((item) => cleanSourceEvidenceText(item?.sourceText ?? item?.source_text ?? item?.sourceClause ?? item?.source_clause))
    .filter(Boolean);
  return [...new Set(texts)].join("\n");
}

function valuesRoughlyEqual(left, right) {
  const leftNum = parseNumber(left);
  const rightNum = parseNumber(right);
  if (leftNum != null && rightNum != null) return Math.abs(leftNum - rightNum) < 0.02;
  return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}

function currentEvidenceIsUnsupported(evidence, value) {
  if (!isMeaningfulValue(value)) return true;
  if (evidence?.derivationTrace || evidence?.derivation_trace) return false;
  const sourceFieldKeys = evidence?.sourceFieldKeys ?? evidence?.source_field_keys ?? [];
  if (Array.isArray(sourceFieldKeys) && sourceFieldKeys.length > 0) return false;
  return !hasValidSourceEvidence({
    ...evidence,
    value,
    sourceText: evidence?.sourceText ?? evidence?.source_text,
    sourcePage: evidence?.sourcePage ?? evidence?.source_page,
  });
}

function buildDerivedFieldEvidence(lease, key, currentValue, currentEvidence = {}) {
  const monthlyEvidence = readFieldEvidence(lease, "monthly_rent");
  const baseMonthlyEvidence = readFieldEvidence(lease, "base_rent_monthly");
  const effectiveMonthlyEvidence = hasValidSourceEvidence(monthlyEvidence) ? monthlyEvidence : baseMonthlyEvidence;
  const monthlyRent = extractFirstMoneyNumber(readFieldValue(lease, "monthly_rent")) ?? extractFirstMoneyNumber(readFieldValue(lease, "base_rent_monthly"));
  const sfEvidence = readFieldEvidence(lease, "square_footage");
  const tenantRsfEvidence = readFieldEvidence(lease, "tenant_rsf");
  const effectiveSfEvidence = hasValidSourceEvidence(sfEvidence) ? sfEvidence : tenantRsfEvidence;
  const squareFootage = parseNumber(readFieldValue(lease, "square_footage")) ?? parseNumber(readFieldValue(lease, "tenant_rsf"));
  const monthlyHasSource = hasValidSourceEvidence({ ...effectiveMonthlyEvidence, value: monthlyRent });
  const sfHasSource = hasValidSourceEvidence({ ...effectiveSfEvidence, value: squareFootage });
  const shouldUpgrade = (derivedValue) =>
    currentEvidenceIsUnsupported(currentEvidence, currentValue) &&
    (!isMeaningfulValue(currentValue) || valuesRoughlyEqual(currentValue, derivedValue));

  if (key === "annual_rent" && monthlyRent != null && monthlyHasSource) {
    const value = Math.round(monthlyRent * 12 * 100) / 100;
    if (!shouldUpgrade(value)) return null;
    return {
      value,
      sourceText: effectiveMonthlyEvidence.sourceText,
      sourcePage: effectiveMonthlyEvidence.sourcePage,
      evidenceType: "derived",
      sourceTextQuality: "derived",
      sourceFieldKeys: ["monthly_rent", "base_rent_monthly"],
      derivationTrace: `annual_rent = monthly_rent (${monthlyRent}) x 12`,
      extractionStatus: "calculated",
    };
  }

  if (key === "rent_per_sf") {
    const annualRent = parseNumber(readFieldValue(lease, "annual_rent")) ?? (monthlyRent != null ? monthlyRent * 12 : null);
    const currentRentPerSf = parseNumber(readFieldValue(lease, "rent_per_sf"));
    if (annualRent != null && squareFootage != null && squareFootage > 0 && (monthlyHasSource || hasValidSourceEvidence(readFieldEvidence(lease, "annual_rent"))) && sfHasSource) {
      const value = Math.round((annualRent / squareFootage) * 100) / 100;
      if (!currentEvidenceIsUnsupported(currentEvidence, currentValue ?? currentRentPerSf) && !valuesRoughlyEqual(currentValue ?? currentRentPerSf, value)) return null;
      return {
        value,
        sourceText: combineSourceText(effectiveMonthlyEvidence, effectiveSfEvidence) || effectiveMonthlyEvidence.sourceText || effectiveSfEvidence.sourceText,
        sourcePage: effectiveMonthlyEvidence.sourcePage ?? effectiveSfEvidence.sourcePage,
        evidenceType: "derived",
        sourceTextQuality: "derived",
        sourceFieldKeys: ["annual_rent", "monthly_rent", "base_rent_monthly", "square_footage", "tenant_rsf"],
        derivationTrace: `rent_per_sf = annual_rent (${annualRent}) / square_footage (${squareFootage})`,
        extractionStatus: "calculated",
      };
    }
  }

  if (key === "billing_frequency" && monthlyRent != null && monthlyHasSource) {
    if (!shouldUpgrade("monthly")) return null;
    return {
      value: "monthly",
      sourceText: effectiveMonthlyEvidence.sourceText,
      sourcePage: effectiveMonthlyEvidence.sourcePage,
      evidenceType: "derived",
      sourceTextQuality: "derived",
      sourceFieldKeys: ["monthly_rent", "base_rent_monthly"],
      derivationTrace: "billing_frequency inferred from monthly_rent",
      extractionStatus: "calculated",
    };
  }

  return null;
}
function normalizeQuotedPropertyName(sourceText) {
  const source = cleanSourceEvidenceText(sourceText);
  if (!source) return null;
  const match =
    source.match(/\bknown\s+as\s+(The\s+[A-Z][A-Za-z0-9 &'.,-]+?)(?:\s+in\b|,|\.|;|\))/) ||
    source.match(/\bknown\s+as\s+([A-Z][A-Za-z0-9 &'.,-]+?)(?:\s+in\b|,|\.|;|\))/);
  return match?.[1]?.replace(/\s+/g, " ").trim() || null;
}

function isDateLikeText(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  return /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}$/i.test(text)
    || /^\d{4}-\d{2}-\d{2}$/.test(text)
    || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(text);
}

function isPhoneLikeText(value) {
  const text = String(value ?? "").trim();
  return /^\+?\d?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/.test(text);
}

function hasHardValidationError(errors = []) {
  return errors.some((error) =>
    /failed_validation|not_specific|looks_like_clause|without_.*evidence|not_core|invalid|not_meaningful|not_identifier|unknown|without_context|without_.*source/i.test(String(error || "")),
  );
}

function isGenericLeaseIntroSource(sourceText) {
  const source = cleanSourceEvidenceText(sourceText) || "";
  const lower = source.toLowerCase();
  return /\bthis lease\b/.test(lower) &&
    /\b(?:landlord|tenant)\b/.test(lower) &&
    /\b(?:article\s+1|lease of premises|in consideration of the rent|made and entered)\b/.test(lower) &&
    !/\b(?:rent includes|full service|property tax|real estate tax|insurance premium|property insurance|utilities|electric|water|sewer|hvac|maintenance expenses|common area maintenance|responsible|shall pay|shall maintain)\b/.test(lower);
}

function responsibilitySourceSupportsValue(key, value, sourceText) {
  const source = cleanSourceEvidenceText(sourceText) || "";
  if (!source) return false;
  if (isGenericLeaseIntroSource(source)) return false;
  const lower = source.toLowerCase();
  const normalizedValue = String(value ?? "").toLowerCase();
  const hasExpenseAction = /\b(?:rent includes|included in rent|full service|shall pay|shall reimburse|responsible for|at (?:tenant|landlord)'?s (?:sole )?(?:cost|expense)|shall maintain|shall provide|separately metered)\b/.test(lower);
  const fieldSupported = {
    responsibility_taxes: /\b(?:tax|taxes|real estate tax|property tax)\b/.test(lower),
    responsibility_insurance: /\b(?:insurance|premium|coverage)\b/.test(lower),
    responsibility_utilities: /\b(?:utilit|electric|water|sewer|gas|hvac|janitorial)\b/.test(lower),
    responsibility_repairs: /\b(?:repair|maintenance|maintain|hvac)\b/.test(lower),
    property_insurance_responsibility: /\b(?:property insurance|insurance premium|rent includes)\b/.test(lower),
  }[key] ?? true;
  const valueSupported = !/^(tenant|landlord)$/.test(normalizedValue) || lower.includes(normalizedValue) || /\b(?:rent includes|included in rent|full service)\b/.test(lower);
  return fieldSupported && hasExpenseAction && valueSupported;
}
function normalizeReviewValueForField(key, value, sourceText, options = {}) {
  if (!isMeaningfulValue(value)) return value;

  const normalizedKey = normalizeDynamicKey(key);
  const text = typeof value === "string" ? value.trim() : value;
  const valueText = String(text ?? "").trim();
  const lowerValue = valueText.toLowerCase();
  const source = cleanSourceEvidenceText(sourceText) || "";
  const combined = `${valueText} ${source}`.toLowerCase();

  if (normalizedKey === "property_name") {
    const quotedName = normalizeQuotedPropertyName(source);
    if (quotedName) return quotedName;
    if (
      valueText.length < 4 ||
      /^(?:a|the|shopping|a shopping|shopping center|center|premises|property|tenant has|landlord has)$/i.test(valueText) ||
      /\b(?:shall|hereby|premises|article|section|rent|maintenance|insurance|taxes)\b/i.test(valueText)
    ) {
      return null;
    }
  }

  if (["premises_use", "permitted_use", "use_clause"].includes(normalizedKey)) {
    if (/\b(?:buffalo\s+wild\s+wings|wings|restaurant|food\s+service|casual\s+dining|bar|cafe|coffee)\b/i.test(combined)) {
      return "restaurant";
    }
    // Reject if the VALUE itself contains restriction or non-use language (check
    // lowerValue not combined so that the source clause text doesn't cause
    // false positives - lease sources almost always contain restriction clauses).
    if (
      valueText.length > 80 ||
      /\b(?:shall\s+not|without\s+(?:prior\s+)?(?:written\s+)?consent|may\s+not|assign|assignment|sublet|subletting|common\s+areas?|parking|merchandise|display|mechanical|sidewalk|landscaping|as\s+is|no\s+other\s+use|restricted|not\s+to\s+be\s+used)\b/.test(lowerValue)
    ) {
      return null;
    }
  }

  if (normalizedKey === "lease_type") {
    if (/\bmodified\s+gross\b/.test(combined)) return "modified_gross";
    if (/\b(?:triple\s+net|triple-net|nnn)\b/.test(combined)) return "nnn";
    if (/\bfull\s+service(?:\s+gross)?\b/.test(combined)) return "full_service";
    if (/\bgross\b/.test(combined)) return "gross";
    if (["net", "single net", "double net"].includes(lowerValue)) return null;
  }

  if (["monthly_rent", "base_rent_monthly", "base_rent", "annual_rent", "security_deposit", "security_deposit_amount", "general_liability_min"].includes(normalizedKey)) {
    const parsed = extractFirstMoneyNumber(valueText) ?? extractFirstMoneyNumber(source);
    if (parsed == null) return null;
    if (normalizedKey === "annual_rent" && !options.allowDerivedAnnual && !/\b(?:annual|year|yr|derived|x\s*12)\b/i.test(combined)) return null;
    if (["monthly_rent", "base_rent_monthly", "base_rent"].includes(normalizedKey) && !/\b(?:monthly|per\s+month|\/mo|rent)\b/i.test(combined)) return null;
    if (["security_deposit", "security_deposit_amount"].includes(normalizedKey) && !/\bsecurity\s+deposit\b/i.test(combined)) return null;
    return parsed;
  }

  if (["assignment_provisions", "assignment_rights", "sublease_rights"].includes(normalizedKey)) {
    if (!/\b(?:assign|assignment|sublet|sublease|transfer)\b/.test(combined)) return null;
    if (/\b(?:alteration|improvement|roofing contractor|roof penetrations?)\b/.test(combined)) return null;
  }

  if (["tenant_name", "landlord_name", "assignor_name", "assignee_name", "guarantor_name", "owner_name", "property_manager", "broker_name"].includes(normalizedKey)) {
    if (
      isDateLikeText(valueText) ||
      isPhoneLikeText(valueText) ||
      valueText.length > 90 ||
      /^(?:tenant|landlord|assignee|assignor|owner|broker|agent|date|name|title)$/i.test(valueText) ||
      /\b(?:assumes?\s+in\s+full|obligations?\s+of|transfer\s+shall|shall|hereby|premises|article|section|rent|maintenance|insurance|taxes|prior\s+written\s+consent|sublet|assignment)\b/i.test(valueText)
    ) {
      return null;
    }
  }
  // Person name fields: reject clause fragments, verb phrases, or anything that isn't a human name.
  // A valid person name is typically 2-4 words, capital letters, no verbs.
  if (["tenant_contact_name", "tenant_signatory_name", "landlord_contact_name", "landlord_signatory_name"].includes(normalizedKey)) {
    if (
      isDateLikeText(valueText) ||
      isPhoneLikeText(valueText) ||
      valueText.length > 60 ||
      /\b(?:leases?|accepts?|agrees?|shall|hereby|premises|article|section|tenant|landlord|lessee|lessor|pursuant|notwithstanding)\b/i.test(valueText) ||
      /^(?:by|its|title|name|date)[:\s]/i.test(valueText)
    ) {
      return null;
    }
  }

  if (normalizedKey === "assignment_consideration") {
    if (/^[.,;:-]?$/.test(valueText)) return null;
    if (!/\b(?:assignment|assign|transfer|consideration|premium|fee|\$|dollar)\b/i.test(combined)) return null;
  }

  if ([
    "responsibility_taxes",
    "responsibility_insurance",
    "responsibility_utilities",
    "responsibility_repairs",
    "property_insurance_responsibility",
  ].includes(normalizedKey)) {
    if (!responsibilitySourceSupportsValue(normalizedKey, valueText, source)) return null;
  }

  if (["tenant_insurance_required", "general_liability_min", "additional_insureds_required"].includes(normalizedKey)) {
    if (!/\b(?:insurance|liability|coverage|insured|certificate)\b/i.test(source)) return null;
  }

  if (["cam_amount", "fixed_cam_amount"].includes(normalizedKey)) {
    const amount = parseNumber(valueText);
    if (amount === 0 && !/\b(?:\$\s*0|0\.00|zero|no separate cam|no cam charge|included in rent|full service)\b/i.test(source)) {
      return null;
    }
  }
  return text;
}

export function buildCanonicalLeaseReviewField(lease, field, tabKey) {
  const key = field?.key || field?.field_key;
  if (!key) return null;

  const initialValue = field.normalized_value ?? field.value ?? readFieldValue(lease, key);
  const evidence = readFieldEvidence(lease, key);
  const derived = buildDerivedFieldEvidence(lease, key, initialValue, evidence);
  let schemaValue = derived?.value ?? initialValue;
  const sourcePage = normalizeSourcePage(
    field.page_number
      ?? field.source_page
      ?? field.page
      ?? derived?.sourcePage
      ?? evidence.sourcePage,
  );
  const sourceText = cleanSourceEvidenceText(
    field.source_text
      ?? field.exact_source_text
      ?? field.source_clause
      ?? derived?.sourceText
      ?? evidence.sourceText,
  );
  const valueBeforeValidation = schemaValue;
  schemaValue = normalizeReviewValueForField(key, schemaValue, sourceText, {
    allowDerivedAnnual: Boolean(derived || field.evidence_type === "derived" || field.derivation_trace || field.source_field_keys?.length),
  });
  const validationErrors = [
    ...(Array.isArray(field.validation_errors) ? field.validation_errors : []),
    ...(Array.isArray(evidence.validationErrors) ? evidence.validationErrors : []),
  ];
  if (isMeaningfulValue(valueBeforeValidation) && !isMeaningfulValue(schemaValue)) {
    validationErrors.push(`${key}_failed_validation`);
  }
  const hardValidationFailed = hasHardValidationError(validationErrors);
  if (hardValidationFailed && isMeaningfulValue(schemaValue)) {
    schemaValue = null;
  }
  const confidence = typeof field.confidence === "number"
    ? field.confidence
    : readFieldConfidence(lease, key, null);
  const explicitSourceTextQuality =
    field.source_text_quality
      ?? field.sourceTextQuality
      ?? derived?.sourceTextQuality
      ?? (sourceText ? null : evidence.sourceTextQuality);
  const explicitExtractionStatus =
    field.status
      ?? field.extraction_status
      ?? derived?.extractionStatus
      ?? (sourceText ? null : evidence.extractionStatus);
  const explicitEvidenceType =
    field.evidence_type
      ?? field.evidenceType
      ?? derived?.evidenceType
      ?? (sourceText ? null : evidence.evidenceType);
  const statusEvidence = {
    sourcePage,
    sourceText,
    rawValue: field.raw_value ?? field.rawValue ?? evidence.rawValue ?? schemaValue,
    value: schemaValue,
    extractionStatus: explicitExtractionStatus,
    evidenceType: explicitEvidenceType,
    sourceTextQuality: explicitSourceTextQuality,
    sourceFieldKeys: field.source_field_keys ?? field.sourceFieldKeys ?? derived?.sourceFieldKeys ?? evidence.sourceFieldKeys,
    derivationTrace: field.derivation_trace ?? field.derivationTrace ?? derived?.derivationTrace ?? evidence.derivationTrace,
  };
  const sourceTextQuality = hardValidationFailed ? "missing" : resolveSourceTextQuality(statusEvidence);
  const evidenceType = hardValidationFailed ? "missing" : normalizeEvidenceType(statusEvidence.evidenceType ?? statusEvidence.extractionStatus, {
    value: schemaValue,
    sourceText,
    sourceTextQuality,
    sourceFieldKeys: statusEvidence.sourceFieldKeys,
    derivationTrace: statusEvidence.derivationTrace,
  });
  const resolvedStatus = field.status
    ?? field.extraction_status
    ?? derived?.extractionStatus
    ?? (sourceText && isMeaningfulValue(schemaValue) ? null : evidence.extractionStatus)
    ?? resolveExtractionStatus(lease, key, {
      value: schemaValue,
      confidence,
      evidence: statusEvidence,
    });
  const effectiveStatus = hardValidationFailed && Boolean(field.required)
    ? "manual_required"
    : hardValidationFailed
      ? "missing_source_evidence"
      : resolvedStatus;
  const hasValue = isMeaningfulValue(schemaValue);
  const hasValidSource = hasValidSourceEvidence({
    ...statusEvidence,
    sourceTextQuality,
    evidenceType,
  });
  const derivedWithoutTrace =
    evidenceType === "derived" &&
    !statusEvidence.derivationTrace &&
    !(Array.isArray(statusEvidence.sourceFieldKeys) && statusEvidence.sourceFieldKeys.length > 0);
  const requiredMissing = Boolean(field.required) && !hasValue;
  const requiredNoSource = Boolean(field.required) && hasValue && !hasValidSource;
  const inferredNeedsReview = evidenceType === "inferred" || sourceTextQuality === "inferred";
  const backendReviewReason =
    field.review_reason ?? field.reviewReason ??
    field.requires_review_reason ?? field.requiresReviewReason ??
    evidence.reviewReason ?? null;
  let reviewReason =
    backendReviewReason ??
    field.approval_blocking_reason ??
    field.approvalBlockingReason ??
    evidence.approvalBlockingReason ??
    null;
  if (!reviewReason && validationErrors.length > 0) {
    reviewReason = "Extracted value failed field validation.";
  }
  if (!reviewReason && requiredMissing) {
    reviewReason = "Required field was not found in the lease. Manual review required.";
  } else if (!reviewReason && requiredNoSource) {
    reviewReason = "Required field has a value but no valid supporting source text.";
  } else if (!reviewReason && inferredNeedsReview) {
    reviewReason = "Value is inferred or classified and requires manual review.";
  } else if (!reviewReason && derivedWithoutTrace) {
    reviewReason = "Derived value is missing a derivation trace.";
  }
  const requiresReview = Boolean(
    field.requires_review ||
      field.requiresReview ||
      evidence.requiresReview ||
      validationErrors.length > 0 ||
      reviewReason ||
      evidenceType === "inferred",
  );
  const status = requiredMissing && !isManualExtractionStatus(effectiveStatus)
    ? "manual_required"
    : effectiveStatus;

  return {
    ...field,
    id: field.id ?? key,
    key,
    field_key: key,
    label: field.label ?? field.field_label ?? titleizeFieldKey(key),
    field_label: field.field_label ?? field.label ?? titleizeFieldKey(key),
    display_value: schemaValue,
    normalized_value: schemaValue,
    raw_value: field.raw_value ?? evidence.rawValue ?? schemaValue,
    page_number: sourcePage,
    page: sourcePage,
    source_text: sourceText,
    source_clause: field.source_clause ?? evidence.sourceClause ?? sourceText,
    category: field.category ?? field.tab ?? tabKey ?? "unknown",
    tab: field.tab ?? tabKey,
    confidence,
    confidence_score: confidence,
    status,
    extraction_status: status,
    evidence_type: evidenceType,
    source_text_quality: sourceTextQuality,
    source_field_keys: statusEvidence.sourceFieldKeys || [],
    derivation_trace: statusEvidence.derivationTrace ?? null,
    validation_errors: validationErrors,
    requires_review: requiresReview,
    required: Boolean(field.required),
    review_reason: reviewReason,
    requires_review_reason: reviewReason,
    approval_blocking_reason: field.approval_blocking_reason ?? field.approvalBlockingReason ?? evidence.approvalBlockingReason ?? reviewReason ?? null,
    is_dynamic: Boolean(field.is_dynamic || field.dynamic_document_item),
    source_file_id: field.source_file_id ?? lease?.source_file_id ?? lease?.extraction_data?.source_file_id ?? lease?.uploaded_files?.id ?? lease?.uploaded_file?.id ?? null,
  };
}

export function buildLeaseReviewRowsByTab(lease, { userCustomFields = {} } = {}) {
  const dynamicFieldsByTab = buildDynamicDocumentFieldsByTab(lease);
  const byTab = {};

  for (const tab of Object.keys(FIELDS_BY_TAB)) {
    const rows = [
      ...(FIELDS_BY_TAB[tab] || []),
      ...(dynamicFieldsByTab[tab] || []),
      ...(userCustomFields[tab] || []),
    ]
      .map((field) => buildCanonicalLeaseReviewField(lease, field, tab))
      .filter(Boolean);
    byTab[tab] = rows;
  }

  for (const [tab, fields] of Object.entries(dynamicFieldsByTab)) {
    if (byTab[tab]) continue;
    byTab[tab] = fields
      .map((field) => buildCanonicalLeaseReviewField(lease, field, tab))
      .filter(Boolean);
  }

  for (const [tab, fields] of Object.entries(userCustomFields || {})) {
    if (byTab[tab]) continue;
    byTab[tab] = fields
      .map((field) => buildCanonicalLeaseReviewField(lease, field, tab))
      .filter(Boolean);
  }

  return byTab;
}

export function buildLeaseReviewRows(lease, options = {}) {
  return Object.values(buildLeaseReviewRowsByTab(lease, options)).flat();
}

export function isReviewRowDisplayable(row, { showMissing = false } = {}) {
  const hasValue = isMeaningfulValue(row?.normalized_value ?? row?.value);
  const hasSource = Boolean(cleanSourceEvidenceText(row?.source_text ?? row?.source_clause));
  const hasReviewBlocker = Boolean(
    row?.requires_review ||
    row?.review_reason ||
    row?.requires_review_reason ||
    row?.approval_blocking_reason ||
    isManualExtractionStatus(row?.extraction_status || row?.status),
  );
  const isDerivedOrInferred = ["derived", "inferred", "conflict"].includes(String(row?.evidence_type || "").toLowerCase())
    || ["calculated", "derived", "computed", "inferred", "conflict_detected"].includes(String(row?.extraction_status || row?.status || "").toLowerCase());
  if (showMissing) {
    if (row?.is_dynamic || row?.dynamic_document_item) return hasValue || hasSource;
    return Boolean(row?.required) || hasValue || hasSource;
  }
  // Extracted-only mode is the reviewer-facing lease abstract. Keep absent
  // fixed fields out of this view; they remain visible through Show missing
  // fields, the required-review queue, and approval blockers. Rows with a
  // source clause but rejected/blank value still show so reviewers can fix bad
  // normalization without rereading the PDF.
  return hasValue || hasSource || isDerivedOrInferred;
}
