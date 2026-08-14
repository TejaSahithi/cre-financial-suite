import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateCoiCompliance } from "../_shared/compliance/coi-compliance-evaluator.ts";

Deno.test("COI compliance passes approved certificates meeting lease requirements", () => {
  const result = evaluateCoiCompliance({
    asOfDate: "2026-08-13",
    requirement: {
      minimumLimits: { general_liability: 1000000 },
      additionalInsuredRequired: true,
      waiverOfSubrogationRequired: true,
    },
    coi: {
      status: "approved",
      expiration_date: "2027-01-01",
      coverage_limits: { general_liability: 2000000 },
      additional_insureds: ["Landlord"],
      waiver_of_subrogation: true,
    },
  });

  assertEquals(result.status, "compliant");
  assertEquals(result.reasonCodes, []);
});

Deno.test("COI compliance flags expired and insufficient certificates", () => {
  const result = evaluateCoiCompliance({
    asOfDate: "2026-08-13",
    requirement: {
      minimumLimits: { general_liability: 1000000, umbrella: 5000000 },
      additionalInsuredRequired: true,
    },
    coi: {
      status: "approved",
      expiration_date: "2026-01-01",
      coverage_limits: { general_liability: 250000 },
      additional_insureds: [],
    },
  });

  assertEquals(result.status, "expired");
  assertEquals(result.reasonCodes.includes("COI_EXPIRED"), true);
  assertEquals(result.reasonCodes.includes("COI_LIMIT_BELOW_REQUIREMENT:general_liability"), true);
  assertEquals(result.reasonCodes.includes("COI_LIMIT_MISSING:umbrella"), true);
  assertEquals(result.reasonCodes.includes("ADDITIONAL_INSURED_REQUIRED"), true);
});

Deno.test("COI compliance blocks when lease-required insurance terms are missing", () => {
  const result = evaluateCoiCompliance({
    asOfDate: "2026-08-13",
    requirement: null,
    coi: {
      status: "approved",
      expiration_date: "2027-01-01",
      coverage_limits: { general_liability: 5000000 },
      additional_insureds: ["Landlord"],
      waiver_of_subrogation: true,
    },
  });

  assertEquals(result.status, "blocked");
  assertEquals(result.reasonCodes, ["INSURANCE_REQUIREMENT_REQUIRED"]);
});

Deno.test("COI compliance compares certificate facts against lease-required terms", () => {
  const result = evaluateCoiCompliance({
    asOfDate: "2026-08-13",
    requirement: {
      minimumLimits: { general_liability: 2000000 },
      additionalInsuredRequired: true,
      waiverOfSubrogationRequired: true,
    },
    coi: {
      status: "approved",
      expiration_date: "2027-01-01",
      coverage_limits: { general_liability: 1000000 },
      additional_insureds: ["Landlord"],
      waiver_of_subrogation: false,
    },
  });

  assertEquals(result.status, "needs_review");
  assertEquals(result.reasonCodes.includes("COI_LIMIT_BELOW_REQUIREMENT:general_liability"), true);
  assertEquals(result.reasonCodes.includes("WAIVER_OF_SUBROGATION_REQUIRED"), true);
});
