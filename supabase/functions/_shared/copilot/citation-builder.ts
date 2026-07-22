// @ts-nocheck
export function buildCitations(nodes) {
  return (nodes || []).flatMap((node) => (node.evidence || []).map((evidence) => ({ evidenceId: evidence.id, nodeId: node.id, fieldKey: node.key, documentId: evidence.documentId, documentFamilyId: node.documentFamilyId, amendmentSourceId: node.amendmentSourceId, page: evidence.page ?? null, reviewerStatus: node.status, confidence: node.confidence }))).filter((citation, index, all) => index === all.findIndex((other) => other.evidenceId === citation.evidenceId && other.nodeId === citation.nodeId));
}

export function buildLineage(nodes) {
  return { canonicalFieldsUsed: nodes.filter((n) => n.nodeType === "canonical_field").map((n) => n.key), semanticRecordsUsed: nodes.filter((n) => n.nodeType === "semantic_record").map((n) => n.id), reviewerOverridesConsidered: nodes.filter((n) => n.nodeType === "reviewer_override").map((n) => n.key), amendmentPrecedenceApplied: nodes.some((n) => n.nodeType === "amendment_effect"), portfolioFactsUsed: nodes.filter((n) => n.nodeType === "portfolio_fact").map((n) => n.key) };
}