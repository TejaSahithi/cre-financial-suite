import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  aggregateLeaseExtractionReports,
  evaluateRegressionThresholds,
  extractActualFields,
  findDuplicateCanonicalRows,
  scoreLeaseExtraction,
  validateLeaseGroundTruthFixture,
  valuesMatch,
} from "../leaseExtractionEval.js";

const fixture = JSON.parse(fs.readFileSync("benchmarks/lease-extraction/golden/macon-crossing.ground-truth.json", "utf8"));
const replayActual = JSON.parse(fs.readFileSync("benchmarks/lease-extraction/replay/macon-crossing.review-payload.json", "utf8"));

describe("lease extraction Stage B evaluator", () => {
  it("validates the Macon Crossing ground-truth fixture against canonical keys", () => {
    expect(validateLeaseGroundTruthFixture(fixture)).toEqual([]);
    expect(fixture.fixtureVersion).toBe("lease-ground-truth/1.0");
    expect(fixture.forbiddenExtractions.some((item) => item.forbiddenValue === "one (1) day in each calendar year")).toBe(true);
  });

  it("normalizes accepted monetary, date, enum and alternative values", () => {
    expect(valuesMatch(25200, "$25,200.00", { canonicalFieldKey: "annual_rent", normalizedValue: 25200 })).toBe(true);
    expect(valuesMatch("2019-03-01", "March 1, 2019", { canonicalFieldKey: "rent_commencement_date", normalizedValue: "2019-03-01" })).toBe(true);
    expect(valuesMatch("split_by_component", "split by component", { canonicalFieldKey: "responsibility_repairs", normalizedValue: "split_by_component" })).toBe(true);
    expect(valuesMatch("#21", "Suite #21", { canonicalFieldKey: "unit_number", normalizedValue: "#21", acceptedAlternativeValues: ["Suite #21"] })).toBe(true);
  });

  it("extracts review-payload fields and detects duplicate canonical rows", () => {
    const fields = extractActualFields({ records: [{ standard_fields: [
      { field_key: "tenant_name", canonical_field_key: "tenant_name", scope_key: "lease", value: "A", canonical_status: "extracted" },
      { field_key: "tenant", canonical_field_key: "tenant_name", scope_key: "lease", value: "A", canonical_status: "extracted" },
    ] }] });
    expect(fields).toHaveLength(2);
    expect(findDuplicateCanonicalRows(fields)).toEqual([{ identity: "lease:tenant_name", count: 2, fieldKeys: ["tenant_name", "tenant"] }]);
  });

  it("scores the Macon replay artifact and labels it as non-live replay", () => {
    const report = scoreLeaseExtraction({ fixture, actual: replayActual, runMode: "replay" });
    expect(report.measuredFromLiveExtraction).toBe(false);
    expect(report.metrics.supportedGroundTruthFacts).toBeGreaterThan(20);
    expect(report.metrics.duplicateCanonicalRows).toBe(0);
    expect(report.metrics.unsupportedCriticalAutoFills).toBe(0);
    expect(report.metrics.f1).toBe(1);
    expect(report.thresholdResults.filter((gate) => gate.level === 2).every((gate) => gate.enabled === false && gate.passed)).toBe(true);
  });

  it("reports wrong-domain evidence separately from value correctness", () => {
    const actual = {
      records: [{ standard_fields: [{
        field_key: "electric_responsibility",
        canonical_field_key: "electric_responsibility",
        scope_key: "lease",
        value: "tenant",
        authoritative_value: "tenant",
        canonical_status: "extracted",
        evidence: [{ page: 1, source_text: "Tenant shall repair electrical wiring.", clause_category: "repairs" }],
      }] }],
    };
    const smallFixture = { ...fixture, expectedFields: [fixture.expectedFields.find((field) => field.canonicalFieldKey === "electric_responsibility")], forbiddenExtractions: [] };
    const report = scoreLeaseExtraction({ fixture: smallFixture, actual, runMode: "replay" });
    expect(report.metrics.truePositiveFacts).toBe(1);
    expect(report.metrics.wrongDomainEvidenceFacts).toBe(1);
    expect(report.failureStages[0].stage).toBe("semantic_validation");
  });

  it("counts forbidden critical autofills and threshold failures", () => {
    const actual = { records: [{ standard_fields: [{ field_key: "property_name", canonical_field_key: "property_name", scope_key: "lease", value: "one (1) day in each calendar year", authoritative_value: "one (1) day in each calendar year", canonical_status: "extracted" }] }] };
    const smallFixture = { ...fixture, expectedFields: [fixture.expectedFields.find((field) => field.canonicalFieldKey === "property_name")], forbiddenExtractions: fixture.forbiddenExtractions.filter((item) => item.canonicalFieldKey === "property_name") };
    const report = scoreLeaseExtraction({ fixture: smallFixture, actual, runMode: "replay" });
    expect(report.metrics.unsupportedCriticalAutoFills).toBeGreaterThan(0);
    expect(report.forbiddenMatches[0].reason).toContain("Timing language");
    expect(evaluateRegressionThresholds(report.metrics).find((gate) => gate.name === "unsupportedCriticalAutoFillsNotIncrease").passed).toBe(false);
  });

  it("aggregates reports and keeps Level 2 disabled until corpus diversity exists", () => {
    const report = scoreLeaseExtraction({ fixture, actual: replayActual, runMode: "replay" });
    const aggregate = aggregateLeaseExtractionReports([report], { runMode: "replay", propertyTypes: ["retail"], documentTypes: ["lease"] });
    expect(aggregate.selectedFixtureCount).toBe(1);
    expect(aggregate.corpusSufficiency).toBe("insufficient_for_level_2_target_gate");
    expect(aggregate.thresholdResults.some((gate) => gate.level === 2 && gate.enabled === false)).toBe(true);
  });
});
