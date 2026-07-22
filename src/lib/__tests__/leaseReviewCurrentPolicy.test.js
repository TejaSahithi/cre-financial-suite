import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REVIEW_STATUSES, REQUIRED_FIELD_KEYS, isResolvedReview } from "../leaseReviewSchema";
import { normalizeLeaseReviewData } from "../leaseReviewFieldNormalizer";
import { detectDocumentProfile } from "../documentProfile";
import {
  buildCurrentReviewPolicy,
  normalizeCurrentReviewProfile,
} from "../leaseReviewCurrentPolicy";

function leaseWithDocumentType(documentType, fields = {}) {
  return {
    id: "lease-1",
    extraction_data: {
      workflow_output: {
        document_profile: { documentType },
      },
      fields,
      field_evidence: Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          { source_text: `${key}: ${value?.value ?? value}`, source_page: 1 },
        ]),
      ),
    },
  };
}

describe("leaseReviewCurrentPolicy", () => {
  it("keeps the legacy required blockers for base leases", () => {
    const policy = buildCurrentReviewPolicy(
      leaseWithDocumentType("base_lease", {
        commencement_date: { value: "2025-01-01" },
        expiration_date: { value: "2030-12-31" },
      }),
    );

    expect(policy.profile).toBe("base_lease");
    expect(policy.applyBaseLeaseBlockers).toBe(true);
    expect(policy.requiredFieldKeys).toEqual(REQUIRED_FIELD_KEYS);
    expect(policy.requiredFieldKeys).toContain("monthly_rent");
    expect(policy.requiredFieldKeys).toContain("lease_type");
  });

  it("does not inherit full base lease blockers for assignment documents", () => {
    const policy = buildCurrentReviewPolicy(
      leaseWithDocumentType("assignment", {
        assignee_name: { value: "New Tenant LLC" },
        assignment_effective_date: { value: "2026-01-15" },
        landlord_consent: { value: true },
      }),
    );

    expect(policy.profile).toBe("assignment");
    expect(policy.applyBaseLeaseBlockers).toBe(false);
    expect(policy.requiredFieldKeys).toContain("assignee_name");
    expect(policy.requiredFieldKeys).toContain("assignment_effective_date");
    expect(policy.requiredFieldKeys).not.toContain("tenant_name");
    expect(policy.requiredFieldKeys).not.toContain("landlord_consent");
    expect(policy.advisoryGaps.map((gap) => gap.key)).toContain("landlord_consent_assignment_advisory");
    expect(policy.requiredFieldKeys).not.toContain("monthly_rent");
    expect(policy.requiredFieldKeys).not.toContain("annual_rent");
    expect(policy.requiredFieldKeys).not.toContain("lease_type");
    expect(policy.requiredFieldKeys).not.toContain("base_year");
    expect(policy.requiredFieldKeys).not.toContain("expense_stop");
  });

  it("does not default unknown CRE documents to base lease blockers", () => {
    const policy = buildCurrentReviewPolicy({ id: "lease-unknown", extraction_data: {} });

    expect(policy.profile).toBe("unknown_cre_document");
    expect(policy.applyBaseLeaseBlockers).toBe(false);
    expect(policy.requiredFieldKeys).toEqual([]);
    expect(policy.advisoryGaps[0].key).toBe("unknown_profile_needs_review");
  });

  it("treats missing original lease as an assignment advisory/current-truth gap", () => {
    const normalized = normalizeLeaseReviewData(
      leaseWithDocumentType("assignment", {
        assignee_name: { value: "New Tenant LLC" },
        assignment_effective_date: { value: "2026-01-15" },
      }),
    );

    expect(normalized.currentReviewPolicy.advisoryGaps.map((gap) => gap.key)).toContain("original_lease_missing");
    expect(normalized.currentReviewPolicy.requiredFieldKeys).not.toContain("original_lease_date");
    expect(normalized.approvalBlockers.warnings.join(" ")).toContain("Original lease is needed");
    expect(normalized.approvalBlockers.budgetBlockers).toEqual([]);
    expect(normalized.approvalBlockers.camBlockers).toEqual([]);
  });

  it("keeps assignment required missing fields visible without base lease noise", () => {
    const normalized = normalizeLeaseReviewData(leaseWithDocumentType("assignment"));

    expect(normalized.readinessSummary.missingRequiredFields).toEqual([
      "assignee_name",
      "assignment_effective_date",
    ]);
    expect(normalized.readinessSummary.missingRequiredFields).not.toContain("monthly_rent");
    expect(normalized.readinessSummary.missingRequiredFields).not.toContain("lease_type");
  });

  it("downgrades assignment tenant and consent signals to advisory review instead of hard blockers", () => {
    const normalized = normalizeLeaseReviewData(
      leaseWithDocumentType("assignment", {
        assignee_name: { value: "New Tenant LLC" },
        assignment_effective_date: { value: "2026-01-15" },
        tenant_name: { value: "Prior Tenant LLC" },
        landlord_consent: { value: true },
        landlord_consent_for_transfer: { value: "Consent attached" },
      }),
    );

    expect(normalized.currentReviewPolicy.requiredFieldKeys).not.toContain("tenant_name");
    expect(normalized.currentReviewPolicy.requiredFieldKeys).not.toContain("landlord_consent");
    expect(normalized.currentReviewPolicy.requiredFieldKeys).not.toContain("landlord_consent_for_transfer");
    expect(normalized.approvalBlockers.missingFields).not.toContain("tenant_name");
    expect(normalized.approvalBlockers.missingFields).not.toContain("landlord_consent");
    expect(normalized.approvalBlockers.missingFields).not.toContain("landlord_consent_for_transfer");
    expect(normalized.currentReviewPolicy.advisoryGaps.map((gap) => gap.key)).toEqual(
      expect.arrayContaining([
        "tenant_name_assignment_advisory",
        "landlord_consent_assignment_advisory",
        "landlord_consent_for_transfer_assignment_advisory",
      ]),
    );
    expect(normalized.readinessSummary.missingRequiredFields).not.toContain("tenant_name");
  });

  it("normalizes assignment-assumption profile names into assignment current-review policy", () => {
    expect(normalizeCurrentReviewProfile("assignment_assumption")).toBe("assignment");
    expect(normalizeCurrentReviewProfile("assignment_assumption_amendment")).toBe("assignment");
  });

  it("keeps existing Accept/Edit/Needs Review resolution semantics intact", () => {
    expect(isResolvedReview({ status: REVIEW_STATUSES.ACCEPTED })).toBe(true);
    expect(isResolvedReview({ status: REVIEW_STATUSES.EDITED })).toBe(true);
    expect(isResolvedReview({ status: REVIEW_STATUSES.N_A })).toBe(true);
    expect(isResolvedReview({ status: REVIEW_STATUSES.MANUAL_REQUIRED })).toBe(true);
    expect(isResolvedReview({ status: REVIEW_STATUSES.NEEDS_LEGAL })).toBe(false);
    expect(isResolvedReview({ status: REVIEW_STATUSES.PENDING })).toBe(false);
  });

  it("keeps Lease Review action handlers while hiding advisory readiness chrome", () => {
    const source = readFileSync(resolve(process.cwd(), "src/pages/LeaseReview.jsx"), "utf8");

    expect(source).toContain("const handleAccept = (field) =>");
    expect(source).toContain("const handleMarkNA = (field) =>");
    expect(source).toContain("const handleNeedsLegal = (field) =>");
    expect(source).toContain("const handleMarkManualRequired = (field) =>");
    expect(source).toContain("isLeaseReviewEnrichmentInFlight(status)");
    expect(source).not.toContain("Evidence and CAM enrichment is still running.");
    expect(source).not.toContain("LeaseReviewReadinessSummary");
    expect(source).not.toContain("ApprovalBlockersPanel");
  });
});

describe("Phase 39: profile detection reconciliation", () => {
  it("reproduces the split-brain bug: detectDocumentProfile disagrees with currentReviewPolicy for the same object", () => {
    // Only the top-level `document_profile` candidate carries the signal -
    // detectDocumentProfile only checks workflow_output.document_profile.*
    // (and a few other primary paths), none of which are set here, and this
    // fixture has no full-lease signals either, so it falls through to
    // "unknown". currentReviewPolicy's resolveCurrentReviewProfile scans a
    // wider candidate list (including plain `lease.document_profile`) and
    // correctly finds the assignment signal.
    const fixture = {
      id: "lease-splitbrain",
      document_profile: "assignment_assumption_amendment",
      extraction_data: { fields: {}, field_evidence: {} },
    };

    expect(detectDocumentProfile(fixture)).toBe("unknown");
    expect(buildCurrentReviewPolicy(fixture).profile).toBe("assignment");
  });

  it("LeaseReview.jsx derives isAssignmentOnlyDocument from currentReviewPolicy.profile, not a separate detectDocumentProfile call", () => {
    const source = readFileSync(resolve(process.cwd(), "src/pages/LeaseReview.jsx"), "utf8");

    expect(source).not.toContain("import { detectDocumentProfile }");
    expect(source).not.toMatch(/isAssignmentOnlyDocument[\s\S]{0,200}detectDocumentProfile\(/);
    expect(source).toContain('normalized.currentReviewPolicy?.profile === "assignment"');
  });

  it("stored amendment metadata keeps reduced-review policy even when carried-forward lease values are present", () => {
    const fixture = {
      ...leaseWithDocumentType("amendment", {
        commencement_date: { value: "2026-06-01" },
        expiration_date: { value: "2031-12-31" },
        monthly_rent: { value: 5000 },
      }),
      document_subtype: "amendment",
      monthly_rent: 5000,
      commencement_date: "2026-06-01",
    };

    const policy = buildCurrentReviewPolicy(fixture);

    expect(policy.profile).toBe("assignment");
    expect(policy.applyBaseLeaseBlockers).toBe(false);
    expect(policy.requiredFieldKeys).not.toContain("monthly_rent");
  });
  it("base lease documents still resolve as base_lease (full-lease-signal override preserved)", () => {
    // AI mis-stamped this as "assignment", but 3 full-lease signals
    // (commencement, expiration, rent) are present, so detectDocumentProfile
    // must still override to "full_lease" and the policy must still resolve
    // to "base_lease" - Phase 39 must not weaken this.
    const fixture = leaseWithDocumentType("assignment", {
      commencement_date: { value: "2025-01-01" },
      expiration_date: { value: "2030-12-31" },
      monthly_rent: { value: 5000 },
    });

    expect(detectDocumentProfile(fixture)).toBe("full_lease");
    expect(buildCurrentReviewPolicy(fixture).profile).toBe("base_lease");
  });

  it("unknown CRE documents with no signals anywhere still resolve as unknown, not assignment or base lease", () => {
    const fixture = { id: "lease-nothing", extraction_data: {} };

    expect(detectDocumentProfile(fixture)).toBe("unknown");
    expect(buildCurrentReviewPolicy(fixture).profile).toBe("unknown_cre_document");
  });
});
