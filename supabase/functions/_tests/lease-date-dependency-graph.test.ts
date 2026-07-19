// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildDateDependencyKey } from "../_shared/extraction/lease-financial-schedule/date-dependencies/date-dependency-key.ts";
import {
  DATE_DEPENDENCY_STATUSES,
  DATE_DEPENDENCY_TYPES,
  DATE_DEPENDENCY_VALIDATION_ERROR_CODES,
  LEASE_DATE_DEPENDENCY_CONTRACT_VERSION,
} from "../_shared/extraction/lease-financial-schedule/date-dependencies/date-dependency-types.ts";
import {
  validateDateDependency,
  wouldCreateDateDependencyCycle,
} from "../_shared/extraction/lease-financial-schedule/date-dependencies/date-dependency-validation.ts";

const orgId = "org-a";
const leaseId = "lease-a";
const packageId = "package-a";
const uploadedFileId = "file-a";
const extractionRunId = "run-a";
const generationId = "generation-a";

const expressions = [
  { id: "expr-commencement", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, expressionStatus: "extracted" },
  { id: "expr-delivery", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, expressionStatus: "unresolved" },
  { id: "expr-notice", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, expressionStatus: "needs_review" },
  { id: "expr-stale", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, expressionStatus: "not_present" },
  { id: "expr-foreign-package", orgId, leaseId, packageId: "package-b", uploadedFileId, extractionRunId, generationId, expressionStatus: "extracted" },
];

const context = {
  orgId,
  leaseId,
  packageId,
  uploadedFileId,
  extractionRunId,
  generationId,
  activeGenerationId: generationId,
  expressions,
};

function dependency(overrides = {}) {
  return {
    orgId,
    leaseId,
    packageId,
    uploadedFileId,
    extractionRunId,
    generationId,
    sourceExpressionId: "expr-commencement",
    targetExpressionId: "expr-delivery",
    dependencyType: "anchor",
    dependencyStatus: "valid",
    sourcePackageEffectiveClaimId: "effective-claim-a",
    producerType: "deterministic_mapper",
    producerName: "p4.2-test",
    dependencyContractVersion: LEASE_DATE_DEPENDENCY_CONTRACT_VERSION,
    ...overrides,
  };
}

Deno.test("P4.2 dependency graph: vocabulary is canonical, unique and complete", () => {
  assertEquals(new Set(DATE_DEPENDENCY_TYPES).size, 16);
  assertEquals(new Set(DATE_DEPENDENCY_STATUSES).size, 7);
  for (const type of [
    "anchor",
    "offset_anchor",
    "event_anchor",
    "alternative",
    "condition",
    "minimum_operand",
    "maximum_operand",
    "earlier_of_operand",
    "later_of_operand",
    "recurrence_anchor",
    "notice_anchor",
    "term_start",
    "term_end",
    "resolves",
    "supersedes_expression",
    "contextual",
  ]) assert(DATE_DEPENDENCY_TYPES.includes(type));
});

Deno.test("P4.2 dependency key: deterministic identity ignores row order, filename-like metadata and confidence-like annotations", async () => {
  const base = dependency({ metadata: { filename: "lease-a.pdf", upload_order: 1, confidence: 0.91 } });
  const replay = dependency({ metadata: { filename: "renamed.pdf", upload_order: 99, confidence: 0.12 } });
  assertEquals(await buildDateDependencyKey(base), await buildDateDependencyKey(replay));
  assert(await buildDateDependencyKey(base) !== await buildDateDependencyKey(dependency({ targetExpressionId: "expr-notice" })));
  assert(await buildDateDependencyKey(base) !== await buildDateDependencyKey(dependency({ generationId: "generation-b" })));
});

Deno.test("P4.2 dependency validation: valid package-aware edge keeps P2/P3 effective provenance without resolving a date", () => {
  const result = validateDateDependency(dependency(), context);
  assertEquals(result, { valid: true, status: "valid", errorCodes: [] });
});

Deno.test("P4.2 dependency validation: rejects self references, stale targets, context drift and missing ordered operands", () => {
  assert(validateDateDependency(dependency({ targetExpressionId: "expr-commencement" }), context).errorCodes.includes(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_SELF_REFERENCE));
  assert(validateDateDependency(dependency({ targetExpressionId: "expr-stale" }), context).errorCodes.includes(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_STALE_TARGET));
  assert(validateDateDependency(dependency({ targetExpressionId: "expr-foreign-package" }), context).errorCodes.includes(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_CONTEXT_MISMATCH));
  assert(validateDateDependency(dependency({ dependencyType: "earlier_of_operand", operandOrder: null }), context).errorCodes.includes(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_OPERAND_ORDER_REQUIRED));
});

Deno.test("P4.2 dependency validation: requires explicit related-document linkage when target expression is absent", () => {
  const missingRequirement = validateDateDependency(dependency({
    targetExpressionId: null,
    dependencyStatus: "requires_related_document",
  }), context);
  assert(missingRequirement.errorCodes.includes(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_RELATED_DOCUMENT_REQUIRED));

  const withRequirement = validateDateDependency(dependency({
    targetExpressionId: null,
    dependencyStatus: "requires_related_document",
    relatedDocumentRequirementId: "requirement-a",
  }), context);
  assertEquals(withRequirement, { valid: true, status: "valid", errorCodes: [] });
});

Deno.test("P4.2 dependency validation: detects graph cycles and leaves acyclic alternatives valid", () => {
  const existing = [
    dependency({ sourceExpressionId: "expr-commencement", targetExpressionId: "expr-delivery" }),
    dependency({ sourceExpressionId: "expr-delivery", targetExpressionId: "expr-notice" }),
  ];
  assert(wouldCreateDateDependencyCycle(dependency({ sourceExpressionId: "expr-notice", targetExpressionId: "expr-commencement" }), existing));
  const cycle = validateDateDependency(dependency({
    sourceExpressionId: "expr-notice",
    targetExpressionId: "expr-commencement",
  }), { ...context, existingDependencies: existing });
  assert(cycle.errorCodes.includes(DATE_DEPENDENCY_VALIDATION_ERROR_CODES.DATE_DEPENDENCY_CYCLE));

  const acyclic = validateDateDependency(dependency({
    dependencyType: "alternative",
    sourceExpressionId: "expr-commencement",
    targetExpressionId: "expr-notice",
    operandOrder: 1,
  }), { ...context, existingDependencies: existing });
  assertEquals(acyclic.valid, true);
});
