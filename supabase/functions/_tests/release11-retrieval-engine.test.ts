import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { retrieveKnowledgeGraph } from "../_shared/copilot/retrieval-engine.ts";

const nodes = [
  { id: "n1", organizationId: "org-1", nodeType: "canonical_field", key: "expiration_date", value: "2027-12-31", status: "approved", generationId: "g1", evidence: [{ id: "e1", documentId: "d1", page: 2, text: "expires" }] },
  { id: "n2", organizationId: "org-2", nodeType: "canonical_field", key: "expiration_date", value: "2028-01-01", status: "approved", generationId: "g1", evidence: [{ id: "e2", documentId: "d2", page: 1, text: "expires" }] },
  { id: "n3", organizationId: "org-1", nodeType: "canonical_field", key: "expiration_date", value: "2026-01-01", status: "stale", generationId: "old", evidence: [{ id: "e3", documentId: "d3", page: 1, text: "old" }] },
];

Deno.test("Release 11 retrieval is permission and organization aware", () => {
  const result = retrieveKnowledgeGraph({ intent: "lease_expiration_search", organizationId: "org-1", nodes, permissionDecision: { allowed: true } });
  assertEquals(result.nodes.map((node) => node.id), ["n1"]);
});

Deno.test("Release 11 retrieval denies cross tenant access", () => {
  const result = retrieveKnowledgeGraph({ intent: "lease_expiration_search", organizationId: "org-1", targetOrganizationId: "org-2", nodes, permissionDecision: { allowed: true } });
  assertEquals(result.blocked, true);
  assertEquals(result.reasonCodes, ["cross_tenant_retrieval_denied"]);
});