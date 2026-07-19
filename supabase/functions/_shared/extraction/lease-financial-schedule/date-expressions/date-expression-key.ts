// @ts-nocheck
import { DATE_EXPRESSION_REGISTRY_VERSION } from "./date-expression-registry-version.ts";
import { stableStringify } from "./date-expression-normalization.ts";
import type { DateExpressionCandidateInput } from "./date-expression-types.ts";

function stablePart(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(stablePart).sort().join(",");
  if (typeof value === "object") return stableStringify(value);
  return String(value);
}

export async function buildDateExpressionKey(input: DateExpressionCandidateInput): Promise<string> {
  const parts = [
    DATE_EXPRESSION_REGISTRY_VERSION,
    input.orgId,
    input.packageId ?? input.leaseId ?? "no-lease-or-package",
    input.uploadedFileId,
    input.generationId,
    input.conceptKey,
    input.scopeKey ?? "lease",
    input.instanceKey ?? "default",
    input.expressionType,
    stablePart(input.sourceClaimIds ?? (input.sourceClaimId ? [input.sourceClaimId] : [])),
    stablePart({
      explicitDate: input.explicitDate ?? null,
      eventKey: input.eventKey ?? null,
      anchorConceptKey: input.anchorConceptKey ?? null,
      anchorExpressionId: input.anchorExpressionId ?? null,
      offsetValue: input.offsetValue ?? null,
      offsetUnit: input.offsetUnit ?? null,
      offsetDirection: input.offsetDirection ?? null,
      businessDayRule: input.businessDayRule ?? null,
      operands: input.operands ?? null,
      recurrenceDefinition: input.recurrenceDefinition ?? null,
      conditionDefinition: input.conditionDefinition ?? null,
      normalizedExpression: input.normalizedExpression ?? null,
    }),
  ];
  const bytes = new TextEncoder().encode(parts.join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
