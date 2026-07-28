// @ts-nocheck
/**
 * Canonical Claim/Evidence Layer (Phase 2) — converters.
 *
 * Pure, additive projections between the existing pipeline shapes and
 * ExtractedClaim. None of these mutate their input or change what the
 * authoritative pipeline produces -- they only build a parallel,
 * inspectable representation (LEASE_CANONICAL_CLAIMS_V1, default off).
 */

import { createDocumentItem } from "../lease-workflow.ts";
import { resolveCanonicalKey } from "../field-contract.ts";
import { domainForField } from "../enrich-bounded-stage/domain-fields.ts";
import type { ExtractedField, ExtractedRecord } from "../types.ts";
import type { FieldAssignment } from "../openai-fact-ledger/adaptive-extractor.ts";
import type { FieldVerificationResult } from "../openai-fact-ledger/llm-field-validator.ts";
import type { StrictExtractedField } from "../schemas/schema-registry.ts";
import type { ExtractedClaim } from "./extracted-claim.ts";
import type { EvidenceReference } from "./evidence-reference.ts";
import type { ClaimStatus } from "./claim-status.ts";
// Phase 6A: moved to claim-identity-context.ts (a neutral file canonical
// types can depend on without depending on converter implementations).
// Re-exported below (not just imported) so every existing import of
// ClaimIdentityContext from THIS file keeps working unchanged.
import type { ClaimIdentityContext } from "./claim-identity-context.ts";
export type { ClaimIdentityContext };

function newClaimId(): string {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `claim_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function baseClaim(args: {
  fieldCode: string;
  domain: string;
  context: ClaimIdentityContext;
  sourceModel: string | null;
  promptVersion: string | null;
  schemaVersion: string | null;
}): Omit<ExtractedClaim, "status" | "verificationStatus" | "rawValue" | "normalizedValue" | "evidence" | "requiresReview" | "reviewReasons"> {
  return {
    claimId: newClaimId(),
    organizationId: args.context.organizationId,
    fileId: args.context.fileId,
    generationId: args.context.generationId,
    extractionRunId: args.context.extractionRunId,
    domain: args.domain,
    fieldCode: args.fieldCode,
    canonicalFieldCode: resolveCanonicalKey(args.fieldCode),
    controllingDocumentId: null,
    sourceModel: args.sourceModel,
    promptVersion: args.promptVersion,
    schemaVersion: args.schemaVersion,
    createdAt: new Date().toISOString(),
  };
}

function directEvidence(fileId: string, quote: string | null, page: number | null): EvidenceReference[] {
  if (!quote) return [];
  return [{ documentId: fileId, pageNumber: page, nodeId: null, quote, polygon: null, ocrConfidence: null, role: "direct" }];
}

// ── mapperResultToClaims ─────────────────────────────────────────────────────
// Reads adaptive-extractor.ts's own per-field FieldAssignment map (the
// schema-aware mapper's proposal for one domain call) -- assignments never
// include a "not_stated" entry at all (parseFieldAssignmentResponse's own
// contract: no key = not stated), so every claim here is status="explicit".
// FieldAssignment has no separate raw-vs-normalized distinction -- rawValue
// is the value's own string form; this is an honest limitation of the
// source shape, not a design choice of this converter.

export function mapperResultToClaims(args: {
  domain: string;
  assignments: Record<string, FieldAssignment>;
  context: ClaimIdentityContext;
  promptVersion?: string | null;
  sourceModel?: string | null;
}): ExtractedClaim[] {
  return Object.entries(args.assignments).map(([fieldCode, assignment]) => ({
    ...baseClaim({
      fieldCode,
      domain: args.domain,
      context: args.context,
      sourceModel: args.sourceModel ?? null,
      promptVersion: args.promptVersion ?? null,
      schemaVersion: null,
    }),
    status: "explicit" as ClaimStatus,
    verificationStatus: "unverified",
    rawValue: assignment.value != null ? String(assignment.value) : null,
    normalizedValue: assignment.value,
    evidence: directEvidence(args.context.fileId, assignment.sourceText, assignment.sourcePage),
    requiresReview: false,
    reviewReasons: [],
  }));
}

// ── strictResultToClaims ─────────────────────────────────────────────────────
// StrictExtractedField's own envelope (schemas/schema-registry.ts) already
// carries the claim-shaped status/value/rawValue/sourceQuote/uncertaintyReason
// -- this converter is close to an identity mapping, which is by design
// (the strict pilot's schema was itself modeled on this exact contract).

export function strictResultToClaims(args: {
  domain: string;
  strictFields: Record<string, StrictExtractedField>;
  context: ClaimIdentityContext;
  promptVersion?: string | null;
  schemaVersion?: string | null;
  sourceModel?: string | null;
}): ExtractedClaim[] {
  return Object.entries(args.strictFields).map(([fieldCode, field]) => ({
    ...baseClaim({
      fieldCode,
      domain: args.domain,
      context: args.context,
      sourceModel: args.sourceModel ?? null,
      promptVersion: args.promptVersion ?? null,
      schemaVersion: args.schemaVersion ?? null,
    }),
    status: field.status as ClaimStatus,
    verificationStatus: "unverified",
    rawValue: field.rawValue ?? null,
    normalizedValue: field.value ?? null,
    evidence: directEvidence(args.context.fileId, field.sourceQuote, null),
    requiresReview: field.status === "ambiguous" || field.status === "conflicting" || field.status === "illegible",
    reviewReasons: field.uncertaintyReason ? [field.uncertaintyReason] : [],
  }));
}

// ── verifierResultToClaims ───────────────────────────────────────────────────
// Updates verificationStatus on EXISTING claims by fieldCode -- this is an
// update pass, not a claim-creation pass (llm-field-validator.ts's
// self-consistency verifier reviews claims that already exist, it never
// invents a new one). A claim the results array doesn't mention is returned
// unchanged. "rejected" deliberately does NOT clear normalizedValue here --
// the canonical layer preserves full history; claimsToLegacyFields is what
// decides whether a rejected claim's value should surface in the legacy
// shape (mirroring applyValidationCorrections' real delete-the-field
// behavior for the "null" decision).

export function verifierResultToClaims(
  claims: ExtractedClaim[],
  results: FieldVerificationResult[],
): ExtractedClaim[] {
  const byField = new Map(results.map((r) => [r.field, r]));
  return claims.map((claim) => {
    const result = byField.get(claim.fieldCode);
    if (!result) return claim;

    if (result.decision === "confirm") {
      return { ...claim, verificationStatus: "verified" };
    }
    if (result.decision === "null") {
      return {
        ...claim,
        verificationStatus: "rejected",
        requiresReview: true,
        reviewReasons: claim.reviewReasons.includes(result.reason) ? claim.reviewReasons : [...claim.reviewReasons, result.reason],
      };
    }
    // "uncertain" -- fail closed, matches applyValidationCorrections: keep
    // the value, flag it, never silently confirm.
    return {
      ...claim,
      verificationStatus: "needs_review",
      requiresReview: true,
      reviewReasons: claim.reviewReasons.includes(result.reason) ? claim.reviewReasons : [...claim.reviewReasons, result.reason],
    };
  });
}

// ── legacyFieldsToClaims / claimsToLegacyFields ──────────────────────────────
// Round-trip against ExtractedField (types.ts) so existing UI payload code
// (flattenRecords, buildReviewPayload, etc.) needs zero changes while this
// phase stays additive-only.

const EXTRACTION_STATUS_TO_CLAIM_STATUS: Record<string, ClaimStatus> = {
  extracted: "explicit",
  not_found: "not_found",
  not_stated: "not_found",
  conflict: "conflicting",
  conflict_detected: "conflicting",
  needs_review: "ambiguous",
  invalid: "illegible",
  insufficient_evidence: "ambiguous",
  manual_review: "ambiguous",
};

const CLAIM_STATUS_TO_EXTRACTION_STATUS: Partial<Record<ClaimStatus, ExtractedField["extractionStatus"]>> = {
  explicit: "extracted",
  derived: "extracted",
  conditional: "extracted",
  not_found: "not_stated",
  ambiguous: "needs_review",
  conflicting: "conflict_detected",
  illegible: "invalid",
};

export function legacyFieldsToClaims(args: {
  fields: Record<string, ExtractedField>;
  context: ClaimIdentityContext;
}): ExtractedClaim[] {
  return Object.entries(args.fields).map(([fieldCode, field]) => {
    const claimStatus = EXTRACTION_STATUS_TO_CLAIM_STATUS[String(field.extractionStatus ?? "")] ?? (field.value != null ? "explicit" : "not_found");
    return {
      ...baseClaim({
        fieldCode,
        // Resolved per-field (not passed in) -- fields merged from multiple
        // domain calls don't share one domain label. "unknown" for a field
        // with no FIELD_GROUP_TO_LLM_CALL_DOMAIN entry (e.g. derived/
        // budget_inputs fields) rather than a fabricated guess.
        domain: domainForField(fieldCode) ?? "unknown",
        context: args.context,
        sourceModel: field.source === "llm" ? "llm" : field.source ?? null,
        promptVersion: null,
        schemaVersion: null,
      }),
      status: claimStatus,
      verificationStatus: (field as any).llmPrimaryMapped ? "unverified" : "unverified",
      rawValue: field.value != null ? String(field.value) : null,
      normalizedValue: field.value ?? null,
      evidence: directEvidence(args.context.fileId, field.sourceText ?? null, field.sourcePage ?? null),
      requiresReview: !!field.requiresReview,
      reviewReasons: (field as any).semanticVetoReason ? [(field as any).semanticVetoReason] : [],
    };
  });
}

export function claimsToLegacyFields(claims: ExtractedClaim[]): Record<string, ExtractedField> {
  const out: Record<string, ExtractedField> = {};
  for (const claim of claims) {
    // A "rejected" claim (explicit verifier "null" decision) does not
    // surface at all in the legacy shape -- matches
    // applyValidationCorrections' delete(fields[field]) behavior exactly.
    if (claim.verificationStatus === "rejected") continue;
    out[claim.fieldCode] = {
      value: claim.normalizedValue,
      source: claim.sourceModel === "llm" || claim.sourceModel == null ? "llm" : (claim.sourceModel as any),
      confidence: claim.verificationStatus === "verified" ? 0.95 : 0.7,
      sourceText: claim.evidence[0]?.quote ?? undefined,
      sourcePage: claim.evidence[0]?.pageNumber ?? undefined,
      extractionStatus: CLAIM_STATUS_TO_EXTRACTION_STATUS[claim.status] ?? "extracted",
      requiresReview: claim.requiresReview,
    };
  }
  return out;
}

// ── claimsToDynamicRows ──────────────────────────────────────────────────────
// Calls createDocumentItem() (lease-workflow.ts) directly -- the exact same
// function dynamic-fact-surfacer.ts already uses -- so dynamicFields.js's
// existing frontend collection logic picks these up unchanged. Only claims
// with no real schema field (canonicalFieldCode resolves to something the
// caller's own knownFieldKeys set doesn't recognize) become rows; a claim
// backing an existing schema field is not duplicated as a dynamic row.

export function claimsToDynamicRows(args: {
  claims: ExtractedClaim[];
  knownFieldKeys: Set<string>;
  documentProfile: string;
}): any[] {
  const rows: any[] = [];
  for (const claim of args.claims) {
    if (args.knownFieldKeys.has(claim.canonicalFieldCode)) continue;
    if (claim.normalizedValue == null) continue;

    const item = createDocumentItem({
      item_id: `canonical_claim:${claim.claimId}`,
      document_profile: args.documentProfile,
      item_type: claim.domain,
      business_area: claim.domain,
      label: claim.fieldCode,
      value: claim.normalizedValue,
      normalized_value: claim.normalizedValue,
      raw_value: claim.rawValue,
      source_text: claim.evidence[0]?.quote ?? null,
      source_page: claim.evidence[0]?.pageNumber ?? null,
      confidence: claim.verificationStatus === "verified" ? 0.95 : 0.7,
      extraction_method: "canonical_claim",
      extraction_status: claim.requiresReview ? "needs_review" : "extracted",
      maps_to_existing_field: false,
      maps_to_fixed_field: false,
      creates_dynamic_row: true,
    });

    rows.push({
      ...item,
      requires_review: claim.requiresReview,
      review_reason: claim.reviewReasons[0] ?? null,
    });
  }
  return rows;
}
