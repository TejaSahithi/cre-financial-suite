// @ts-nocheck

import { DOCUMENT_SEMANTICS_ALGORITHM_VERSION, type AmendmentEffectRecord, type AmendmentEffectType, type SemanticBlockLike, semanticId } from "./types.ts";

const FIELD_TARGETS: Array<[RegExp, string]> = [
  [/\bexpiration date\b/i, "expiration_date"],
  [/\bcommencement date\b/i, "commencement_date"],
  [/\brent commencement date\b/i, "rent_commencement_date"],
  [/\bbase rent\b|\bminimum rent\b|\bmonthly rent\b/i, "monthly_rent"],
  [/\bpremises\b/i, "premises"],
  [/\bsecurity deposit\b/i, "security_deposit"],
];

function effectTypeFor(text: string): AmendmentEffectType {
  if (/deleted\s+and\s+replaced|amended\s+and\s+restated|is\s+replaced/i.test(text)) return "replace";
  if (/supplement|in addition/i.test(text)) return "supplement";
  if (/deleted|removed/i.test(text)) return "delete";
  if (/waived/i.test(text)) return "waive";
  if (/extended|extension/i.test(text)) return "extend";
  if (/shortened|reduced/i.test(text)) return "shorten";
  if (/clarif/i.test(text)) return "clarify";
  if (/renamed/i.test(text)) return "rename";
  if (/restated/i.test(text)) return "restate";
  if (/override/i.test(text)) return "override";
  if (/except\s+as\s+modified.*remain/i.test(text)) return "no_change";
  return "unknown";
}

function targetFieldFor(text: string): string | null {
  for (const [pattern, fieldKey] of FIELD_TARGETS) if (pattern.test(text)) return fieldKey;
  return null;
}

function sectionTarget(text: string): string | null {
  return text.match(/\bSection\s+([0-9A-Za-z.\-]+)/i)?.[1] ?? null;
}

function definitionTarget(text: string): string | null {
  return text.match(/definition\s+of\s+["'\u201c\u201d]?([^"'\u201c\u201d.]{2,80})["'\u201c\u201d]?\s+is\s+amended/i)?.[1]?.trim() ?? null;
}

function replacementValue(text: string): unknown | null {
  const toMatch = text.match(/\b(?:to|shall\s+be|is\s+changed\s+to)\s+([^.;]+)/i)?.[1];
  if (toMatch) return toMatch.trim();
  const quoted = text.match(/["'\u201c\u201d]([^"'\u201c\u201d]{2,160})["'\u201c\u201d]/)?.[1];
  return quoted?.trim() ?? null;
}

function effectiveDate(text: string): string | null {
  const raw = text.match(/effective\s+(?:as\s+of\s+)?([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i)?.[1] ?? null;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function extractAmendmentEffects(args: { blocks: SemanticBlockLike[]; sourceUploadedFileId: string; sourceRunId: string; sourceGenerationId: string; documentFamilyId?: string | null }): AmendmentEffectRecord[] {
  const effects: AmendmentEffectRecord[] = [];
  for (const block of args.blocks) {
    const text = String(block.text ?? "").replace(/\s+/g, " ").trim();
    if (!/amend|replace|deleted|extended|waived|supplement|except\s+as\s+modified/i.test(text)) continue;
    const type = effectTypeFor(text);
    const targetCanonicalFieldKey = targetFieldFor(text);
    const targetClauseKey = sectionTarget(text);
    const targetDefinitionTerm = definitionTarget(text);
    const resolved = type !== "unknown" && Boolean(targetCanonicalFieldKey || targetClauseKey || targetDefinitionTerm || type === "no_change");
    effects.push({
      id: semanticId("amendment-effect", [args.sourceUploadedFileId, block.blockId, type, targetCanonicalFieldKey ?? targetClauseKey ?? targetDefinitionTerm ?? "unknown"]),
      documentFamilyId: args.documentFamilyId ?? null,
      sourceUploadedFileId: args.sourceUploadedFileId,
      sourceRunId: args.sourceRunId,
      sourceGenerationId: args.sourceGenerationId,
      targetUploadedFileId: null,
      targetCanonicalFieldKey,
      targetClauseKey,
      targetDefinitionTerm,
      effectType: type,
      effectiveDate: effectiveDate(text),
      previousValue: null,
      replacementValue: replacementValue(text),
      sourceClaimIds: [],
      sourceEvidenceIds: [],
      resolutionStatus: resolved ? "resolved" : "unresolved",
      confidence: resolved ? 0.82 : 0.42,
      reasonCodes: resolved ? ["explicit_amendment_language"] : ["amendment_target_unresolved"],
      algorithmVersion: DOCUMENT_SEMANTICS_ALGORITHM_VERSION,
    });
  }
  return effects;
}

export async function persistAmendmentEffects(args: { supabaseAdmin: any; orgId: string; effects: AmendmentEffectRecord[] }) {
  if (!args.effects.length) return { count: 0, error: null };
  const rows = args.effects.map((effect) => ({
    organization_id: args.orgId,
    document_family_id: effect.documentFamilyId,
    source_uploaded_file_id: effect.sourceUploadedFileId,
    source_run_id: effect.sourceRunId,
    source_generation_id: effect.sourceGenerationId,
    target_uploaded_file_id: effect.targetUploadedFileId,
    target_canonical_field_key: effect.targetCanonicalFieldKey,
    target_clause_key: effect.targetClauseKey,
    target_definition_term: effect.targetDefinitionTerm,
    effect_type: effect.effectType,
    effective_date: effect.effectiveDate,
    previous_value: effect.previousValue,
    replacement_value: effect.replacementValue,
    source_claim_ids: effect.sourceClaimIds,
    source_evidence_ids: effect.sourceEvidenceIds,
    resolution_status: effect.resolutionStatus,
    confidence: effect.confidence,
    reason_codes: effect.reasonCodes,
    algorithm_version: effect.algorithmVersion,
  }));
  const scopes = [...new Map(rows.map((row) => [
    [row.document_family_id, row.source_uploaded_file_id, row.source_run_id, row.source_generation_id].join("|"),
    {
      documentFamilyId: row.document_family_id,
      sourceUploadedFileId: row.source_uploaded_file_id,
      sourceRunId: row.source_run_id,
      sourceGenerationId: row.source_generation_id,
    },
  ])).values()];
  for (const scope of scopes) {
    await args.supabaseAdmin.from("document_amendment_effects")
      .delete()
      .eq("organization_id", args.orgId)
      .eq("document_family_id", scope.documentFamilyId)
      .eq("source_uploaded_file_id", scope.sourceUploadedFileId)
      .eq("source_run_id", scope.sourceRunId)
      .eq("source_generation_id", scope.sourceGenerationId);
  }
  const { error } = await args.supabaseAdmin.from("document_amendment_effects").insert(rows);
  return { count: error ? 0 : rows.length, error: error?.message ?? null };
}
