import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const pageSource = await Deno.readTextFile(new URL("../../../src/pages/AutomationReadiness.jsx", import.meta.url));
const serviceSource = await Deno.readTextFile(new URL("../../../src/services/leaseFinancialOperationsService.js", import.meta.url));
const inboxSource = await Deno.readTextFile(new URL("../../../src/services/utils/automationExceptionsInbox.js", import.meta.url));
const domainsSql = await Deno.readTextFile(new URL("../../migrations/20269900000071_major_client_financial_domains.sql", import.meta.url));
const policySql = await Deno.readTextFile(new URL("../../migrations/20269900000074_financial_control_policy_resolution.sql", import.meta.url));

Deno.test("Priority 6 inbox is a read projection over existing operational domains", () => {
  assertStringIncludes(inboxSource, "buildAutomationExceptionInbox");
  assertStringIncludes(pageSource, "buildAutomationExceptionInbox");
  assertStringIncludes(pageSource, "listLeaseChargeReadModel");
  assertEquals(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?public\.automation/i.test(inboxSource + pageSource + serviceSource), false);
  assertEquals(/runFinancialControls\(|computePercentageRent\(|computeManagementFee\(/.test(inboxSource), false);
});

Deno.test("Priority 6 inbox preserves authoritative source record links", () => {
  [
    "financial_control_findings",
    "lease_obligation_occurrences",
    "tenant_sales_reports",
    "coi_documents",
    "vendor_credentials",
    "reference_series_selections",
    "reference_observations",
    "lease_charge_calculations",
  ].forEach((table) => assertStringIncludes(inboxSource, table));
  assertStringIncludes(inboxSource, "sourceRecordId");
  assertStringIncludes(inboxSource, "sourceTable");
  assertStringIncludes(inboxSource, "actionUrl");
});

Deno.test("Priority 6 actions continue through server-owned operational commands", () => {
  [
    "approveSalesReport",
    "rejectSalesReport",
    "acknowledgeFinding",
    "resolveFinding",
    "dismissFinding",
    "approveCoi",
    "rejectCoi",
    "verifyVendorCredential",
    "revokeVendorCredential",
    "satisfyObligation",
    "waiveObligation",
  ].forEach((command) => assertStringIncludes(pageSource, command));
  assertEquals(/\.from\("tenant_sales_reports"\)\.update\(/.test(pageSource), false);
  assertEquals(/\.from\("financial_control_findings"\)\.update\(/.test(pageSource), false);
  assertStringIncludes(serviceSource, 'invokeEdgeFunction("operational-review-command"');
});

Deno.test("Priority 6 underlying domain reads remain org-scoped and RLS backed", () => {
  assertStringIncludes(serviceSource, 'query = query.eq("org_id", orgId)');
  [
    "tenant_sales_reports",
    "lease_obligation_occurrences",
    "reference_observations",
    "coi_documents",
    "vendor_credentials",
    "lease_charge_calculations",
    "financial_control_findings",
  ].forEach((table) => {
    const sql = table === "financial_control_findings" ? domainsSql + policySql : domainsSql;
    assertStringIncludes(sql, `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    assertStringIncludes(sql, `CREATE POLICY ${table}_select`);
  });
});

Deno.test("Priority 6 open queue excludes resolved dismissed satisfied waived and approved terminal records", () => {
  ["resolved", "dismissed", "satisfied", "waived", "approved", "verified", "compliant"].forEach((status) => {
    assertStringIncludes(inboxSource, `"${status}"`);
  });
  assertStringIncludes(inboxSource, "TERMINAL_STATUSES");
});
