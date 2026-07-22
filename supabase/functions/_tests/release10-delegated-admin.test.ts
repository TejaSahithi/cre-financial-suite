import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validateDelegatedRoleAssignment } from "../_shared/enterprise-control/enterprise-authorization.ts";

Deno.test("Release 10 delegated admins cannot grant platform roles", () => {
  const decision = validateDelegatedRoleAssignment({ actorOrganizationId: "org-1", targetOrganizationId: "org-1", role: "platform_super_admin" });
  assertEquals(decision.allowed, false);
  assertEquals(decision.reasonCodes, ["platform_role_not_delegable"]);
});

Deno.test("Release 10 delegated admin blocks last administrator removal", () => {
  const decision = validateDelegatedRoleAssignment({ actorOrganizationId: "org-1", targetOrganizationId: "org-1", role: "organization_admin", removesLastAdmin: true });
  assertEquals(decision.allowed, false);
  assertEquals(decision.reasonCodes, ["last_admin_removal_denied"]);
});