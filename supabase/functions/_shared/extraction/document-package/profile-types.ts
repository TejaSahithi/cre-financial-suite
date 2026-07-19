// @ts-nocheck
/**
 * Document profile type definitions — P3.1.
 *
 * Mirrors claims/concept-types.ts's authoring/generated-snapshot split
 * exactly: this TS registry (profile-registry.ts) is the AUTHORING source;
 * a generated, immutable DB snapshot (lease_document_profile_registry_versions/
 * lease_document_profiles, P3.1's own migration) is what
 * lease_document_profile_records' insert-time trigger actually validates
 * against -- a SQL RPC cannot consult a TS file, and trusting the calling
 * Edge Function's TS validation alone would mean the service-owned DB
 * boundary trusts its caller (the same reasoning already applied once in
 * P2.1 correction #1).
 */

export type DocumentProfileKey =
  | "base_lease"
  | "lease_assignment"
  | "lease_amendment"
  | "assignment_and_amendment"
  | "lease_extension"
  | "lease_renewal"
  | "guaranty"
  | "commencement_certificate"
  | "rent_addendum"
  | "cam_addendum"
  | "work_letter"
  | "exhibit"
  | "unknown_supported_document";

export interface DocumentProfileDefinition {
  profileKey: DocumentProfileKey;
  displayName: string;
  /** Relationship types (P3.2+) this profile may participate in as a
   *  source -- e.g. lease_assignment -> ["assigns"]. Documentation/future-
   *  contract only; not DB-enforced until P3.2 builds the relationship
   *  table. */
  allowedRelationshipRoles: readonly string[];
  /** Whether a single uploaded file classified as this profile is expected
   *  to ever contain multiple document_segments (e.g. a combined
   *  assignment_and_amendment file). */
  supportsSegmentation: boolean;
  /** P2 concept keys whose presence is a meaningful signal for this
   *  profile (documentation/future-classifier-input only, not enforced). */
  expectedClaimSignals: readonly string[];
  /** Which P2 concept domains this profile's own document may explicitly
   *  override on a base lease once P3.5's precedence resolver exists --
   *  documentation contract only in P3.1. */
  permittedOverrideDomains: readonly string[];
  /** Whether this profile is meaningless without a resolved base-lease
   *  package relationship (e.g. an assignment alone still classifies fine,
   *  but its package resolution will require the base document). */
  requiresBaseDocument: boolean;
  introducedIn: string;
}

export type LegacyVocabulary = "document_subtype" | "document_profile";
export type LegacyMappingType = "direct" | "ambiguous" | "unsupported";

/**
 * One row of the reconciliation matrix: what a real, already-existing
 * legacy classification value means in terms of the new canonical
 * registry. `canonicalProfiles` holds exactly one entry for "direct",
 * two-or-more for "ambiguous" (a real candidate set, never silently
 * resolved to one), and is empty for "unsupported" (documented, not
 * silently dropped).
 */
export interface LegacyVocabularyMapping {
  legacyVocabulary: LegacyVocabulary;
  legacyValue: string;
  mappingType: LegacyMappingType;
  canonicalProfiles: readonly DocumentProfileKey[];
  reason: string;
}
