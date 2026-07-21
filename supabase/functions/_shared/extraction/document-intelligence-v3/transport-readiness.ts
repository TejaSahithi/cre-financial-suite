// @ts-nocheck
/**
 * Transport-wrapper readiness (Release 2, review correction 3).
 *
 * `provenance/transport/azure.ts` and `provenance/transport/openai.ts` are
 * fully built and unit-tested but have zero production callers (see the
 * Release 2 plan's finding #3) -- every real Azure/OpenAI call bypasses
 * them. That's a documented, in-scope limitation, unaffected by anything
 * below.
 *
 * CORRECTION: the original version of this module (and the plan review that
 * asked for it) believed `provider_invocations.provider`'s CHECK constraint
 * blocked `provider:"openai"`, based on the base migration
 * (20260825000000_extraction_runs_provenance.sql) alone. A later migration,
 * 20260855000000_provider_invocations_add_openai.sql, already widened the
 * constraint to include 'openai' -- confirmed live against the local
 * Postgres harness in extraction-provenance-transport-readiness.test.ts,
 * which inserts a real provider:"openai" row and asserts it succeeds. That
 * migration was missed when the finding was first written up; this module
 * now reports the true current state (both providers schema-compatible)
 * rather than a stale blocker. The still-true, still-in-scope fact is
 * "unwired" (no production caller), not "blocked".
 *
 * The live DB test remains valuable as a regression guard even though there
 * is no current blocker: if a future migration ever narrows the constraint
 * back down, that test starts failing, which is the signal to update this
 * module again.
 */

export type ProviderConstraintStatus = "compatible" | "blocked_by_provider_constraint";

export interface TransportProviderReadiness {
  providerConstraint: ProviderConstraintStatus;
  hasLiveCaller: boolean;
}

export interface TransportWrapperReadiness {
  azure: TransportProviderReadiness;
  openai: TransportProviderReadiness;
  details: string[];
}

// Mirrors the exact allowed-value list in the CHECK constraint as of
// 20260855000000_provider_invocations_add_openai.sql (the latest migration
// touching this constraint). Not queried from information_schema at runtime
// (deliberately simple) -- kept in sync by the paired live-DB integration
// test, not by a round-trip on every diagnostic call.
const PROVIDER_INVOCATIONS_ALLOWED_PROVIDERS = new Set([
  "azure_document_intelligence",
  "vertex_ai",
  "gemini_api_key",
  "docling",
  "openai",
]);

export function evaluateTransportWrapperReadiness(): TransportWrapperReadiness {
  const azureConstraintOk = PROVIDER_INVOCATIONS_ALLOWED_PROVIDERS.has("azure_document_intelligence");
  const openaiConstraintOk = PROVIDER_INVOCATIONS_ALLOWED_PROVIDERS.has("openai");

  const details: string[] = [
    "Neither transport wrapper (provenance/transport/azure.ts, provenance/transport/openai.ts) " +
      "has any production caller today -- real Azure/OpenAI calls bypass both. This is a documented " +
      "Release 2 limitation, not fixed in this release. Wiring either in is future work, not blocked " +
      "by the provider_invocations.provider constraint (both providers are schema-compatible today).",
  ];

  return {
    azure: {
      providerConstraint: azureConstraintOk ? "compatible" : "blocked_by_provider_constraint",
      hasLiveCaller: false,
    },
    openai: {
      providerConstraint: openaiConstraintOk ? "compatible" : "blocked_by_provider_constraint",
      hasLiveCaller: false,
    },
    details,
  };
}
