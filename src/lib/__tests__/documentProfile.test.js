import { describe, it, expect } from "vitest";
import { detectDocumentProfile, isAssignmentDocument } from "../documentProfile";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeWfLease(overrides = {}) {
  return {
    extraction_data: {
      workflow_output: {
        lease_fields: overrides,
      },
    },
  };
}

function withDocumentType(lease, documentType) {
  return {
    ...lease,
    extraction_data: {
      ...(lease?.extraction_data || {}),
      workflow_output: {
        ...(lease?.extraction_data?.workflow_output || {}),
        document_profile: { documentType },
      },
    },
  };
}

// ── detectDocumentProfile ─────────────────────────────────────────────────────

describe("detectDocumentProfile — null / empty", () => {
  it("returns 'unknown' for null", () => {
    expect(detectDocumentProfile(null)).toBe("unknown");
  });

  it("returns 'unknown' for an empty object", () => {
    expect(detectDocumentProfile({})).toBe("unknown");
  });
});

describe("detectDocumentProfile — manual override", () => {
  it("returns 'full_lease' when document_type_override is 'full_lease'", () => {
    const lease = { extraction_data: { document_type_override: "full_lease" } };
    expect(detectDocumentProfile(lease)).toBe("full_lease");
  });

  it("manual override wins even when documentType says assignment", () => {
    const lease = withDocumentType(
      { extraction_data: { document_type_override: "full_lease" } },
      "assignment",
    );
    expect(detectDocumentProfile(lease)).toBe("full_lease");
  });
});

describe("detectDocumentProfile — full lease signals beat documentType", () => {
  it("returns 'full_lease' when commencement + expiration both present", () => {
    const lease = makeWfLease({
      commencement_date: { value: "2024-02-01" },
      expiration_date: { value: "2025-01-31" },
    });
    expect(detectDocumentProfile(lease)).toBe("full_lease");
  });

  it("returns 'full_lease' when commencement + rent both present", () => {
    const lease = makeWfLease({
      commencement_date: { value: "2024-02-01" },
      monthly_rent: { value: 1400 },
    });
    expect(detectDocumentProfile(lease)).toBe("full_lease");
  });

  it("returns 'full_lease' even when documentType says 'assignment' and 2 signals present", () => {
    const base = makeWfLease({
      commencement_date: { value: "2024-02-01" },
      expiration_date: { value: "2025-01-31" },
    });
    const lease = withDocumentType(base, "assignment");
    expect(detectDocumentProfile(lease)).toBe("full_lease");
  });

  it("returns 'full_lease' even when documentType says 'amendment' and rent + expiration present", () => {
    const base = makeWfLease({
      annual_rent: { value: 16800 },
      expiration_date: { value: "2025-01-31" },
    });
    const lease = withDocumentType(base, "amendment");
    expect(detectDocumentProfile(lease)).toBe("full_lease");
  });

  it("reads signals from top-level lease columns too", () => {
    const lease = { commencement_date: "2024-02-01", monthly_rent: 1400 };
    expect(detectDocumentProfile(lease)).toBe("full_lease");
  });

  it("reads signals from uploaded_file ui_review_payload records", () => {
    const lease = {
      uploaded_file: {
        ui_review_payload: {
          records: [{
            fields: {
              commencement_date: { value: "2024-02-01" },
              monthly_rent: { value: 1400 },
            },
          }],
        },
      },
    };
    expect(detectDocumentProfile(lease)).toBe("full_lease");
  });

  it("only one signal → does NOT override documentType", () => {
    const base = makeWfLease({ commencement_date: { value: "2024-02-01" } });
    const lease = withDocumentType(base, "assignment");
    expect(detectDocumentProfile(lease)).toBe("assignment");
  });
});

describe("detectDocumentProfile — assignment / amendment detection", () => {
  it("returns 'assignment' when documentType is assignment and no full lease signals", () => {
    const lease = withDocumentType({}, "assignment");
    expect(detectDocumentProfile(lease)).toBe("assignment");
  });

  it("returns 'amendment' for amendment documentType", () => {
    const lease = withDocumentType({}, "amendment");
    expect(detectDocumentProfile(lease)).toBe("amendment");
  });

  it("returns 'estoppel' for estoppel documentType", () => {
    const lease = withDocumentType({}, "estoppel");
    expect(detectDocumentProfile(lease)).toBe("estoppel");
  });

  it("returns 'consent' for consent documentType", () => {
    const lease = withDocumentType({}, "consent");
    expect(detectDocumentProfile(lease)).toBe("consent");
  });

  it("matches substring: 'assignment_of_lease' → 'assignment'", () => {
    const lease = withDocumentType({}, "assignment_of_lease");
    expect(detectDocumentProfile(lease)).toBe("assignment");
  });
});

// ── isAssignmentDocument ──────────────────────────────────────────────────────

describe("isAssignmentDocument", () => {
  it("returns false for a full lease (2 signals present)", () => {
    const lease = makeWfLease({
      commencement_date: { value: "2024-02-01" },
      monthly_rent: { value: 1400 },
    });
    expect(isAssignmentDocument(lease)).toBe(false);
  });

  it("returns true for a pure assignment document (no signals)", () => {
    const lease = withDocumentType({}, "assignment");
    expect(isAssignmentDocument(lease)).toBe(true);
  });

  it("returns false for unknown profile (treated as full lease)", () => {
    expect(isAssignmentDocument({})).toBe(false);
    expect(isAssignmentDocument(null)).toBe(false);
  });
});
