// @ts-nocheck

import type { AmendmentEffectRecord, CrossReferenceRecord, DefinitionRecord, SemanticCoverageSummary, SemanticFinding } from "./types.ts";

export function buildSemanticCoverageSummary(args: { definitions?: DefinitionRecord[]; references?: CrossReferenceRecord[]; amendmentEffects?: AmendmentEffectRecord[]; lineageByField?: Record<string, any> }): SemanticCoverageSummary {
  const definitions = args.definitions ?? [];
  const references = args.references ?? [];
  const amendmentEffects = args.amendmentEffects ?? [];
  const lineage = Object.values(args.lineageByField ?? {});
  return {
    definitionsDetected: definitions.length,
    definitionsResolved: definitions.filter((item) => item.definitionStatus === "resolved").length,
    definitionsAmbiguous: definitions.filter((item) => item.definitionStatus === "ambiguous").length,
    definitionsConflicting: definitions.filter((item) => item.definitionStatus === "conflicting").length,
    crossReferencesDetected: references.length,
    crossReferencesResolved: references.filter((item) => ["resolved", "cross_document"].includes(item.resolutionStatus)).length,
    crossReferencesUnresolved: references.filter((item) => ["unresolved", "invalid_target"].includes(item.resolutionStatus)).length,
    amendmentsDetected: amendmentEffects.length,
    amendmentEffectsResolved: amendmentEffects.filter((item) => item.resolutionStatus === "resolved").length,
    amendmentEffectsUnresolved: amendmentEffects.filter((item) => item.resolutionStatus === "unresolved").length,
    familyFieldsEvaluated: lineage.length,
    familyFieldsResolved: lineage.filter((item: any) => item?.amendmentPrecedence?.resolutionStatus === "resolved" || item?.selectedLayer === "document_local").length,
    familyFieldsConflicting: lineage.filter((item: any) => item?.amendmentPrecedence?.resolutionStatus === "conflicting").length,
  };
}

function finding(id: string, type: string, severity: SemanticFinding["severity"], title: string, summary: string, reasonCodes: string[], options: Partial<SemanticFinding> = {}): SemanticFinding {
  return {
    findingId: id,
    type,
    canonicalFieldKey: options.canonicalFieldKey ?? null,
    affectedFieldKeys: options.affectedFieldKeys ?? [],
    sourceDocumentIds: options.sourceDocumentIds ?? [],
    severity,
    title,
    summary,
    reasonCodes,
    evidenceIds: options.evidenceIds ?? [],
    resolutionGuidance: options.resolutionGuidance ?? "Review the semantic record and either resolve or dismiss the issue.",
    resolutionStatus: options.resolutionStatus ?? "open",
    reviewerActionRequired: options.reviewerActionRequired ?? severity === "blocking",
  };
}

export function buildSemanticFindings(args: { definitions?: DefinitionRecord[]; references?: CrossReferenceRecord[]; amendmentEffects?: AmendmentEffectRecord[]; lineageByField?: Record<string, any>; approvalCriticalFieldKeys?: string[] }): SemanticFinding[] {
  const findings: SemanticFinding[] = [];
  const approvalCritical = new Set(args.approvalCriticalFieldKeys ?? []);
  for (const definition of args.definitions ?? []) {
    if (definition.definitionStatus === "unresolved") findings.push(finding(`unresolved_definition:${definition.termNormalized}`, "unresolved_definition", "warning", "Unresolved defined term", `${definition.termDisplay} references a definition that was not found.`, ["definition_not_found"], { evidenceIds: definition.evidenceIds, resolutionGuidance: "Select the intended definition or mark the term unresolved." }));
    if (definition.definitionStatus === "ambiguous") findings.push(finding(`ambiguous_definition:${definition.termNormalized}`, "ambiguous_definition", "warning", "Ambiguous defined term", `${definition.termDisplay} has more than one possible definition.`, ["multiple_definition_targets"]));
    if (definition.definitionStatus === "conflicting") findings.push(finding(`conflicting_definition:${definition.termNormalized}:${definition.sourceBlockIds.join("-")}`, "conflicting_definition", "material", "Conflicting definition", `${definition.termDisplay} has conflicting active definitions in the same scope.`, ["conflicting_definition_text"], { evidenceIds: definition.evidenceIds, reviewerActionRequired: true }));
  }
  for (const ref of args.references ?? []) {
    if (ref.resolutionStatus === "unresolved") findings.push(finding(`unresolved_cross_reference:${ref.sourceBlockId}:${ref.targetLabel}`, "unresolved_cross_reference", "warning", "Unresolved cross-reference", `${ref.targetLabel} could not be resolved from ${ref.sourceBlockId}.`, ref.reasonCodes.length ? ref.reasonCodes : ["target_not_found"], { resolutionGuidance: "Open the source clause and confirm the target or mark it unresolved." }));
    if (ref.resolutionStatus === "invalid_target") findings.push(finding(`invalid_cross_reference:${ref.sourceBlockId}:${ref.targetLabel}`, "invalid_cross_reference", "warning", "Invalid cross-reference", `${ref.targetLabel} points to an invalid target.`, ref.reasonCodes));
  }
  for (const effect of args.amendmentEffects ?? []) {
    const critical = effect.targetCanonicalFieldKey && approvalCritical.has(effect.targetCanonicalFieldKey);
    if (effect.resolutionStatus === "unresolved") findings.push(finding(`amendment_target_unresolved:${effect.id}`, "amendment_target_unresolved", critical ? "blocking" : "warning", "Unresolved amendment target", "An amendment effect was detected but the affected field, clause, or definition could not be resolved.", effect.reasonCodes.length ? effect.reasonCodes : ["amendment_target_unresolved"], { canonicalFieldKey: effect.targetCanonicalFieldKey, affectedFieldKeys: effect.targetCanonicalFieldKey ? [effect.targetCanonicalFieldKey] : [], sourceDocumentIds: [effect.sourceUploadedFileId], reviewerActionRequired: true }));
  }
  for (const [fieldKey, lineage] of Object.entries(args.lineageByField ?? {})) {
    const status = (lineage as any)?.amendmentPrecedence?.resolutionStatus;
    if (status === "conflicting") findings.push(finding(`amendment_precedence_conflict:${fieldKey}`, "amendment_precedence_conflict", approvalCritical.has(fieldKey) ? "blocking" : "material", "Amendment precedence conflict", `${fieldKey} has conflicting amendment effects.`, ["amendment_precedence_conflict"], { canonicalFieldKey: fieldKey, affectedFieldKeys: [fieldKey], reviewerActionRequired: true }));
    if (status === "incomplete") findings.push(finding(`family_projection_incomplete:${fieldKey}`, "family_projection_incomplete", approvalCritical.has(fieldKey) ? "blocking" : "warning", "Family projection incomplete", `${fieldKey} has incomplete amendment/family semantics.`, (lineage as any)?.amendmentPrecedence?.reasonCodes ?? ["family_projection_incomplete"], { canonicalFieldKey: fieldKey, affectedFieldKeys: [fieldKey] }));
    if ((lineage as any)?.supersededValues?.length > 0) findings.push(finding(`superseded_value:${fieldKey}`, "superseded_value", "informational", "Superseded value", `${fieldKey} has a superseded document-local value.`, ["superseded_by_amendment"], { canonicalFieldKey: fieldKey, affectedFieldKeys: [fieldKey], reviewerActionRequired: false }));
  }
  return findings.sort((a, b) => a.findingId.localeCompare(b.findingId));
}