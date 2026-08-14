// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { createBlsReferenceDataProvider } from "../_shared/reference-data/bls-provider.ts";
import { resolveReferenceObservation } from "../_shared/reference-data/reference-data-provider.ts";
import { operationalStatus, writeOperationalAudit } from "../_shared/operational-audit.ts";

const DATE_RE = /^\d{4}(?:-\d{2})?$/;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { supabaseAdmin, user } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["LeaseExpenseRules", "RentProjection", "LeaseReview"], "write");

    const body = await req.json().catch(() => ({}));
    const providerName = String(body.provider || "bls").trim().toLowerCase();
    const period = String(body.period || "").trim();
    const leaseId = String(body.lease_id ?? body.leaseId ?? "").trim() || null;
    const fieldKey = String(body.field_key ?? body.fieldKey ?? "").trim() || null;
    let seriesHint = String(body.series_id ?? body.seriesId ?? body.series_hint ?? body.seriesHint ?? "").trim() || null;

    if (providerName !== "bls") throw new Error("Only BLS reference observations are supported by this function");
    if (!DATE_RE.test(period)) throw new Error("period is required in YYYY or YYYY-MM format");

    let approvedSelection = null;
    if (!seriesHint && leaseId && fieldKey) {
      const { data, error } = await supabaseAdmin
        .from("reference_series_selections")
        .select("*")
        .eq("org_id", orgId)
        .eq("lease_id", leaseId)
        .eq("field_key", fieldKey)
        .eq("provider", providerName)
        .eq("status", "approved")
        .order("approved_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`Failed to load approved reference series: ${error.message}`);
      approvedSelection = data;
      seriesHint = data?.series_id || null;
    }

    if (!seriesHint) {
      const blocked = {
        contractVersion: "reference-data-resolution-v1",
        status: "requires_review",
        reasonCodes: ["REFERENCE_SERIES_APPROVAL_REQUIRED"],
        observation: null,
        candidates: [],
      };
      await writeOperationalAudit(supabaseAdmin, {
        orgId,
        entityType: "reference_observation",
        entityId: leaseId || fieldKey || providerName,
        action: "REFERENCE_OBSERVATION_BLOCKED",
        actorEmail: user.email || null,
        actorUserId: user.id,
        source: "resolve-reference-observation",
        newValue: { provider: providerName, period, lease_id: leaseId, field_key: fieldKey, result: blocked },
      });
      return jsonResponse({ error: false, data: blocked });
    }

    const result = await resolveReferenceObservation(createBlsReferenceDataProvider(), {
      provider: providerName,
      seriesHint,
      period,
      leaseId,
      fieldKey,
    });

    let savedObservation = null;
    if (result.observation) {
      const observationStatus = approvedSelection || body.status === "approved" ? "approved" : operationalStatus(result.status);
      const approvalTimestamp = observationStatus === "approved" ? (approvedSelection?.approved_at || new Date().toISOString()) : null;
      const approvalActor = observationStatus === "approved" ? (approvedSelection?.approved_by || user.id) : null;
      const { data, error } = await supabaseAdmin
        .from("reference_observations")
        .upsert({
          org_id: orgId,
          provider: result.observation.provider,
          series_id: result.observation.seriesId,
          period: result.observation.period,
          value: result.observation.value,
          retrieved_at: result.observation.retrievedAt,
          source_url: result.observation.sourceUrl || null,
          payload_fingerprint: result.observation.payloadFingerprint,
          status: observationStatus,
          approved_at: approvalTimestamp,
          approved_by: approvalActor,
          evidence: {
            source: "resolve-reference-observation",
            lease_id: leaseId,
            field_key: fieldKey,
            approved_series_selection_id: approvedSelection?.id || null,
            approved_series_selection_at: approvedSelection?.approved_at || null,
            approved_series_selection_by: approvedSelection?.approved_by || null,
          },
        }, { onConflict: "org_id,provider,series_id,period" })
        .select("*")
        .single();
      if (error) throw new Error(`Failed to persist reference observation: ${error.message}`);
      savedObservation = data;
    }

    await writeOperationalAudit(supabaseAdmin, {
      orgId,
      entityType: "reference_observation",
      entityId: savedObservation?.id ?? leaseId ?? fieldKey ?? providerName,
      action: "REFERENCE_OBSERVATION_RESOLVED",
      actorEmail: user.email || null,
      actorUserId: user.id,
      source: "resolve-reference-observation",
      newValue: { provider: providerName, period, lease_id: leaseId, field_key: fieldKey, result, saved_observation: savedObservation },
    });

    return jsonResponse({ error: false, data: result, saved_observation: savedObservation });
  } catch (error) {
    const message = error?.message || "Could not resolve reference observation";
    console.error("[resolve-reference-observation]", message);
    return jsonResponse({ error: true, message, error_code: "RESOLVE_REFERENCE_OBSERVATION_FAILED" }, /unauthorized/i.test(message) ? 401 : 400);
  }
});
