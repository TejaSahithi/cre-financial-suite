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

  // Sync the latest reviewed values back to the dedicated lease columns
  // (landlord_name, lease_type, monthly_rent, commencement_date, etc.) so
  // downstream consumers — Leases list, dashboard cards, expense engine —
  // see the approved values without having to dig into extraction_data.
  // Without this, columns retain whatever was set at upload time (often
  // null) even though the abstract shows the extracted values.
  const columnSync = {};
  for (const field of LEASE_REVIEW_FIELDS) {
    const rawValue = readFieldValue(lease, field.key);
    if (rawValue === undefined || rawValue === null) continue;
    let value = rawValue;
    if (NUMERIC_REVIEW_FIELDS.has(field.key)) {
      const n = typeof rawValue === "number"
        ? rawValue
        : Number(String(rawValue).replace(/[$,%\s,]/g, ""));
      if (!Number.isFinite(n)) continue;
      value = n;
    } else if (field.type === "boolean") {
      value = rawValue === true || String(rawValue).toLowerCase() === "true" || String(rawValue).toLowerCase() === "yes";
    } else if (typeof rawValue === "string") {
      const trimmed = rawValue.trim();
      if (!trimmed) continue;
      value = trimmed;
    }
    const columns = resolveFieldColumns(field.key);
    if (!columns || columns.length === 0) continue;
    for (const column of columns) {
      // Don't clobber a column we've already set from a higher-priority field.
      if (columnSync[column] === undefined) columnSync[column] = value;
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
  await syncApprovedAbstractExpenseTermsToRules(lease.id, snapshot, lease.org_id).catch((err) => {
    console.warn("[leaseAbstractService] syncApprovedAbstractExpenseTermsToRules skipped:", err?.message || err);
  });

  return data;
}

export async function syncApprovedAbstractExpenseTermsToRules(leaseId, approvedSnapshot, orgId) {
  if (!leaseId || !approvedSnapshot || !orgId) return;

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

    const fields = approvedSnapshot.fields || {};
    const rulesToUpsert = [];

    const addRule = (fieldKey, ruleType, overrides = {}) => {
      const field = fields[fieldKey];
      if (!field || field.value === null || field.value === undefined || field.value === "") return;
      if (!["accepted", "reviewed", "approved", "edited"].includes(String(field.review_status).toLowerCase())) return;

      const num = (v) => {
        const n = Number(String(v).replace(/[$,%\s,]/g, ""));
        return Number.isFinite(n) ? n : null;
      };

      rulesToUpsert.push({
        org_id: orgId,
        lease_id: leaseId,
        rule_set_id: ruleSetId,
        rule_key: `abstract_sync_${fieldKey}`,
        rule_type: ruleType,
        source_field_key: fieldKey,
        review_status: autoApproveAcceptedExpenseRules ? "approved" : "reviewed",
        approval_status: autoApproveAcceptedExpenseRules ? "approved" : "needs_review",
        source_page: field.source_page,
        exact_source_text: field.exact_source_text || field.source_text || null,
        confidence_score: field.confidence_score || field.confidence || null,
        created_from: "approved_lease_abstract",
        generation_source: "lease_review_acceptance",
        ...overrides,
        // Resolve nested numeric properties if they are functions
        ...(overrides.estimated_annual_amount && { estimated_annual_amount: num(overrides.estimated_annual_amount) }),
        ...(overrides.estimated_monthly_amount && { estimated_monthly_amount: num(overrides.estimated_monthly_amount) }),
        ...(overrides.tenant_share_percent && { tenant_share_percent: num(overrides.tenant_share_percent) }),
        ...(overrides.admin_fee_percent && { admin_fee_percent: num(overrides.admin_fee_percent) }),
        ...(overrides.gross_up_percent && { gross_up_percent: num(overrides.gross_up_percent) }),
        ...(overrides.cap_percent && { cap_percent: num(overrides.cap_percent) }),
      });
    };

    addRule("responsibility_taxes", "taxes", { expense_category: "real_estate_taxes", responsibility: fields["responsibility_taxes"]?.value });
    addRule("property_insurance_responsibility", "insurance", { expense_category: "property_insurance", responsibility: fields["property_insurance_responsibility"]?.value });
    addRule("responsibility_utilities", "utilities", { expense_category: "utilities", responsibility: fields["responsibility_utilities"]?.value });
    addRule("responsibility_repairs", "repairs_maintenance", { expense_category: "repairs_maintenance", responsibility: fields["responsibility_repairs"]?.value });
    addRule("expense_structure", "operating_expenses", { expense_category: "operating_expenses", cam_eligible: "yes" });
    addRule("admin_fee_percent", "cam_admin_fee", { admin_fee_percent: fields["admin_fee_percent"]?.value, cam_eligible: "yes" });
    addRule("gross_up_percent", "cam_gross_up", { gross_up_percent: fields["gross_up_percent"]?.value, cam_eligible: "yes" });
    addRule("cam_cap_percent", "cam_cap", { cap_percent: fields["cam_cap_percent"]?.value, cam_eligible: "yes" });
    addRule("base_year", "base_year", { cam_eligible: "yes", recovery_method: "base_year" }); 
    addRule("expense_stop", "expense_stop", { cam_eligible: "yes", recovery_method: "expense_stop" }); 
    addRule("tenant_pro_rata_share", "tenant_share", { tenant_share_percent: fields["tenant_pro_rata_share"]?.value, cam_eligible: "yes" });
    addRule("estimated_annual_cam", "cam_estimate_annual", { estimated_annual_amount: fields["estimated_annual_cam"]?.value, cam_eligible: "yes" });
    addRule("estimated_monthly_cam", "cam_estimate_monthly", { estimated_monthly_amount: fields["estimated_monthly_cam"]?.value, cam_eligible: "yes" });
    addRule("reconciliation_required", "reconciliation", { cam_eligible: "yes", recovery_method: String(fields["reconciliation_required"]?.value).toLowerCase() === "yes" || String(fields["reconciliation_required"]?.value).toLowerCase() === "true" ? "reconciliation" : "none" });
    addRule("management_fee_basis", "management_fee", { cam_eligible: "yes" });

    if (rulesToUpsert.length > 0) {
      // Since lease_expense_rules doesn't have a unique constraint on (lease_id, rule_key) in older versions, 
      // we'll try to update existing ones first, then insert new ones.
      for (const rule of rulesToUpsert) {
        const { data: existing } = await supabase
          .from("lease_expense_rules")
          .select("id")
          .eq("lease_id", leaseId)
          .eq("rule_key", rule.rule_key)
          .maybeSingle();

        if (existing?.id) {
          await supabase.from("lease_expense_rules").update(rule).eq("id", existing.id);
        } else {
          await supabase.from("lease_expense_rules").insert(rule);
        }
      }
    }
  } catch (err) {
    console.warn("[leaseAbstractService] Error syncing rules:", err);
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
