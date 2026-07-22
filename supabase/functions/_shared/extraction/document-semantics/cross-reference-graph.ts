// @ts-nocheck

import type { AmendmentEffectRecord, CrossReferenceRecord, DefinitionRecord, GraphEdge } from "./types.ts";

export function buildCrossReferenceGraph(args: { definitions?: DefinitionRecord[]; references?: CrossReferenceRecord[]; amendmentEffects?: AmendmentEffectRecord[] }): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const definition of args.definitions ?? []) {
    for (const blockId of definition.sourceBlockIds ?? []) {
      edges.push({ fromType: "block", fromKey: blockId, toType: "definition", toKey: definition.id ?? definition.termNormalized, edgeType: "defines", confidence: definition.confidence, reasonCodes: [] });
    }
  }
  for (const ref of args.references ?? []) {
    const targetKey = ref.targetDefinitionId ?? ref.targetBlockId ?? ref.targetSectionKey ?? ref.targetDocumentId ?? ref.targetLabel;
    const targetType = ref.targetDefinitionId ? "definition" : ref.targetBlockId ? "block" : ref.targetSectionKey ? "section" : ref.targetDocumentId ? "document" : "unresolved_reference";
    if (["resolved", "cross_document", "superseded_target"].includes(ref.resolutionStatus)) {
      edges.push({ fromType: "block", fromKey: ref.sourceBlockId, toType: targetType, toKey: targetKey, edgeType: "references", confidence: ref.confidence, reasonCodes: ref.reasonCodes });
    }
  }
  for (const effect of args.amendmentEffects ?? []) {
    const targetKey = effect.targetCanonicalFieldKey ?? effect.targetClauseKey ?? effect.targetDefinitionTerm ?? effect.targetUploadedFileId ?? "unknown";
    const edgeType = effect.effectType === "replace" || effect.effectType === "delete" ? "replaces" : effect.effectType === "supplement" ? "supplements" : effect.effectType === "clarify" ? "clarifies" : "amends";
    if (effect.resolutionStatus === "resolved") edges.push({ fromType: "amendment_effect", fromKey: effect.id ?? `${effect.sourceUploadedFileId}:${targetKey}`, toType: effect.targetCanonicalFieldKey ? "projection" : "document", toKey: targetKey, edgeType, confidence: effect.confidence, reasonCodes: effect.reasonCodes });
  }
  return edges.sort((a, b) => `${a.fromType}:${a.fromKey}:${a.edgeType}`.localeCompare(`${b.fromType}:${b.fromKey}:${b.edgeType}`));
}