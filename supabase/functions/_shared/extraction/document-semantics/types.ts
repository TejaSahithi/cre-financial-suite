// @ts-nocheck

export const DOCUMENT_SEMANTICS_SCHEMA_VERSION = "document-semantics-v1";
export const DOCUMENT_SEMANTICS_ALGORITHM_VERSION = "document-semantics-release6-v1";

export type DefinitionStatus = "resolved" | "ambiguous" | "conflicting" | "unresolved" | "superseded";
export type DefinitionScopeType = "document_global" | "article" | "section" | "exhibit" | "schedule" | "amendment_only" | "document_family";
export type CrossReferenceType = "section" | "article" | "exhibit" | "schedule" | "defined_term" | "amendment" | "document" | "date_clause" | "rent_clause" | "option_clause" | "other";
export type CrossReferenceStatus = "resolved" | "ambiguous" | "unresolved" | "invalid_target" | "cross_document" | "superseded_target";
export type DocumentRole = "base_lease" | "amendment" | "addendum" | "commencement_certificate" | "estoppel" | "assignment" | "guaranty" | "exhibit" | "schedule" | "unknown";
export type AmendmentEffectType = "replace" | "supplement" | "delete" | "waive" | "extend" | "shorten" | "clarify" | "rename" | "restate" | "override" | "no_change" | "unknown";
export type AmendmentResolutionStatus = "resolved" | "ambiguous" | "unresolved" | "conflicting" | "superseded" | "not_applicable";

export interface SemanticBlockLike {
  blockId: string;
  text: string;
  pageNumber?: number | null;
  sectionKey?: string | null;
  heading?: string | null;
  documentId?: string | null;
}

export interface NormalizedDefinedTerm {
  display: string;
  normalized: string;
}

export interface DefinitionRecord {
  id: string | null;
  termNormalized: string;
  termDisplay: string;
  definitionText: string;
  scopeType: DefinitionScopeType;
  scopeKey: string | null;
  sourceBlockIds: string[];
  sourcePageNumbers: number[];
  evidenceIds: string[];
  definitionStatus: DefinitionStatus;
  confidence: number | null;
  schemaVersion: string;
  algorithmVersion: string;
}

export interface DefinitionResolution {
  term: string;
  definitionId: string | null;
  status: "resolved" | "ambiguous" | "unresolved" | "not_applicable";
  scope: string | null;
  sourceDocumentId: string | null;
  reasonCodes: string[];
}

export interface CrossReferenceRecord {
  id: string | null;
  sourceBlockId: string;
  sourceText: string;
  referenceType: CrossReferenceType;
  targetLabel: string;
  targetDocumentId: string | null;
  targetBlockId: string | null;
  targetSectionKey: string | null;
  targetDefinitionId: string | null;
  resolutionStatus: CrossReferenceStatus;
  confidence: number | null;
  reasonCodes: string[];
  schemaVersion: string;
  algorithmVersion: string;
}

export interface GraphEdge {
  fromType: string;
  fromKey: string;
  toType: string;
  toKey: string;
  edgeType: "defines" | "references" | "amends" | "replaces" | "supplements" | "clarifies" | "depends_on" | "evidences" | "projects_to";
  confidence: number | null;
  reasonCodes: string[];
}

export interface DocumentFamilyClassification {
  documentRole: DocumentRole;
  referencedBaseLeaseDate: string | null;
  effectiveDate: string | null;
  executionDate: string | null;
  sequenceNumber: number | null;
  candidateFamilyIds: string[];
  confidence: number | null;
  reasonCodes: string[];
}

export interface DocumentFamilyMemberSummary {
  uploadedFileId: string;
  role: DocumentRole;
  effectiveDate: string | null;
  executionDate: string | null;
  sequenceNumber: number | null;
  status: "active" | "ambiguous" | "inactive";
  reasonCodes: string[];
}

export interface AmendmentEffectRecord {
  id: string | null;
  documentFamilyId: string | null;
  sourceUploadedFileId: string;
  sourceRunId: string;
  sourceGenerationId: string;
  targetUploadedFileId: string | null;
  targetCanonicalFieldKey: string | null;
  targetClauseKey: string | null;
  targetDefinitionTerm: string | null;
  effectType: AmendmentEffectType;
  effectiveDate: string | null;
  previousValue: unknown | null;
  replacementValue: unknown | null;
  sourceClaimIds: string[];
  sourceEvidenceIds: string[];
  resolutionStatus: AmendmentResolutionStatus;
  confidence: number | null;
  reasonCodes: string[];
  algorithmVersion: string;
}

export interface AmendmentPrecedenceTrace {
  documentFamilyId: string | null;
  baseProjectionId: string | null;
  amendmentEffectIds: string[];
  selectedSourceDocumentId: string | null;
  supersededProjectionIds: string[];
  effectiveDate: string | null;
  resolutionStatus: "not_applicable" | "resolved" | "ambiguous" | "conflicting" | "incomplete";
  reasonCodes: string[];
}

export interface ReviewFieldLineage {
  documentLocalValue: unknown;
  familyEffectiveValue: unknown;
  reviewerEffectiveValue: unknown;
  selectedLayer: "document_local" | "family_effective" | "reviewer_override" | "legacy_fallback" | "none";
  amendmentPrecedence: AmendmentPrecedenceTrace;
  supersededValues: Array<{ value: unknown; sourceDocumentId: string | null; effectId: string | null; effectiveDate: string | null }>;
  definitionDependencies: DefinitionResolution[];
  crossReferenceDependencies: CrossReferenceRecord[];
}

export interface SemanticCoverageSummary {
  definitionsDetected: number;
  definitionsResolved: number;
  definitionsAmbiguous: number;
  definitionsConflicting: number;
  crossReferencesDetected: number;
  crossReferencesResolved: number;
  crossReferencesUnresolved: number;
  amendmentsDetected: number;
  amendmentEffectsResolved: number;
  amendmentEffectsUnresolved: number;
  familyFieldsEvaluated: number;
  familyFieldsResolved: number;
  familyFieldsConflicting: number;
}

export interface SemanticFinding {
  findingId: string;
  type: string;
  canonicalFieldKey: string | null;
  affectedFieldKeys: string[];
  sourceDocumentIds: string[];
  severity: "informational" | "warning" | "material" | "blocking";
  title: string;
  summary: string;
  reasonCodes: string[];
  evidenceIds: string[];
  resolutionGuidance: string;
  resolutionStatus: "open" | "resolved" | "dismissed";
  reviewerActionRequired: boolean;
}

export interface FieldSearchRequest {
  uploadedFileId?: string | null;
  documentFamilyId?: string | null;
  query: string;
  entityTypes?: string[];
  statuses?: string[];
  domains?: string[];
  limit?: number;
}

export interface FieldSearchResult {
  entityType: string;
  key: string;
  label: string;
  matchedText: string | null;
  uploadedFileId: string;
  documentFamilyId: string | null;
  runId: string | null;
  generationId: string | null;
  fieldKey: string | null;
  sectionKey: string | null;
  pageNumber: number | null;
  status: string | null;
  source: string | null;
  score: number;
  evidenceIds: string[];
  reasonCodes: string[];
}

export function semanticId(prefix: string, parts: unknown[]): string {
  return `${prefix}:${parts.map((part) => String(part ?? "none").trim().toLowerCase()).join(":")}`;
}

export function clampConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}