// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { evaluateCoiCompliance } from "../_shared/compliance/coi-compliance-evaluator.ts";
import { writeOperationalAudit } from "../_shared/operational-audit.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { supabaseAdmin, user } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["Leases", "LeaseReview", "Vendors"], "write");

    const body = await req.json().catch(() => ({}));
    const coiDocumentId = String(body.coi_document_id ?? body.coiDocumentId ?? "").trim() || null;
    const leaseIdFromBody = String(body.lease_id ?? body.leaseId ?? "").trim() || null;
    const asOfDate = String(body.as_of_date ?? body.asOfDate ?? new Date().toISOString().slice(0, 10)).trim();
    if (!DATE_RE.test(asOfDate)) throw new Error("as_of_date is required in YYYY-MM-DD format");
    if (coiDocumentId && !UUID_RE.test(coiDocumentId)) throw new Error("coi_document_id is invalid");
    if (leaseIdFromBody && !UUID_RE.test(leaseIdFromBody)) throw new Error("lease_id is invalid");

    let coi = body.coi && typeof body.coi === "object" && !Array.isArray(body.coi) ? body.coi : null;
    if (coiDocumentId) {
      const { data, error } = await supabaseAdmin
        .from("coi_documents")
        .select("*")
        .eq("org_id", orgId)
        .eq("id", coiDocumentId)
        .maybeSingle();
      if (error) throw new Error(`Failed to load COI document: ${error.message}`);
      if (!data?.id) throw new Error("COI document not found");
      coi = data;
    }

    const leaseId = leaseIdFromBody ?? coi?.lease_id ?? null;
    if (!leaseId) throw new Error("lease_id is required");

    const { data: lease, error: leaseError } = await supabaseAdmin
      .from("leases")
      .select("id, property_id")
      .eq("org_id", orgId)
      .eq("id", leaseId)
      .maybeSingle();
    if (leaseError) throw new Error(`Failed to load lease: ${leaseError.message}`);
    if (!lease?.id) throw new Error("Lease not found");
    if (lease.property_id) await assertPropertyAccess(req, lease.property_id);

    const requirement = body.requirement && typeof body.requirement === "object" && !Array.isArray(body.requirement)
      ? body.requirement
      : null;
    const result = evaluateCoiCompliance({ requirement, coi, asOfDate });

    let savedResult = null;
    if (body.persist !== false) {
      const { data, error } = await supabaseAdmin
        .from("lease_insurance_compliance_results")
        .insert({
          org_id: orgId,
          lease_id: leaseId,
          coi_document_id: coi?.id ?? coiDocumentId,
          status: result.status,
          reason_codes: result.reasonCodes,
          requirement_snapshot: requirement ?? {},
          coi_snapshot: coi ?? {},
          evaluated_by: user.id,
        })
        .select("*")
        .single();
      if (error) throw new Error(`Failed to save COI compliance result: ${error.message}`);
      savedResult = data;
    }

    let expirationObligation = null;
    if (body.persist !== false && coi?.expiration_date) {
      const dueDate = String(coi.expiration_date).slice(0, 10);
      const { data: obligation, error: obligationError } = await supabaseAdmin
        .from("lease_obligations")
        .upsert({
          org_id: orgId,
          lease_id: leaseId,
          property_id: lease.property_id ?? null,
          obligation_type: "insurance_certificate",
          title: "COI Expiration",
          source_key: `coi_expiration:${coi?.id ?? coiDocumentId ?? "manual"}:${dueDate}`,
          cadence: "once",
          due_rule: { due_date: dueDate },
          effective_start: dueDate,
          effective_end: dueDate,
          responsible_party: "tenant",
          communication_policy: "external_requires_approval",
          status: "active",
          source: "coi_compliance_evaluation",
          evidence: { coi_document_id: coi?.id ?? coiDocumentId, compliance_result_id: savedResult?.id ?? null },
        }, { onConflict: "org_id,lease_id,source_key" })
        .select("*")
        .single();
      if (obligationError) console.warn(`[evaluate-coi-compliance] COI expiration obligation skipped: ${obligationError.message}`);
      expirationObligation = obligation ?? null;
    }

    await writeOperationalAudit(supabaseAdmin, {
      orgId,
      entityType: "coi_compliance_result",
      entityId: savedResult?.id ?? null,
      action: "COI_COMPLIANCE_EVALUATED",
      actorEmail: user.email || null,
      actorUserId: user.id,
      propertyId: lease.property_id ?? null,
      newValue: { result, saved_result: savedResult, expiration_obligation: expirationObligation },
      source: "evaluate-coi-compliance",
    });

    return jsonResponse({ error: false, data: { result, saved_result: savedResult, expiration_obligation: expirationObligation } });
  } catch (error) {
    const message = error?.message || "Could not evaluate COI compliance";
    console.error("[evaluate-coi-compliance]", message);
    return jsonResponse({ error: true, message, error_code: "EVALUATE_COI_COMPLIANCE_FAILED" }, errorStatus(message));
  }
});
