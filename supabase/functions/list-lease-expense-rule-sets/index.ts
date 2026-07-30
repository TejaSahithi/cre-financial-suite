// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown) {
  return typeof value === "string" && UUID_RE.test(value);
}

function uniqueUuidList(values: unknown): string[] {
  const input = Array.isArray(values) ? values : [];
  return [...new Set(input.map((value) => String(value || "").trim()).filter(isUuid))];
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|invalid/i.test(message)) return 400;
  return 500;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["LeaseExpenseRules", "LeaseExpenseClassification", "LeaseReview"], "read");

    const body = await req.json().catch(() => ({}));
    const leaseIds = uniqueUuidList([
      ...(Array.isArray(body?.lease_ids) ? body.lease_ids : []),
      body?.lease_id,
    ]);
    const ruleSetId = isUuid(body?.rule_set_id) ? String(body.rule_set_id) : null;

    let ruleSetQuery = supabaseAdmin
      .from("lease_expense_rule_sets")
      .select("*")
      .eq("org_id", orgId)
      .not("status", "eq", "archived")
      .order("version", { ascending: false })
      .order("updated_at", { ascending: false });

    if (ruleSetId) {
      ruleSetQuery = ruleSetQuery.eq("id", ruleSetId);
    } else if (leaseIds.length > 0) {
      ruleSetQuery = ruleSetQuery.in("lease_id", leaseIds);
    }

    const { data: unfilteredRuleSets = [], error: ruleSetsError } = await ruleSetQuery;
    if (ruleSetsError) {
      throw new Error(ruleSetsError.message || "Could not load lease expense rule sets");
    }

    const candidateLeaseIds = [...new Set(
      (unfilteredRuleSets || []).map((row: any) => row.lease_id).filter(isUuid),
    )];
    let approvedLeaseIds = new Set<string>();
    if (candidateLeaseIds.length > 0) {
      const { data: leases = [], error: leasesError } = await supabaseAdmin
        .from("leases")
        .select("id, abstract_status, status, abstract_approved_at")
        .eq("org_id", orgId)
        .in("id", candidateLeaseIds);
      if (leasesError) {
        throw new Error(leasesError.message || "Could not verify lease approval status");
      }
      approvedLeaseIds = new Set(
        (leases || [])
          .filter((lease: any) =>
            String(lease.abstract_status || "").toLowerCase() === "approved" ||
            ["approved", "budget_ready"].includes(
              String(lease.status || "").toLowerCase(),
            ) ||
            Boolean(lease.abstract_approved_at)
          )
          .map((lease: any) => lease.id),
      );
    }
    const ruleSets = (unfilteredRuleSets || []).filter((row: any) => approvedLeaseIds.has(row.lease_id));

    const ruleSetIds = (ruleSets || []).map((row: any) => row.id).filter(isUuid);
    if (ruleSetIds.length === 0) {
      return jsonResponse({
        error: false,
        ruleSets: [],
        rules: [],
        values: [],
        clauses: [],
        rule_sets_count: 0,
        rules_count: 0,
      });
    }

    const { data: rules = [], error: rulesError } = await supabaseAdmin
      .from("lease_expense_rules")
      .select("*")
      .eq("org_id", orgId)
      .in("rule_set_id", ruleSetIds);
    if (rulesError) {
      throw new Error(rulesError.message || "Could not load lease expense rules");
    }

    const ruleIds = (rules || []).map((row: any) => row.id).filter(isUuid);
    const [{ data: values = [], error: valuesError }, { data: clauses = [], error: clausesError }] = await Promise.all([
      ruleIds.length > 0
        ? supabaseAdmin.from("lease_expense_values").select("*").in("rule_id", ruleIds)
        : Promise.resolve({ data: [], error: null }),
      ruleIds.length > 0
        ? supabaseAdmin.from("lease_expense_rule_clauses").select("*").in("lease_expense_rule_id", ruleIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (valuesError) {
      throw new Error(valuesError.message || "Could not load lease expense values");
    }
    if (clausesError) {
      throw new Error(clausesError.message || "Could not load lease expense clauses");
    }

    return jsonResponse({
      error: false,
      ruleSets: ruleSets || [],
      rules: rules || [],
      values: values || [],
      clauses: clauses || [],
      rule_sets_count: ruleSets?.length || 0,
      rules_count: rules?.length || 0,
    });
  } catch (err) {
    const message = err?.message || "Could not load lease expense rule sets";
    return jsonResponse({
      error: true,
      message,
      error_code: "LIST_LEASE_EXPENSE_RULE_SETS_FAILED",
    }, errorStatus(message));
  }
});
