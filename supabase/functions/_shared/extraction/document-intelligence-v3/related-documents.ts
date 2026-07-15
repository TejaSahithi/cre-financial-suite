// @ts-nocheck
/**
 * Document Intelligence v3 - Related Document Diagnostics (Phase 11).
 *
 * Pure helpers for turning profile-planner related_documents_needed output
 * into diagnostic requirements. No approval gate, Lease Review business row,
 * or extraction-provider behavior depends on this module.
 */

export const RELATED_DOCUMENT_REQUIREMENT_STATUSES = [
  "missing",
  "candidate_found",
  "linked",
  "waived",
  "not_applicable",
] as const;

export const DOCUMENT_RELATIONSHIP_STATUSES = [
  "inferred",
  "confirmed",
  "rejected",
  "missing_target",
  "needs_review",
] as const;

export const DOCUMENT_RELATIONSHIP_TYPES = [
  "original_lease_for",
  "amends",
  "assigns",
  "assumes",
  "guarantees",
  "references",
  "duplicate_of",
  "supersedes_candidate",
] as const;

function compactText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

export function normalizeRequiredDocumentType(value: unknown): string {
  return compactText(value)?.toLowerCase().replace(/[\s-]+/g, "_") ?? "unknown_related_document";
}

export function relatedDocumentReason(documentType: string, plannerWarnings: string[] = []): string {
  const type = normalizeRequiredDocumentType(documentType);
  const matchingWarning = (Array.isArray(plannerWarnings) ? plannerWarnings : [])
    .find((warning) => String(warning).toLowerCase().includes(type.replace(/_/g, " ")) || String(warning).toLowerCase().includes(type));
  if (matchingWarning) return String(matchingWarning);
  if (type === "original_lease") return "Original lease required for full assignment, CAM, expense recovery, and budget diagnostics.";
  return `${type} required by the document profile plan.`;
}

export function relatedDocumentImportance(documentType: string): "critical" | "high" | "medium" | "low" | "hidden_optional" {
  const type = normalizeRequiredDocumentType(documentType);
  if (type === "original_lease") return "high";
  if (["guaranty", "snda", "estoppel", "amendment"].includes(type)) return "high";
  if (["exhibit", "rider", "work_letter"].includes(type)) return "medium";
  return "medium";
}

export function relationshipTypeForRequiredDocument(documentType: string): string {
  const type = normalizeRequiredDocumentType(documentType);
  if (type === "original_lease") return "original_lease_for";
  if (type === "guaranty") return "guarantees";
  return "references";
}

export function buildRelatedDocumentRequirementInputs(args: {
  relatedDocumentsNeeded?: string[];
  plannerWarnings?: string[];
  requiredFor?: string[];
  candidatesByType?: Record<string, any[]>;
}) {
  const needed = Array.isArray(args.relatedDocumentsNeeded) ? args.relatedDocumentsNeeded : [];
  const plannerWarnings = Array.isArray(args.plannerWarnings) ? args.plannerWarnings : [];
  const requiredFor = Array.isArray(args.requiredFor) ? args.requiredFor : [];
  const candidatesByType = args.candidatesByType && typeof args.candidatesByType === "object" ? args.candidatesByType : {};

  return [...new Set(needed.map(normalizeRequiredDocumentType))]
    .filter((type) => type !== "unknown_related_document")
    .map((type) => {
      const candidates = Array.isArray(candidatesByType[type]) ? candidatesByType[type] : [];
      return {
        required_document_type: type,
        reason: relatedDocumentReason(type, plannerWarnings),
        required_for: requiredFor,
        importance_level: relatedDocumentImportance(type),
        status: candidates.length > 0 ? "candidate_found" : "missing",
        candidate_document_ids: candidates.map((candidate) => candidate.candidate_document_id).filter(Boolean),
        candidates,
      };
    });
}
