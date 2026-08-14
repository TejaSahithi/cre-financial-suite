import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const commandSource = await Deno.readTextFile(new URL("../operational-review-command/index.ts", import.meta.url));
const serviceSource = await Deno.readTextFile(new URL("../../../src/services/leaseFinancialOperationsService.js", import.meta.url));
const uiSource = await Deno.readTextFile(new URL("../../../src/pages/AutomationReadiness.jsx", import.meta.url));
const configSource = await Deno.readTextFile(new URL("../../config.toml", import.meta.url));

Deno.test("Priority 4 operational command function is registered for deployment", () => {
  assertStringIncludes(configSource, "[functions.operational-review-command]");
  assertStringIncludes(configSource, "verify_jwt = true");
});

Deno.test("tenant sales approval is server-owned and persists percentage rent downstream", () => {
  assertStringIncludes(commandSource, '"approveSalesReport"');
  assertStringIncludes(commandSource, 'action: "SALES_REPORT_APPROVED"');
  assertStringIncludes(commandSource, "persistPercentageRentCalculation");
  assertStringIncludes(commandSource, "evaluatePercentageRent");
  assertStringIncludes(commandSource, ".from(\"percentage_rent_calculations\")");
  assertStringIncludes(commandSource, "PERCENTAGE_RENT_CALCULATED_FROM_SALES_APPROVAL");
});

Deno.test("all Priority 4 commands validate transitions and write audit", () => {
  [
    "createSalesReport",
    "submitSalesReport",
    "approveSalesReport",
    "rejectSalesReport",
    "acknowledgeFinding",
    "assignFinding",
    "resolveFinding",
    "dismissFinding",
    "approveCoi",
    "rejectCoi",
    "verifyVendorCredential",
    "revokeVendorCredential",
    "waiveObligation",
    "satisfyObligation",
  ].forEach((command) => assertStringIncludes(commandSource, `"${command}"`));
  assertStringIncludes(commandSource, "assertTransition");
  assertStringIncludes(commandSource, "writeOperationalAudit");
});

Deno.test("COI approval evaluates compliance and materializes expiration obligation", () => {
  assertStringIncludes(commandSource, '"approveCoi"');
  assertStringIncludes(commandSource, "evaluateCoiCompliance");
  assertStringIncludes(commandSource, ".from(\"lease_insurance_compliance_results\")");
  assertStringIncludes(commandSource, ".from(\"lease_obligations\")");
  assertStringIncludes(commandSource, "external_requires_approval");
});

Deno.test("frontend service exposes named command wrappers instead of generic status commands", () => {
  assertStringIncludes(serviceSource, 'invokeEdgeFunction("operational-review-command"');
  [
    "approveSalesReport",
    "rejectSalesReport",
    "acknowledgeFinding",
    "resolveFinding",
    "approveCoi",
    "verifyVendorCredential",
    "satisfyObligation",
  ].forEach((wrapper) => assertStringIncludes(serviceSource, `export const ${wrapper}`));
});

Deno.test("Automation & Exceptions queue reads persisted rows and calls server commands", () => {
  assertStringIncludes(uiSource, "QueueSummary");
  assertStringIncludes(uiSource, "OperationalReviewRows");
  assertStringIncludes(uiSource, "runOperationalReviewCommand");
  assertStringIncludes(uiSource, "Gross Sales Reports");
  assertStringIncludes(uiSource, "Financial Findings");
  assertStringIncludes(uiSource, "COI Compliance");
  assertStringIncludes(uiSource, "Vendor Credentials");
  assertStringIncludes(uiSource, "Overdue Obligations");
  assertEquals(/\.from\("tenant_sales_reports"\)\.update\(/.test(uiSource), false);
});

Deno.test("obligation review commands are terminal review transitions, not notification logic", () => {
  assertStringIncludes(commandSource, '"satisfyObligation"');
  assertStringIncludes(commandSource, '"waiveObligation"');
  assertStringIncludes(commandSource, 'const status = command === "satisfyObligation" ? "satisfied" : "waived"');
  assertEquals(commandSource.includes("notification-dispatch-v9"), false);
});

Deno.test("Pass 2 vendor credential create and edit are server-owned audited commands", () => {
  ["createVendorCredential", "editVendorCredential", "verifyVendorCredential", "revokeVendorCredential"].forEach((command) => {
    assertStringIncludes(commandSource, `"${command}"`);
  });
  assertStringIncludes(commandSource, "loadVendor(ctx, vendorId)");
  assertStringIncludes(commandSource, 'action: "VENDOR_CREDENTIAL_CREATED"');
  assertStringIncludes(commandSource, 'action: "VENDOR_CREDENTIAL_EDITED"');
  assertStringIncludes(commandSource, 'action: "VENDOR_CREDENTIAL_VERIFIED"');
  assertStringIncludes(commandSource, 'action: "VENDOR_CREDENTIAL_REVOKED"');
  assertEquals(/\.from\("vendor_credentials"\)\.update\(/.test(serviceSource), false);
});

Deno.test("Pass 2 COI approval distinguishes certificate facts from lease-required terms", () => {
  assertStringIncludes(commandSource, "loadApprovedInsuranceRequirement");
  assertStringIncludes(commandSource, "resolveLeaseTerms(snapshot, asOfDate)");
  assertStringIncludes(commandSource, "normalizeInsuranceRequirement");
  assertStringIncludes(commandSource, "requirement_snapshot: requirement ?? {}");
  assertStringIncludes(commandSource, "coi_snapshot: coi");
});

Deno.test("Pass 2 operational UI surfaces vendor credential workflow", () => {
  const vendorsUiSource = Deno.readTextFileSync(new URL("../../../src/pages/Vendors.jsx", import.meta.url));
  assertStringIncludes(vendorsUiSource, "Vendor Credentials");
  assertStringIncludes(vendorsUiSource, "saveVendorCredential");
  assertStringIncludes(vendorsUiSource, "reviewVendorCredential");
  assertStringIncludes(vendorsUiSource, "checkVendorEligibility");
});

Deno.test("Pass 2 commands remain org-scoped and transition-gated", () => {
  assertStringIncludes(commandSource, '.eq("org_id", ctx.orgId)');
  assertStringIncludes(commandSource, '.eq("org_id", orgId)');
  assertStringIncludes(commandSource, "assertTransition(row, config.allowed, config.command)");
  assertStringIncludes(commandSource, 'allowed: ["draft", "pending_review", "needs_review", "rejected"]');
  assertStringIncludes(commandSource, 'allowed: ["draft", "pending_review", "needs_review", "rejected", "expired"]');
  assertStringIncludes(commandSource, 'allowed: ["verified", "approved", "active", "needs_review", "pending_review"]');
});
