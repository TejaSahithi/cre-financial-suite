import { describe, expect, it } from "vitest";

import { getUserRoutingState } from "../getUserRoutingState";

const user = { id: "user-1", email: "member@example.com" };
const activeOrg = { id: "org-1", status: "active" };

describe("getUserRoutingState", () => {
  it("keeps invited team members out of org approval/onboarding when no active membership exists yet", () => {
    expect(
      getUserRoutingState(
        user,
        {
          status: "pending_approval",
          onboarding_type: "invited",
          first_login: true,
        },
        null,
        [],
      ),
    ).toBe("AcceptInvite");
  });

  it("routes pending team memberships to AcceptInvite", () => {
    expect(
      getUserRoutingState(
        user,
        {
          status: "invited",
          onboarding_type: "invited",
          first_login: true,
        },
        activeOrg,
        [{ role: "portfolio_manager", status: "invited" }],
      ),
    ).toBe("AcceptInvite");
  });

  it("routes active invited team members to the product, not owner onboarding", () => {
    expect(
      getUserRoutingState(
        user,
        {
          status: "active",
          onboarding_type: "invited",
          first_login: false,
        },
        activeOrg,
        [{ role: "portfolio_manager", status: "active" }],
      ),
    ).toBe("WelcomeAboard");
  });

  it("keeps public/org access approval on the PendingApproval path", () => {
    expect(
      getUserRoutingState(
        user,
        {
          status: "pending_approval",
          onboarding_type: "owner",
          first_login: true,
        },
        null,
        [],
      ),
    ).toBe("PendingApproval");
  });
});
