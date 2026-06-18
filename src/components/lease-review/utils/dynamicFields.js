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

// Single canonical implementation — delegates to leaseReviewSchema so both
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
  // uploaded file — available immediately after extraction, before any backfill
  // or approval has written workflow data back onto the lease row.
  const ufPayload =
    lease?.uploaded_files?.ui_review_payload ||
    lease?.uploaded_file?.ui_review_payload;
  const ufWfMeta = ufPayload?.metadata?.workflow_output;
  const ufWfRecord = (ufPayload?.records || ufPayload?.rows || [])[0]?.workflow_output;
  const ufWf = ufWfRecord || ufWfMeta || {};

  const workflowOutput = (
    Object.keys(lease?.extraction_data?.workflow_output || {}).length > 0
      ? lease.extraction_data.workflow_output
      : ufWf
  );
  const recordOutput = Array.isArray(workflowOutput.records) ? workflowOutput.records[0] || {} : {};
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
      const displayTab = category && category !== "clause_records"
        ? inferDynamicItemTab({ business_area: category }, key) || category
        : "clause_records";
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
  // Insurance — must come before rent_charges so "liability" and "certificate"
  // are not swallowed by the generic "fee/charge" pattern.
  if (/(insurance|insured|deductible|liability|subrogation|waiver_of_sub|additional_insured|certificate)/i.test(key)) return "insurance";
  // CAM — must come before rent_charges so "admin_fee" / "management_fee" /
  // "gross_up" are not swallowed by the generic "fee/percent" pattern.
  if (/(gross_up|cam_|admin_fee|management_fee|base_year|reconciliation|controllable|cam.cap|cam.pool)/i.test(key)) return "cam_rules";
  // Rent & charges: rent, deposit, allowance, late fees, holdover, etc.
  if (/(rent|fee|deposit|allowance|charge|amount|payment|holdover|interest|premium|breakpoint|percentage|consideration|security)/i.test(key)) return "rent_charges";
  // Expense / recovery terms: taxes, utilities, maintenance, repairs, janitorial,
  // full-service/gross/NNN/net lease structure, operating expenses, reimbursements.
  if (/(tax|utilit|maintenance|repair|expense|operating|reimburs|recovery|recoveries|janitorial|cleaning|sanitation|full.service|gross.lease|full_service|nnn|triple.net|net.lease|modified.gross|lease.structure|lease.type|expense.structure|responsibility)/i.test(key)) return "expenses_recoveries";
  if (/(assign|consent|assumption|default|remed|surrender|alteration|sublet|broker|estoppel|subordination|notice|rofr|termination|exclusive|noncompete|non_compete|co_tenancy|relocation)/i.test(key)) return "legal_options";
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
    // attorneys_fees) from being silently dropped — every extracted item with
    // a value or source text must be visible somewhere.
    const tab = inferDynamicItemTab(item, key) || "legal_options";
    if (tab === "clause_records") continue;
    const signature = [
      item?.item_id || "",
      key,
      normalizeSourcePage(item?.source_page ?? item?.page_number ?? item?.page) ?? "",
      String(value ?? "").slice(0, 100),
      String(sourceText ?? "").slice(0, 160),
    ].join("|");
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

function combineSourceText(...items) {
  const texts = items
    .map((item) => cleanSourceEvidenceText(item?.sourceText ?? item?.source_text ?? item?.sourceClause ?? item?.source_clause))
    .filter(Boolean);
  return [...new Set(texts)].join("\n");
}

function buildDerivedFieldEvidence(lease, key, currentValue) {
  const monthlyEvidence = readFieldEvidence(lease, "monthly_rent");
  const monthlyRent = parseNumber(readFieldValue(lease, "monthly_rent"));
  const sfEvidence = readFieldEvidence(lease, "square_footage");
  const squareFootage = parseNumber(readFieldValue(lease, "square_footage"));
  const monthlyHasSource = hasValidSourceEvidence({ ...monthlyEvidence, value: monthlyRent });
  const sfHasSource = hasValidSourceEvidence({ ...sfEvidence, value: squareFootage });

  if (key === "annual_rent" && !isMeaningfulValue(currentValue) && monthlyRent != null && monthlyHasSource) {
    return {
      value: Math.round(monthlyRent * 12 * 100) / 100,
      sourceText: monthlyEvidence.sourceText,
      sourcePage: monthlyEvidence.sourcePage,
      evidenceType: "derived",
      sourceTextQuality: "derived",
      sourceFieldKeys: ["monthly_rent"],
      derivationTrace: `annual_rent = monthly_rent (${monthlyRent}) x 12`,
      extractionStatus: "calculated",
    };
  }

  if (key === "rent_per_sf") {
    const annualRent = parseNumber(readFieldValue(lease, "annual_rent")) ?? (monthlyRent != null ? monthlyRent * 12 : null);
    const currentRentPerSf = parseNumber(readFieldValue(lease, "rent_per_sf"));
    if (!isMeaningfulValue(currentRentPerSf) && annualRent != null && squareFootage != null && squareFootage > 0 && (monthlyHasSource || hasValidSourceEvidence(readFieldEvidence(lease, "annual_rent"))) && sfHasSource) {
      return {
        value: Math.round((annualRent / squareFootage) * 100) / 100,
        sourceText: combineSourceText(monthlyEvidence, sfEvidence) || monthlyEvidence.sourceText || sfEvidence.sourceText,
        sourcePage: monthlyEvidence.sourcePage ?? sfEvidence.sourcePage,
        evidenceType: "derived",
        sourceTextQuality: "derived",
        sourceFieldKeys: ["annual_rent", "monthly_rent", "square_footage"],
        derivationTrace: `rent_per_sf = annual_rent (${annualRent}) / square_footage (${squareFootage})`,
        extractionStatus: "calculated",
      };
    }
  }

  if (key === "billing_frequency" && !isMeaningfulValue(currentValue) && monthlyRent != null && monthlyHasSource) {
    return {
      value: "monthly",
      sourceText: monthlyEvidence.sourceText,
      sourcePage: monthlyEvidence.sourcePage,
      evidenceType: "derived",
      sourceTextQuality: "derived",
      sourceFieldKeys: ["monthly_rent"],
      derivationTrace: "billing_frequency inferred from monthly_rent",
      extractionStatus: "calculated",
    };
  }

  return null;
}

export function buildCanonicalLeaseReviewField(lease, field, tabKey) {
  const key = field?.key || field?.field_key;
  if (!key) return null;

  const initialValue = field.normalized_value ?? field.value ?? readFieldValue(lease, key);
  const derived = buildDerivedFieldEvidence(lease, key, initialValue);
  const schemaValue = derived?.value ?? initialValue;
  const evidence = readFieldEvidence(lease, key);
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
  const confidence = typeof field.confidence === "number"
    ? field.confidence
    : readFieldConfidence(lease, key, null);
  const statusEvidence = {
    sourcePage,
    sourceText,
    rawValue: field.raw_value ?? field.rawValue ?? evidence.rawValue ?? schemaValue,
    value: schemaValue,
    extractionStatus: field.status ?? field.extraction_status ?? derived?.extractionStatus ?? evidence.extractionStatus,
    evidenceType: field.evidence_type ?? field.evidenceType ?? derived?.evidenceType ?? evidence.evidenceType,
    sourceTextQuality: field.source_text_quality ?? field.sourceTextQuality ?? derived?.sourceTextQuality ?? evidence.sourceTextQuality,
    sourceFieldKeys: field.source_field_keys ?? field.sourceFieldKeys ?? derived?.sourceFieldKeys ?? evidence.sourceFieldKeys,
    derivationTrace: field.derivation_trace ?? field.derivationTrace ?? derived?.derivationTrace ?? evidence.derivationTrace,
  };
  const sourceTextQuality = resolveSourceTextQuality(statusEvidence);
  const evidenceType = normalizeEvidenceType(statusEvidence.evidenceType ?? statusEvidence.extractionStatus, {
    value: schemaValue,
    sourceText,
    sourceTextQuality,
    sourceFieldKeys: statusEvidence.sourceFieldKeys,
    derivationTrace: statusEvidence.derivationTrace,
  });
  const resolvedStatus = field.status
    ?? field.extraction_status
    ?? derived?.extractionStatus
    ?? resolveExtractionStatus(lease, key, {
      value: schemaValue,
      confidence,
      evidence: statusEvidence,
    });
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
      reviewReason ||
      evidenceType === "inferred",
  );
  const status = requiredMissing && !isManualExtractionStatus(resolvedStatus)
    ? "manual_required"
    : resolvedStatus;

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
  return hasValue || hasSource || isDerivedOrInferred || (Boolean(row?.required) && hasReviewBlocker);
}
