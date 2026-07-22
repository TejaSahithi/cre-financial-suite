import { describe, expect, it } from "vitest";
import { adaptEnterpriseReviewPayload } from "@/lib/review/adapters/enterpriseReviewAdapter";
import { reviewDocumentToLegacyReviewPayload } from "@/lib/review/adapters/viewModelLegacyBridge";

function payload(status = "resolved", confidence: number | null = 0.91) {
  return {
    schemaVersion: "enterprise-review-payload-v1",
    uploadedFileId: "file-1",
    runId: "run-1",
    generationId: "gen-1",
    sourceMode: "canonical_hybrid",
    fields: {
      tenant_name: {
        canonicalFieldKey: "tenant_name",
        value: "Acme LLC",
        displayValue: "Acme LLC",
        status,
        authoritativeSource: "canonical_projection",
        confidence,
        evidence: [{ evidenceId: "ev-1", page: 2, sourceText: "Tenant: Acme LLC", polygonAvailable: true }],
        review: { blocking: status === "missing", reasonCodes: status === "missing" ? ["required"] : [] },
      },
    },
    coverage: { totals: { configured: 1, resolved: status === "resolved" ? 1 : 0, blocking: status === "missing" ? 1 : 0 } },
    validationSummary: { approvalEligible: status === "resolved", blockingIssueCount: status === "missing" ? 1 : 0, warningCount: 0 },
    findings: [{ findingId: "finding-1", canonicalFieldKey: "tenant_name", severity: "warning", title: "Review tenant", reasonCodes: ["tenant_check"] }],
  };
}

describe("enterprise review adapter", () => {
  it("preserves canonical status and field key in the view model", () => {
    const document = adaptEnterpriseReviewPayload(payload("missing_source_evidence", null));

    expect(document.schemaVersion).toBe("review-document-view-model-v1");
    expect(document.mode).toBe("canonical_hybrid");
    expect(document.fields.tenant_name.status).toBe("missing_source_evidence");
    expect(document.fields.tenant_name.confidence).toBeNull();
    expect(document.findings[0].fieldKey).toBe("tenant_name");
  });

  it("bridges a review document to legacy rows without changing canonical authority", () => {
    const document = adaptEnterpriseReviewPayload(payload("resolved", 0.94));
    const legacy = reviewDocumentToLegacyReviewPayload(document, { metadata: { existing: true } });

    expect(legacy.records[0].values.tenant_name).toBe("Acme LLC");
    expect(legacy.records[0].standard_fields[0].canonical_status).toBe("resolved");
    expect(legacy.records[0].standard_fields[0].status).toBe("auto_populated");
    expect(legacy.metadata.review_document_view_model.source_mode).toBe("canonical_hybrid");
  });

  it("adapts enterprise review payload v2 semantic metadata", () => {
    const v2 = payload("resolved", 0.93);
    v2.schemaVersion = "enterprise-review-payload-v2";
    v2.fields.tenant_name.authoritativeSource = "canonical_family_effective";
    v2.fields.tenant_name.lineage = {
      selectedLayer: "family_effective",
      familyEffectiveValue: "Acme Holdings LLC",
      amendmentPrecedence: { resolutionStatus: "resolved", reasonCodes: ["explicit_later_amendment_effect"] },
    };
    v2.documentFamily = { id: "family-1", role: "base_lease", members: [{ uploadedFileId: "file-1", role: "base_lease" }] };
    v2.definitions = [{ termDisplay: "Tenant", definitionStatus: "resolved" }];
    v2.crossReferences = [{ sourceText: "Section 1.1", resolutionStatus: "resolved" }];
    v2.semanticCoverage = { definitionsDetected: 1, crossReferencesResolved: 1 };
    v2.searchCapabilities = { enabled: true, entityTypes: ["field", "definition"] };

    const document = adaptEnterpriseReviewPayload(v2);

    expect(document.diagnostics.backendSchemaVersion).toBe("enterprise-review-payload-v2");
    expect(document.fields.tenant_name.source).toBe("canonical_family_effective");
    expect(document.fields.tenant_name.lineage.selectedLayer).toBe("family_effective");
    expect(document.documentFamily.id).toBe("family-1");
    expect(document.definitions).toHaveLength(1);
    expect(document.crossReferences).toHaveLength(1);
    expect(document.semanticCoverage.definitionsDetected).toBe(1);
    expect(document.searchCapabilities.enabled).toBe(true);
  });
});