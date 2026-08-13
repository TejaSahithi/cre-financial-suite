// @ts-nocheck
// I/O only: loads everything resolve.ts needs for ANY asOfDate on one
// lease, so the pure resolver can be called repeatedly against one loaded
// snapshot without re-querying (mirrors cam-engine-v2's snapshot builder).
// org_id is always taken from the caller's resolved session org — never
// trust a client-supplied org_id.
import type { AbstractSnapshotFieldEntry, LeaseTermsSnapshot, RentScheduleRow } from "./contracts/resolved-lease-terms.ts";

function toRentScheduleRow(row: any): RentScheduleRow {
  return {
    id: row.id,
    row_type: row.row_type,
    phase: row.phase,
    period_start: row.period_start,
    period_end: row.period_end,
    monthly_amount: row.monthly_amount,
    annual_amount: row.annual_amount,
    rsf: row.rsf,
    status: row.status,
    is_abatement: !!row.is_abatement,
    abatement_percent: row.abatement_percent,
    building_id: row.building_id,
    unit_id: row.unit_id,
    approved_at: row.approved_at,
    approved_by: row.approved_by,
    abstract_version: row.abstract_version,
    source: row.source,
  };
}

function toApprovedFields(approved: Record<string, any> | undefined): Record<string, AbstractSnapshotFieldEntry> {
  const out: Record<string, AbstractSnapshotFieldEntry> = {};
  for (const [key, entry] of Object.entries(approved || {})) {
    out[key] = {
      value: entry?.value ?? null,
      source_page: entry?.source_page ?? null,
      source_text: entry?.source_text ?? entry?.exact_source_text ?? null,
      reviewer: entry?.reviewer ?? null,
      reviewed_at: entry?.reviewed_at ?? null,
    };
  }
  return out;
}

export async function loadLeaseTermsSnapshot(
  supabaseAdmin: any,
  { orgId, leaseId }: { orgId: string; leaseId: string },
): Promise<LeaseTermsSnapshot | null> {
  const { data: lease, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select("id, org_id, property_id, unit_id, abstract_version, abstract_snapshot")
    .eq("id", leaseId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (leaseError || !lease) return null;

  const { data: rentRows, error: rentError } = await supabaseAdmin
    .from("rent_schedules")
    .select(
      "id, row_type, phase, period_start, period_end, monthly_amount, annual_amount, rsf, status, is_abatement, abatement_percent, building_id, unit_id, approved_at, approved_by, abstract_version, source",
    )
    .eq("org_id", orgId)
    .eq("lease_id", leaseId);
  if (rentError) throw new Error(`Failed to load rent_schedules for lease ${leaseId}: ${rentError.message}`);

  const { data: ruleSets, error: ruleSetError } = await supabaseAdmin
    .from("lease_expense_rule_sets")
    .select("id, status, approved_at")
    .eq("org_id", orgId)
    .eq("lease_id", leaseId)
    .neq("status", "archived")
    .order("version", { ascending: false, nullsFirst: false })
    .limit(1);
  if (ruleSetError) throw new Error(`Failed to load lease_expense_rule_sets for lease ${leaseId}: ${ruleSetError.message}`);

  const snapshot = (lease.abstract_snapshot || {}) as Record<string, any>;

  return {
    leaseId: lease.id,
    orgId: lease.org_id,
    propertyId: lease.property_id ?? null,
    unitId: lease.unit_id ?? null,
    abstractVersion: Number(lease.abstract_version || 0),
    approvedAt: snapshot.approved_at ?? null,
    approvedFields: toApprovedFields(snapshot.approved),
    sourceDocumentId: snapshot.source_document?.uploaded_file_id ?? snapshot.uploaded_file_id ?? null,
    rentScheduleRows: (rentRows || []).map(toRentScheduleRow),
    expenseRuleSet: ruleSets && ruleSets[0]
      ? { id: ruleSets[0].id, status: ruleSets[0].status, approvedAt: ruleSets[0].approved_at ?? null }
      : null,
  };
}
