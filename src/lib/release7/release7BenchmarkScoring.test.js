import { describe, expect, it } from "vitest";
import { aggregateScores, evaluateThresholds, runBenchmark, scoreDocument, valuesMatch } from "../../../scripts/lease-intelligence-benchmark-lib.mjs";

describe("Release 7 benchmark scoring", () => {
  it("runs the CI benchmark with separate quality metrics", async () => {
    const report = await runBenchmark({ corpus: "ci", output: "benchmarks/reports/test", failOnThreshold: true });

    expect(report.schemaVersion).toBe("lease-intelligence-benchmark-report-v1");
    expect(report.selectedDocumentCount).toBeGreaterThanOrEqual(3);
    expect(report.metrics.approvalCriticalNormalizedAccuracy).toBe(1);
    expect(report.metrics.definitionResolutionAccuracy).toBe(1);
    expect(report.metrics.crossReferenceTargetAccuracy).toBe(1);
    expect(report.thresholdResults.every((gate) => gate.passed)).toBe(true);
  });

  it("supports tolerant dates, numbers, text, and sets", () => {
    expect(valuesMatch("2026-01-01", "2026-01-02", { expectedValue: "2026-01-01", tolerance: { type: "date", value: 1 } })).toBe(true);
    expect(valuesMatch(1000, "1,000", { expectedValue: 1000, tolerance: { type: "numeric", value: 0 } })).toBe(true);
    expect(valuesMatch("base rent and additional rent", "additional rent plus base rent", { expectedValue: "base rent and additional rent", tolerance: { type: "text_similarity", value: 0.5 } })).toBe(true);
    expect(valuesMatch(["tax", "insurance"], ["insurance", "tax"], { expectedValue: ["tax", "insurance"], tolerance: { type: "set", value: 1 } })).toBe(true);
  });

  it("fails threshold gates when approval-critical fields are wrong", () => {
    const document = { id: "bad", familyId: "family-bad" };
    const truth = { fields: { expiration_date: { expectedStatus: "resolved", expectedValue: "2030-01-01", evidencePages: [1], materiality: "approval_critical" } }, definitions: [], crossReferences: [], amendmentEffects: [], familyEffectiveFields: {}, expectedFindings: [], familyId: "family-bad" };
    const actual = { schemaVersion: "enterprise-review-payload-v2", documentFamily: { id: "family-bad" }, fields: { expiration_date: { status: "resolved", value: "2029-01-01", evidence: [{ page: 1 }] } } };
    const metrics = aggregateScores([scoreDocument({ document, truth, actual })]);
    const gates = evaluateThresholds(metrics);

    expect(gates.find((gate) => gate.name === "approvalCriticalNormalizedAccuracy").passed).toBe(false);
  });
});