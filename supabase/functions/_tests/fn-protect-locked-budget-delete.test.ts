// Regression coverage for fn_protect_locked_budget's DELETE behavior
// (trigger trg_protect_locked_budget, BEFORE UPDATE OR DELETE ON budgets).
//
// Bug fixed in 20269900000064_fix_protect_locked_budget_delete_behavior.sql:
// every branch of the function ended with `RETURN NEW;`, including the
// fallthrough for DELETE on a non-locked budget. `NEW` is always NULL on a
// DELETE trigger, and a BEFORE DELETE trigger returning NULL silently
// CANCELS the delete with no error -- so deleting a draft/reviewed budget
// appeared to succeed (no exception) but left the row in place. A locked
// budget's delete happened to still be blocked, but only because the
// financial-values-changed check above it tripped first (NEW.total_revenue
// IS DISTINCT FROM OLD.total_revenue is true when NEW is NULL), reporting
// the wrong message ("modify financial values" instead of "cannot delete").
//
// Correct, product-verified intent (delete_organization_admin --
// 20260602014048_security_definer_search_path_hardening.sql -- deletes
// budgets unconditionally by org_id as part of a real, currently-used
// SuperAdmin.jsx "Permanently delete organization" cascade, so
// non-locked-budget deletion must actually work, not silently no-op):
//   DELETE + status='locked'  -> explicit RAISE EXCEPTION, no row removed.
//   DELETE + status<>'locked' -> the row is actually removed.
//   UPDATE regressions (financial-value block on locked, everything else
//   unaffected) must remain exactly as before.
import { assertEquals, assertExists, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}
function assertNoError(error: unknown) {
  if (error) throw new Error(JSON.stringify(error));
}
async function insertOne(client: ReturnType<typeof adminClient>, table: string, values: Record<string, unknown>) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  assertNoError(error);
  assertExists(data);
  return data;
}

async function setUpOrgAndProperty(suffix: string) {
  const admin = adminClient();
  const org = await insertOne(admin, "organizations", { name: `Budget Delete Trigger Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Budget Delete Trigger Property ${suffix}`, status: "active" });
  return { admin, org, property };
}

async function insertBudget(admin: ReturnType<typeof adminClient>, org: any, property: any, status: string, year: number) {
  return await insertOne(admin, "budgets", {
    org_id: org.id, scope: "property", scope_id: property.id, property_id: property.id,
    budget_year: year, name: `Budget ${status} ${year}`, status,
    total_revenue: 1000, total_expenses: 400, noi: 600, period: "annual",
  });
}

Deno.test({
  name: "fn_protect_locked_budget DELETE: a draft budget is actually deleted (not silently no-op'd)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const suffix = crypto.randomUUID();
    const { admin, org, property } = await setUpOrgAndProperty(suffix);
    const budget = await insertBudget(admin, org, property, "draft", 2031);

    const { error: deleteError } = await admin.from("budgets").delete().eq("id", budget.id);
    assertNoError(deleteError);

    const { data: stillThere } = await admin.from("budgets").select("id").eq("id", budget.id).maybeSingle();
    assertEquals(stillThere, null, "draft budget must actually be removed, not silently retained");
  },
});

Deno.test({
  name: "fn_protect_locked_budget DELETE: a reviewed (non-locked) budget is actually deleted",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const suffix = crypto.randomUUID();
    const { admin, org, property } = await setUpOrgAndProperty(suffix);
    const budget = await insertBudget(admin, org, property, "reviewed", 2031);

    const { error: deleteError } = await admin.from("budgets").delete().eq("id", budget.id);
    assertNoError(deleteError);

    const { data: stillThere } = await admin.from("budgets").select("id").eq("id", budget.id).maybeSingle();
    assertEquals(stillThere, null, "reviewed (non-locked) budget must actually be removed");
  },
});

Deno.test({
  name: "fn_protect_locked_budget DELETE: a locked budget is explicitly rejected with the correct message, and remains in place",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const suffix = crypto.randomUUID();
    const { admin, org, property } = await setUpOrgAndProperty(suffix);
    const budget = await insertBudget(admin, org, property, "locked", 2031);

    const { error: deleteError } = await admin.from("budgets").delete().eq("id", budget.id);
    assertExists(deleteError, "deleting a locked budget must fail");
    assertMatch(String(deleteError?.message ?? ""), /Cannot delete a locked budget/);

    const { data: stillThere } = await admin.from("budgets").select("id, status").eq("id", budget.id).maybeSingle();
    assertExists(stillThere, "locked budget must remain in place after the rejected delete");
    assertEquals(stillThere.status, "locked");
  },
});

Deno.test({
  name: "fn_protect_locked_budget UPDATE regression: financial-value changes on a locked budget are still blocked",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const suffix = crypto.randomUUID();
    const { admin, org, property } = await setUpOrgAndProperty(suffix);
    const budget = await insertBudget(admin, org, property, "locked", 2031);

    const { error: updateError } = await admin.from("budgets").update({ total_revenue: 999999 }).eq("id", budget.id);
    assertExists(updateError, "modifying financial values of a locked budget must still fail");
    assertMatch(String(updateError?.message ?? ""), /Cannot modify financial values of a locked budget/);
  },
});

Deno.test({
  name: "fn_protect_locked_budget UPDATE regression: non-financial changes on a locked budget still succeed",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const suffix = crypto.randomUUID();
    const { admin, org, property } = await setUpOrgAndProperty(suffix);
    const budget = await insertBudget(admin, org, property, "locked", 2031);

    const { error: updateError } = await admin.from("budgets").update({ ai_insights: "updated note" }).eq("id", budget.id);
    assertNoError(updateError);

    const { data: updated } = await admin.from("budgets").select("ai_insights").eq("id", budget.id).maybeSingle();
    assertEquals(updated?.ai_insights, "updated note");
  },
});

Deno.test({
  name: "fn_protect_locked_budget UPDATE regression: draft/reviewed budgets remain fully editable",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const suffix = crypto.randomUUID();
    const { admin, org, property } = await setUpOrgAndProperty(suffix);
    const budget = await insertBudget(admin, org, property, "draft", 2031);

    const { error: updateError } = await admin.from("budgets").update({ total_revenue: 4242, status: "reviewed" }).eq("id", budget.id);
    assertNoError(updateError);

    const { data: updated } = await admin.from("budgets").select("total_revenue, status").eq("id", budget.id).maybeSingle();
    assertEquals(updated?.total_revenue, 4242);
    assertEquals(updated?.status, "reviewed");
  },
});
