/**
 * LeaseReview field normalizer — the single place that computes every "wide
 * payload-path union" the grouped Lease Review UI needs, so every consuming
 * section reads from ONE normalized object instead of each re-deriving its
 * own union. That duplication is exactly how the ExtractionDebugPanel count
 * mismatch happened (its own narrower union disagreeing with the real
 * Clause Records/Dynamic Findings unions) — see docs/lease-standard-field-model.md
 * and this task's plan for the full writeup.
 *
 * Built entirely on top of existing, working code:
 *   - readFieldValue/readFieldEvidence/readFieldConfidence/resolveExtractionStatus/
 *     hasValidSourceEvidence/classifyConfidence/normalizeClauseType/isMeaningfulValue
 *     (src/lib/leaseReviewSchema.js) — the canonical resolver, untouched.
 *   - collectExtractedDocumentItems (src/components/lease-review/utils/dynamicFields.js)
 *     — the existing dynamic-item collector, untouched.
 *   - src/lib/leaseFieldContract.js — the 17-group canonical field list.
 *
 * No new payload-path invention beyond what SpecializedTables.jsx's own
 * fallbackClauses already checked (that logic is ported here verbatim, not
 * rewritten, so ClauseRecordsTable's behavior doesn't change).
 */

import {
  readFieldValue,
  readFieldEvidence,
  readFieldConfidence,
  resolveExtractionStatus,
  hasValidSourceEvidence,
  classifyConfidence,
  normalizeClauseType,
  isMeaningfulValue,
  REVIEW_STATUSES,
  EXTRACTION_STATUSES,
} from "@/lib/leaseReviewSchema";
import { collectExtractedDocumentItems } from "@/components/lease-review/utils/dynamicFields";
import { LEASE_FIELD_CONTRACT, getFieldContract } from "@/lib/leaseFieldContract";

function titleize(key) {
  return String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim() || "Untitled";
}

// ── Standard fields ───────────────────────────────────────────────────────

function describeApprovalImpact(contract) {
  const parts = [];
  if (contract.requiredForApproval) parts.push("blocks core approval readiness");
  if (contract.requiredForCam) parts.push("required for CAM calculation");
  if (contract.requiredForBudget) parts.push("required for Budget handoff");
  if (contract.requiredByDocumentProfile?.length) {
    parts.push(`blocks approval for: ${contract.requiredByDocumentProfile.join(", ")}`);
  }
  return parts.length ? parts.join("; ") : "Advisory only — no downstream gate today.";
}

function computeFieldStatus({ hasValue, evidenceVerified, confidenceBucket, reviewStatus, extractionStatus }) {
  if (reviewStatus === REVIEW_STATUSES.EDITED) return "manually_edited";
  if (extractionStatus === EXTRACTION_STATUSES.CONFLICT) return "rejected";
  if (!hasValue) return "missing";
  if (evidenceVerified && confidenceBucket === "high") return "auto_populated";
  return "needs_review";
}

/**
 * One row per LEASE_FIELD_CONTRACT entry that's a real, directly-extractable
 * LEASE_SCHEMA field (skips `computed: true` entries like tenant_pro_rata_share
 * and row-level, non-field entries like document_profile/approval_status —
 * those are surfaced separately, see normalizeApprovalBlockers).
 */
export function normalizeStandardFields(lease, { fieldReviews = {} } = {}) {
  const rows = [];
  for (const contract of LEASE_FIELD_CONTRACT) {
    if (contract.computed || !contract.inLeaseSchema) continue;
    const canonicalKey = contract.canonicalKey;
    const value = readFieldValue(lease, canonicalKey);
    const evidence = readFieldEvidence(lease, canonicalKey);
    const confidence = readFieldConfidence(lease, canonicalKey);
    const extractionStatus = resolveExtractionStatus(lease, canonicalKey, { value, confidence, evidence });
    const evidenceVerified = hasValidSourceEvidence(evidence);
    const review = fieldReviews?.[canonicalKey];
    const hasValue = isMeaningfulValue(value);

    rows.push({
      fieldKey: canonicalKey,
      canonicalKey,
      label: contract.label,
      group: contract.group,
      value,
      normalizedValue: value,
      confidence,
      status: computeFieldStatus({
        hasValue,
        evidenceVerified,
        confidenceBucket: classifyConfidence(confidence),
        reviewStatus: review?.status,
        extractionStatus,
      }),
      sourcePage: evidence?.sourcePage ?? null,
      sourceText: evidence?.sourceText ?? null,
      evidenceVerified,
      requiredForApproval: Boolean(contract.requiredForApproval),
      requiredForCam: Boolean(contract.requiredForCam),
      requiredForBudget: Boolean(contract.requiredForBudget),
      approvalImpact: describeApprovalImpact(contract),
      validationMessage: evidence?.reviewReason ?? evidence?.approvalBlockingReason ?? null,
      sourceProvider: evidence?.extractionStatus
        ?? lease?.extraction_data?.workflow_output?.extraction_provider
        ?? "unknown",
    });
  }
  return rows;
}

export function getStandardFieldsByGroup(standardFields, group) {
  return standardFields.filter((row) => row.group === group);
}

// ── Dynamic findings ─────────────────────────────────────────────────────

/**
 * Facts extracted but not mapped to a standard field. Reuses
 * collectExtractedDocumentItems() (dynamicFields.js) — not reimplemented —
 * plus the vertex_fact_ledger-only diagnostic path your spec named
 * explicitly (additive; empty for legacy_hybrid leases, the live default).
 */
export function normalizeDynamicFindings(lease) {
  const collected = collectExtractedDocumentItems(lease) || [];
  const vertexItems =
    lease?.uploaded_files?.ui_review_payload?.metadata?.extractionDebug?.vertex_fact_ledger?.dynamic_items
    ?? lease?.uploaded_file?.ui_review_payload?.metadata?.extractionDebug?.vertex_fact_ledger?.dynamic_items
    ?? [];
  const merged = [...collected, ...(Array.isArray(vertexItems) ? vertexItems : [])];

  const seen = new Set();
  const rows = [];
  for (const item of merged) {
    if (!item || typeof item !== "object") continue;
    if (item.maps_to_existing_field) continue; // genuinely unmapped only
    const sourceText = item.source_text ?? item.exact_source_text ?? null;
    const dedupeKey = `${item.item_type || item.field_key || ""}|${String(sourceText || item.value || "").toLowerCase().slice(0, 140)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    rows.push({
      label: item.label || titleize(item.item_type || item.field_key || "Finding"),
      category: item.business_area || item.display_tab || item.item_type || "unknown_needs_review",
      value: item.normalized_value ?? item.value ?? null,
      sourcePage: item.source_page ?? item.page_number ?? null,
      sourceText,
      confidence: typeof item.confidence === "number" ? item.confidence : null,
      mapsToExistingField: Boolean(item.maps_to_existing_field),
      createsDynamicRow: item.creates_dynamic_row !== false,
    });
  }
  return rows;
}

// ── Clause records ────────────────────────────────────────────────────────

function cleanDocumentItemSource(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/^(llm extracted|extracted|manual_review|not found|unknown|n\/a|na|null)$/i.test(text)) return null;
  if (text.toLowerCase().includes("derived from")) return null;
  if (/^[a-z][a-z0-9_]*_[a-z0-9_]*\s*:\s*/i.test(text)) return null;
  if (/^[a-z][a-z0-9_]{2,60}$/i.test(text)) return null;
  return text;
}

function looksLikeClauseEvidence(value) {
  const text = cleanDocumentItemSource(value);
  if (!text) return false;
  if (text.length > 180) return true;
  return /\b(?:summary of basic lease information|this lease|article\s+\d+|section\s+\d+|tenant shall|landlord shall|premises|rent:|security deposit|common area|operating expense|insurance|utilities|maintenance|repairs?)\b/i.test(text);
}

function documentItemSource(item) {
  if (!item || typeof item !== "object") return null;
  return cleanDocumentItemSource(
    item.source_text
      || item.exact_source_text
      || item.source_clause
      || item.exact_text
      || item.clause_text
      || item.snippet
      || (looksLikeClauseEvidence(item.normalized_value ?? item.value ?? item.raw_value ?? item.rawValue)
        ? item.normalized_value ?? item.value ?? item.raw_value ?? item.rawValue
        : null),
  );
}

function documentItemValue(item) {
  if (!item || typeof item !== "object") return null;
  const value = item.normalized_value ?? item.normalizedValue ?? item.normalized_meaning ?? item.normalizedMeaning ?? item.value ?? item.raw_value ?? item.rawValue ?? null;
  return looksLikeClauseEvidence(value) ? null : value;
}

/**
 * Ported verbatim from SpecializedTables.jsx's `fallbackClauses` useMemo body
 * (same 24-path union, same cleanDocumentItemSource gating, same dedupe) —
 * extracted as a plain function so it isn't coupled to a React hook and can
 * be shared by ClauseRecordsTable, Dynamic Findings, and the debug panel.
 * ClauseRecordsTable still layers the DB-backed `lease_clauses` table rows
 * on top of this (that query stays async/component-local; this function
 * only covers the synchronous payload-derived fallback).
 */
export function computeFallbackClauseRows(lease) {
  const rawWorkflowOutput = lease?.extraction_data?.workflow_output || {};
  const workflowOutput = rawWorkflowOutput.workflow_output || rawWorkflowOutput;
  const ufPayload = lease?.uploaded_files?.ui_review_payload || lease?.uploaded_file?.ui_review_payload || {};
  const ufMetaWorkflow = ufPayload?.metadata?.workflow_output || {};
  const ufWorkflowOutput = ufMetaWorkflow.workflow_output || ufMetaWorkflow;
  const ufRecordOutput = (ufPayload?.records || ufPayload?.rows || [])[0]?.workflow_output || {};
  const recordOutput = Array.isArray(rawWorkflowOutput.records) ? rawWorkflowOutput.records[0] || {} : {};

  const fromWorkflow = workflowOutput?.lease_clauses;
  const fromTopLevel = lease?.extraction_data?.lease_clauses;
  const fromUploadMeta = ufWorkflowOutput?.lease_clauses;
  const fromUploadRecord = ufRecordOutput?.lease_clauses;

  const itemRows = [
    workflowOutput.extracted_document_items,
    workflowOutput.clause_records,
    recordOutput.extracted_document_items,
    recordOutput.clause_records,
    rawWorkflowOutput.extracted_document_items,
    rawWorkflowOutput.clause_records,
    lease?.extraction_data?.extracted_document_items,
    lease?.extraction_data?.clause_records,
    ufWorkflowOutput.extracted_document_items,
    ufWorkflowOutput.clause_records,
    ufRecordOutput.extracted_document_items,
    ufRecordOutput.clause_records,
    collectExtractedDocumentItems(lease),
  ].flatMap((rows) => (Array.isArray(rows) ? rows : []));

  const fieldMapRows = [
    workflowOutput.lease_fields,
    recordOutput.lease_fields,
    lease?.extraction_data?.fields,
    ufWorkflowOutput.lease_fields,
    ufRecordOutput.lease_fields,
  ].flatMap((map, mapIdx) => {
    if (!map || typeof map !== "object" || Array.isArray(map)) return [];
    return Object.entries(map).map(([key, entry]) => ({
      item_id: `field-map-${mapIdx}-${key}`,
      item_type: key,
      label: titleize(key),
      business_area: "clause_records",
      source_text: documentItemSource(entry),
      source_page: entry?.source_page ?? entry?.page_number ?? entry?.page ?? null,
      confidence: entry?.confidence_score ?? entry?.confidence ?? null,
      normalized_value: documentItemValue(entry),
      value: documentItemValue(entry),
      extraction_status: entry?.extraction_status ?? null,
    }));
  });

  const list = [fromWorkflow, fromTopLevel, fromUploadMeta, fromUploadRecord, recordOutput.lease_clauses]
    .flatMap((rows) => (Array.isArray(rows) ? rows : []));
  const clauseRows = list
    .map((c, idx) => ({
      id: c.id || c.item_id || `extract-${idx}`,
      clause_type: normalizeClauseType(c.clause_type || c.type || c.item_type || "clause_records"),
      clause_title: c.clause_title || c.title || c.label || c.section_title || "Extracted Clause",
      clause_text: cleanDocumentItemSource(c.clause_text || c.exact_text || c.exact_source_text || c.source_text || c.source_clause),
      source_page: c.source_page ?? c.page_number ?? c.page ?? null,
      confidence_score: c.confidence_score ?? c.confidence ?? null,
      structured_fields_json: c.structured_fields_json || {
        normalized_meaning: c.normalized_meaning || c.normalized_value || c.value || null,
        evidence_type: c.evidence_type || null,
        requires_review: c.requires_review ?? null,
      },
    }))
    .filter((row) => cleanDocumentItemSource(row.clause_text));

  const discoveredRows = [...itemRows, ...fieldMapRows]
    .filter((item) => documentItemSource(item))
    .map((item, idx) => {
      const semanticType = String(item.item_type || item.field_key || item.clause_type || item.business_area || item.display_tab || "clause_records").replace(/^clause[_-]/i, "");
      return {
        id: item.item_id || item.id || `document-item-${idx}`,
        is_document_item: true,
        clause_type: normalizeClauseType(semanticType),
        clause_title: item.label || item.section_title || item.item_type || item.field_key || "Discovered Field",
        clause_text: documentItemSource(item),
        source_page: item.source_page ?? item.page_number ?? item.page ?? null,
        confidence_score: item.confidence_score ?? item.confidence ?? null,
        structured_fields_json: {
          item_type: item.item_type || null,
          display_tab: item.display_tab || null,
          value: documentItemValue(item),
          extraction_status: item.extraction_status || null,
          evidence_type: item.evidence_type || null,
          maps_to_fixed_field: item.maps_to_fixed_field ?? null,
          creates_dynamic_row: item.creates_dynamic_row ?? null,
        },
      };
    });

  const dedupedDiscovered = [];
  const seenDiscovered = new Set();
  for (const row of discoveredRows) {
    const key = `${row.clause_title}|${row.source_page ?? ""}|${row.clause_text}`;
    if (seenDiscovered.has(key)) continue;
    seenDiscovered.add(key);
    dedupedDiscovered.push(row);
  }

  return [...clauseRows, ...dedupedDiscovered];
}

/** Phase-6 UI shape, sync/payload-only (no `lease_clauses` DB table rows —
 *  ClauseRecordsTable layers those in separately since that query is async). */
export function normalizeClauseRecords(lease) {
  const rows = computeFallbackClauseRows(lease).filter((c) => cleanDocumentItemSource(c.clause_text));
  return rows.map((c) => ({
    clauseType: c.clause_type,
    title: c.clause_title,
    summary: c.clause_text,
    sourcePage: c.source_page ?? null,
    sourceText: c.clause_text,
    confidence: c.confidence_score ?? null,
    businessArea: c.structured_fields_json?.display_tab || c.clause_type,
    reviewStatus: c.structured_fields_json?.requires_review ? "needs_review" : "pending",
  }));
}

// ── CAM / Expense rules ───────────────────────────────────────────────────

function normalizeExpenseRuleShape(rule) {
  return {
    category: rule?.expense_category ?? rule?.category ?? rule?.normalized_key ?? "unknown",
    recoverable: rule?.recoverable_from_tenant ?? rule?.recoverable_flag ?? rule?.is_recoverable ?? null,
    allocationMethod: rule?.recovery_method ?? rule?.allocation_method ?? null,
    cap: rule?.cap_percent ?? rule?.cam_cap_pct ?? null,
    floor: rule?.floor_percent ?? rule?.floor ?? null,
    adminFeePercent: rule?.admin_fee_percent ?? rule?.admin_fee_pct ?? null,
    exclusions: rule?.exclusions ?? rule?.excluded_items ?? null,
    sourcePage: rule?.source_page ?? rule?.page_number ?? null,
    sourceText: rule?.exact_source_text ?? rule?.source_clause ?? rule?.source_text ?? null,
    confidence: rule?.confidence_score ?? rule?.confidence ?? null,
    needsReview: (rule?.review_status ?? rule?.row_status ?? "").toLowerCase() === "needs_review"
      || Boolean(rule?.requires_review),
  };
}

/** Rich path: already-loaded, already-normalized DB expense-rule rows (via
 *  leaseExpenseRuleService.loadRuleSet()/normalizeLeaseExpenseRule(), the
 *  same service ExpenseRulesTable/CamRulesTable already use) — reused, not
 *  reimplemented. Call this with the rows your data hook already loaded. */
export function normalizeExpenseRuleRows(rules) {
  return (Array.isArray(rules) ? rules : []).map(normalizeExpenseRuleShape);
}

/** Sync-only fallback (workflow_output.expense_rules), for contexts with no
 *  DB query available (debug counts, tests) — mirrors what ExpenseRulesTable
 *  itself falls back to when the lease_expense_rules table is empty. */
export function normalizeExpenseRuleFallback(lease) {
  const rawWorkflowOutput = lease?.extraction_data?.workflow_output || {};
  const workflowOutput = rawWorkflowOutput.workflow_output || rawWorkflowOutput;
  const rules = workflowOutput?.expense_rules;
  return normalizeExpenseRuleRows(rules);
}

// ── Critical dates ────────────────────────────────────────────────────────

const CRITICAL_DATE_KEYS = [
  "lease_date",
  "commencement_date",
  "rent_commencement_date",
  "expiration_date",
  "renewal_notice_months",
  "termination_notice_months",
  "option_exercise_deadline",
];

/** The fixed CriticalDatesTable checklist, sourced from the already-computed
 *  standardFields rows (no re-resolution) for parity with the existing table. */
export function normalizeCriticalDates(standardFields) {
  const byKey = new Map(standardFields.map((row) => [row.canonicalKey, row]));
  return CRITICAL_DATE_KEYS.map((key) => byKey.get(key)).filter(Boolean);
}

// ── Advisory approval blockers ────────────────────────────────────────────

function readDocumentProfile(lease) {
  const rawWorkflowOutput = lease?.extraction_data?.workflow_output || {};
  const workflowOutput = rawWorkflowOutput.workflow_output || rawWorkflowOutput;
  return workflowOutput?.document_profile ?? workflowOutput?.selected_document_profile ?? null;
}

function readServerApprovalBlockers(lease) {
  const ufPayload = lease?.uploaded_files?.ui_review_payload || lease?.uploaded_file?.ui_review_payload || null;
  const fromTopLevel = ufPayload?.approval_blockers;
  const fromVertex = ufPayload?.metadata?.extractionDebug?.vertex_fact_ledger?.approval_blockers;
  const rawWorkflowOutput = lease?.extraction_data?.workflow_output || {};
  const workflowOutput = rawWorkflowOutput.workflow_output || rawWorkflowOutput;
  const fromWorkflow = workflowOutput?.approval_blockers;
  const list = fromTopLevel ?? fromVertex ?? fromWorkflow ?? null;
  return Array.isArray(list) ? list : null;
}

/**
 * Advisory-only, never enforced. Prefers real backend-computed blockers
 * (currently only populated under vertex_fact_ledger, not the live default)
 * and falls back to a client-side, clearly-labeled estimate built purely
 * from field-contract requiredByDocumentProfile flags against the
 * already-normalized standardFields — so this section shows real,
 * profile-aware content for legacy_hybrid leases too, without inventing any
 * new backend logic or enforcing anything.
 */
export function normalizeApprovalBlockers(lease, standardFields) {
  const documentProfile = readDocumentProfile(lease);
  const serverBlockers = readServerApprovalBlockers(lease);

  if (serverBlockers) {
    return {
      documentProfile,
      source: "server",
      missingFields: serverBlockers.map((b) => b.fieldKey ?? b.field_key ?? b.label ?? String(b)),
      warnings: [],
      budgetBlockers: [],
      camBlockers: [],
    };
  }

  // Client-side advisory estimate: which fields does the field contract say
  // are required for THIS document's profile, and are they populated?
  const byKey = new Map(standardFields.map((row) => [row.canonicalKey, row]));
  const missingFields = [];
  const budgetBlockers = [];
  const camBlockers = [];
  for (const contract of LEASE_FIELD_CONTRACT) {
    if (!contract.inLeaseSchema || contract.computed) continue;
    const appliesToProfile = documentProfile
      ? contract.requiredByDocumentProfile?.includes(documentProfile)
      : false;
    const row = byKey.get(contract.canonicalKey);
    const hasValue = row ? isMeaningfulValue(row.value) : false;
    if (appliesToProfile && !hasValue) missingFields.push(contract.canonicalKey);
    if (contract.requiredForBudget && !hasValue) budgetBlockers.push(contract.canonicalKey);
    if (contract.requiredForCam && !hasValue) camBlockers.push(contract.canonicalKey);
  }

  return {
    documentProfile,
    source: "client_estimate",
    missingFields,
    warnings: documentProfile ? [] : ["Document profile not classified — advisory estimate uses no profile filter (all fields advisory)."],
    budgetBlockers,
    camBlockers,
  };
}

// ── Debug counts ───────────────────────────────────────────────────────────

export function buildDebugCounts({ standardFields, dynamicFindings, clauseRecords, expenseRules, criticalDates, approvalBlockers }) {
  return {
    standard_fields_total: standardFields.length,
    standard_fields_populated: standardFields.filter((f) => isMeaningfulValue(f.value)).length,
    standard_fields_source_backed: standardFields.filter((f) => f.evidenceVerified).length,
    dynamic_findings_count: dynamicFindings.length,
    clause_records_count: clauseRecords.length,
    expense_rules_count: expenseRules.length,
    critical_dates_count: criticalDates.length,
    approval_blockers_count: approvalBlockers.missingFields.length + approvalBlockers.warnings.length,
  };
}

// ── Top-level ────────────────────────────────────────────────────────────

/**
 * The single normalized view of a lease's review data. Synchronous —
 * DB-backed data (lease_clauses table rows, lease_expense_rules table rows)
 * is NOT included here; those stay in their existing async react-query hooks
 * and get layered on top by the components that already load them
 * (ClauseRecordsTable, ExpenseRulesTable/CamRulesTable). This function
 * covers everything derivable from the `lease` object alone.
 */
export function normalizeLeaseReviewData(lease, { fieldReviews = {} } = {}) {
  const standardFields = normalizeStandardFields(lease, { fieldReviews });
  const dynamicFindings = normalizeDynamicFindings(lease);
  const clauseRecords = normalizeClauseRecords(lease);
  const expenseRules = normalizeExpenseRuleFallback(lease);
  const criticalDates = normalizeCriticalDates(standardFields);
  const approvalBlockers = normalizeApprovalBlockers(lease, standardFields);
  const debugCounts = buildDebugCounts({ standardFields, dynamicFindings, clauseRecords, expenseRules, criticalDates, approvalBlockers });

  return { standardFields, dynamicFindings, clauseRecords, expenseRules, criticalDates, approvalBlockers, debugCounts };
}
