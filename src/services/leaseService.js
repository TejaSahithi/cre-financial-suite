import { createEntityService } from '@/services/api';
import { supabase } from '@/services/supabaseClient';
import { resolveLeaseFields } from '@/lib/leaseFieldResolver';
import { LEASE_REVIEW_FIELDS, NUMERIC_REVIEW_FIELDS, resolveFieldColumns } from '@/lib/leaseReviewSchema';

export const leaseService = createEntityService('Lease');

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
  
  let query = supabase.from("leases").select(`
    *,
    approved_lease_abstracts!left (
       snapshot_json
    ),
    uploaded_files!left (
       reviewed_output,
       ui_review_payload
    )
  `);

  if (approvedOnly) {
    query = query.eq("abstract_status", "approved");
  }

  const { data: rawData, error } = await query;
  if (error) {
    console.error("[backfillLeaseSummaryFields] Failed to fetch leases:", error);
    throw error;
  }

  const leases = rawData.map(lease => ({
    ...lease,
    approved_lease_abstracts: Array.isArray(lease.approved_lease_abstracts) ? lease.approved_lease_abstracts[0] : lease.approved_lease_abstracts,
    uploaded_files: Array.isArray(lease.uploaded_files) ? lease.uploaded_files[0] : lease.uploaded_files,
    uploaded_file: Array.isArray(lease.uploaded_files) ? lease.uploaded_files[0] : lease.uploaded_files
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
