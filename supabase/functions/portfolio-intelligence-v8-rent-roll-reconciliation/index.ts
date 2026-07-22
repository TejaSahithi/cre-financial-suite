// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isRentRollReconciliationEnabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import { reconcileRentRoll } from "../_shared/portfolio-intelligence/rent-roll-reconciliation.ts";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!isRentRollReconciliationEnabled()) return jsonResponse({ error: true, message: "Rent roll reconciliation is disabled" }, 403);
    const body = await req.json().catch(() => ({}));
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    let facts = body.facts;
    if (!Array.isArray(facts)) {
      let query = supabaseAdmin.from("portfolio_lease_facts").select("*").eq("organization_id", orgId).is("superseded_at", null).limit(1000);
      if (body.portfolioId) query = query.eq("portfolio_id", body.portfolioId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      facts = (data ?? []).map((row: any) => ({ ...(row.fact_payload ?? row), id: row.id }));
    }
    const findings = reconcileRentRoll({ facts, rentRoll: body.rentRoll ?? [], config: body.config ?? {} });
    return jsonResponse({ schemaVersion: "portfolio-rent-roll-reconciliation-response-v1", findings, writeBackPerformed: false });
  } catch (error: any) { console.error(`[portfolio-intelligence-v8-rent-roll-reconciliation] ${error?.message ?? error}`); return jsonResponse({ error: true, message: error?.message ?? "Failed to reconcile rent roll" }, 500); }
});
