// @ts-nocheck
/**
 * Claim concept type definitions — P2.1.
 *
 * The TypeScript registry (concept-registry.ts) is the AUTHORING source.
 * A generated, immutable DB snapshot (lease_claim_registry_versions /
 * lease_claim_concepts, added in a later P2.1 migration) is what the
 * claim-persistence RPC actually validates against at the database
 * boundary -- a SQL RPC cannot consult a TS file, and trusting the calling
 * Edge Function's TS validation alone would mean the service-owned DB
 * boundary trusts its caller, the opposite of P0/P1's whole design
 * (round-2 external review correction #1). The generated snapshot is a
 * deterministic artifact of this file, never a second independently
 * maintained registry.
 */

export type ClaimValueType =
  | "string"
  | "money"
  | "decimal"
  | "integer"
  | "percentage"
  | "boolean"
  | "date"
  | "duration_months"
  | "address"
  | "object"
  | "array";

export type ClaimCardinality = "single" | "multiple";

/**
 * How a concept's instance_key is derived when cardinality is "multiple"
 * (or, for "single" concepts, confirms the fixed "default" instance).
 * P2.1 defines this contract; P2.4's adapters implement it (round-2
 * correction #6).
 */
export type ClaimInstanceStrategy =
  | "singleton"
  | "source_ordinal"
  | "semantic_role"
  | "normalized_identifier"
  | "evidence_position";

export interface ClaimConceptDefinition {
  conceptKey: string;
  domain: string;
  valueType: ClaimValueType;
  cardinality: ClaimCardinality;
  instanceStrategy: ClaimInstanceStrategy;
  evidenceRequired: boolean;
  /** projection_field_key: the existing compatibility-payload field key this
   *  concept projects onto. Must be unique across single-cardinality
   *  concepts (enforced by a registry validation test). */
  projectionFieldKey?: string;
  /** Current Lease Review tab/section this projects into, for documentation
   *  and the cross-registry audit test -- not itself enforced at the DB layer. */
  compatibilitySection?: string;
  /** Other vocabularies' names for this exact same concept -- sourced
   *  directly from field-contract.ts's FieldContractEntry.aliases, never
   *  hand-duplicated (round-2 correction #10). */
  aliases: readonly string[];
  comparisonStrategy: string;
  normalizationStrategy: string;
  /** Registry version this concept was introduced in -- "lease-claims-v1"
   *  for every initial entry. */
  introducedIn: string;
  /** Set false for concepts kept in the registry for reference/documentation
   *  but not currently emitted by any producer. */
  active: boolean;
}

/** A field known to exist in one of the three current UI/extraction
 * registries (LEASE_REVIEW_FIELDS, LEASE_FIELD_CONTRACT, FIELD_ALIASES) but
 * deliberately NOT given a claim concept in lease-claims-v1 -- with a
 * documented reason, per round-2 correction #10's "explicit, documented
 * exclusion list" clause. Never a silent omission. */
export interface ClaimConceptExclusion {
  key: string;
  reason: string;
}
