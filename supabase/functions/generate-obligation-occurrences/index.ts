// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { generateObligationOccurrences } from "../_shared/obligations/obligation-engine.ts";
import {
  DEFAULT_REMINDER_MILESTONES,
  occurrenceIsTerminal,
  obligationNotificationIdempotencyKey,
  reminderMilestoneForOccurrence,
} from "../_shared/obligations/obligation-notifications.ts";
import { writeOperationalAudit } from "../_shared/operational-audit.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found|invalid/i.test(message)) return 400;
  return 500;
}

function addDaysIso(base: string, days: number) {
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function notificationPolicyAllowsInternalDispatch(policy: unknown) {
  const value = String(policy || "internal_only").trim().toLowerCase();
  return !["none", "disabled", "do_not_notify", "manual_only"].includes(value);
}

function notificationPolicyAllowsExternalDispatch(policy: unknown) {
  const value = String(policy || "internal_only").trim().toLowerCase();
  return ["external_allowed", "tenant_allowed", "stakeholder_allowed", "internal_and_external"].includes(value);
}

async function loadExistingOccurrences(supabaseAdmin: any, orgId: string, keys: string[]) {
  if (!keys.length) return [];
  const { data, error } = await supabaseAdmin
    .from("lease_obligation_occurrences")
    .select("*")
    .eq("org_id", orgId)
    .in("idempotency_key", keys);
  if (error) throw new Error(`Failed to load existing obligation occurrences: ${error.message}`);
  return data || [];
}

async function dispatchOccurrenceNotification(input: {
  occurrence: any;
  obligation: any;
  eventType: string;
  days: number;
  milestone: string;
  retryFailedDeliveries: boolean;
}) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Missing Supabase service configuration");
  const { occurrence, obligation, eventType, days, milestone, retryFailedDeliveries } = input;
  const notificationPolicy = occurrence.notification_policy || obligation.communication_policy || "internal_only";
  const idempotencyKey = obligationNotificationIdempotencyKey({
    orgId: occurrence.org_id,
    occurrenceId: occurrence.id,
    eventType,
    milestone,
  });

  const response = await fetch(`${SUPABASE_URL}/functions/v1/notification-dispatch-v9`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-service-key": SERVICE_KEY,
      "x-internal-org-id": occurrence.org_id,
    },
    body: JSON.stringify({
      org_id: occurrence.org_id,
      event_type: eventType,
      entity_type: "lease_obligation_occurrence",
      entity_id: occurrence.id,
      entity_label: obligation.title || obligation.obligation_type || "Lease obligation",
      property_id: occurrence.property_id || null,
      action_url: "/AutomationReadiness",
      idempotency_key: idempotencyKey,
      retry_failed_deliveries: retryFailedDeliveries,
      metadata: {
        source: "generate_obligation_occurrences",
        obligation_id: occurrence.obligation_id,
        lease_id: occurrence.lease_id || null,
        due_date: occurrence.due_date,
        days_until_due: days,
        reminder_milestone: milestone,
        notification_policy: notificationPolicy,
        external_delivery_allowed: notificationPolicyAllowsExternalDispatch(notificationPolicy),
      },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    throw new Error(payload?.message || payload?.error || `notification-dispatch-v9 failed with ${response.status}`);
  }
  return { ...payload, idempotency_key: idempotencyKey };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { supabaseAdmin, user, isInternal } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["CriticalDates", "Leases", "LeaseReview"], "write");

    const body = await req.json().catch(() => ({}));
    const asOfDate = String(body.as_of_date ?? body.asOfDate ?? new Date().toISOString().slice(0, 10)).trim();
    const windowStart = String(body.window_start ?? body.windowStart ?? asOfDate).trim();
    const windowEnd = String(body.window_end ?? body.windowEnd ?? addDaysIso(windowStart, 60)).trim();
    const leaseId = String(body.lease_id ?? body.leaseId ?? "").trim() || null;
    const propertyId = String(body.property_id ?? body.propertyId ?? "").trim() || null;
    const dispatchNotifications = body.dispatch_notifications !== false;
    const retryFailedDeliveries = body.retry_failed_deliveries !== false;
    const reminderMilestones = Array.isArray(body.reminder_milestones ?? body.reminderMilestones)
      ? (body.reminder_milestones ?? body.reminderMilestones)
      : DEFAULT_REMINDER_MILESTONES;
    const schedulerRunId = String(body.scheduler_run_id ?? body.schedulerRunId ?? crypto.randomUUID());
    const runSource = body.scheduled || body.run_source === "scheduler" || body.runSource === "scheduler" ? "scheduler" : "manual";

    if (!DATE_RE.test(windowStart)) throw new Error("window_start is required in YYYY-MM-DD format");
    if (!DATE_RE.test(windowEnd)) throw new Error("window_end is required in YYYY-MM-DD format");
    if (!DATE_RE.test(asOfDate)) throw new Error("as_of_date is required in YYYY-MM-DD format");
    if (leaseId && !UUID_RE.test(leaseId)) throw new Error("lease_id is invalid");
    if (propertyId && !UUID_RE.test(propertyId)) throw new Error("property_id is invalid");
    if (propertyId) await assertPropertyAccess(req, propertyId);

    let query = supabaseAdmin
      .from("lease_obligations")
      .select("*")
      .eq("org_id", orgId)
      .eq("status", "active");
    if (leaseId) query = query.eq("lease_id", leaseId);
    if (propertyId) query = query.eq("property_id", propertyId);

    const { data: obligations, error: obligationError } = await query;
    if (obligationError) throw new Error(`Failed to load lease obligations: ${obligationError.message}`);

    const generatedRows = (obligations ?? []).flatMap((obligation: Record<string, unknown>) =>
      generateObligationOccurrences({ obligation, windowStart, windowEnd, asOfDate }).map((occurrence) => ({
        ...occurrence,
        org_id: orgId,
        notification_policy: occurrence.notification_policy || obligation.communication_policy || "internal_only",
      }))
    );

    const keys = [...new Set(generatedRows.map((row: any) => row.idempotency_key).filter(Boolean))];
    const existingRows = await loadExistingOccurrences(supabaseAdmin, orgId, keys);
    const existingByKey = new Map(existingRows.map((row: any) => [row.idempotency_key, row]));
    const terminalExisting = existingRows.filter((row: any) => occurrenceIsTerminal(row.status));
    const upsertRows = generatedRows.filter((row: any) => !occurrenceIsTerminal(existingByKey.get(row.idempotency_key)?.status));

    let savedRows = [];
    if (upsertRows.length > 0) {
      const { data: saved, error: saveError } = await supabaseAdmin
        .from("lease_obligation_occurrences")
        .upsert(upsertRows, { onConflict: "org_id,idempotency_key" })
        .select("*");
      if (saveError) throw new Error(`Failed to save obligation occurrences: ${saveError.message}`);
      savedRows = saved ?? upsertRows;
    }

    const obligationById = new Map((obligations ?? []).map((obligation: any) => [obligation.id, obligation]));
    const dispatched = [];
    const skipped = [];

    if (dispatchNotifications) {
      for (const occurrence of savedRows) {
        const obligation = obligationById.get(occurrence.obligation_id) || {};
        const notificationPolicy = occurrence.notification_policy || obligation.communication_policy || "internal_only";
        if (!notificationPolicyAllowsInternalDispatch(notificationPolicy)) {
          skipped.push({ id: occurrence.id, reason: "notification_policy_disabled" });
          continue;
        }
        const milestone = reminderMilestoneForOccurrence(occurrence, asOfDate, reminderMilestones);
        if (!milestone) {
          skipped.push({ id: occurrence.id, reason: occurrenceIsTerminal(occurrence.status) ? "terminal_status" : "outside_reminder_milestone" });
          continue;
        }
        try {
          const payload = await dispatchOccurrenceNotification({
            occurrence,
            obligation,
            eventType: milestone.eventType,
            days: milestone.days,
            milestone: milestone.milestone,
            retryFailedDeliveries,
          });
          dispatched.push({
            id: occurrence.id,
            org_id: occurrence.org_id,
            event_type: milestone.eventType,
            due_date: occurrence.due_date,
            milestone: milestone.milestone,
            idempotency_key: payload.idempotency_key,
            recipient_count: payload.recipient_count ?? 0,
          });
        } catch (notificationError) {
          skipped.push({ id: occurrence.id, reason: notificationError?.message || "dispatch_failed" });
        }
      }
    }

    await writeOperationalAudit(supabaseAdmin, {
      orgId,
      entityType: "lease_obligation_scheduler_run",
      entityId: schedulerRunId,
      action: runSource === "scheduler" ? "OBLIGATION_SCHEDULER_RUN" : "OBLIGATION_OCCURRENCES_GENERATED",
      actorUserId: isInternal ? null : user.id,
      source: "generate-obligation-occurrences",
      newValue: {
        scheduler_run_id: schedulerRunId,
        run_source: runSource,
        window_start: windowStart,
        window_end: windowEnd,
        as_of_date: asOfDate,
        generated_count: generatedRows.length,
        upserted_count: savedRows.length,
        terminal_preserved_count: terminalExisting.length,
        notifications_dispatched: dispatched.length,
        notifications_skipped: skipped.length,
      },
    });

    return jsonResponse({
      error: false,
      data: {
        scheduler_run_id: schedulerRunId,
        run_source: runSource,
        generated_count: generatedRows.length,
        upserted_count: savedRows.length,
        terminal_preserved_count: terminalExisting.length,
        occurrences: savedRows,
        terminal_preserved: terminalExisting,
        notifications: { dispatched, skipped },
      },
    });
  } catch (error) {
    const message = error?.message || "Could not generate obligation occurrences";
    console.error("[generate-obligation-occurrences]", message);
    return jsonResponse({ error: true, message, error_code: "GENERATE_OBLIGATION_OCCURRENCES_FAILED" }, errorStatus(message));
  }
});
