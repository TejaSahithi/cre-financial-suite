import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/leaseReviewSchema", () => ({
  REVIEW_STATUSES: {
    PENDING: "pending",
    ACCEPTED: "accepted",
    EDITED: "edited",
    REJECTED: "rejected",
    N_A: "not_applicable",
    NEEDS_LEGAL: "needs_legal_review",
    MANUAL_REQUIRED: "manual_required",
  },
  hasValidSourceEvidence: ({ sourceText, sourcePage } = {}) => !!(sourceText || sourcePage != null),
  isCalculatedExtractionStatus: (s) => s === "calculated",
}));

import { isProtectedExtractionField, mergeLatestExtraction } from "../applyLatestExtractionMerge";

// Feature: enterprise-readiness-hardening Phase 6D-6A (apply-latest
// protection bugfix). Properties:
//   1. A protected field (manually edited / manual source / accepted /
//      edited / approved review status) is not overwritten by a new
//      source-backed extraction value.
//   2. An unprotected field is updated when the new value is source-backed.
//   3. extraction_data.field_reviews survives the merge untouched.
//   4. extraction_data.source_file_id (and any other unrelated top-level
//      key) survives the merge untouched.
//   5. No unrelated extraction_data keys are dropped by the merge.

describe("isProtectedExtractionField", () => {
  it("protects a manually-edited entry", () => {
    expect(isProtectedExtractionField("rent", { manually_edited: true }, null)).toBe(true);
  });

  it("protects a manual-source entry", () => {
    expect(isProtectedExtractionField("rent", { source: "manual" }, null)).toBe(true);
  });

  it("protects a field whose review status is accepted/edited/approved", () => {
    expect(isProtectedExtractionField("rent", {}, { rent: { status: "accepted" } })).toBe(true);
    expect(isProtectedExtractionField("rent", {}, { rent: { status: "edited" } })).toBe(true);
    expect(isProtectedExtractionField("rent", {}, { rent: { status: "approved" } })).toBe(true);
  });

  it("does not protect a field with no manual/accepted markers", () => {
    expect(isProtectedExtractionField("rent", { value: 1000 }, null)).toBe(false);
    expect(isProtectedExtractionField("rent", {}, { rent: { status: "pending" } })).toBe(false);
  });
});

describe("mergeLatestExtraction", () => {
  it("does not overwrite a protected (manually-edited) field even when the new value is source-backed", () => {
    const extractionData = {
      fields: { monthly_rent: { value: 5000, manually_edited: true } },
      field_evidence: { monthly_rent: { source_page: 2, source_text: "old evidence" } },
    };
    const fieldsWithEvidence = {
      monthly_rent: { value: 9999, source_page: 3, source_text: "fresh extraction text" },
    };
    const evidenceMap = {
      monthly_rent: { source_page: 3, source_text: "fresh extraction text" },
    };

    const { nextExtraction, protectedFieldsPreservedCount } = mergeLatestExtraction({
      extractionData,
      fieldsWithEvidence,
      evidenceMap,
      confidenceMap: {},
    });

    expect(nextExtraction.fields.monthly_rent.value).toBe(5000);
    expect(nextExtraction.fields.monthly_rent.manually_edited).toBe(true);
    expect(nextExtraction.field_evidence.monthly_rent.source_text).toBe("old evidence");
    expect(protectedFieldsPreservedCount).toBe(1);
  });

  it("does not overwrite a field the reviewer has explicitly accepted", () => {
    const extractionData = {
      fields: { tenant_name: { value: "Acme Corp" } },
      field_evidence: { tenant_name: { source_page: 1, source_text: "Acme Corp LLC" } },
      field_reviews: { tenant_name: { status: "accepted" } },
    };
    const fieldsWithEvidence = {
      tenant_name: { value: "Wrong Name Inc", source_page: 5, source_text: "different clause" },
    };
    const evidenceMap = {
      tenant_name: { source_page: 5, source_text: "different clause" },
    };

    const { nextExtraction } = mergeLatestExtraction({
      extractionData,
      fieldsWithEvidence,
      evidenceMap,
      confidenceMap: {},
    });

    expect(nextExtraction.fields.tenant_name.value).toBe("Acme Corp");
  });

  it("updates an unprotected field when the new value is source-backed", () => {
    const extractionData = {
      fields: { square_footage: { value: 1000, source_page: 1, source_text: "old text" } },
      field_evidence: { square_footage: { source_page: 1, source_text: "old text" } },
    };
    const fieldsWithEvidence = {
      square_footage: { value: 2000, source_page: 4, source_text: "new text" },
    };
    const evidenceMap = {
      square_footage: { source_page: 4, source_text: "new text" },
    };

    const { nextExtraction, protectedFieldsPreservedCount } = mergeLatestExtraction({
      extractionData,
      fieldsWithEvidence,
      evidenceMap,
      confidenceMap: {},
    });

    expect(nextExtraction.fields.square_footage.value).toBe(2000);
    expect(nextExtraction.field_evidence.square_footage.source_text).toBe("new text");
    expect(protectedFieldsPreservedCount).toBe(0);
  });

  it("preserves extraction_data.field_reviews untouched", () => {
    const extractionData = {
      fields: {},
      field_evidence: {},
      field_reviews: { tenant_name: { status: "accepted", note: "confirmed with tenant" } },
    };

    const { nextExtraction } = mergeLatestExtraction({
      extractionData,
      fieldsWithEvidence: { tenant_name: { value: "New Value", source_page: 1, source_text: "x" } },
      evidenceMap: { tenant_name: { source_page: 1, source_text: "x" } },
      confidenceMap: {},
    });

    expect(nextExtraction.field_reviews).toEqual({
      tenant_name: { status: "accepted", note: "confirmed with tenant" },
    });
  });

  it("preserves source_file_id and other unrelated top-level extraction_data keys", () => {
    const extractionData = {
      fields: {},
      field_evidence: {},
      source_file_id: "file-123",
      source_file_name: "lease.pdf",
      rejection: { reason: "missing signature", rejected_at: "2026-01-01T00:00:00.000Z" },
      document_type_override: "full_lease",
    };

    const { nextExtraction } = mergeLatestExtraction({
      extractionData,
      fieldsWithEvidence: {},
      evidenceMap: {},
      confidenceMap: {},
    });

    expect(nextExtraction.source_file_id).toBe("file-123");
    expect(nextExtraction.source_file_name).toBe("lease.pdf");
    expect(nextExtraction.rejection).toEqual({ reason: "missing signature", rejected_at: "2026-01-01T00:00:00.000Z" });
    expect(nextExtraction.document_type_override).toBe("full_lease");
  });

  it("does not drop any unrelated extraction_data keys across a full merge", () => {
    const extractionData = {
      fields: { monthly_rent: { value: 1000, manually_edited: true } },
      field_evidence: { monthly_rent: { source_page: 1, source_text: "orig" } },
      field_reviews: { monthly_rent: { status: "accepted" } },
      source_file_id: "file-abc",
      workflow_output: { lease_fields: { monthly_rent: { value: 1000 } } },
      extraction_debug: { last_reextract_at: "2026-01-01T00:00:00.000Z" },
    };
    const fieldsWithEvidence = {
      monthly_rent: { value: 9999, source_page: 2, source_text: "fresh" },
      tenant_name: { value: "Acme", source_page: 3, source_text: "fresh tenant" },
    };
    const evidenceMap = {
      monthly_rent: { source_page: 2, source_text: "fresh" },
      tenant_name: { source_page: 3, source_text: "fresh tenant" },
    };

    const { nextExtraction } = mergeLatestExtraction({
      extractionData,
      fieldsWithEvidence,
      evidenceMap,
      confidenceMap: { tenant_name: 90 },
    });

    // Protected field preserved.
    expect(nextExtraction.fields.monthly_rent.value).toBe(1000);
    // Unprotected new field applied.
    expect(nextExtraction.fields.tenant_name.value).toBe("Acme");
    // Every pre-existing top-level key still present.
    expect(nextExtraction.field_reviews).toEqual({ monthly_rent: { status: "accepted" } });
    expect(nextExtraction.source_file_id).toBe("file-abc");
    expect(nextExtraction.extraction_debug).toEqual({ last_reextract_at: "2026-01-01T00:00:00.000Z" });
    // workflow_output was not passed as an override this time, so the old
    // one (from the extractionData spread) must survive.
    expect(nextExtraction.workflow_output).toEqual({ lease_fields: { monthly_rent: { value: 1000 } } });
    // New keys always present.
    expect(nextExtraction.evidence_refreshed_at).toBeTruthy();
    expect(nextExtraction.confidence_scores).toEqual({ tenant_name: 90 });
  });
});
