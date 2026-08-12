import { describe, expect, it } from "vitest";
import {
  ROLE_DEFINITIONS,
  getPageAccessLevel,
  getRoleDefaultModulePerms,
  resolveEffectivePermissions,
} from "@/lib/userPermissions";

const ORG = "org-standard";

function userWithRole(role, membership = {}) {
  return {
    id: `${role}-user`,
    role,
    org_id: ORG,
    memberships: [
      {
        id: `${role}-membership`,
        org_id: ORG,
        user_id: `${role}-user`,
        role,
        status: "active",
        module_permissions: {},
        page_permissions: {},
        capabilities: {},
        ...membership,
      },
    ],
  };
}

describe("standard CRE roles in userPermissions", () => {
  it("exposes the standard role catalog used by User Management", () => {
    const roleValues = ROLE_DEFINITIONS.map((role) => role.value);

    expect(roleValues).toEqual(expect.arrayContaining([
      "org_owner",
      "org_admin",
      "portfolio_manager",
      "property_manager",
      "lease_admin",
      "leasing_agent",
      "finance",
      "property_owner",
      "auditor",
      "tenant",
      "custom_role",
    ]));
  });

  it("gives Organization Owner admin-level page defaults", () => {
    const owner = userWithRole("org_owner");

    expect(getPageAccessLevel(owner, "UserManagement")).toBe("admin");
    expect(getRoleDefaultModulePerms("org_owner").admin).toBe("full");
  });

  it("keeps Property Owner visible but not administrative", () => {
    const propertyOwner = userWithRole("property_owner");

    expect(getPageAccessLevel(propertyOwner, "Revenue")).toBe("read");
    expect(getPageAccessLevel(propertyOwner, "UserManagement")).toBe("none");
  });

  it("gives Lease Admin lease workflow write access", () => {
    const leaseAdmin = userWithRole("lease_admin");

    expect(getPageAccessLevel(leaseAdmin, "LeaseUpload")).toBe("write");
    expect(getPageAccessLevel(leaseAdmin, "LeaseReview")).toBe("write");
  });

  it("uses custom_role as the custom role key", () => {
    const effective = resolveEffectivePermissions("custom_role", {}, {}, {});

    expect(effective.effectiveModule.dashboard).toBe("full");
  });
});
