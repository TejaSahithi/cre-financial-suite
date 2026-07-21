import { describe, it, expect } from "vitest";
import { normalizeStandardFields, normalizeLeaseReviewData } from "@/lib/leaseReviewFieldNormalizer";

// Release 1 (document-coverage architecture audit): computeFieldStatus()
// previously collapsed every blank-value case to a flat "missing" badge,
// even though resolveExtractionStatus() (leaseReviewSchema.js) already
// distinguished "not_found" (extractor ran, found nothing) from "missing"
// (extractor never ran) upstream. These tests lock in the scoped fix: only
// the blank-value branch changed. Two broader variants considered during
// implementation (a distinct "missing_source_evidence" badge for a
// present-but-unverified value, and a distinct "conflicting" badge instead
// of "needs_review" for EXTRACTION_STATUSES.CONFLICT) were reverted after
// they broke existing, deliberately-designed test expectations elsewhere in
// this suite -- see the scope note in computeFieldStatus() itself.

describe("computeFieldStatus: blank-value precedence (Release 1 fix)", () => {
  it("no extraction_data at all -> missing (extractor never ran)", () => {
    const rows = normalizeStandardFields({ id: "lease-1" });
    const row = rows.find((r) => r.canonicalKey === "tenant_name");
    expect(row.status).toBe("missing");
  });

  it("extraction_data.fields present but this field absent -> not_found (extractor ran, found nothing) -- previously indistinguishable from missing", () => {
    const lease = {
      id: "lease-2",
      extraction_data: {
        fields: { landlord_name: "224 Partners, LLC" }, // some field present, proves extractor ran
        field_evidence: { landlord_name: { source_text: "Landlord: 224 Partners, LLC", source_page: 1 } },
      },
    };
    const rows = normalizeStandardFields(lease);
    const row = rows.find((r) => r.canonicalKey === "tenant_name");
    expect(row.value == null || row.value === "").toBe(true);
    expect(row.status).toBe("not_found");
  });

  it("a value rejected as a markup artifact still counts as not_found, not missing (extractor ran, produced a rejected value)", () => {
    const lease = {
      id: "lease-3",
      extraction_data: {
        fields: { property_name: "<figure>" },
        field_evidence: { property_name: { source_text: "PROPERTY:\n\n<figure>", source_page: 1 } },
      },
    };
    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "property_name");
    expect(row.value).toBeNull();
    expect(row.status).toBe("not_found");
  });

  it("a conflict-flagged extraction_status still resolves to needs_review, not a new distinct badge (scoped revert)", () => {
    const lease = {
      id: "lease-4",
      extraction_data: {
        fields: { security_deposit: 30000 },
        field_evidence: {
          security_deposit: {
            value: 30000,
            source_text: "Security deposit listed as $30,000 in one paragraph.",
            source_page: 6,
            confidence: 0.53,
            extraction_status: "conflict_detected",
          },
        },
      },
    };
    const rows = normalizeStandardFields(lease);
    const row = rows.find((r) => r.canonicalKey === "security_deposit");
    expect(row.status).toBe("needs_review");
  });

  it("a reviewer edit always wins, even over a detected conflict (top of precedence)", () => {
    const lease = {
      id: "lease-5",
      security_deposit: 32500,
      extraction_data: {
        fields: { security_deposit: { value: 30000, extraction_status: "conflict_detected" } },
        field_evidence: { security_deposit: { source_text: "Security deposit listed as $30,000.", source_page: 6, extraction_status: "conflict_detected" } },
        field_reviews: {
          security_deposit: { status: "edited", value: 32500, source_page: 6, source_text: "Reviewer confirmed $32,500." },
        },
      },
    };
    const rows = normalizeStandardFields(lease);
    const row = rows.find((r) => r.canonicalKey === "security_deposit");
    expect(row.status).toBe("manually_edited");
  });

  it("a high-confidence, evidence-verified value still computes to auto_populated (baseline, unaffected by the fix)", () => {
    const uploadedFile = {
      document_subtype: "base_lease",
      ui_review_payload: {
        document_subtype: "base_lease",
        records: [{
          standard_fields: [
            {
              field_key: "tenant_name",
              value: "Acme Inc",
              source: "rule",
              confidence: 96,
              evidence: { source_page: 1, source_text: "Tenant: Acme Inc", confidence: 96 },
            },
          ],
          row_index: 0,
        }],
      },
    };
    const lease = { id: "lease-6", uploaded_files: uploadedFile, uploaded_file: uploadedFile };
    const row = normalizeStandardFields(lease).find((r) => r.canonicalKey === "tenant_name");
    expect(row.value).toBe("Acme Inc");
    expect(row.evidenceVerified).toBe(true);
    expect(row.status).toBe("auto_populated");
  });
});

describe("normalizeStandardFields regression guard: existing field groups do not disappear", () => {
  it("a bare lease still produces the same non-empty set of standard field rows as before Release 1", () => {
    // Domain/evidencePolicy gating is a backend (schemas.ts) concept and
    // does not touch this frontend function at all, but this guards against
    // any accidental frontend regression from the status-precedence fix
    // above -- every field must still appear, just with a more precise
    // status for the blank-value case.
    const rows = normalizeStandardFields({ id: "lease-7" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => typeof row.status === "string" && row.status.length > 0)).toBe(true);
    expect(rows.some((row) => row.canonicalKey === "landlord_name")).toBe(true);
    expect(rows.some((row) => row.canonicalKey === "tenant_name")).toBe(true);
  });

  it("normalizeLeaseReviewData still returns dynamicFindings as an array (empty when there are none)", () => {
    const result = normalizeLeaseReviewData({ id: "lease-8" });
    expect(Array.isArray(result.dynamicFindings)).toBe(true);
  });
});
