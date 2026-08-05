// @ts-nocheck
/**
 * Partitions the lease schema's fields across the 5 existing LlmCallDomain
 * buckets, for the enrich_evidence_<domain> bounded stages (see
 * docs/lease-extraction-architecture-audit-2026-07-29.md and the "Bounded Per-Domain Enrich
 * Refactor" plan). Reuses field-contract.ts's FieldGroup and
 * deterministic-candidates.ts's existing FIELD_GROUP_TO_LLM_CALL_DOMAIN
 * mapping -- no new taxonomy, no new registry.
 *
 * A field with no contract entry, or whose FieldGroup maps to no domain
 * (FIELD_GROUP_TO_LLM_CALL_DOMAIN[group] === null -- e.g. budget_inputs,
 * approval_controls), belongs to neither of the 5 domain stages. It is
 * still processed, exactly once, by getSchemaEntriesWithNoDomain() --
 * consumed by enrich_truth_assembly as a final catch-all pass, so every
 * schema field is covered exactly once across the 5 domain stages plus
 * this remainder, matching the guarantee proven in
 * _tests/enrich-evidence-domain-split.test.ts.
 */

import { type FieldGroup, getFieldContract } from "../field-contract.ts";
import { FIELD_GROUP_TO_LLM_CALL_DOMAIN } from "../deterministic-candidates.ts";
import { LLM_CALL_DOMAINS, type LlmCallDomain } from "../section-router.ts";

export type SchemaEntry = [string, any];

export function domainForField(fieldKey: string): LlmCallDomain | null {
  const group = getFieldContract(fieldKey)?.group;
  if (!group) return null;
  return FIELD_GROUP_TO_LLM_CALL_DOMAIN[group] ?? null;
}

export function getSchemaEntriesForDomain(
  schemaEntries: SchemaEntry[],
  domain: LlmCallDomain,
): SchemaEntry[] {
  return schemaEntries.filter(([fieldKey]) =>
    domainForField(fieldKey) === domain
  );
}

export function getSchemaEntriesForFieldGroups(
  schemaEntries: SchemaEntry[],
  groups: readonly FieldGroup[],
): SchemaEntry[] {
  const allowed = new Set(groups);
  return schemaEntries.filter(([fieldKey]) => {
    const group = getFieldContract(fieldKey)?.group;
    return group ? allowed.has(group) : false;
  });
}

export function getSchemaEntriesWithNoDomain(
  schemaEntries: SchemaEntry[],
): SchemaEntry[] {
  return schemaEntries.filter(([fieldKey]) =>
    domainForField(fieldKey) === null
  );
}

/**
 * Pooling the 5 domain stages + the no-domain remainder (in that dispatch
 * order) yields the full set of standard fields, but NOT in the schema's
 * declared order -- the monolithic single-pass loop
 * (buildStandardFieldsForEntries called once, unrestricted) always emits
 * fields in schemaEntries order. Restoring that order here keeps the
 * bounded path's output byte-equivalent to the monolithic path (see
 * _tests/enrich-bounded-stages.test.ts's byte-equivalence gate) and keeps
 * the reviewer-facing field order stable regardless of which stage produced
 * a given field.
 */
export function reorderStandardFieldsBySchema(
  fields: Array<Record<string, any>>,
  schemaEntries: SchemaEntry[],
): Array<Record<string, any>> {
  const byKey = new Map(fields.map((field) => [field.field_key, field]));
  return schemaEntries
    .map(([fieldKey]) => byKey.get(fieldKey))
    .filter((field): field is Record<string, any> => field != null);
}

export { LLM_CALL_DOMAINS };
export type { LlmCallDomain };
