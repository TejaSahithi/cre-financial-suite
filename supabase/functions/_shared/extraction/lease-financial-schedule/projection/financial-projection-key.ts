// @ts-nocheck
import { createHash } from "node:crypto";
import { LEASE_FINANCIAL_PROJECTION_VERSION } from "./financial-projection-version.ts";

export function stableProjectionStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableProjectionStringify).sort().join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableProjectionStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildFinancialProjectionInputHash(input: unknown): string {
  return createHash("sha256").update(stableProjectionStringify(input)).digest("hex");
}

export function buildFinancialProjectionRunIdentity(input: { orgId: string; calculationRunId: string; generationId: string; inputHash: string; version?: string }) {
  return buildFinancialProjectionInputHash({
    version: input.version ?? LEASE_FINANCIAL_PROJECTION_VERSION,
    orgId: input.orgId,
    calculationRunId: input.calculationRunId,
    generationId: input.generationId,
    inputHash: input.inputHash,
  });
}

export function buildProjectedScheduleKey(input: { scheduleType: string; sourceId?: string | null; sequenceNumber?: number | null; amountRole?: string | null; startDate?: string | null; endDate?: string | null }) {
  return buildFinancialProjectionInputHash({ version: LEASE_FINANCIAL_PROJECTION_VERSION, ...input });
}
