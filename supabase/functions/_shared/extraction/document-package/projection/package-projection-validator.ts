// @ts-nocheck
/**
 * P3.6 package projection validation.
 */

import { CLAIM_CONCEPTS, getClaimConcept } from "../../claims/concept-registry.ts";
import type { PackageProjectionInput } from "./package-projection-types.ts";
import { PACKAGE_PROJECTION_ERROR_CODES } from "./package-projection-types.ts";

const VALUE_SELECTED = new Set(["effective", "inherited", "overridden"]);
const EXPLICIT_STATUS = new Set(["not_present", "not_applicable", "unreadable", "extraction_failed"]);
const singleCardinality = new Set(CLAIM_CONCEPTS.filter((c) => c.cardinality === "single").map((c) => c.conceptKey));

function slotKey(row: { conceptKey: string; scopeKey?: string | null; instanceKey?: string | null }): string {
  return `${row.conceptKey}|${row.scopeKey || "lease"}|${row.instanceKey || "default"}`;
}

function sourceClaimId(claim: { id?: string; claimId?: string }): string {
  return claim.id ?? claim.claimId ?? "";
}

function claimBelongsToDocument(claim: any, document: any): boolean {
  return claim.orgId === document.orgId
    && claim.packageDocumentId === document.id
    && claim.uploadedFileId === document.uploadedFileId
    && claim.extractionRunId === document.extractionRunId
    && claim.generationId === document.generationId;
}

export function validatePackageProjectionInput(input: PackageProjectionInput): void {
  if (!input?.orgId || !input?.packageId || !input?.resolutionRun?.id) {
    throw new Error(PACKAGE_PROJECTION_ERROR_CODES.PACKAGE_PROJECTION_INPUT_INVALID);
  }
  if (input.resolutionRun.status !== "completed") {
    throw new Error(PACKAGE_PROJECTION_ERROR_CODES.PACKAGE_RESOLUTION_NOT_COMPLETED);
  }

  const documentsById = new Map(input.documents.map((document) => [document.id, document]));
  const activeDocumentIds = new Set(
    input.documents
      .filter((document) =>
        document.orgId === input.orgId
        && document.packageId === input.packageId
        && document.membershipStatus === "confirmed"
        && (!document.activeGenerationId || document.activeGenerationId === document.generationId)
      )
      .map((document) => document.id),
  );
  const claimsById = new Map(input.sourceClaims.map((claim) => [sourceClaimId(claim), claim]));
  const seenSlots = new Map<string, string>();

  for (const row of input.effectiveClaims) {
    const key = slotKey(row);
    if (seenSlots.has(key) && singleCardinality.has(row.conceptKey)) {
      throw new Error(PACKAGE_PROJECTION_ERROR_CODES.PACKAGE_EFFECTIVE_CLAIM_DUPLICATE);
    }
    seenSlots.set(key, row.status);

    if (row.status === "requires_related_document" && !row.relatedDocumentRequirementId) {
      throw new Error(PACKAGE_PROJECTION_ERROR_CODES.PACKAGE_RELATED_DOCUMENT_LINK_MISSING);
    }
    if (row.status === "needs_review" && !row.conflict) {
      throw new Error(PACKAGE_PROJECTION_ERROR_CODES.PACKAGE_CONFLICT_STATUS_MISMATCH);
    }
    if (row.conflict && row.status !== "needs_review") {
      throw new Error(PACKAGE_PROJECTION_ERROR_CODES.PACKAGE_CONFLICT_STATUS_MISMATCH);
    }

    if (!VALUE_SELECTED.has(row.status) && !EXPLICIT_STATUS.has(row.status)) continue;
    if (!row.selectedClaimId) {
      throw new Error(PACKAGE_PROJECTION_ERROR_CODES.PACKAGE_EFFECTIVE_CLAIM_MISSING);
    }
    const selected = claimsById.get(row.selectedClaimId);
    if (!selected) {
      throw new Error(PACKAGE_PROJECTION_ERROR_CODES.PACKAGE_EFFECTIVE_CLAIM_MISSING);
    }
    const document = documentsById.get(selected.packageDocumentId);
    if (!document) {
      throw new Error(PACKAGE_PROJECTION_ERROR_CODES.PACKAGE_SELECTED_CLAIM_OUTSIDE_PACKAGE);
    }
    if (document.activeGenerationId && selected.generationId !== document.activeGenerationId) {
      throw new Error(PACKAGE_PROJECTION_ERROR_CODES.PACKAGE_SELECTED_CLAIM_STALE);
    }
    if (!activeDocumentIds.has(document.id) || !claimBelongsToDocument(selected, document)) {
      throw new Error(PACKAGE_PROJECTION_ERROR_CODES.PACKAGE_SELECTED_CLAIM_OUTSIDE_PACKAGE);
    }
    if (!getClaimConcept(selected.conceptKey) && !selected.conceptKey.startsWith("dynamic.")) {
      throw new Error(PACKAGE_PROJECTION_ERROR_CODES.PACKAGE_PROJECTION_INPUT_INVALID);
    }
  }
}
