// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function requireInternal(req: Request) {
  const key = req.headers.get("x-internal-service-key") || "";
  if (!SERVICE_KEY || key.trim() !== SERVICE_KEY) {
    throw new Error("Unauthorized: internal service key is required");
  }
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function daysUntil(value: string) {
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return null;
  due.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - startOfToday().getTime()) / 86400000);
}

function eventTypeForCriticalDate(row: any, days: number, daysAhead: number) {
  if (days < 0) return "critical_date.overdue";
  if (days === 0) return "critical_date.due_today";
  const reminderWindow = Number(row.reminder_days_before ?? daysAhead);
  if (days <= Math.max(0, reminderWindow || daysAhead)) return "critical_date.due_soon";
  return null;
}

async function alreadyNotifiedToday(supabase: any, row: any, eventType: string) {
  const since = startOfToday().toISOString();
  const { data, error } = await supabase
    .from("notifications")
    .select("id")
    .eq("org_id", row.org_id)
    .eq("event_type", eventType)
    .eq("entity_id", row.id)
    .gte("created_at", since)
    .limit(1);
  if (error) {
    console.warn("[critical-date-notifications] duplicate check failed:", error.message);
    return false;
  }
  return (data || []).length > 0;
}

async function dispatchNotification(row: any, eventType: string, days: number) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/notification-dispatch-v9`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-service-key": SERVICE_KEY,
      "x-internal-org-id": row.org_id,
    },
    body: JSON.stringify({
      org_id: row.org_id,
      event_type: eventType,
      entity_type: "critical_date",
      entity_id: row.id,
      entity_label: row.date_type || "Critical Date",
      property_id: row.property_id || null,
      tenant_id: row.tenant_id || null,
      action_url: "/CriticalDates",
      metadata: {
        source: "dispatch_critical_date_notifications",
        lease_id: row.lease_id || null,
        due_date: row.due_date,
        days_until_due: days,
        owner_email: row.owner_email || null,
        owner_name: row.owner_name || null,
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    throw new Error(payload?.message || payload?.error || `notification-dispatch-v9 failed with ${response.status}`);
  }
  return payload;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    requireInternal(req);
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return json({ error: true, message: "Missing Supabase service configuration" }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const orgId = String(body.org_id || "").trim();
    const daysAhead = Number.isFinite(Number(body.days_ahead)) ? Number(body.days_ahead) : 30;
    const dryRun = body.dry_run === true;
    const today = startOfToday();
    const maxDueDate = new Date(today);
    maxDueDate.setDate(maxDueDate.getDate() + Math.max(0, daysAhead));

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    let query = supabase
      .from("lease_critical_dates")
      .select("id, org_id, lease_id, property_id, tenant_id, date_type, due_date, status, owner_email, owner_name, reminder_days_before")
      .not("due_date", "is", null)
      .lte("due_date", dateOnly(maxDueDate))
      .not("status", "in", "(completed,dismissed)");
    if (orgId) query = query.eq("org_id", orgId);

    const { data: rows, error } = await query.limit(500);
    if (error) throw error;

    const dispatched = [];
    const skipped = [];

    for (const row of rows || []) {
      const days = daysUntil(row.due_date);
      if (days === null) {
        skipped.push({ id: row.id, reason: "invalid_due_date" });
        continue;
      }

      const eventType = eventTypeForCriticalDate(row, days, daysAhead);
      if (!eventType) {
        skipped.push({ id: row.id, reason: "outside_reminder_window" });
        continue;
      }

      if (await alreadyNotifiedToday(supabase, row, eventType)) {
        skipped.push({ id: row.id, event_type: eventType, reason: "already_notified_today" });
        continue;
      }

      if (!dryRun) await dispatchNotification(row, eventType, days);
      dispatched.push({ id: row.id, org_id: row.org_id, event_type: eventType, due_date: row.due_date });
    }

    return json({ error: false, dry_run: dryRun, dispatched, skipped });
  } catch (error) {
    console.error("[critical-date-notifications] Error:", error?.message || error);
    return json({ error: true, message: error?.message || "Unexpected error" }, /unauthorized/i.test(error?.message || "") ? 401 : 500);
  }
});
