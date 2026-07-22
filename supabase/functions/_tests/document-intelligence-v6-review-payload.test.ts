// @ts-nocheck

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildEnterpriseReviewPayloadV2 } from "../_shared/extraction/document-semantics/enterprise-review-payload-v2.ts";

function payloadV1() {
  return {
    schemaVersion: "enterprise-review-payload-v1",
    orgId: "org-1",
    uploadedFileId: "base",
    runId: "run-1",
    generationId: "gen-1",
    leaseId: null,
    sourceMode: "canonical_hybrid",
    fields: {
      expiration_date: { canonicalFieldKey: "expiration_date", domain: "dates", value: "2026-12-31", displayValue: "2026-12-31", status: "resolved", authoritativeSource: "canonical_projection", confidence: 0.94, evidence: [], review: { editable: true, requiresAttention: false, blocking: false, reasonCodes: [] } },
    },
    coverage: { entries: [{ canonicalFieldKey: "expiration_date", requiredForApproval: true }], totals: { configured: 1, resolved: 1, blocking: 0 }, approvalReady: true },
    validationSummary: { approvalEligible: true, blockingIssueCount: 0, warningCount: 0 },
    findings: [],
    compatibility: { paritySummary: { readiness: { ready: true, reasons: [] } } },
  };
}

Deno.test("Release 6 enterprise review payload v2 makes family effective values authoritative", async () => {
  const payload = await buildEnterpriseReviewPayloadV2({
    payloadV1: payloadV1(),
    documentFamilyId: "family-1",
    documentRole: "base_lease",
    familyMembers: [{ uploadedFileId: "base", role: "base_lease", effectiveDate: "2024-01-01", executionDate: null, sequenceNumber: null, status: "active", reasonCodes: [] }],
    chronologyStatus: "resolved",
    amendmentEffects: [{ id: "effect-1", documentFamilyId: "family-1", sourceUploadedFileId: "amendment", sourceRunId: "run-2", sourceGenerationId: "gen-2", targetCanonicalFieldKey: "expiration_date", effectType: "extend", effectiveDate: "2025-01-01", replacementValue: "2027-12-31", resolutionStatus: "resolved", sourceEvidenceIds: [], sourceClaimIds: [], reasonCodes: [] }],
    semanticSearchEnabled: true,
  });

  assertEquals(payload.schemaVersion, "enterprise-review-payload-v2");
  assertEquals(payload.fields.expiration_date.value, "2027-12-31");
  assertEquals(payload.fields.expiration_date.authoritativeSource, "canonical_family_effective");
  assertEquals(payload.documentFamily.id, "family-1");
  assert(payload.semanticSearchRecords.some((record) => record.entityType === "field" && record.key === "expiration_date"));
});