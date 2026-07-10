import { createEntityService } from '@/services/api';
import { supabase } from '@/services/supabaseClient';
import { resolveLeaseFields } from '@/lib/leaseFieldResolver';
import { NUMERIC_REVIEW_FIELDS, resolveFieldColumns } from '@/lib/leaseReviewSchema';
import { logAudit } from '@/services/audit';
import { invokeEdgeFunction } from '@/services/edgeFunctions';

const baseService = createEntityService('Lease');

function isMissingSchemaError(error) {
  const text = `${error?.code || ""} ${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return (
    error?.code === "PGRST202" ||
    error?.code === "PGRST204" ||
    error?.code === "PGRST205" ||
    error?.code === "42P01" ||
    error?.code === "42703" ||
    text.includes("schema cache") ||
    text.includes("could not find the function") ||
    text.includes("does not exist") ||
    text.includes("not found")
  );
}

async function ignoreMissingSchema(label, operation) {
  const { error } = await operation();
  if (error) {
    if (isMissingSchemaError(error)) {
      // Schema-cache misses are expected in environments where optional
      // migrations haven't been applied yet. Log at debug level — the
      // operation is already skipped gracefully so this is informational,
      // not a warning that requires developer action on every page load.
      console.debug(`[leaseService] ${label} skipped: ${error.message}`);
      return false;
    }
    throw error;
  }
  return true;
}

async function updateIfPresent(table, patch, column, value) {
  return ignoreMissingSchema(`${table}.${column} update`, () =>
    supabase.from(table).update(patch).eq(column, value)
  );
}

async function deleteIfPresent(table, column, value) {
  return ignoreMissingSchema(`${table}.${column} delete`, () =>
    supabase.from(table).delete().eq(column, value)
  );
}

async function deleteLeaseCascadeFallback(id) {
  // Only update tables/columns that exist in the current schema.
  // uploaded_files has no lease_id column; expense_classification_templates
  // and cam_expense_inputs do not exist — omit them to avoid 400/404 noise.
  await updateIfPresent("units", { lease_id: null }, "lease_id", id);
  await updateIfPresent("documents", { lease_id: null }, "lease_id", id);

  const childDeletes = [
    ["expense_classifications", "lease_id"],
    ["expenses", "lease_id"],
    ["rent_projections", "lease_id"],
    ["rent_schedules", "lease_id"],
    ["revenues", "lease_id"],
    ["lease_critical_dates", "lease_id"],
    ["lease_clauses", "lease_id"],
    ["lease_field_reviews", "lease_id"],
    ["lease_config", "lease_id"],
    ["cam_profiles", "lease_id"],
    ["lease_amendments", "lease_id"],
    ["lease_assignments", "lease_id"],
    ["lease_expense_rule_clauses", "lease_id"],
    ["lease_expense_rules", "lease_id"],
    ["lease_expense_rule_sets", "lease_id"],
  ];

  for (const [table, column] of childDeletes) {
    await deleteIfPresent(table, column, id);
  }

  const { error } = await supabase.from("leases").delete().eq("id", id);
  if (error) throw error;
}

// Module-level cache: once we learn the RPC doesn't exist, skip the network
// call entirely on subsequent deletes so no 404 appears in DevTools.
let _cascadeRpcAvailable = null; // null=unknown, true=yes, false=no

export const leaseService = {
  ...baseService,
  async delete(id) {
    if (!id) throw new Error("Lease ID is required for deletion");
    if (supabase) {
      // 1. Fetch lease to know its org_id for the audit log
      const lease = await baseService.get(id);

      // 2. Prefer the transactional cascade RPC only when it is known to exist.
      //    If unknown, try once. On a 404/schema error, cache the failure so
      //    subsequent deletes skip the failing network call entirely.
      if (_cascadeRpcAvailable !== false) {
        const { error } = await supabase.rpc('delete_lease_cascade', { target_lease_id: id });
        if (!error) {
          _cascadeRpcAvailable = true;
        } else if (isMissingSchemaError(error)) {
          _cascadeRpcAvailable = false;
          console.debug(`[leaseService] delete_lease_cascade RPC not available; using client fallback.`);
          await deleteLeaseCascadeFallback(id);
        } else {
          console.error(`[leaseService] Cascade delete failed for lease ${id}:`, error);
          throw error;
        }
      } else {
        await deleteLeaseCascadeFallback(id);
      }

      // 3. Log the audit manually since we bypassed baseService.delete
      if (lease) {
        logAudit({
          entityType: 'Lease',
          entityId: id,
          action: 'delete',
          orgId: lease.org_id
        }).catch(() => { });
      }

      return true;
    }

    return baseService.delete(id);
  }
};

/**
 * Server-owned uploaded_files delete (Phase HARD-2). Replaces the direct
 * supabase.from("uploaded_files").delete() write with an audited,
 * org-boundary-checked RPC call via the delete-uploaded-file edge function.
 *
 * @param {string} fileId
 */
export async function deleteUploadedFile(fileId) {
  if (!fileId) throw new Error("File ID is required");
  const result = await invokeEdgeFunction("delete-uploaded-file", {
    file_id: fileId,
  });
  return result;
}

/**
 * Server-owned lease extraction_data field/source-link/lease-flag write
 * (Phase HARD-3B1 / 6D-2 / 6R-1). Replaces direct
 * supabase.from("leases").update() writes for the narrow set of areas the
 * update_lease_extraction_field RPC owns.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {'field_value'|'source_link'|'lease_flag'} params.fieldArea
 * @param {string} params.action
 * @param {string|null} [params.fieldKey] - required iff fieldArea==='field_value'
 * @param {Object} params.patch
 */
export async function updateLeaseExtractionField({ leaseId, fieldArea, action, fieldKey = null, patch }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("update-lease-extraction-field", {
    lease_id: leaseId,
    field_area: fieldArea,
    action,
    field_key: fieldKey,
    patch,
  });
}

/**
 * Server-owned lease review draft save (Phase HARD-3B1 / 6D-3). Replaces
 * leaseAbstractService.js's direct extraction_data.field_reviews write.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {Object} params.fieldReviews
 */
export async function saveLeaseReviewDraftWorkflow({ leaseId, fieldReviews }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("save-lease-review-draft", {
    lease_id: leaseId,
    field_reviews: fieldReviews,
  });
}

/**
 * Server-owned lease abstract rejection (Phase HARD-3B1 / 6D-5). Replaces
 * leaseAbstractService.js's direct status/abstract_status/rejection write.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {string} params.reason
 * @param {string|null} [params.rejectedBy]
 */
export async function rejectLeaseAbstractWorkflow({ leaseId, reason, rejectedBy = null }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("reject-lease-abstract", {
    lease_id: leaseId,
    reason,
    rejected_by: rejectedBy,
  });
}

/**
 * Server-owned "send back for re-extraction" verdict (Phase HARD-3B1 /
 * 6R-1). Replaces LeaseReview.jsx's direct status='draft' +
 * extraction_data.send_back write.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {string|null} [params.reason]
 */
export async function sendLeaseBackForReextraction({ leaseId, reason = null }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("send-lease-back-for-reextraction", {
    lease_id: leaseId,
    reason,
  });
}

/**
 * Server-owned typed-column + extraction_data.fields[key] field save
 * (Phase HARD-3B2). Replaces LeaseReview.jsx's handleFieldSave /
 * FieldDetailDrawer.onSaveEdit direct writes. Server-side whitelists which
 * columnUpdates keys are real, currently-existing lease columns and
 * silently drops the rest.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {string} params.fieldKey
 * @param {Object} [params.columnUpdates] - {column_name: value}
 * @param {Object} [params.patch] - {field, field_evidence, confidence_score}
 */
export async function updateLeaseFieldAndColumns({ leaseId, fieldKey, columnUpdates = {}, patch = {} }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("update-lease-field-and-columns", {
    lease_id: leaseId,
    field_key: fieldKey,
    column_updates: columnUpdates,
    patch,
  });
}

/**
 * Server-owned evidence-backfill bulk merge (Phase HARD-3B2). Replaces
 * LeaseReview.jsx's evidence-backfill useEffect direct write. All
 * evidence-matching computation stays client-side; this only persists the
 * already-computed patch transactionally with one audit row.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {Object} [params.fieldsPatch]
 * @param {Object} [params.fieldEvidencePatch]
 * @param {Object|null} [params.workflowOutput]
 */
export async function backfillLeaseEvidence({ leaseId, fieldsPatch = {}, fieldEvidencePatch = {}, workflowOutput = null }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("backfill-lease-evidence", {
    lease_id: leaseId,
    fields_patch: fieldsPatch,
    field_evidence_patch: fieldEvidencePatch,
    workflow_output: workflowOutput,
  });
}

/**
 * Server-owned post-approval building/unit link (Phase HARD-3B2, reuses
 * the already-deployed link_lease_space_assignment RPC from Phase 6R-13).
 * Replaces LeaseReview.jsx's post-approval building/unit auto-link direct
 * write. Client-side text matching (matchBuildingAndUnit) stays unchanged;
 * this only persists the resolved building_id/unit_id.
 *
 * @param {Object} params
 * @param {string} params.leaseId
 * @param {string|null} [params.buildingId]
 * @param {string|null} [params.unitId]
 */
export async function linkLeaseSpaceAssignment({ leaseId, buildingId = null, unitId = null }) {
  if (!leaseId) throw new Error("Lease ID is required");
  return invokeEdgeFunction("link-lease-space-assignment", {
    lease_id: leaseId,
    building_id: buildingId,
    unit_id: unitId,
  });
}

/**
 * Backfills missing top-level summary columns on the `leases` table using the
 * generic lease field resolver to read from extraction_data, snapshot_json, etc.
 * 
 * @param {Object} options
 * @param {boolean} options.dryRun - If true, only reports what would change.
 * @param {boolean} options.force - If true, overwrites existing non-null fields.
 * @param {boolean} options.approvedOnly - If true, only processes approved leases.
 */
export async function backfillLeaseSummaryFields({ dryRun = true, force = false, approvedOnly = true } = {}) {
  console.log(`[backfillLeaseSummaryFields] Starting backfill... dryRun=${dryRun}, force=${force}, approvedOnly=${approvedOnly}`);

  let query = supabase.from("leases").select("*");

  if (approvedOnly) {
    query = query.eq("abstract_status", "approved");
  }

  const { data: rawData, error } = await query;
  if (error) {
    console.error("[backfillLeaseSummaryFields] Failed to fetch leases:", error);
    throw error;
  }

  const sourceFileIds = [...new Set(rawData.map(l => l.source_file_id).filter(Boolean))];
  const fileMap = {};
  if (sourceFileIds.length > 0) {
    const { data: files } = await supabase
      .from("uploaded_files")
      .select("id, reviewed_output, ui_review_payload")
      .in("id", sourceFileIds);
    if (files) {
      for (const f of files) fileMap[f.id] = f;
    }
  }

  const leases = rawData.map(lease => ({
    ...lease,
    uploaded_files: fileMap[lease.source_file_id] || null,
    uploaded_file: fileMap[lease.source_file_id] || null
  }));

  const summaryKeys = [
    "tenant_name", "landlord_name", "lease_type", "commencement_date",
    "expiration_date", "monthly_rent", "annual_rent", "square_footage",
    "total_sf", "property_name"
  ];

  const results = {
    processed: 0,
    updated: 0,
    changes: []
  };

  for (const lease of leases) {
    results.processed++;
    const resolvedFields = resolveLeaseFields(lease, summaryKeys, { mode: "canonical" });
    const updates = {};
    const leaseChanges = { lease_id: lease.id, before: {}, after: {} };

    for (const key of summaryKeys) {
      const resolved = resolvedFields[key];
      if (!resolved || !resolved.found || resolved.value == null) continue;

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
        if (!force && lease[column] != null && lease[column] !== "") continue;

        // Skip if the value is essentially the same
        if (lease[column] === value) continue;

        if (updates[column] === undefined) {
          updates[column] = value;
          leaseChanges.before[column] = lease[column];
          leaseChanges.after[column] = value;
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      results.changes.push(leaseChanges);
      if (!dryRun) {
        const { error: updateError } = await supabase
          .from("leases")
          .update(updates)
          .eq("id", lease.id);

        if (updateError) {
          console.error(`[backfillLeaseSummaryFields] Failed to update lease ${lease.id}:`, updateError);
        } else {
          results.updated++;
        }
      } else {
        results.updated++;
      }
    }
  }

  console.log(`[backfillLeaseSummaryFields] Completed. Processed: ${results.processed}, ${dryRun ? 'Would update' : 'Updated'}: ${results.updated}`);
  if (results.changes.length > 0) {
    console.log("[backfillLeaseSummaryFields] Changes detail:", results.changes);
  }

  return results;
}
