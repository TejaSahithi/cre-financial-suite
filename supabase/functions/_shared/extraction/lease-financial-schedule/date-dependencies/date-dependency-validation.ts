// @ts-nocheck
import {
  DATE_DEPENDENCY_STATUSES,
  DATE_DEPENDENCY_TYPES,
  DATE_DEPENDENCY_VALIDATION_ERROR_CODES,
  LEASE_DATE_DEPENDENCY_CONTRACT_VERSION,
  type DateDependencyInput,
  type DateDependencyValidationContext,
} from "./date-dependency-types.ts";

const TYPE_SET = new Set(DATE_DEPENDENCY_TYPES);
const STATUS_SET = new Set(DATE_DEPENDENCY_STATUSES);
const ORDERED_TYPES = new Set(["minimum_operand", "maximum_operand", "earlier_of_operand", "later_of_operand", "alternative"]);
const TERMINAL_OR_INACTIVE_EXPRESSION_STATUSES = new Set(["not_present", "not_applicable", "unreadable", "extraction_failed"]);

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function sameNullable(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

function expressionMap(context: DateDependencyValidationContext) {
  return new Map(context.expressions.map((expression) => [expression.id, expression]));
}

function expressionMatchesContext(expression: unknown, context: DateDependencyValidationContext): boolean {
  if (!expression) return false;
  return expression.orgId === context.orgId &&
    expression.uploadedFileId === context.uploadedFileId &&
    expression.extractionRunId === context.extractionRunId &&
    expression.generationId === context.generationId &&
    sameNullable(expression.packageId, context.packageId) &&
    sameNullable(expression.leaseId, context.leaseId);
}

function dependencyEdges(dependencies: DateDependencyInput[]): Array<[string, string]> {
  return dependencies
    .filter((dependency) => hasValue(dependency.sourceExpressionId) && hasValue(dependency.targetExpressionId))
    .filter((dependency) => !["invalid", "superseded"].includes(String(dependency.dependencyStatus)))
    .map((dependency) => [String(dependency.sourceExpressionId), String(dependency.targetExpressionId)]);
}

export function wouldCreateDateDependencyCycle(candidate: DateDependencyInput, dependencies: DateDependencyInput[] = []): boolean {
  if (!hasValue(candidate.targetExpressionId)) return false;
  const source = String(candidate.sourceExpressionId);
  const target = String(candidate.targetExpressionId);
  if (source === target) return true;

  const adjacency = new Map<string, string[]>();
  for (const [from, to] of dependencyEdges([...dependencies, candidate])) {
    adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
  }

  const stack = [target];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === source) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

export function validateDateDependency(
  input: DateDependencyInput,
  context: DateDependencyValidationContext,
): { valid: boolean; status: "valid" | "invalid" | "needs_review"; errorCodes: string[] } {
  const errors: string[] = [];
  const expressionsById = expressionMap(context);
  const source = expressionsById.get(input.sourceExpressionId);
  const target = input.targetExpressionId ? expressionsById.get(input.targetExpressionId) : null;
  const dependencyType = String(input.dependencyType ?? "");
  const dependencyStatus = String(input.dependencyStatus ?? "");

  if (input.dependencyContractVersion && input.dependencyContractVersion !== LEASE_DATE_DEPENDENCY_CONTRACT_VERSION) {
    errors.push(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_CONTRACT_VERSION_MISMATCH);
  }
  if (!TYPE_SET.has(dependencyType)) {
    errors.push(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_TYPE_INVALID);
  }
  if (!STATUS_SET.has(dependencyStatus)) {
    errors.push(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_STATUS_INVALID);
  }
  if (!source) {
    errors.push(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_SOURCE_EXPRESSION_MISSING);
  } else if (!expressionMatchesContext(source, context)) {
    errors.push(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_CONTEXT_MISMATCH);
  }

  if (context.activeGenerationId && context.activeGenerationId !== context.generationId) {
    errors.push(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_GENERATION_STALE);
  }
  if (input.sourceExpressionId === input.targetExpressionId) {
    errors.push(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_SELF_REFERENCE);
  }

  if (!hasValue(input.targetExpressionId)) {
    if (dependencyStatus === "requires_related_document") {
      if (!hasValue(input.relatedDocumentRequirementId)) {
        errors.push(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_RELATED_DOCUMENT_REQUIRED);
      }
    } else {
      errors.push(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_TARGET_REQUIRED);
    }
  } else if (!target) {
    errors.push(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_TARGET_EXPRESSION_MISSING);
  } else {
    if (!expressionMatchesContext(target, context)) {
      errors.push(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_CONTEXT_MISMATCH);
    }
    if (TERMINAL_OR_INACTIVE_EXPRESSION_STATUSES.has(String(target.expressionStatus))) {
      errors.push(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_STALE_TARGET);
    }
  }

  if (ORDERED_TYPES.has(dependencyType)) {
    const order = Number(input.operandOrder);
    if (!Number.isInteger(order) || order < 1) {
      errors.push(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_OPERAND_ORDER_REQUIRED);
    }
  }

  if (wouldCreateDateDependencyCycle(input, context.existingDependencies ?? [])) {
    errors.push(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_CYCLE);
  }

  const unique = [...new Set(errors)];
  return {
    valid: unique.length === 0,
    status: unique.length === 0 ? "valid" : "invalid",
    errorCodes: unique,
  };
}
