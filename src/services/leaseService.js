import { createEntityService } from '@/services/api';
import { supabase } from '@/services/supabaseClient';
import { resolveLeaseFields } from '@/lib/leaseFieldResolver';
import { NUMERIC_REVIEW_FIELDS, resolveFieldColumns } from '@/lib/leaseReviewSchema';
import { logAudit } from '@/services/audit';

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
