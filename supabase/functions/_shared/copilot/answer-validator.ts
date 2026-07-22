// @ts-nocheck
import { COPILOT_SCHEMA_VERSION } from "./copilot-contracts.ts";
import { buildCitations, buildLineage } from "./citation-builder.ts";

export function unsupportedAnswer(reasonCodes) {
  return { schemaVersion: COPILOT_SCHEMA_VERSION, answer: "The requested information is unavailable in reviewed canonical data.", supported: false, confidence: null, citations: [], lineage: { canonicalFieldsUsed: [], semanticRecordsUsed: [], reviewerOverridesConsidered: [], amendmentPrecedenceApplied: false, portfolioFactsUsed: [] }, limitations: reasonCodes };
}

export function validateCopilotAnswer(args) {
  const citations = buildCitations(args.nodes || []);
  if (!args.nodes?.length) return unsupportedAnswer(["no_grounded_nodes"]);
  if (!citations.length) return unsupportedAnswer(["missing_evidence_citations"]);
  if (args.nodes.some((node) => node.status === "stale")) return unsupportedAnswer(["stale_generation_rejected"]);
  const confidenceValues = args.nodes.map((node) => node.confidence).filter((value) => Number.isFinite(Number(value))).map(Number);
  const confidence = confidenceValues.length ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length : null;
  return { schemaVersion: COPILOT_SCHEMA_VERSION, answer: args.answer, supported: true, confidence, citations, lineage: buildLineage(args.nodes), limitations: [] };
}