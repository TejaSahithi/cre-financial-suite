// @ts-nocheck

import type { AmendmentEffectRecord, CrossReferenceRecord, DefinitionRecord, FieldSearchRequest, FieldSearchResult, SemanticFinding } from "./types.ts";

function norm(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreRecord(query: string, key: string, label: string, text: string): number {
  const q = norm(query);
  const keyNorm = norm(key);
  const labelNorm = norm(label);
  const textNorm = norm(text);
  if (!q) return 0;
  if (keyNorm === q) return 100;
  if (labelNorm === q) return 90;
  if (keyNorm.includes(q)) return 82;
  if (labelNorm.includes(q)) return 75;
  if (textNorm.includes(q)) return 55;
  const tokens = q.split(/\s+/).filter(Boolean);
  const matched = tokens.filter((token) => textNorm.includes(token) || labelNorm.includes(token) || keyNorm.includes(token)).length;
  return matched ? 25 + matched * 8 : 0;
}

export function buildSemanticSearchRecords(args: { uploadedFileId: string; documentFamilyId?: string | null; runId?: string | null; generationId?: string | null; fields?: Record<string, any>; definitions?: DefinitionRecord[]; references?: CrossReferenceRecord[]; findings?: SemanticFinding[]; amendmentEffects?: AmendmentEffectRecord[]; evidence?: any[] }): FieldSearchResult[] {
  const common = { uploadedFileId: args.uploadedFileId, documentFamilyId: args.documentFamilyId ?? null, runId: args.runId ?? null, generationId: args.generationId ?? null };
  const records: FieldSearchResult[] = [];
  for (const [key, field] of Object.entries(args.fields ?? {})) records.push({ entityType: "field", key, label: field.label ?? field.canonicalFieldKey ?? key, matchedText: field.displayValue ?? (field.value == null ? null : String(field.value)), ...common, fieldKey: key, sectionKey: null, pageNumber: field.evidence?.[0]?.page ?? field.evidence?.[0]?.pageNumber ?? null, status: field.status ?? null, source: field.authoritativeSource ?? field.source ?? null, score: 0, evidenceIds: (field.evidence ?? []).map((e: any) => e.evidenceId ?? e.id).filter(Boolean), reasonCodes: field.review?.reasonCodes ?? field.reasonCodes ?? [] });
  for (const definition of args.definitions ?? []) records.push({ entityType: "definition", key: definition.termNormalized, label: definition.termDisplay, matchedText: definition.definitionText, ...common, fieldKey: null, sectionKey: definition.scopeKey, pageNumber: definition.sourcePageNumbers?.[0] ?? null, status: definition.definitionStatus, source: "definition", score: 0, evidenceIds: definition.evidenceIds, reasonCodes: definition.definitionStatus === "conflicting" ? ["conflicting_definition_text"] : [] });
  for (const ref of args.references ?? []) records.push({ entityType: "section", key: ref.targetSectionKey ?? ref.targetLabel, label: ref.targetLabel, matchedText: ref.sourceText, ...common, fieldKey: null, sectionKey: ref.targetSectionKey, pageNumber: null, status: ref.resolutionStatus, source: ref.referenceType, score: 0, evidenceIds: [], reasonCodes: ref.reasonCodes });
  for (const finding of args.findings ?? []) records.push({ entityType: "finding", key: finding.findingId, label: finding.title, matchedText: finding.summary, ...common, fieldKey: finding.canonicalFieldKey, sectionKey: null, pageNumber: null, status: finding.resolutionStatus, source: finding.type, score: 0, evidenceIds: finding.evidenceIds, reasonCodes: finding.reasonCodes });
  for (const effect of args.amendmentEffects ?? []) records.push({ entityType: "amendment_effect", key: effect.id ?? `${effect.sourceUploadedFileId}:${effect.targetCanonicalFieldKey ?? "unknown"}`, label: `${effect.effectType} ${effect.targetCanonicalFieldKey ?? effect.targetClauseKey ?? effect.targetDefinitionTerm ?? "target"}`, matchedText: effect.replacementValue == null ? null : String(effect.replacementValue), ...common, fieldKey: effect.targetCanonicalFieldKey, sectionKey: effect.targetClauseKey, pageNumber: null, status: effect.resolutionStatus, source: effect.effectType, score: 0, evidenceIds: effect.sourceEvidenceIds, reasonCodes: effect.reasonCodes });
  for (const evidence of args.evidence ?? []) records.push({ entityType: "evidence", key: String(evidence.id ?? evidence.evidenceId ?? evidence.claim_id ?? "evidence"), label: "Evidence", matchedText: evidence.source_text ?? evidence.sourceText ?? null, ...common, fieldKey: evidence.field_key ?? evidence.canonical_field_key ?? null, sectionKey: null, pageNumber: evidence.page ?? evidence.page_number ?? null, status: evidence.status ?? null, source: evidence.claim_type ?? "evidence", score: 0, evidenceIds: [evidence.id ?? evidence.evidenceId].filter(Boolean), reasonCodes: [] });
  return records;
}

export function searchSemanticRecords(request: FieldSearchRequest, records: FieldSearchResult[]): FieldSearchResult[] {
  const entityTypes = new Set(request.entityTypes ?? []);
  const statuses = new Set(request.statuses ?? []);
  const limit = Math.min(Math.max(Number(request.limit ?? 20) || 20, 1), 100);
  return records
    .filter((record) => !request.uploadedFileId || record.uploadedFileId === request.uploadedFileId)
    .filter((record) => !request.documentFamilyId || record.documentFamilyId === request.documentFamilyId)
    .filter((record) => entityTypes.size === 0 || entityTypes.has(record.entityType))
    .filter((record) => statuses.size === 0 || statuses.has(String(record.status ?? "")))
    .map((record) => ({ ...record, score: scoreRecord(request.query, record.key, record.label, record.matchedText ?? "") }))
    .filter((record) => record.score > 0)
    .sort((a, b) => b.score - a.score || a.entityType.localeCompare(b.entityType) || a.key.localeCompare(b.key))
    .slice(0, limit);
}
export function buildSemanticFieldSearchResponse(request: FieldSearchRequest, records: FieldSearchResult[]) {
  const results = searchSemanticRecords(request, records);
  return {
    query: request.query,
    uploadedFileId: request.uploadedFileId ?? null,
    documentFamilyId: request.documentFamilyId ?? null,
    resultCount: results.length,
    results,
    diagnostics: {
      sourceRecordCount: records.length,
      schemaVersion: "document-semantic-search-response-v1",
    },
  };
}