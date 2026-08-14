import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

const field = {
  key: "tenant_name",
  path: "fields.tenant_name",
  label: "Tenant Name",
  domain: "parties",
  value: "Acme LLC",
  displayValue: "Acme LLC",
  status: "missing_source_evidence",
  source: "canonical_projection",
  confidence: null,
  editable: true,
  requiresAttention: true,
  blocking: true,
  reasonCodes: ["missing_evidence"],
  evidence: [],
  conflict: null,
  derivation: { method: "projection" },
  reviewerAction: { state: "none", reason: null },
};

beforeAll(() => {
  const browserWindow = {};
  browserWindow.self = browserWindow;
  browserWindow.top = browserWindow;
  vi.stubGlobal("window", browserWindow);
});

describe("review shared components", () => {
  it("renders field status, value, guidance, metadata, and actions from the view model", async () => {
    const { default: ReviewField } = await import("@/components/review/ReviewField");
    const html = renderToStaticMarkup(<ReviewField field={field} onAction={() => {}} />);

    expect(html).toContain("Tenant Name");
    expect(html).toContain("Missing Evidence");
    expect(html).toContain("Acme LLC");
    expect(html).toContain("supporting source evidence is unavailable");
    expect(html).toContain("Accept");
    expect(html).toContain("Follow Up");
  }, 15000);

  it("renders approval readiness from backend-derived summary only", async () => {
    const { default: ApprovalReadinessSummary } = await import("@/components/review/ApprovalReadinessSummary");
    const html = renderToStaticMarkup(
      <ApprovalReadinessSummary
        approval={{
          eligible: false,
          blockingCount: 2,
          warningCount: 1,
          conflictCount: 1,
          missingRequiredCount: 1,
          missingEvidenceCount: 1,
          fallbackCount: 0,
          overrideCount: 0,
          reasons: ["missing_required_field"],
        }}
      />,
    );

    expect(html).toContain("Approval Readiness");
    expect(html).toContain("Review Required");
    expect(html).toContain("missing_required_field");
  });
});