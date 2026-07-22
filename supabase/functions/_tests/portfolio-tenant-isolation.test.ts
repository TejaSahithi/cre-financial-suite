import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PORTFOLIO_ENDPOINTS_REQUIRING_ORG_SCOPE, PORTFOLIO_RLS_TABLES, PORTFOLIO_SECURITY_REQUIREMENTS } from "../_shared/portfolio-intelligence/portfolio-security-contract.ts";

Deno.test("Release 8 portfolio tenant isolation contract enumerates scoped tables and endpoints", () => {
  assertEquals(PORTFOLIO_RLS_TABLES.includes("portfolio_lease_facts"), true);
  assertEquals(PORTFOLIO_RLS_TABLES.includes("portfolio_export_runs"), true);
  assertEquals(PORTFOLIO_ENDPOINTS_REQUIRING_ORG_SCOPE.length, 6);
  assertEquals(PORTFOLIO_SECURITY_REQUIREMENTS.organizationMembership, "organization_id IN (SELECT public.get_my_org_ids())");
  assertEquals(PORTFOLIO_SECURITY_REQUIREMENTS.portfolioAccess, "public.can_access_portfolio(portfolio_id)");
  assertEquals(PORTFOLIO_SECURITY_REQUIREMENTS.rawEvidenceTextDefault, false);
});
