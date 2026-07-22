// @ts-nocheck

import type { CrossReferenceRecord, DefinitionRecord, SemanticBlockLike } from "./types.ts";
import { normalizeDefinedTerm } from "./definitions.ts";

function headingKey(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sectionKeyFromLabel(label: string): string | null {
  return label.match(/\b(?:Section|Article|Exhibit|Schedule)\s+([0-9A-Za-z.\-]+)/i)?.[1] ?? null;
}

export function resolveCrossReferences(args: {
  references: CrossReferenceRecord[];
  blocks?: SemanticBlockLike[];
  definitions?: DefinitionRecord[];
  familyDocumentIds?: string[];
  supersededSectionKeys?: string[];
}): CrossReferenceRecord[] {
  const blocks = args.blocks ?? [];
  const definitions = args.definitions ?? [];
  const sections = new Map<string, SemanticBlockLike[]>();
  const headings = new Map<string, SemanticBlockLike[]>();
  for (const block of blocks) {
    if (block.sectionKey) sections.set(String(block.sectionKey).toLowerCase(), [...(sections.get(String(block.sectionKey).toLowerCase()) ?? []), block]);
    if (block.heading) headings.set(headingKey(block.heading), [...(headings.get(headingKey(block.heading)) ?? []), block]);
  }
  const superseded = new Set((args.supersededSectionKeys ?? []).map((key) => String(key).toLowerCase()));
  return args.references.map((ref) => {
    if (ref.referenceType === "defined_term") {
      const term = normalizeDefinedTerm(ref.targetLabel);
      const matches = definitions.filter((definition) => definition.termNormalized === term.normalized && definition.definitionStatus !== "superseded");
      if (matches.length === 1) return { ...ref, targetDefinitionId: matches[0].id, resolutionStatus: matches[0].definitionStatus === "conflicting" ? "ambiguous" : "resolved", confidence: 0.82, reasonCodes: matches[0].definitionStatus === "conflicting" ? ["definition_conflict"] : [] };
      if (matches.length > 1) return { ...ref, resolutionStatus: "ambiguous", confidence: 0.45, reasonCodes: ["multiple_definition_targets"] };
      return { ...ref, resolutionStatus: "unresolved", confidence: 0.3, reasonCodes: ["definition_target_not_found"] };
    }

    const sectionKey = ref.targetSectionKey ?? sectionKeyFromLabel(ref.targetLabel);
    if (sectionKey) {
      const normalized = sectionKey.toLowerCase();
      if (superseded.has(normalized)) return { ...ref, resolutionStatus: "superseded_target", confidence: 0.7, reasonCodes: ["target_section_superseded"] };
      const exact = sections.get(normalized) ?? [];
      if (exact.length === 1) return { ...ref, targetBlockId: exact[0].blockId, targetSectionKey: exact[0].sectionKey ?? sectionKey, resolutionStatus: "resolved", confidence: 0.9, reasonCodes: [] };
      if (exact.length > 1) return { ...ref, targetSectionKey: sectionKey, resolutionStatus: "ambiguous", confidence: 0.55, reasonCodes: ["multiple_section_targets"] };
    }

    const headingMatches = headings.get(headingKey(ref.targetLabel)) ?? [];
    if (headingMatches.length === 1) return { ...ref, targetBlockId: headingMatches[0].blockId, targetSectionKey: headingMatches[0].sectionKey ?? null, resolutionStatus: "resolved", confidence: 0.74, reasonCodes: ["heading_match"] };
    if (headingMatches.length > 1) return { ...ref, resolutionStatus: "ambiguous", confidence: 0.45, reasonCodes: ["ambiguous_heading_match"] };

    if (["amendment", "document"].includes(ref.referenceType) && (args.familyDocumentIds ?? []).length > 0) {
      return { ...ref, targetDocumentId: args.familyDocumentIds![0], resolutionStatus: "cross_document", confidence: 0.65, reasonCodes: ["family_document_target"] };
    }

    return { ...ref, resolutionStatus: "unresolved", confidence: Math.min(ref.confidence ?? 0.4, 0.4), reasonCodes: [...new Set([...(ref.reasonCodes ?? []), "target_not_found"])] };
  });
}

export async function persistCrossReferences(args: { supabaseAdmin: any; orgId: string; uploadedFileId: string; runId: string; generationId: string; references: CrossReferenceRecord[] }) {
  if (!args.references.length) return { count: 0, error: null };
  const rows = args.references.map((ref) => ({
    organization_id: args.orgId,
    uploaded_file_id: args.uploadedFileId,
    run_id: args.runId,
    generation_id: args.generationId,
    source_block_id: ref.sourceBlockId,
    source_text: ref.sourceText,
    reference_type: ref.referenceType,
    target_label: ref.targetLabel,
    target_document_id: ref.targetDocumentId,
    target_block_id: ref.targetBlockId,
    target_section_key: ref.targetSectionKey,
    target_definition_id: ref.targetDefinitionId,
    resolution_status: ref.resolutionStatus,
    confidence: ref.confidence,
    reason_codes: ref.reasonCodes,
    schema_version: ref.schemaVersion,
    algorithm_version: ref.algorithmVersion,
  }));
  await args.supabaseAdmin.from("document_cross_references")
    .delete()
    .eq("organization_id", args.orgId)
    .eq("uploaded_file_id", args.uploadedFileId)
    .eq("run_id", args.runId)
    .eq("generation_id", args.generationId);
  const { error } = await args.supabaseAdmin.from("document_cross_references").insert(rows);
  return { count: error ? 0 : rows.length, error: error?.message ?? null };
}