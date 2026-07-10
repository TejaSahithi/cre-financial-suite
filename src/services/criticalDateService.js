/**
 * criticalDateService — CRUD over `lease_critical_dates` (migration
 * 20260514130000). The table mixes derived rows (commencement, expiration,
 * renewal_notice — auto-created from approved lease columns at migration
 * time) with user-added reminders. Both behave identically once persisted.
 */
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";

export const DATE_TYPES = [
  { value: "lease_date",            label: "Lease Date" },
  { value: "commencement",          label: "Commencement" },
  { value: "rent_commencement",     label: "Rent Commencement" },
  { value: "expiration",            label: "Expiration" },
  { value: "renewal_notice",        label: "Renewal Notice Deadline" },
  { value: "option_exercise",       label: "Option Exercise Deadline" },
  { value: "insurance_certificate", label: "Insurance Certificate Due" },
  { value: "termination_notice",    label: "Termination Notice Deadline" },
  { value: "custom",                label: "Custom Reminder" },
];

export const DATE_TYPE_LABELS = DATE_TYPES.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {});

const CRITICAL_DATE_COLUMNS =
  "id, org_id, lease_id, property_id, date_type, due_date, owner_email, owner_name, status, completed_at, completed_by, reminder_days_before, note, source, created_at, updated_at";
const CRITICAL_DATE_COLUMNS_NO_OWNER_EMAIL =
  "id, org_id, lease_id, property_id, date_type, due_date, owner_name, status, completed_at, completed_by, reminder_days_before, note, source, created_at, updated_at";
const CRITICAL_DATE_COLUMNS_NO_OWNERS =
  "id, org_id, lease_id, property_id, date_type, due_date, status, completed_at, completed_by, reminder_days_before, note, source, created_at, updated_at";

function isMissingOwnerEmailColumn(error) {
  const text = `${error?.code || ""} ${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return text.includes("owner_email") && (text.includes("does not exist") || text.includes("schema cache") || error?.code === "42703" || error?.code === "PGRST204");
}

function isMissingOwnerNameColumn(error) {
  const text = `${error?.code || ""} ${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return text.includes("owner_name") && (text.includes("does not exist") || text.includes("schema cache") || error?.code === "42703" || error?.code === "PGRST204");
}

function withOwnerEmailFallback(row) {
  return { ...row, owner_email: row?.owner_email || null, owner_name: row?.owner_name || null };
}

export async function listCriticalDates({ orgId, propertyId, leaseId, status } = {}) {
  const runQuery = (columns) => {
    let q = supabase
      .from("lease_critical_dates")
      .select(columns)
      .order("due_date", { ascending: true });
    if (orgId) q = q.eq("org_id", orgId);
    if (propertyId) q = q.eq("property_id", propertyId);
    if (leaseId) q = q.eq("lease_id", leaseId);
    if (status) q = q.eq("status", status);
    return q;
  };

  let q = runQuery(CRITICAL_DATE_COLUMNS);
  let { data, error } = await q;
  if (error && isMissingOwnerEmailColumn(error)) {
    console.warn("[criticalDateService] owner_email column missing; retrying without it.");
    ({ data, error } = await runQuery(CRITICAL_DATE_COLUMNS_NO_OWNER_EMAIL));
  }
  if (error && isMissingOwnerNameColumn(error)) {
    console.warn("[criticalDateService] owner_name column missing; retrying without owner columns.");
    ({ data, error } = await runQuery(CRITICAL_DATE_COLUMNS_NO_OWNERS));
  }
  if (error) {
    console.warn("[criticalDateService] list failed:", error.message);
    return [];
  }
  return (data || []).map(withOwnerEmailFallback);
}

// Server-owned, audited CRUD (Phase 6D-4: manage_lease_critical_date RPC /
// manage-lease-critical-date edge function) -- replaces the prior direct
// supabase.from("lease_critical_dates") calls, which had zero audit logging
// and zero permission check anywhere. Note: approve_lease_workflow's own
// derived-critical-date inserts (commencement/expiration/renewal_notice,
// seeded from approved lease columns) are a completely separate code path
// and are untouched by this change.
export async function createCriticalDate(row) {
  if (!row?.lease_id) {
    throw new Error("createCriticalDate: lease_id is required");
  }
  const data = await invokeEdgeFunction("manage-lease-critical-date", {
    lease_id: row.lease_id,
    action: "create",
    patch: {
      date_type: row.date_type || "custom",
      due_date: row.due_date,
      owner_email: row.owner_email || null,
      owner_name: row.owner_name || null,
      reminder_days_before: row.reminder_days_before ?? null,
      note: row.note || null,
    },
  });
  return withOwnerEmailFallback(data.row);
}

export async function updateCriticalDate({ id, leaseId, ownerEmail, ownerName }) {
  if (!id || !leaseId) {
    throw new Error("updateCriticalDate: id and leaseId are required");
  }
  const data = await invokeEdgeFunction("manage-lease-critical-date", {
    lease_id: leaseId,
    action: "update",
    critical_date_id: id,
    patch: { owner_email: ownerEmail ?? null, owner_name: ownerName ?? null },
  });
  return withOwnerEmailFallback(data.row);
}

export async function markCriticalDateComplete({ id, leaseId, completedBy }) {
  if (!id || !leaseId) {
    throw new Error("markCriticalDateComplete: id and leaseId are required");
  }
  const data = await invokeEdgeFunction("manage-lease-critical-date", {
    lease_id: leaseId,
    action: "mark_complete",
    critical_date_id: id,
    patch: { completed_by: completedBy || null },
  });
  return withOwnerEmailFallback(data.row);
}

export async function deleteCriticalDate({ id, leaseId }) {
  if (!id || !leaseId) {
    throw new Error("deleteCriticalDate: id and leaseId are required");
  }
  await invokeEdgeFunction("manage-lease-critical-date", {
    lease_id: leaseId,
    action: "delete",
    critical_date_id: id,
    patch: {},
  });
  return id;
}

export function daysUntil(dateString) {
  if (!dateString) return null;
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return Math.round((d - today) / (1000 * 60 * 60 * 24));
}

export function urgencyOf(date) {
  const days = daysUntil(date?.due_date);
  if (date?.status === "completed") return "completed";
  if (date?.status === "dismissed") return "dismissed";
  if (days === null) return "unknown";
  if (days < 0) return "overdue";
  if (days <= 30) return "due_soon";
  if (days <= 90) return "upcoming";
  return "future";
}
