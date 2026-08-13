// @ts-nocheck
import type {
  AbstractSnapshotFieldEntry,
  ExpenseRuleSetPointer,
  LeaseTermsSnapshot,
  RentScheduleRow,
} from "./contracts/resolved-lease-terms.ts";

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeFieldEntry(value: unknown): AbstractSnapshotFieldEntry {
  const record = asObject(value);
  return {
    value: record.value ?? record.normalized_value ?? record.raw_value ?? null,
    source_page: asNumber(record.source_page),
    source_text: record.source_text ?? record.exact_source_text ?? null,
    reviewer: record.reviewer ?? record.reviewed_by ?? null,
    reviewed_at: record.reviewed_at ?? record.approved_at ?? null,
  };
}

function normalizeApprovedFields(snapshot: Record<string, any>): Record<string, AbstractSnapshotFieldEntry> {
  const approved = asObject(snapshot.approved);
  const normalized: Record<string, AbstractSnapshotFieldEntry> = {};
  for (const [key, value] of Object.entries(approved)) {
    normalized[key] = normalizeFieldEntry(value);
  }
  return normalized;
}

function normalizeRentScheduleRow(row: Record<string, any>): RentScheduleRow {
  return {
    id: String(row.id),
    row_type: String(row.row_type ?? "manual"),
    phase: String(row.phase ?? "contracted"),
    period_start: String(row.period_start ?? ""),
    period_end: String(row.period_end ?? ""),
    monthly_amount: asNumber(row.monthly_amount),
    annual_amount: asNumber(row.annual_amount),
    rsf: asNumber(row.rsf),
    status: String(row.status ?? "draft"),
    is_abatement: Boolean(row.is_abatement),
    abatement_percent: asNumber(row.abatement_percent),
    building_id: row.building_id ?? null,
    unit_id: row.unit_id ?? null,
    approved_at: row.approved_at ?? null,
    approved_by: row.approved_by ?? null,
    source: row.source ?? null,
    metadata: asObject(row.metadata),
  };
}

function normalizeExpenseRuleSet(row: Record<string, any> | null): ExpenseRuleSetPointer | null {
  if (!row) return null;
  return {
    id: String(row.id),
    status: String(row.status ?? row.review_status ?? "draft"),
    approvedAt: row.approved_at ?? null,
  };
}

export async function loadLeaseTermsSnapshot(
  supabaseAdmin: any,
  params: { orgId: string; leaseId: string },
): Promise<LeaseTermsSnapshot | null> {
  const { data: lease, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select("*")
    .eq("id", params.leaseId)
    .eq("org_id", params.orgId)
    .maybeSingle();

  if (leaseError) throw leaseError;
  if (!lease) return null;

  const { data: rentRows, error: rentError } = await supabaseAdmin
    .from("rent_schedules")
    .select("*")
    .eq("lease_id", params.leaseId)
    .eq("org_id", params.orgId)
    .order("period_start", { ascending: true });

  if (rentError) throw rentError;

  const { data: ruleSets, error: ruleSetError } = await supabaseAdmin
    .from("lease_expense_rule_sets")
    .select("id,status,review_status,approved_at,created_at")
    .eq("lease_id", params.leaseId)
    .eq("org_id", params.orgId)
    .order("approved_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1);

  if (ruleSetError) throw ruleSetError;

  const abstractSnapshot = asObject(lease.abstract_snapshot);
  const sourceDocument = asObject(abstractSnapshot.source_document);

  return {
    leaseId: String(lease.id),
    orgId: String(lease.org_id),
    propertyId: lease.property_id ?? null,
    unitId: lease.unit_id ?? null,
    abstractVersion: Number(lease.abstract_version ?? abstractSnapshot.version ?? 0),
    approvedAt: lease.abstract_approved_at ?? abstractSnapshot.approved_at ?? null,
    approvedFields: normalizeApprovedFields(abstractSnapshot),
    sourceDocumentId: sourceDocument.uploaded_file_id ?? null,
    rentScheduleRows: Array.isArray(rentRows) ? rentRows.map(normalizeRentScheduleRow) : [],
    expenseRuleSet: normalizeExpenseRuleSet(Array.isArray(ruleSets) ? ruleSets[0] ?? null : null),
  };
}
