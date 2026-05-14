/**
 * criticalDateService — CRUD over `lease_critical_dates` (migration
 * 20260514130000). The table mixes derived rows (commencement, expiration,
 * renewal_notice — auto-created from approved lease columns at migration
 * time) with user-added reminders. Both behave identically once persisted.
 */
import { supabase } from "@/services/supabaseClient";

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

export async function listCriticalDates({ orgId, propertyId, leaseId, status } = {}) {
  let q = supabase
    .from("lease_critical_dates")
    .select(
      "id, org_id, lease_id, property_id, date_type, due_date, owner_email, owner_name, status, completed_at, completed_by, reminder_days_before, note, source, created_at, updated_at",
    )
    .order("due_date", { ascending: true });
  if (orgId) q = q.eq("org_id", orgId);
  if (propertyId) q = q.eq("property_id", propertyId);
  if (leaseId) q = q.eq("lease_id", leaseId);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) {
    console.warn("[criticalDateService] list failed:", error.message);
    return [];
  }
  return data || [];
}

export async function createCriticalDate(row) {
  if (!row?.org_id || !row?.lease_id) {
    throw new Error("createCriticalDate: org_id and lease_id are required");
  }
  const payload = {
    org_id: row.org_id,
    lease_id: row.lease_id,
    property_id: row.property_id || null,
    date_type: row.date_type || "custom",
    due_date: row.due_date,
    owner_email: row.owner_email || null,
    owner_name: row.owner_name || null,
    status: row.status || "open",
    reminder_days_before: row.reminder_days_before ?? null,
    note: row.note || null,
    source: row.source || "manual",
  };
  const { data, error } = await supabase
    .from("lease_critical_dates")
    .upsert(payload, { onConflict: "lease_id,date_type,due_date" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateCriticalDate(id, patch) {
  const { data, error } = await supabase
    .from("lease_critical_dates")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function markCriticalDateComplete(id, completedBy) {
  return updateCriticalDate(id, {
    status: "completed",
    completed_at: new Date().toISOString(),
    completed_by: completedBy || null,
  });
}

export async function deleteCriticalDate(id) {
  const { error } = await supabase.from("lease_critical_dates").delete().eq("id", id);
  if (error) throw error;
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
