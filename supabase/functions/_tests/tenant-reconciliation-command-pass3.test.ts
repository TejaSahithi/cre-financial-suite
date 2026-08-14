import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../../", import.meta.url);
async function read(path: string) {
  return await Deno.readTextFile(new URL(path, ROOT));
}

Deno.test("tenant reconciliation command is registered and server-owned", async () => {
  const config = await read("supabase/config.toml");
  const edge = await read("supabase/functions/tenant-reconciliation-command/index.ts");
  assertStringIncludes(config, "[functions.tenant-reconciliation-command]");
  assertStringIncludes(config, "verify_jwt = true");
  for (const command of ["calculateReconciliation", "submitReconciliation", "approveReconciliation", "rejectReconciliation", "postReconciliation"]) {
    assertStringIncludes(edge, command);
  }
  assertStringIncludes(edge, "assertPageAccess");
  assertStringIncludes(edge, "assertPropertyAccess");
  assertStringIncludes(edge, "writeOperationalAudit");
});

Deno.test("tenant reconciliation consumes CAM and lease charge read model without duplicating engines", async () => {
  const edge = await read("supabase/functions/tenant-reconciliation-command/index.ts");
  assertStringIncludes(edge, ".from(\"cam_run_lease_results\")");
  assertStringIncludes(edge, ".from(\"lease_charge_read_model\")");
  assertEquals(edge.includes("compute-percentage-rent"), false);
  assertEquals(edge.includes("compute-management-fee"), false);
  assertEquals(edge.includes("run-cam-calculation-v2"), false);
  assertEquals(edge.includes("bls"), false);
});

Deno.test("tenant reconciliation schema has source identity, RLS, uniqueness, audit, and posted immutability", async () => {
  const sql = await read("supabase/migrations/20269900000075_tenant_additional_rent_reconciliation.sql");
  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS public.tenant_reconciliations");
  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS public.tenant_reconciliation_lines");
  for (const column of ["charge_type", "authoritative_table", "source_record_id", "source_period", "charge_key"]) {
    assertStringIncludes(sql, column);
  }
  assertStringIncludes(sql, "UNIQUE (org_id, tenant_reconciliation_id, line_role, charge_key)");
  assertStringIncludes(sql, "UNIQUE (org_id, tenant_reconciliation_id, line_role, authoritative_table, source_record_id)");
  assertStringIncludes(sql, "ENABLE ROW LEVEL SECURITY");
  assertStringIncludes(sql, "public.get_my_org_ids()");
  assertStringIncludes(sql, "public.can_write_org_data(org_id)");
  assertStringIncludes(sql, "prevent_posted_tenant_reconciliation_mutation");
  assertStringIncludes(sql, "audit_operational_domain_row_change");
});

Deno.test("tenant reconciliation UI and inbox are read/projection consumers", async () => {
  const service = await read("src/services/leaseFinancialOperationsService.js");
  const page = await read("src/pages/Reconciliation.jsx");
  const inbox = await read("src/services/utils/automationExceptionsInbox.js");
  const automation = await read("src/pages/AutomationReadiness.jsx");

  assertStringIncludes(service, "tenant-reconciliation-command");
  assertStringIncludes(page, "calculateTenantReconciliation");
  assertStringIncludes(page, "submitTenantReconciliation");
  assertStringIncludes(page, "approveTenantReconciliation");
  assertStringIncludes(page, "postTenantReconciliation");
  assertStringIncludes(inbox, "tenant-reconciliations");
  assertStringIncludes(automation, "tenant_reconciliations");
  assertEquals(page.includes(".from(\"tenant_reconciliations\").update"), false);
});

