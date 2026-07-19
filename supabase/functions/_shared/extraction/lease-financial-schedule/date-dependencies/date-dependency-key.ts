// @ts-nocheck
import { LEASE_DATE_DEPENDENCY_CONTRACT_VERSION, type DateDependencyInput } from "./date-dependency-types.ts";

export async function buildDateDependencyKey(input: DateDependencyInput): Promise<string> {
  const parts = [
    LEASE_DATE_DEPENDENCY_CONTRACT_VERSION,
    input.orgId,
    input.packageId ?? input.leaseId ?? "no-lease-or-package",
    input.uploadedFileId,
    input.extractionRunId,
    input.generationId,
    input.sourceExpressionId,
    input.targetExpressionId ?? "requires-related-document-or-contextual",
    input.dependencyType,
    input.operandRole ?? "",
    input.operandOrder ?? "",
    input.conditionKey ?? "",
    input.sourceClaimId ?? "",
    input.sourcePackageEffectiveClaimId ?? "",
    input.relatedDocumentRequirementId ?? "",
  ];
  const bytes = new TextEncoder().encode(parts.join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}