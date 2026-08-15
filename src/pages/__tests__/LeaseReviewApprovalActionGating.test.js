import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("LeaseReview approval action gating", () => {
  const source = readFileSync(resolve(process.cwd(), "src/pages/LeaseReview.jsx"), "utf8");

  it("allows lease approver roles to see send and approve actions", () => {
    expect(source).toContain("const canCurrentUserSendOrApproveLease = userHasLeaseApproverRole(user, lease?.org_id);");
    expect(source).toContain("const canCurrentUserApproveLeaseRequest = canCurrentUserSendOrApproveLease;");
    expect(source).toContain("{canCurrentUserSendOrApproveLease && (");
    expect(source).toContain("{canCurrentUserApproveLeaseRequest && (");
  });

  it("keeps Send for Approval enabled even when approval blockers exist", () => {
    expect(source).toContain("disabled={!lease.id || !lease.org_id}");
    expect(source).not.toContain("disabled={!lease.id || !lease.org_id || !canApprove}");
  });

  it("keeps final approval clickable while unresolved blockers remain", () => {
    expect(source).toContain("if (!canApprove) {");
    expect(source).toContain("approvalBlockers.forEach((b) =>");
    expect(source).not.toContain("disabled={!canApprove}");
  });
});