// @ts-nocheck
// P4.1 -- immutable date-expression candidate validation tests.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildDateExpressionKey } from "../_shared/extraction/lease-financial-schedule/date-expressions/date-expression-key.ts";
import { DATE_EXPRESSION_REGISTRY_VERSION } from "../_shared/extraction/lease-financial-schedule/date-expressions/date-expression-registry-version.ts";
import {
  DATE_EXPRESSION_VALIDATION_ERROR_CODES,
  validateDateExpressionCandidate,
} from "../_shared/extraction/lease-financial-schedule/date-expressions/date-expression-validation.ts";

const HASH = "4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8";
const ORG = "00000000-0000-4000-8000-000000000001";
const FILE = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-000000000003";
const GEN = "00000000-0000-4000-8000-000000000004";
const CLAIM = "00000000-0000-4000-8000-000000000005";
const PACKAGE = "00000000-0000-4000-8000-000000000006";

function base(overrides = {}) {
  return {
    orgId: ORG,
    uploadedFileId: FILE,
    extractionRunId: RUN,
    generationId: GEN,
    sourceClaimId: CLAIM,
    conceptKey: "lease_start_date",
    expressionType: "fixed_date",
    expressionStatus: "extracted",
    originType: "extracted",
    explicitDate: "2026-01-01",
    producerType: "semantic_extractor",
    providerInvocationId: "00000000-0000-4000-8000-000000000007",
    registryVersion: DATE_EXPRESSION_REGISTRY_VERSION,
    registryHash: HASH,
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    orgId: ORG,
    uploadedFileId: FILE,
    extractionRunId: RUN,
    generationId: GEN,
    activeGenerationId: GEN,
    expectedRegistryVersion: DATE_EXPRESSION_REGISTRY_VERSION,
    expectedRegistryHash: HASH,
    sourceClaims: [{ id: CLAIM, orgId: ORG, uploadedFileId: FILE, extractionRunId: RUN, generationId: GEN, activeGenerationId: GEN }],
    ...overrides,
  };
}

function invalidCodes(candidate, ctx = context()) {
  const result = validateDateExpressionCandidate(candidate, ctx);
  assertEquals(result.valid, false);
  return result.errorCodes;
}

Deno.test("P4.1 validation: fixed extracted date with source claim and provider provenance is valid", () => {
  assertEquals(validateDateExpressionCandidate(base(), context()), { valid: true, status: "valid", errorCodes: [] });
});

Deno.test("P4.1 validation: canonical structures reject missing required components", () => {
  assert(invalidCodes(base({ explicitDate: null })).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_FIXED_DATE_MISSING));
  assert(invalidCodes(base({ expressionType: "event_date", explicitDate: null, eventKey: null })).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_EVENT_MISSING));
  assert(invalidCodes(base({ expressionType: "relative_to_date", explicitDate: null, anchorConceptKey: null, offsetValue: 5, offsetUnit: "day", offsetDirection: "after" })).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_ANCHOR_MISSING));
  assert(invalidCodes(base({ expressionType: "relative_to_event", explicitDate: null, eventKey: "co", offsetValue: -1, offsetUnit: "day", offsetDirection: "after" })).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_OFFSET_MISSING));
  assert(invalidCodes(base({ expressionType: "earlier_of", explicitDate: null, operands: [{ conceptKey: "a" }] })).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_OPERANDS_MISSING));
  assert(invalidCodes(base({ expressionType: "recurring_deadline", explicitDate: null, recurrenceDefinition: { frequency: "annual" } })).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_RECURRENCE_MISSING));
});

Deno.test("P4.1 validation: dependent expressions preserve structure without resolving dates", () => {
  const relative = base({ expressionType: "relative_to_date", explicitDate: null, anchorConceptKey: "rent_commencement_date", offsetValue: 30, offsetUnit: "day", offsetDirection: "after" });
  assertEquals(validateDateExpressionCandidate(relative, context()), { valid: true, status: "valid", errorCodes: [] });

  const resolvedRelative = base({ ...relative, explicitDate: "2026-02-01" });
  assert(invalidCodes(resolvedRelative).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_P4_1_RESOLUTION_NOT_ALLOWED));

  const noticeWindow = base({ expressionType: "notice_window", explicitDate: null, eventKey: "renewal_option", offsetValue: 180, offsetUnit: "day", offsetDirection: "before" });
  assertEquals(validateDateExpressionCandidate(noticeWindow, context()), { valid: true, status: "valid", errorCodes: [] });
});

Deno.test("P4.1 validation: unresolved and related-document statuses stay distinct", () => {
  const unresolved = base({ expressionType: "unresolved_expression", expressionStatus: "unresolved", explicitDate: null, normalizedExpression: { text: "after landlord approval" } });
  assertEquals(validateDateExpressionCandidate(unresolved, context()), { valid: true, status: "valid", errorCodes: [] });

  const relatedMissingCondition = base({ expressionType: "dependent_date", expressionStatus: "requires_related_document", explicitDate: null, eventKey: "amendment_effective_date" });
  assert(invalidCodes(relatedMissingCondition).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_RELATED_DOCUMENT_MISSING));

  const relatedWithCondition = base({ ...relatedMissingCondition, conditionDefinition: { requiredDocumentType: "amendment" } });
  assertEquals(validateDateExpressionCandidate(relatedWithCondition, context()), { valid: true, status: "valid", errorCodes: [] });
});

Deno.test("P4.1 validation: source-claim, generation and registry fences are enforced", () => {
  assert(invalidCodes(base({ sourceClaimId: null, sourceClaimIds: [] })).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_SOURCE_CLAIM_MISSING));
  assert(invalidCodes(base({ registryHash: "0".repeat(64) })).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_REGISTRY_MISMATCH));
  assert(invalidCodes(base({ generationId: "00000000-0000-4000-8000-000000000099" })).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_GENERATION_STALE));
  assert(invalidCodes(base(), context({ sourceClaims: [{ id: CLAIM, orgId: "00000000-0000-4000-8000-999999999999", uploadedFileId: FILE, extractionRunId: RUN, generationId: GEN }] })).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_SOURCE_MISMATCH));
  assert(invalidCodes(base(), context({ sourceClaims: [{ id: CLAIM, orgId: ORG, uploadedFileId: FILE, extractionRunId: RUN, generationId: "00000000-0000-4000-8000-000000000099", activeGenerationId: GEN }] })).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_SOURCE_MISMATCH));
});

Deno.test("P4.1 validation: extracted, reviewer, derived and calculated lanes remain separate", () => {
  assert(invalidCodes(base({ providerInvocationId: null })).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_PROVIDER_PROVENANCE_MISSING));
  assert(invalidCodes(base({ expressionStatus: "ambiguous" })).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_AMBIGUOUS_AUTHORITATIVE_DATE));
  assert(invalidCodes(base({ originType: "reviewer", producerType: "reviewer", providerInvocationId: "provider", extractionStageRunId: "stage" }), undefined).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_REVIEWER_PROVENANCE_INVALID));
  assertEquals(validateDateExpressionCandidate(base({ originType: "reviewer", producerType: "reviewer", providerInvocationId: null, extractionStageRunId: null, sourceClaimId: null }), context()), { valid: true, status: "valid", errorCodes: [] });
  assert(invalidCodes(base({ originType: "derived", producerType: "system", providerInvocationId: null })).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_FORMULA_MISSING));
  assertEquals(validateDateExpressionCandidate(base({ originType: "calculated", producerType: "system", providerInvocationId: null, calculationFormulaKey: "test_formula", calculationVersion: "v1" }), context()), { valid: true, status: "valid", errorCodes: [] });
});

Deno.test("P4.1 key: immutable identity includes generation and stable schema metadata, not timestamps", async () => {
  const a = base({ sourceClaimIds: ["b", "a"], normalizedExpression: { z: 1, a: { two: 2 } } });
  const b = base({ sourceClaimIds: ["a", "b"], normalizedExpression: { a: { two: 2 }, z: 1 } });
  assertEquals(await buildDateExpressionKey(a), await buildDateExpressionKey(b));

  const changedGeneration = base({ ...a, generationId: "00000000-0000-4000-8000-000000000098" });
  const changedType = base({ ...a, expressionType: "event_date", explicitDate: null, eventKey: "delivery" });
  assert((await buildDateExpressionKey(a)) !== (await buildDateExpressionKey(changedGeneration)));
  assert((await buildDateExpressionKey(a)) !== (await buildDateExpressionKey(changedType)));
});

Deno.test("P4.1 validation: package context accepts source claims fenced to the same package", () => {
  const packageCandidate = base({ packageId: PACKAGE });
  const packageContext = context({
    packageId: PACKAGE,
    sourceClaims: [{ id: CLAIM, orgId: ORG, uploadedFileId: FILE, extractionRunId: RUN, generationId: GEN, packageId: PACKAGE, activeGenerationId: GEN }],
  });
  assertEquals(validateDateExpressionCandidate(packageCandidate, packageContext), { valid: true, status: "valid", errorCodes: [] });

  const badPackageContext = context({
    packageId: PACKAGE,
    sourceClaims: [{ id: CLAIM, orgId: ORG, uploadedFileId: FILE, extractionRunId: RUN, generationId: GEN, packageId: "00000000-0000-4000-8000-000000000097" }],
  });
  assert(invalidCodes(packageCandidate, badPackageContext).includes(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_SOURCE_MISMATCH));
});