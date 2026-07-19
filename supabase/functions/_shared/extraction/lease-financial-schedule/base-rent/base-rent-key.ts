// @ts-nocheck
import {
  LEASE_BASE_RENT_AMOUNT_CONTRACT_VERSION,
  LEASE_BASE_RENT_ESCALATION_CONTRACT_VERSION,
  LEASE_BASE_RENT_PERIOD_CONTRACT_VERSION,
  LEASE_BASE_RENT_SCHEDULE_CONTRACT_VERSION,
  type BaseRentAmountInput,
  type BaseRentEscalationInput,
  type BaseRentPeriodInput,
  type BaseRentScheduleInput,
} from "./base-rent-types.ts";

async function sha256Hex(parts: unknown[]): Promise<string> {
  const normalized = parts.map((part) => {
    if (Array.isArray(part)) return [...part].map(String).sort().join(",");
    if (part && typeof part === "object") return JSON.stringify(part, Object.keys(part as Record<string, unknown>).sort());
    return part ?? "";
  });
  const bytes = new TextEncoder().encode(normalized.join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function stableSourceClaims(sourceClaimIds: string[] = []): string[] {
  return [...new Set(sourceClaimIds.filter(Boolean).map(String))].sort();
}

export async function buildBaseRentScheduleKey(input: BaseRentScheduleInput): Promise<string> {
  return sha256Hex([
    LEASE_BASE_RENT_SCHEDULE_CONTRACT_VERSION,
    input.orgId,
    input.packageId ?? input.leaseId ?? "no-lease-or-package",
    input.uploadedFileId,
    input.extractionRunId,
    input.generationId,
    input.sourcePackageDocumentId ?? "",
    input.termCandidateId ?? "",
    input.instanceKey ?? "default",
    stableSourceClaims(input.sourceClaimIds),
  ]);
}

export async function buildBaseRentPeriodKey(input: BaseRentPeriodInput): Promise<string> {
  return sha256Hex([
    LEASE_BASE_RENT_PERIOD_CONTRACT_VERSION,
    input.orgId,
    input.scheduleKey,
    input.sequenceNumber ?? "",
    input.periodType,
    input.startExpressionId ?? "",
    input.endExpressionId ?? "",
    input.startTermMonth ?? "",
    input.endTermMonth ?? "",
    input.termCandidateId ?? "",
    input.sourceClaimId ?? "",
    input.sourcePackageEffectiveClaimId ?? "",
  ]);
}

export async function buildBaseRentAmountKey(input: BaseRentAmountInput): Promise<string> {
  return sha256Hex([
    LEASE_BASE_RENT_AMOUNT_CONTRACT_VERSION,
    input.orgId,
    input.scheduleKey,
    input.periodKey,
    input.amountRole,
    input.amountBasis,
    input.frequency ?? "",
    input.sourceClaimId ?? "",
    input.sourcePackageEffectiveClaimId ?? "",
    input.formulaCandidateId ?? "",
  ]);
}

export async function buildBaseRentEscalationKey(input: BaseRentEscalationInput): Promise<string> {
  return sha256Hex([
    LEASE_BASE_RENT_ESCALATION_CONTRACT_VERSION,
    input.orgId,
    input.scheduleKey,
    input.generationId,
    input.escalationType,
    input.appliesAfterPeriodKey ?? "",
    input.effectiveExpressionId ?? "",
    input.effectiveTermMonth ?? "",
    input.sourceClaimId ?? "",
    input.sourcePackageEffectiveClaimId ?? "",
  ]);
}
