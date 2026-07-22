import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { RELEASE9_ENDPOINTS_REQUIRE_ORG_SCOPE, RELEASE9_RLS_TABLES, RELEASE9_SECURITY_REQUIREMENTS } from "../_shared/integrations/integration-security-contract.ts";

Deno.test("Release 9 security contract enforces organization-scoped integration control plane", () => {
  assertEquals(RELEASE9_RLS_TABLES.includes("integration_events"), true);
  assertEquals(RELEASE9_RLS_TABLES.includes("integration_credentials"), true);
  assertEquals(RELEASE9_ENDPOINTS_REQUIRE_ORG_SCOPE.length, 6);
  assertEquals(RELEASE9_SECURITY_REQUIREMENTS.organizationMembership, "organization_id IN (SELECT public.get_my_org_ids())");
  assertEquals(RELEASE9_SECURITY_REQUIREMENTS.credentialStorage, "credential_ciphertext");
  assertEquals(RELEASE9_SECURITY_REQUIREMENTS.directDatabaseAccessForThirdParties, false);
  assertEquals(RELEASE9_SECURITY_REQUIREMENTS.automaticFinancialPosting, false);
});
