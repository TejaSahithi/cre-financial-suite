// @ts-nocheck

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildLeaseDomainCoverage, LEASE_DOMAIN_COVERAGE_VERSION } from "../_shared/extraction/whole-document-llm/lease-domain-coverage.ts";

Deno.test("lease domain coverage marks source-backed fixed fields and expense rules", () => {
  const coverage = buildLeaseDomainCoverage({
    architecture: "llm_field_partitioned",
    completeDocumentReviewed: true,
    requestedFieldKeys: ["monthly_rent", "cam_cap_pct", "gross_up_enabled", "tenant_insurance_required"],
    fieldStatuses: {
      monthly_rent: "found",
      cam_cap_pct: "found",
      gross_up_enabled: "not_stated",
      tenant_insurance_required: "found",
    },
    evidenceAnchors: [
      { field_key: "monthly_rent", source_text: "Monthly Base Rent shall be $5,000.", quote_verified: true },
      { field_key: "cam_cap_pct", source_text: "Controllable expenses shall not increase by more than 5%.", quote_verified: true },
      { field_key: "tenant_insurance_required", source_text: "Tenant shall maintain insurance.", quote_verified: true },
    ],
    expenseRuleCandidates: [
      {
        expense_category: "common_area_maintenance",
        obligation_kind: "cam",
        exact_source_text: "Tenant shall pay its pro rata share of CAM.",
        review_status: "needs_review",
      },
    ],
    processedGroupNames: ["rent_amounts", "cam_structure", "insurance"],
  });

  assertEquals(coverage.version, LEASE_DOMAIN_COVERAGE_VERSION);
  assertEquals(coverage.totals.domainCount > 0, true);

  const rent = coverage.domains.find((domain) => domain.domainKey === "rent_schedule");
  assertExists(rent);
  assertEquals(rent!.status, "source_backed");
  assertEquals(rent!.fixedFieldsFound.includes("monthly_rent"), true);

  const cam = coverage.domains.find((domain) => domain.domainKey === "cam_recoveries");
  assertExists(cam);
  assertEquals(cam!.status, "needs_review");
  assertEquals(cam!.expenseRuleCandidateCount, 1);

  const insurance = coverage.domains.find((domain) => domain.domainKey === "insurance");
  assertExists(insurance);
  assertEquals(insurance!.status, "source_backed");
});

Deno.test("lease domain coverage distinguishes dynamic-only domains from not-stated domains", () => {
  const coverage = buildLeaseDomainCoverage({
    architecture: "llm_direct_schema",
    completeDocumentReviewed: true,
    requestedFieldKeys: ["escalation_type"],
    fieldStatuses: { escalation_type: "not_stated" },
    dynamicItems: [
      {
        field_key: "percentage_rent_schedule",
        label: "Percentage rent schedule",
        business_meaning: "Tenant pays percentage rent after a gross sales breakpoint.",
        value: "Breakpoint | Rate\n$1,000,000 | 6%",
        extraction_status: "extracted",
      },
    ],
  });

  const percentageRent = coverage.domains.find((domain) => domain.domainKey === "percentage_rent");
  assertExists(percentageRent);
  assertEquals(percentageRent!.status, "source_backed");
  assertEquals(percentageRent!.dynamicFindingCount, 1);

  const cpi = coverage.domains.find((domain) => domain.domainKey === "cpi_escalations");
  assertExists(cpi);
  assertEquals(cpi!.status, "not_stated_after_review");
  assertEquals(cpi!.fixedFieldsNotStated, ["escalation_type"]);
});

Deno.test("lease domain coverage marks skipped field groups as partial or not attempted", () => {
  const coverage = buildLeaseDomainCoverage({
    architecture: "llm_field_partitioned",
    completeDocumentReviewed: false,
    requestedFieldKeys: ["monthly_rent", "cam_cap_pct", "tenant_insurance_required"],
    fieldStatuses: { monthly_rent: "found" },
    processedGroupNames: ["rent_amounts"],
    skippedGroupNames: ["cam_structure", "insurance"],
  });

  const rent = coverage.domains.find((domain) => domain.domainKey === "rent_schedule");
  assertExists(rent);
  assertEquals(rent!.status, "source_backed");

  const caps = coverage.domains.find((domain) => domain.domainKey === "caps_exclusions");
  assertExists(caps);
  assertEquals(caps!.status, "not_attempted");

  const insurance = coverage.domains.find((domain) => domain.domainKey === "insurance");
  assertExists(insurance);
  assertEquals(insurance!.status, "not_attempted");
  assertEquals(coverage.totals.notAttempted >= 2, true);
});

