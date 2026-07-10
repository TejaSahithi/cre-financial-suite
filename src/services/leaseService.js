import { createEntityService } from '@/services/api';
import { supabase } from '@/services/supabaseClient';
import { resolveLeaseFields } from '@/lib/leaseFieldResolver';
import { NUMERIC_REVIEW_FIELDS, resolveFieldColumns } from '@/lib/leaseReviewSchema';
import { invokeEdgeFunction } from '@/services/edgeFunctions';

const baseService = createEntityService('Lease');

const MISSING_SCHEMA_ERROR_CODES = new Set(["PGRST202", "PGRST204", "PGRST205", "42P01", "42703"]);

// Narrow, function-specific classifier: only "delete_lease_cascade is not
// deployed/callable" shapes are treated as an unavailable-workflow error.
// A bare "not found"/"does not exist" substring is NOT enough on its own —
// the RPC's own business errors ("Lease not found") also contain "not
// found" and must instead pass through unchanged (Phase 6R-10A: the prior,
// broader text match misclassified that exact case).
function isDeleteLeaseCascadeUnavailableError(error) {
  if (MISSING_SCHEMA_ERROR_CODES.has(String(error?.code || "").toUpperCase())) {
    return true;
  }
  const text = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  if (text.includes("schema cache")) return true;
  if (text.includes("could not find the function")) return true;
  if (text.includes("delete_lease_cascade") && text.includes("does not exist")) return true;
  return false;
}

const LEASE_DELETE_UNAVAILABLE_MESSAGE =
  "Lease deletion is temporarily unavailable because the server-side delete workflow is not deployed. Please contact support or retry after migrations are applied.";

export const leaseService = {
  ...baseService,
  async delete(id) {
    if (!id) throw new Error("Lease ID is required for deletion");
    if (supabase) {
      const { data: { user } = {} } = await supabase.auth.getUser().catch(() => ({ data: {} }));

      // delete_lease_cascade owns the entire cascade (detach + delete
      // children + delete lease + audit) in one transaction. There is no
      // client-side fallback: a non-atomic, per-table cascade driven by the
      // caller's own RLS session was a real correctness risk (partial
      // deletes on failure, silent no-ops on tables with no DELETE policy,
      // and a growing list of tables it had to be kept in sync with by
      // hand) — see Phase 6R-9's investigation. If the RPC is genuinely
      // unavailable (schema-cache-miss -- an incompletely migrated
      // environment), fail clearly instead of attempting that cascade.
      const { error } = await supabase.rpc('delete_lease_cascade', {
        target_lease_id: id,
        p_actor_user_id: user?.id || null,
        p_actor_email: user?.email || null,
      });
      if (!error) {
        return true;
      }
      if (isDeleteLeaseCascadeUnavailableError(error)) {
        console.error(`[leaseService] delete_lease_cascade RPC not available for lease ${id}:`, error);
        throw new Error(LEASE_DELETE_UNAVAILABLE_MESSAGE);
      }
      console.error(`[leaseService] Cascade delete failed for lease ${id}:`, error);
      throw error;
    }

    return baseService.delete(id);
  }
};

// Server-owned, audited replacement for the single-field-path direct writes
// to leases.extraction_data (Phase 6D-2). See update_lease_extraction_field
// RPC / update-lease-extraction-field edge function. Not for whole-object
// rebuilds or the field_reviews map (those stay client-side for now).
export async function updateLeaseExtractionField({ leaseId, fieldArea, action, fieldKey = null, patch }) {
  return invokeEdgeFunction("update-lease-extraction-field", {
    lease_id: leaseId,
    field_area: fieldArea,
    action,
    field_key: fieldKey,
    patch,
  });
}

// Server-owned, audited replacement for the whole-field_reviews-map draft
// save (Phase 6D-3). See save_lease_review_draft RPC / save-lease-review-draft
// edge function. Called by leaseAbstractService.js's saveAbstractDraft, which
// still computes the next fieldReviews map client-side (unchanged) and only
// delegates the mechanical persistence step here.
export async function saveLeaseReviewDraft({ leaseId, fieldReviews }) {
  return invokeEdgeFunction("save-lease-review-draft", {
    lease_id: leaseId,
    field_reviews: fieldReviews,
  });
}

// Server-owned, audited replacement for the "Reject Document" action
// (Phase 6D-5). See reject_lease_abstract RPC / reject-lease-abstract edge
// function. Called by leaseAbstractService.js's rejectLeaseAbstract.
export async function rejectLeaseAbstract({ leaseId, reason, rejectedBy = null }) {
  return invokeEdgeFunction("reject-lease-abstract", {
    lease_id: leaseId,
    reason,
    rejected_by: rejectedBy,
  });
}

// Server-owned, audited replacement for the "Send Back" (for re-extraction)
// action (Phase 6R-1). See send_lease_back_for_reextraction RPC /
// send-lease-back-for-reextraction edge function. Called by
// LeaseReview.jsx's handleSendBack.
export async function sendLeaseBackForReextraction({ leaseId, reason = null }) {
  return invokeEdgeFunction("send-lease-back-for-reextraction", {
    lease_id: leaseId,
    reason,
  });
}

// Server-owned, audited replacement for the post-approval building/unit
// auto-link direct write (Phase 6R-13). See link_lease_space_assignment RPC
// / link-lease-space-assignment edge function. The building/unit MATCH
// itself (text-matching against candidate rows) stays entirely client-side,
// unchanged -- see buildingUnitMatcher.js's matchBuildingAndUnit(). This
// wrapper only persists whichever of building_id/unit_id was resolved. Not
// folded into update_lease_extraction_field: that RPC rejects any write
// once abstract_status='approved', and this always runs immediately after
// approval succeeds.
export async function linkLeaseSpaceAssignment({ leaseId, buildingId = null, unitId = null }) {
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
