/**
 * leaseAbstractService — writes the approved-lease-abstract data model
 * introduced in migration 20260514120000_approved_lease_abstract.sql.
 *
 * The Phase 2 review workspace persists field reviews into
 * `leases.extraction_data.field_reviews` (additive JSONB). This service
 * promotes those reviews into:
 *   - `lease_field_reviews` rows (one per field, SQL-indexable)
 *   - dedicated columns on `leases` (abstract_status, abstract_version,
 *     abstract_approved_at, abstract_approved_by, abstract_snapshot)
 *
 * Both the JSONB and the new columns are written so old code that still
 * reads `extraction_data` keeps working during the transition.
 */
import { supabase } from "@/services/supabaseClient";
import { resolveLeaseField, resolveLeaseFields } from "@/lib/leaseFieldResolver";
import {
  readFieldConfidence,
  readFieldEvidence,
  readFieldValue,
  resolveFieldColumns,
  LEASE_REVIEW_FIELDS,
  NUMERIC_REVIEW_FIELDS,
} from "@/lib/leaseReviewSchema";

export const ABSTRACT_STATUS = {
  DRAFT: "draft",
  PENDING_REVIEW: "pending_review",
  APPROVED: "approved",
  REJECTED: "rejected",
  SUPERSEDED: "superseded",
};

const autoApproveAcceptedExpenseRules = false;

function extractMissingColumn(err) {
  const message = [err?.message, err?.details, err?.hint].filter(Boolean).join(" ");
  if (!message) return null;
  let match = message.match(/Could not find the '([^']+)' column/i);
  if (match?.[1]) return match[1];
  match = message.match(/column ["']?([a-zA-Z0-9_]+)["']?/i);
  if (match?.[1]) return match[1];
  return null;
}

function isMissingColumnError(err) {
  return (
    err?.code === "PGRST204" ||
    err?.code === "42703" ||
    !!extractMissingColumn(err)
  );
}

/**
 * Run a lease UPDATE, stripping any columns that PostgREST/Postgres reports
 * as missing. This protects approval/draft flows when the target Supabase
 * schema is behind on migrations (e.g. approval_comments, abstract_status
 * columns haven't been added yet).
 */
async function updateLeaseStripMissing(leaseId, payload) {
  let workingPayload = { ...payload };
  const stripped = [];
  while (true) {
    const { data, error } = await supabase
      .from("leases")
      .update(workingPayload)
      .eq("id", leaseId)
      .select()
      .single();
    if (!error) {
      if (stripped.length > 0) {
        console.warn(
          "[leaseAbstractService] stripped unsupported columns:",
          stripped.join(", "),
        );
      }
      return data;
    }
    const missingColumn = extractMissingColumn(error);
    if (!isMissingColumnError(error) || !missingColumn || !(missingColumn in workingPayload)) {
      throw error;
    }
    stripped.push(missingColumn);
    delete workingPayload[missingColumn];
    if (Object.keys(workingPayload).length === 0) throw error;
  }
}

function toText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Upsert one row into lease_field_reviews per field key in `fieldReviews`.
 * Returns the inserted/updated rows.
 */
export async function persistFieldReviews({ lease, fieldReviews, reviewer }) {
  if (!lease?.id || !lease?.org_id) return [];
  const rows = Object.entries(fieldReviews || {}).map(([fieldKey, review]) => {
    const { rawValue, sourcePage, sourceText } = readFieldEvidence(lease, fieldKey);
    const value = review?.value !== undefined ? review.value : readFieldValue(lease, fieldKey);
    const confidence = readFieldConfidence(lease, fieldKey);
    return {
      org_id: lease.org_id,
      lease_id: lease.id,
      field_key: fieldKey,
      status: review?.status || "pending",
      normalized_value: toText(value),
      raw_value: toText(rawValue),
      source_page: typeof sourcePage === "number" ? sourcePage : null,
      source_text: toText(sourceText),
      confidence: typeof confidence === "number" ? confidence : null,
      note: review?.note || null,
      reviewer: review?.reviewer || reviewer || null,
      reviewed_at: review?.reviewed_at || new Date().toISOString(),
    };
  });
  if (rows.length === 0) return [];
  const { data, error } = await supabase
    .from("lease_field_reviews")
    .upsert(rows, { onConflict: "lease_id,field_key" })
    .select();
  if (error) {
    // Table not present yet (older schema) — don't block callers.
    if (error.code === "PGRST205" || error.code === "42P01") {
      console.warn("[leaseAbstractService] lease_field_reviews table missing; skipping audit upsert.");
      return [];
    }
    throw error;
  }
  return data || [];
}

/**
 * Build an immutable abstract snapshot from the current lease + review state.
 * This is what gets frozen on the lease.abstract_snapshot column each time the
 * abstract is approved (one snapshot per version).
 */
export function buildAbstractSnapshot({ lease, fieldReviews, version, approver }) {
  const approved = {};
  const pending_fields = {};
  const rejected_fields = {};
  const unmapped_terms = {};
  const allFields = {};

  const allKeys = new Set([
    ...LEASE_REVIEW_FIELDS.map(f => f.key),
    ...Object.keys(fieldReviews || {}),
    ...Object.keys(lease?.extraction_data?.fields || {}),
    ...Object.keys(lease?.extraction_data?.workflow_output?.lease_fields || {}),
    ...Object.keys(lease?.extracted_fields || {})
  ]);

  const knownKeys = new Set(LEASE_REVIEW_FIELDS.map(f => f.key));

  for (const key of allKeys) {
    const value = readFieldValue(lease, key);
    const { rawValue, sourcePage, sourceText, extractionStatus } = readFieldEvidence(lease, key);
    const confidence = readFieldConfidence(lease, key);
    const review = fieldReviews?.[key] || null;
    const review_status = review?.status || "pending";
    const fieldDef = LEASE_REVIEW_FIELDS.find(f => f.key === key);

    const entry = {
      value: value ?? null,
      raw_value: rawValue ?? null,
      source_page: sourcePage ?? null,
      source_text: sourceText ?? null,
      exact_source_text: sourceText ?? null,
      confidence_score: typeof confidence === "number" ? confidence : null,
      confidence: typeof confidence === "number" ? confidence : null,
      extraction_status: extractionStatus ?? null,
      review_status: review_status,
      reviewed_at: review?.reviewed_at || null,
      reviewer: review?.reviewer || null,
      section_key: fieldDef?.tab || null,
      field_key: key,
    };

    allFields[key] = entry;

    if (["accepted", "edited", "approved", "reviewed"].includes(review_status)) {
      approved[key] = entry;
    } else if (review_status === "rejected") {
      rejected_fields[key] = entry;
    } else {
      if (knownKeys.has(key)) {
        pending_fields[key] = entry;
      } else {
        unmapped_terms[key] = entry;
      }
    }
  }

  return {
    version,
    approved_at: new Date().toISOString(),
    approved_by: approver || null,
    fields: allFields,
    approved,
    pending_fields,
    rejected_fields,
    unmapped_terms,
  };
}

/**
 * Mark a lease abstract as approved. Writes to the new abstract_* columns AND
 * keeps `leases.status='approved'` + `extraction_data.abstract` in sync so
 * downstream code that hasn't migrated yet keeps working.
 *
 * Returns the updated lease row.
 */
export async function approveLeaseAbstract({
  lease,
  fieldReviews,
  approvedBy,
  signedAt,
  comments,
  documentUrl,
}) {
  if (!lease?.id) throw new Error("approveLeaseAbstract: lease.id is required");
  const nextVersion = (lease.abstract_version || 0) + 1;
  const snapshot = buildAbstractSnapshot({
    lease,
    fieldReviews,
    version: nextVersion,
    approver: approvedBy,
  });
  const nextExtraction = {
    ...(lease.extraction_data || {}),
    field_reviews: fieldReviews,
    abstract: {
      approved_at: snapshot.approved_at,
      approved_by: approvedBy,
      version: nextVersion,
    },
  };

  // Use canonical mode to grab the best available values for top-level columns
  const summaryKeys = [
    "tenant_name", "landlord_name", "lease_type", "commencement_date", 
    "expiration_date", "monthly_rent", "annual_rent", "square_footage", 
    "total_sf", "property_name"
  ];
  
  const resolvedFields = resolveLeaseFields(lease, summaryKeys, { mode: "canonical" });
  const columnSync = {};

  for (const key of summaryKeys) {
    const resolved = resolvedFields[key];
    if (!resolved || !resolved.found || resolved.value == null) continue;
    
    // Convert to numbers for numeric fields
    let value = resolved.value;
    if (NUMERIC_REVIEW_FIELDS.has(key)) {
      const n = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
      if (!Number.isFinite(n)) continue;
      value = n;
    } else if (typeof value === "string") {
      value = value.trim();
      if (!value) continue;
    }

    const columns = resolveFieldColumns(key);
    for (const column of columns) {
      if (columnSync[column] === undefined) {
         // Do not overwrite existing values unless they are null/empty.
         // (User requested onlyFillMissing = true, approvedOnly = true, force = false logic here)
         if (lease[column] == null || lease[column] === "") {
           columnSync[column] = value;
         }
      }
    }
  }

  const update = {
    ...columnSync,
    status: "approved",
    signed_by: approvedBy,
    signed_at: signedAt || snapshot.approved_at,
    approval_comments: comments || null,
    approval_document_url: documentUrl || null,
    abstract_status: ABSTRACT_STATUS.APPROVED,
    abstract_version: nextVersion,
    abstract_approved_at: snapshot.approved_at,
    abstract_approved_by: approvedBy,
    abstract_snapshot: snapshot,
    extraction_data: nextExtraction,
    extracted_fields: snapshot.fields,
  };

  const data = await updateLeaseStripMissing(lease.id, update);

  // Update uploaded_files.reviewed_output if source_file_id exists
  if (lease.source_file_id) {
    try {
      await supabase
        .from("uploaded_files")
        .update({ reviewed_output: snapshot })
        .eq("id", lease.source_file_id);
    } catch (err) {
      console.warn("[leaseAbstractService] failed to update uploaded_files.reviewed_output:", err);
    }
  }

  // Persist per-field reviews so the audit trail is queryable. If the
  // dedicated table doesn't exist yet (older schema), don't block approval.
  await persistFieldReviews({
    lease: { ...lease, ...data },
    fieldReviews,
    reviewer: approvedBy,
  }).catch((err) => {
    console.warn("[leaseAbstractService] persistFieldReviews skipped:", err?.message || err);
  });

  // Sync accepted terms to lease_expense_rules
  try {
    await syncApprovedAbstractExpenseTermsToRules(lease, snapshot);
  } catch (err) {
    console.error("[leaseAbstractService] syncApprovedAbstractExpenseTermsToRules FAILED:", err);
    throw err;
  }

  return data;
}

export async function syncApprovedAbstractExpenseTermsToRules(lease, approvedSnapshot) {
  const leaseId = lease?.id;
  const orgId = lease?.org_id;

  if (!leaseId || !approvedSnapshot || !orgId) {
    console.warn("[syncApprovedAbstractExpenseTermsToRules] Missing required arguments", { leaseId, orgId, snapshotKeys: Object.keys(approvedSnapshot || {}) });
    return;
  }

  console.log("[syncApprovedAbstractExpenseTermsToRules] CALLED", { leaseId });
  console.log("extraction_data keys", Object.keys(lease?.extraction_data || {}));
  console.log("[syncApprovedAbstractExpenseTermsToRules] Starting sync for lease", leaseId);
  
  // Diagnostic table for global resolver
    const debugKeys = [
      "admin_fee_percent",
      "gross_up_percent",
      "cap_percent",
      "tenant_share_percent",
      "estimated_annual_amount",
      "estimated_monthly_amount",
      "reconciliation_required"
    ];
    
    console.table(debugKeys.map(dk => {
      const result = resolveLeaseField(lease, dk, { mode: "canonical" });
      return {
        key: dk,
        found: result?.found || false,
        value: result?.value || null,
        raw: result?.rawValue || null,
        source: result?.sourcePath || null
      };
    }));

    const resolveNum = (key) => {
      const r = resolveLeaseField(lease, key, { mode: "canonical" });
      if (!r || !r.found || r.value == null) return null;
      const n = Number(String(r.value).replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    
    const resolveBool = (key) => {
      const r = resolveLeaseField(lease, key, { mode: "canonical" });
      if (!r || !r.found || r.value == null) return null;
      return String(r.value).toLowerCase() === "true" || String(r.value).toLowerCase() === "yes";
    };

    const adminFeePercent = resolveNum("admin_fee_percent");
    const grossUpPercent = resolveNum("gross_up_percent");
    const capPercent = resolveNum("cap_percent");
    const tenantSharePercent = resolveNum("tenant_share_percent");
    const estimatedAnnualAmount = resolveNum("estimated_annual_amount");
    const estimatedMonthlyAmount = resolveNum("estimated_monthly_amount");
    const reconciliationRequired = resolveBool("reconciliation_required");

  try {
    let { data: ruleSets } = await supabase
      .from("lease_expense_rule_sets")
      .select("id, status")
      .eq("lease_id", leaseId)
      .neq("status", "archived")
      .order("version", { ascending: false })
      .limit(1);

    let ruleSetId;
    if (!ruleSets || ruleSets.length === 0) {
      const { data: newRuleSet } = await supabase
        .from("lease_expense_rule_sets")
        .insert({
          lease_id: leaseId,
          org_id: orgId,
          status: "draft",
          version: 1,
        })
        .select("id")
        .single();
      if (!newRuleSet) return;
      ruleSetId = newRuleSet.id;
    } else {
      ruleSetId = ruleSets[0].id;
    }

    const rulesToUpsert = [];

    const fieldReviews = extractionData?.field_reviews || {};

    const addRule = (aliases, ruleType, overrides = {}) => {
      const aliasList = Array.isArray(aliases) ? aliases : [aliases];
      const fieldKey = aliasList[0];
      const field = resolveLeaseField(lease, fieldKey, { mode: "canonical" });
      
      if (!field || !field.found || field.value === null || field.value === undefined || field.value === "") return;
      
      // We don't mandate 'review_status' since we are deeply scanning AI outputs that may not have statuses
      const num = (v) => {
        const n = Number(String(v).replace(/[$,%\s,]/g, ""));
        return Number.isFinite(n) ? n : null;
      };

      const review = fieldReviews[fieldKey];
      // Only auto-approve if the specific field was accepted/edited in the Lease Review UI
      const isAccepted = review?.status === "accepted" || review?.status === "edited";
      const ruleApprovalStatus = isAccepted ? "approved" : "needs_review";

      const isCam = overrides.cam_eligible === "yes";
      
      rulesToUpsert.push({
        org_id: orgId,
        lease_id: leaseId,
        rule_set_id: ruleSetId,
        rule_key: `${leaseId}_${ruleType}_${overrides.expense_category || "general"}_${fieldKey}`,
        rule_type: ruleType,
        source_field_key: fieldKey,
        review_status: ruleApprovalStatus,
        approval_status: ruleApprovalStatus,
        source_page: field.sourcePage ? Number(field.sourcePage) : null,
        exact_source_text: field.exactSourceText || field.rawValue || null,
        confidence_score: field.confidence || 0.8,
        extraction_status: field.reviewStatus || "extracted",
        created_from: "approved_lease_abstract",
        generation_source: "lease_review_acceptance",
        ...(isCam ? {
          operational_responsibility: "landlord",
          payment_treatment: "pass_through",
          recoverable_from_tenant: "yes"
        } : {}),
        ...overrides,
        // Resolve numeric fields from the found value OR the explicit overrides
        ...(ruleType === "cam_admin_fee" && { admin_fee_percent: num(field.value) }),
        ...(ruleType === "cam_gross_up" && { gross_up_percent: num(field.value) }),
        ...(ruleType === "cam_cap" && { cap_percent: num(field.value) }),
        ...(ruleType === "tenant_share" && { tenant_share_percent: num(field.value) }),
        ...(ruleType === "cam_estimate" && aliasList.includes("estimated_annual_cam") && { estimated_annual_amount: num(field.value) }),
        ...(ruleType === "cam_estimate" && aliasList.includes("estimated_monthly_cam") && { estimated_monthly_amount: num(field.value) }),
        ...(ruleType === "cam_reconciliation" && { reconciliation_required: String(field.value).toLowerCase() === "true" || String(field.value).toLowerCase() === "yes" }),
        // Apply overrides last if provided directly
        ...(overrides.estimated_annual_amount && { estimated_annual_amount: num(overrides.estimated_annual_amount) }),
        ...(overrides.estimated_monthly_amount && { estimated_monthly_amount: num(overrides.estimated_monthly_amount) }),
        ...(overrides.tenant_share_percent && { tenant_share_percent: num(overrides.tenant_share_percent) }),
        ...(overrides.admin_fee_percent && { admin_fee_percent: num(overrides.admin_fee_percent) }),
        ...(overrides.gross_up_percent && { gross_up_percent: num(overrides.gross_up_percent) }),
        ...(overrides.cap_percent && { cap_percent: num(overrides.cap_percent) }),
      });
      
      const payload = rulesToUpsert[rulesToUpsert.length - 1];
      console.log(`[sync] Mapped ${fieldKey} -> ${ruleType}`, {
        value: field.value,
        raw: field.rawValue,
        rule_key: payload.rule_key
      });
    };

    addRule(["responsibility_taxes"], "direct_tenant_responsibility", { expense_category: "real_estate_taxes" });
    addRule(["property_insurance_responsibility"], "direct_tenant_responsibility", { expense_category: "property_insurance" });
    addRule(["responsibility_utilities"], "direct_tenant_responsibility", { expense_category: "utilities" });
    addRule(["responsibility_repairs"], "direct_tenant_responsibility", { expense_category: "repairs_maintenance" });
    addRule(["expense_structure"], "expense_recovery", { expense_category: "operating_expenses", cam_eligible: "yes" });
    addRule(["admin_fee_percent", "administrative_fee_percent", "cam_admin_fee_percent", "adminFeePercent", "administrative fee", "admin fee"], "cam_admin_fee", { cam_eligible: "yes" });
    addRule(["gross_up_percent", "gross_up_threshold_percent", "gross_up_threshold", "grossUpPercent", "gross-up", "gross up"], "cam_gross_up", { cam_eligible: "yes" });
    addRule(["cam_cap_percent", "cap_percent", "controllable_cap_percent", "controllable_cam_cap_percent", "controllable cap"], "cam_cap", { cam_eligible: "yes" });
    addRule(["tenant_share_percent", "tenant_pro_rata_share", "pro_rata_share", "tenant_share", "tenant pro rata share"], "tenant_share", { cam_eligible: "yes" });
    addRule(["estimated_annual_cam", "cam_estimate_annual", "estimated_annual_amount", "annual_cam_estimate", "estimated annual cam"], "cam_estimate", { cam_eligible: "yes" });
    addRule(["estimated_monthly_cam", "cam_estimate_monthly", "estimated_monthly_amount", "monthly_cam_estimate", "estimated monthly cam"], "cam_estimate", { cam_eligible: "yes" });
    addRule(["reconciliation_required", "cam_reconciliation_required", "reconciliation"], "cam_reconciliation", { cam_eligible: "yes" });
    addRule(["reconciliation_frequency"], "cam_reconciliation", { cam_eligible: "yes" });
    addRule(["management_fee_basis"], "additional_rent", { cam_eligible: "yes" });
    addRule(["late_fee_percent"], "additional_rent", { cam_eligible: "yes" });
    addRule(["default_interest_percent"], "additional_rent", { cam_eligible: "yes" });
    addRule(["holdover_multiplier"], "additional_rent", { cam_eligible: "yes" });

    // Extract workflow/LLM rules from extraction_data
    let workflowRules = [];
    if (Array.isArray(lease?.extraction_data?.workflow_output?.expense_rules)) {
      workflowRules = lease.extraction_data.workflow_output.expense_rules;
    } else if (Array.isArray(lease?.extraction_data?.expenses)) {
      workflowRules = lease.extraction_data.expenses;
    } else if (Array.isArray(lease?.extraction_data?.rules)) {
      workflowRules = lease.extraction_data.rules;
    }

    workflowRules.forEach((rule, index) => {
      const expenseCategory = rule.expense_category || rule.category || `rule_${index}`;
      const ruleType = rule.rule_type || "additional_rent";
      
      const num = (v) => {
        if (v === null || v === undefined) return null;
        const n = Number(String(v).replace(/[$,%\s,]/g, ""));
        return Number.isFinite(n) ? n : null;
      };

      const workflowCategoryToFieldKey = {
        "real_estate_taxes": "responsibility_taxes",
        "property_insurance": "responsibility_insurance",
        "utilities": "responsibility_utilities",
        "electricity": "responsibility_utilities",
        "water": "responsibility_utilities",
        "sewer": "responsibility_utilities",
        "gas": "responsibility_utilities",
        "hvac": "responsibility_utilities",
        "interior_repairs": "responsibility_repairs",
        "exterior_repairs": "responsibility_repairs",
        "roof_structure": "responsibility_repairs",
        "foundation_structure": "responsibility_repairs",
        "capital_expenditures": "responsibility_repairs",
        "janitorial": "responsibility_repairs",
        "trash_removal": "responsibility_repairs",
        "landscaping": "responsibility_repairs",
        "snow_removal": "responsibility_repairs",
      };

      const normalizedCat = String(expenseCategory).toLowerCase().replace(/[^a-z0-9_]/g, "_");
      let mappedFieldKey = workflowCategoryToFieldKey[normalizedCat] || null;
      
      let ruleApprovalStatus = "needs_review";
      if (mappedFieldKey) {
        const review = fieldReviews[mappedFieldKey];
        if (review?.status === "accepted" || review?.status === "edited") {
          ruleApprovalStatus = "approved";
        }
      }

      rulesToUpsert.push({
        org_id: orgId,
        lease_id: leaseId,
        rule_set_id: ruleSetId,
        rule_key: `${leaseId}_workflow_${expenseCategory}_${index}`,
        rule_type: ruleType,
        expense_category: expenseCategory,
        review_status: ruleApprovalStatus,
        approval_status: ruleApprovalStatus,
        source_page: rule.source_page || null,
        exact_source_text: rule.exact_source_text || rule.source_text || rule.raw_value || null,
        confidence_score: rule.confidence_score || rule.confidence || 0.8,
        extraction_status: rule.extraction_status || "extracted",
        created_from: "approved_lease_abstract",
        generation_source: "workflow_output",
        payment_treatment: rule.payment_treatment || "not_applicable",
        recoverable_from_tenant: rule.recoverable_from_tenant || "no",
        cam_eligible: rule.cam_eligible || "no",
        recovery_method: rule.recovery_method || null,
        allocation_basis: rule.allocation_basis || null,
        cap_type: rule.cap_type || null,
        cap_percent: num(rule.cap_percent),
        cap_amount: num(rule.cap_amount),
        tenant_share_percent: num(rule.tenant_share_percent),
        admin_fee_applicable: rule.admin_fee_applicable === true || rule.admin_fee_applicable === "yes",
        admin_fee_percent: num(rule.admin_fee_percent),
        estimated_annual_amount: num(rule.estimated_annual_amount),
        estimated_monthly_amount: num(rule.estimated_monthly_amount),
        notes: rule.notes || rule.reason || null
      });
    });

    console.log("structured payload count", rulesToUpsert.length);

    if (rulesToUpsert.length > 0) {
      console.log(`[syncApprovedAbstractExpenseTermsToRules] Found ${rulesToUpsert.length} rules to upsert.`);
      
      console.table(rulesToUpsert.map(p => ({
        rule_key: p.rule_key,
        rule_type: p.rule_type,
        source_field_key: p.source_field_key,
        admin_fee_percent: p.admin_fee_percent,
        gross_up_percent: p.gross_up_percent,
        cap_percent: p.cap_percent,
        tenant_share_percent: p.tenant_share_percent,
        estimated_annual_amount: p.estimated_annual_amount,
        estimated_monthly_amount: p.estimated_monthly_amount,
        reconciliation_required: p.reconciliation_required
      })));

      const { data, error } = await supabase
        .from("lease_expense_rules")
        .upsert(rulesToUpsert, { onConflict: "lease_id,rule_key" })
        .select("*");
      
      console.log("structured upsert result", { data, error });

      if (error) {
        console.error("[syncApprovedAbstractExpenseTermsToRules] Upsert error:", error);
        throw error;
      }
      
      console.log("[syncApprovedAbstractExpenseTermsToRules] Completed sync.");
    } else {
      console.log("[syncApprovedAbstractExpenseTermsToRules] No mapped fields found to upsert.");
    }
  } catch (err) {
    console.error("[leaseAbstractService] Error syncing rules:", err);
    throw err;
  }
}

/**
 * Save the in-progress review state without approving. Updates the JSONB
 * (Phase 2 shape) and upserts lease_field_reviews so the audit table mirrors
 * the draft.
 */
export async function saveAbstractDraft({ lease, fieldReviews, reviewer }) {
  if (!lease?.id) throw new Error("saveAbstractDraft: lease.id is required");
  const nextExtraction = {
    ...(lease.extraction_data || {}),
    field_reviews: fieldReviews,
  };
  const update = {
    extraction_data: nextExtraction,
    abstract_status: lease.abstract_status === ABSTRACT_STATUS.APPROVED
      ? ABSTRACT_STATUS.APPROVED  // Keep approved status; new edits create the next version on approval.
      : ABSTRACT_STATUS.PENDING_REVIEW,
  };
  const data = await updateLeaseStripMissing(lease.id, update);
  await persistFieldReviews({ lease: { ...lease, ...data }, fieldReviews, reviewer }).catch((err) => {
    console.warn("[leaseAbstractService] persistFieldReviews skipped:", err?.message || err);
  });
  return data;
}

/**
 * Mark a lease abstract as rejected (document rejected) — used by the
 * "Reject Document" action in Lease Review.
 */
export async function rejectLeaseAbstract({ lease, reason, reviewer }) {
  const nextExtraction = {
    ...(lease.extraction_data || {}),
    rejection: {
      reason,
      rejected_at: new Date().toISOString(),
      rejected_by: reviewer || null,
    },
  };
  return updateLeaseStripMissing(lease.id, {
    status: "rejected",
    abstract_status: ABSTRACT_STATUS.REJECTED,
    extraction_data: nextExtraction,
  });
}

/**
 * Convenience: load the current per-field review rows for a lease, keyed by
 * field_key. Used by pages that need the audit trail (e.g. Lease Detail).
 */
export async function loadFieldReviewMap(leaseId) {
  if (!leaseId) return {};
  const { data, error } = await supabase
    .from("lease_field_reviews")
    .select("field_key, status, normalized_value, raw_value, source_page, source_text, confidence, note, reviewer, reviewed_at")
    .eq("lease_id", leaseId);
  if (error) {
    console.warn("[leaseAbstractService] loadFieldReviewMap failed:", error.message);
    return {};
  }
  const map = {};
  for (const row of data || []) {
    map[row.field_key] = row;
  }
  return map;
}
