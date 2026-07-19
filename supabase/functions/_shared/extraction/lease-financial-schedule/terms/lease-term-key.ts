// @ts-nocheck
import { LEASE_TERM_CANDIDATE_CONTRACT_VERSION, type LeaseTermCandidateInput } from "./lease-term-types.ts";

function stablePart(value: unknown): string {
  if (Array.isArray(value)) return value.map((part) => String(part)).sort().join(",");
  return String(value ?? "");
}

export async function buildLeaseTermKey(input: LeaseTermCandidateInput): Promise<string> {
  const parts = [
    LEASE_TERM_CANDIDATE_CONTRACT_VERSION,
    input.orgId,
    input.packageId ?? input.leaseId ?? "no-lease-or-package",
    input.uploadedFileId,
    input.extractionRunId,
    input.generationId,
    input.termType,
    input.instanceKey ?? "default",
    input.startExpressionId ?? "",
    input.endExpressionId ?? "",
    input.durationValue ?? "",
    input.durationUnit ?? "",
    input.durationInclusiveRule ?? "",
    input.sequenceNumber ?? "",
    input.parentTermId ?? "",
    input.sourcePackageEffectiveClaimId ?? "",
    stablePart(input.sourceClaimIds ?? []),
    input.relatedDocumentRequirementId ?? "",
  ];
  const bytes = new TextEncoder().encode(parts.join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}