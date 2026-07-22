import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildGroundedCopilotResponse } from "../_shared/copilot/copilot-orchestrator.ts";

const baseNode = { id: "n1", organizationId: "org-1", nodeType: "reviewer_override", key: "base_rent", value: "$10", status: "approved", generationId: "g1", documentFamilyId: "fam", sourceDocumentId: "doc", amendmentSourceId: null, confidence: 0.95, evidence: [{ id: "e1", documentId: "doc", page: 3, text: "base rent" }], metadata: {} };
const portfolioNode = { ...baseNode, id: "p1", nodeType: "portfolio_fact", key: "portfolio_summary", value: "5 leases", evidence: [{ id: "e2", documentId: "portfolio", page: null, text: "portfolio summary" }] };

Deno.test("Release 11 orchestrator returns grounded lease Q&A with reviewer override lineage", () => {
  const answer = buildGroundedCopilotResponse({ question: "What is the current base rent?", scope: "lease", organizationId: "org-1", nodes: [baseNode], permissionDecision: { allowed: true }, draftAnswer: "The current base rent is $10." });
  assertEquals(answer.supported, true);
  assertEquals(answer.lineage.reviewerOverridesConsidered, ["base_rent"]);
  assertEquals(answer.citations.length, 1);
});

Deno.test("Release 11 orchestrator supports portfolio grounded summaries", () => {
  const answer = buildGroundedCopilotResponse({ question: "Generate a portfolio summary", scope: "portfolio", organizationId: "org-1", nodes: [portfolioNode], permissionDecision: { allowed: true }, draftAnswer: "Portfolio summary uses 5 leases." });
  assertEquals(answer.supported, true);
  assertEquals(answer.lineage.portfolioFactsUsed, ["portfolio_summary"]);
});

Deno.test("Release 11 orchestrator reports limitations for unsupported questions", () => {
  const answer = buildGroundedCopilotResponse({ question: "Should we buy the building?", scope: "portfolio", organizationId: "org-1", nodes: [portfolioNode], permissionDecision: { allowed: true } });
  assertEquals(answer.supported, false);
  assertEquals(answer.limitations, ["unsupported_question"]);
});