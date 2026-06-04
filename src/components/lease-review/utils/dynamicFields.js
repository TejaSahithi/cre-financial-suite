import {
  LEASE_REVIEW_FIELDS,
  hasValidSourceEvidence,
  isCalculatedExtractionStatus,
  isManualExtractionStatus,
  canAcceptCalculatedReviewField,
  cleanSourceEvidenceText,
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
      const statusEvidence = { sourcePage, sourceText };
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
        raw_value: typeof entry === "object" && entry ? entry.raw_value ?? entry.rawValue ?? value : value,
        source_text: sourceText,
        source_page: sourcePage,
        confidence,
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
      fieldMapItems.push({
        item_id: `${sourceName}:${key}`,
        label: clause?.label || clause?.clause_label || titleizeFieldKey(clauseType),
        item_type: clauseType,
        field_key: key,
        business_area: category,
        display_tab: inferDynamicItemTab({ business_area: category }, clauseType) || "legal_options",
        value,
        normalized_value: value,
        raw_value: clause?.raw_value ?? value,
        source_text: sourceText,
        source_page: sourcePage,
        confidence: typeof clause?.confidence === "number" ? clause.confidence : null,
        extraction_method: sourceName,
        extraction_status: sourceText ? "extracted" : "missing_source_evidence",
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
  const seen = new Set();
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
    if (!key || !createsDynamicRow || seen.has(key)) continue;
    // Fall back to legal_options for any item inferDynamicItemTab can't route.
    // This prevents extracted fields (e.g. force_majeure, jury_trial_waiver,
    // attorneys_fees) from being silently dropped — every extracted item with
    // a value or source text must be visible somewhere.
    const tab = inferDynamicItemTab(item, key) || "legal_options";
    if (tab === "clause_records") continue;
    seen.add(key);
    if (!byTab[tab]) byTab[tab] = [];
    byTab[tab].push({
      key,
      label: item?.label || titleizeFieldKey(item?.section_title || item?.field_key || item?.item_type || key),
      tab,
      type: inferDynamicItemType(item, key),
      allowNA: true,
      allowCalculatedAccept: canAcceptCalculatedReviewField({ key }),
      dynamic_document_item: true,
    });
  }
  return byTab;
}
