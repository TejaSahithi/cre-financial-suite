// @ts-nocheck
/**
 * Extraction domain registry (Phase 4) — definition contract.
 *
 * Deliberately generic (TId extends string, no import of LlmCallDomain) --
 * LlmCallDomain is DERIVED from the registry built out of these definitions
 * (domain-registry.ts), so this file cannot depend on that type without
 * creating an import cycle. Each concrete definition (definitions/*.ts)
 * supplies its own literal id via `as const satisfies
 * ExtractionDomainDefinition`, which is what lets
 * `(typeof DOMAIN_REGISTRY)[number]["id"]` produce the real 5-string union.
 */

/** authoritative: this domain's output is what's shown/persisted. shadow:
 *  runs (or may run) purely for comparison, never authoritative this phase.
 *  disabled: not currently registered as running at all. */
export type DomainAuthorityMode = "authoritative" | "shadow" | "disabled";

/** "core" is the original 5 domains from Phase 4. "expense_specialist" is
 *  Phase 5's 5 shadow-only obligation specialists. Used to select "the 5
 *  specialists" together with authorityMode -- authorityMode alone would
 *  silently absorb any OTHER future shadow-mode domain a later feature
 *  adds; domainFamily is the deliberate second, narrower filter. */
export type DomainFamily = "core" | "expense_specialist";

export interface ExtractionDomainDefinition<TId extends string = string> {
  readonly id: TId;
  readonly enabled: boolean;
  readonly authorityMode: DomainAuthorityMode;
  readonly domainFamily: DomainFamily;
  readonly executionOrder: number;

  readonly promptVersion: string;
  /** The actual prompt text (adaptive-extractor.ts's former DOMAIN_CONCEPTS
   *  entries) -- promptVersion alone is a label, not content. */
  readonly promptConcepts: string;

  readonly schemaName: string | null;
  readonly schemaVersion: string | null;

  readonly routingThreshold: number;
  readonly maximumEvidenceCharacters: number;
  readonly maximumOutputTokens: number;

  /** domain-readiness.ts's former CRITICAL_FIELDS_BY_DOMAIN entry -- [] for
   *  a domain with no fixed critical-field list (not omitted; explicit). */
  readonly criticalFields: readonly string[];
  readonly dependencies: readonly string[];

  /** Which authoritative domain(s)' fields the shadow-comparison metrics
   *  module diffs this domain against. [] for authoritative domains
   *  themselves -- only meaningful for authorityMode:"shadow" domains.
   *  Registry-validated: every id must resolve to a real domain. */
  readonly evidenceSourceDomains: readonly string[];
  /** Authoritative domain ids that must have completed in the main
   *  escalation loop before this (shadow) domain's call may fire. [] for
   *  authoritative domains. Registry-validated: every id must resolve, and
   *  must itself have authorityMode !== "shadow" (a shadow domain may
   *  depend on an authoritative domain's timing, never on another shadow
   *  domain's -- that would be an ambiguous ordering). Replaces what would
   *  otherwise be a documentation-only reuse of `dependencies`. */
  readonly shadowRunsAfter: readonly string[];

  /** Explicit, never derived by string manipulation (e.g.
   *  stage.replace("enrich_evidence_", "")) -- that would let the registry
   *  and the bounded-enrich dispatch switch (normalize-pdf-output/index.ts)
   *  silently drift apart. null for a domain not (yet) wired into the
   *  bounded-enrich path -- see Phase 4.5 in the plan; every domain in this
   *  phase has a real value here. */
  readonly boundedEnrichStageName: string | null;

  /** Explicit, not inferred from boundedEnrichStageName being non-null -- a
   *  future specialist domain (Phase 5) may exist and run in shadow mode
   *  elsewhere in the pipeline while intentionally opting OUT of bounded
   *  enrichment (boundedEnrichStageName: null, participatesInBoundedEnrichment:
   *  false) until it is ready. validateDomainRegistry() enforces that an
   *  enabled domain claiming participation actually has a stage name. */
  readonly participatesInBoundedEnrichment: boolean;
}
