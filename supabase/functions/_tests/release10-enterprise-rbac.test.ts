import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decideEnterpriseAuthorization } from "../_shared/enterprise-control/enterprise-authorization.ts";

Deno.test("Release 10 enterprise RBAC grants scoped permissions and audits decisions", () => {
  const decision = decideEnterpriseAuthorization({ organizationId: "org-1", permission: "lease.approve", actor: { organizationRoles: { "org-1": ["lease_reviewer"] } } });
  assertEquals(decision.allowed, true);
  assertEquals(decision.auditRequired, true);
});

Deno.test("Release 10 enterprise RBAC denies cross organization privilege inheritance", () => {
  const decision = decideEnterpriseAuthorization({ organizationId: "org-1", targetOrganizationId: "org-2", permission: "lease.read", actor: { organizationRoles: { "org-1": ["organization_admin"] } } });
  assertEquals(decision.allowed, false);
  assertEquals(decision.reasonCodes.includes("cross_organization_access_denied"), true);
});