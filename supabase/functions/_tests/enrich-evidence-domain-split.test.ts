// @ts-nocheck
// Bounded Per-Domain Enrich Refactor -- correctness gate for splitting
// buildReviewPayload's per-field evidence-verification loop
// (buildStandardFieldsForEntries, extracted from normalize-pdf-output/index.ts)
// along the existing 5 LlmCallDomain buckets (see docs/lease-extraction-architecture-audit-2026-07-29.md
// and the "Bounded Per-Domain Enrich Refactor" plan).
//
// Unlike buildLeaseWorkflowAbstraction, this loop is genuinely a per-field-
// independent schemaEntries.map(...) -- restricting schemaEntries to one
// domain's fields (via field-contract.ts's FieldGroup -> LlmCallDomain
// mapping) and pooling all 5 domains' results must produce IDENTICAL
// per-field output to running the loop unrestricted, with no field key
// double-claimed by two domains and none silently dropped.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { getSchema } from "../_shared/extraction/schemas.ts";
import { LLM_CALL_DOMAINS, getSchemaEntriesForDomain, getSchemaEntriesWithNoDomain, type LlmCallDomain } from "../_shared/extraction/enrich-bounded-stage/domain-fields.ts";

const realServe = Deno.serve;
(Deno as any).serve = (..._args: unknown[]) => ({ finished: Promise.resolve(), shutdown: () => {} });
const { __test__: normalizeTest } = await import("../normalize-pdf-output/index.ts");
(Deno as any).serve = realServe;

const { buildStandardFieldsForEntries } = normalizeTest;

const schema = getSchema("lease");
const allSchemaEntries = Object.entries(schema).filter(([, def]) => !(def as any).derived);

function schemaEntriesForDomain(domain: LlmCallDomain) {
  return getSchemaEntriesForDomain(allSchemaEntries, domain);
}

function schemaEntriesWithNoDomain() {
  return getSchemaEntriesWithNoDomain(allSchemaEntries);
}

const BASE_ARGS = {
  index: 0,
  values: {
    tenant_name: "CRESS FAMILY RESTAURANTS, LLC",
    landlord_name: "Markets at Choto, LLC",
    monthly_rent: 4500,
    responsibility_taxes: "tenant",
    commencement_date: "2024-02-01",
    lease_type: "full_service",
  },
  workflowOutput: null,
  fieldConfidences: { tenant_name: 0.92, landlord_name: 0.92, monthly_rent: 0.9, responsibility_taxes: 0.85 },
  fieldSources: {},
  fieldEvidence: {},
  calculatorDerivationTraces: {},
  calculatorDerivationSourceFields: {},
  doclingRaw: { full_text: "", text_blocks: [], tables: [], fields: [] },
  extractionModuleType: "lease",
  truthAssemblyCanonicalFields: {},
  source: "llm",
  rowConfidence: 0.9,
};

Deno.test("enrich-evidence-domain-split: every one of the 5 LlmCallDomain buckets is non-empty for the lease schema", () => {
  for (const domain of LLM_CALL_DOMAINS) {
    const entries = schemaEntriesForDomain(domain);
    assert(entries.length > 0, `domain ${domain} has zero schema fields -- FIELD_GROUP_TO_LLM_CALL_DOMAIN mapping may be stale`);
  }
});

Deno.test("enrich-evidence-domain-split: no schema field is claimed by more than one domain", () => {
  const seen = new Map<string, LlmCallDomain>();
  for (const domain of LLM_CALL_DOMAINS) {
    for (const [fieldKey] of schemaEntriesForDomain(domain)) {
      const prior = seen.get(fieldKey);
      assert(!prior, `field ${fieldKey} claimed by both ${prior} and ${domain}`);
      seen.set(fieldKey, domain);
    }
  }
});

Deno.test("enrich-evidence-domain-split: pooling all 5 domains + the no-domain remainder covers every schema field exactly once", () => {
  const pooledKeys = new Set<string>();
  for (const domain of LLM_CALL_DOMAINS) {
    for (const [fieldKey] of schemaEntriesForDomain(domain)) pooledKeys.add(fieldKey);
  }
  for (const [fieldKey] of schemaEntriesWithNoDomain()) pooledKeys.add(fieldKey);

  const allKeys = new Set(allSchemaEntries.map(([fieldKey]) => fieldKey));
  assertEquals(pooledKeys.size, allKeys.size);
  for (const key of allKeys) assert(pooledKeys.has(key), `schema field ${key} missing from the pooled domain partition`);
});

Deno.test("enrich-evidence-domain-split: domain-restricted evidence loop pooled across all domains produces IDENTICAL per-field results to the unrestricted loop", () => {
  const unrestricted = buildStandardFieldsForEntries({ ...BASE_ARGS, schemaEntries: allSchemaEntries });
  const unrestrictedByKey = new Map(unrestricted.map((field: any) => [field.field_key, field]));

  const pooledByKey = new Map<string, any>();
  for (const domain of LLM_CALL_DOMAINS) {
    const domainEntries = schemaEntriesForDomain(domain);
    if (domainEntries.length === 0) continue;
    const domainResult = buildStandardFieldsForEntries({ ...BASE_ARGS, schemaEntries: domainEntries });
    for (const field of domainResult) pooledByKey.set(field.field_key, field);
  }
  const remainderEntries = schemaEntriesWithNoDomain();
  if (remainderEntries.length > 0) {
    const remainderResult = buildStandardFieldsForEntries({ ...BASE_ARGS, schemaEntries: remainderEntries });
    for (const field of remainderResult) pooledByKey.set(field.field_key, field);
  }

  assertEquals(pooledByKey.size, unrestrictedByKey.size);
  for (const [key, field] of unrestrictedByKey) {
    assertEquals(pooledByKey.get(key), field, `field ${key} differs between domain-restricted and unrestricted evidence loop`);
  }
});

Deno.test("enrich-evidence-domain-split: a single domain's result contains ONLY that domain's fields", () => {
  const coreTermsEntries = schemaEntriesForDomain("core_terms");
  const result = buildStandardFieldsForEntries({ ...BASE_ARGS, schemaEntries: coreTermsEntries });
  const resultKeys = new Set(result.map((field: any) => field.field_key));
  const expectedKeys = new Set(coreTermsEntries.map(([fieldKey]) => fieldKey));
  assertEquals(resultKeys, expectedKeys);
});
