// @ts-nocheck
/**
 * Document profile registry — P3.1.
 *
 * Hand-authored (unlike concept-registry.ts, which programmatically derives
 * from LEASE_FIELD_CONTRACT -- there are only 13 canonical profiles here,
 * a small, stable, deliberately-curated set, not 92 fields).
 *
 * This is the SOLE reconciliation layer for the two real, already-existing,
 * independently-maintained document-type vocabularies (P3.0 finding):
 *   - uploaded_files.document_subtype's 11-value CHECK enum
 *     (base_lease, amendment, assignment, consent, extension, addendum,
 *     expense_backup, cam_support, budget_support, rent_roll, generic)
 *   - the document_profile classifier's 7-value output
 *     (full_lease, assignment, amendment, assignment_amendment, abstract,
 *     addendum, exhibit)
 * Every legacy value maps to exactly one canonical profile ("direct"), an
 * explicit multi-candidate set ("ambiguous"), or a documented absence
 * ("unsupported") -- never a silent default to base_lease.
 */
import type { DocumentProfileDefinition, DocumentProfileKey, LegacyVocabularyMapping } from "./profile-types.ts";
import { DOCUMENT_PROFILE_REGISTRY_VERSION } from "./profile-registry-version.ts";

export const DOCUMENT_PROFILES: readonly DocumentProfileDefinition[] = [
  {
    profileKey: "base_lease",
    displayName: "Base Lease",
    allowedRelationshipRoles: ["base_document"],
    supportsSegmentation: false,
    expectedClaimSignals: ["tenant_name", "landlord_name", "commencement_date", "monthly_rent"],
    permittedOverrideDomains: [],
    requiresBaseDocument: false,
    introducedIn: DOCUMENT_PROFILE_REGISTRY_VERSION,
  },
  {
    profileKey: "lease_assignment",
    displayName: "Lease Assignment",
    allowedRelationshipRoles: ["assigns"],
    supportsSegmentation: true,
    expectedClaimSignals: ["assignor_name", "assignee_name", "assignment_effective_date", "assignment_consideration"],
    permittedOverrideDomains: ["parties"],
    requiresBaseDocument: true,
    introducedIn: DOCUMENT_PROFILE_REGISTRY_VERSION,
  },
  {
    profileKey: "lease_amendment",
    displayName: "Lease Amendment",
    allowedRelationshipRoles: ["amends"],
    supportsSegmentation: true,
    expectedClaimSignals: ["all_other_terms_remain_same"],
    permittedOverrideDomains: [], // explicit amended concepts only -- determined per-amendment in P3.4/P3.5, not a fixed domain list
    requiresBaseDocument: true,
    introducedIn: DOCUMENT_PROFILE_REGISTRY_VERSION,
  },
  {
    profileKey: "assignment_and_amendment",
    displayName: "Assignment and Amendment",
    allowedRelationshipRoles: ["assigns", "amends"],
    supportsSegmentation: true,
    expectedClaimSignals: ["assignor_name", "assignee_name", "assignment_effective_date"],
    permittedOverrideDomains: ["parties"],
    requiresBaseDocument: true,
    introducedIn: DOCUMENT_PROFILE_REGISTRY_VERSION,
  },
  {
    profileKey: "lease_extension",
    displayName: "Lease Extension",
    allowedRelationshipRoles: ["extends"],
    supportsSegmentation: true,
    expectedClaimSignals: ["expiration_date", "renewal_options"],
    permittedOverrideDomains: ["term"],
    requiresBaseDocument: true,
    introducedIn: DOCUMENT_PROFILE_REGISTRY_VERSION,
  },
  {
    profileKey: "lease_renewal",
    displayName: "Lease Renewal",
    allowedRelationshipRoles: ["renews"],
    supportsSegmentation: true,
    expectedClaimSignals: ["renewal_options", "renewal_type"],
    permittedOverrideDomains: ["term"],
    requiresBaseDocument: true,
    introducedIn: DOCUMENT_PROFILE_REGISTRY_VERSION,
  },
  {
    profileKey: "guaranty",
    displayName: "Guaranty",
    allowedRelationshipRoles: ["guarantees"],
    supportsSegmentation: true,
    expectedClaimSignals: [],
    permittedOverrideDomains: [], // guaranty adds an obligation, never overrides lease-party/economic concepts (locked decision, P3 spec)
    requiresBaseDocument: true,
    introducedIn: DOCUMENT_PROFILE_REGISTRY_VERSION,
  },
  {
    profileKey: "commencement_certificate",
    displayName: "Commencement Certificate",
    allowedRelationshipRoles: ["resolves_commencement"],
    supportsSegmentation: true,
    expectedClaimSignals: ["commencement_date", "expiration_date", "rent_commencement_date"],
    permittedOverrideDomains: ["term"],
    requiresBaseDocument: true,
    introducedIn: DOCUMENT_PROFILE_REGISTRY_VERSION,
  },
  {
    profileKey: "rent_addendum",
    displayName: "Rent Addendum",
    allowedRelationshipRoles: ["amends", "incorporates"],
    supportsSegmentation: true,
    expectedClaimSignals: ["monthly_rent", "annual_rent", "escalation_rate"],
    permittedOverrideDomains: ["rent"],
    requiresBaseDocument: true,
    introducedIn: DOCUMENT_PROFILE_REGISTRY_VERSION,
  },
  {
    profileKey: "cam_addendum",
    displayName: "CAM Addendum",
    allowedRelationshipRoles: ["amends", "incorporates"],
    supportsSegmentation: true,
    expectedClaimSignals: ["cam_amount", "cam_cap_type", "cam_cap_pct"],
    permittedOverrideDomains: ["cam"],
    requiresBaseDocument: true,
    introducedIn: DOCUMENT_PROFILE_REGISTRY_VERSION,
  },
  {
    profileKey: "work_letter",
    displayName: "Work Letter",
    allowedRelationshipRoles: ["incorporates", "attachment_to"],
    supportsSegmentation: true,
    expectedClaimSignals: ["ti_allowance"],
    permittedOverrideDomains: [],
    requiresBaseDocument: true,
    introducedIn: DOCUMENT_PROFILE_REGISTRY_VERSION,
  },
  {
    profileKey: "exhibit",
    displayName: "Exhibit",
    allowedRelationshipRoles: ["attachment_to"],
    supportsSegmentation: true,
    expectedClaimSignals: [],
    permittedOverrideDomains: [],
    requiresBaseDocument: true,
    introducedIn: DOCUMENT_PROFILE_REGISTRY_VERSION,
  },
  {
    profileKey: "unknown_supported_document",
    displayName: "Unknown (Supported)",
    allowedRelationshipRoles: ["related_unknown"],
    supportsSegmentation: true,
    expectedClaimSignals: [],
    permittedOverrideDomains: [],
    requiresBaseDocument: false,
    introducedIn: DOCUMENT_PROFILE_REGISTRY_VERSION,
  },
];

const _profileIndex = new Map<DocumentProfileKey, DocumentProfileDefinition>();
for (const profile of DOCUMENT_PROFILES) _profileIndex.set(profile.profileKey, profile);

export function getDocumentProfile(profileKey: string): DocumentProfileDefinition | undefined {
  return _profileIndex.get(profileKey as DocumentProfileKey);
}

// ---------------------------------------------------------------------------
// Reconciliation matrix -- grounded in the actual enum values confirmed
// during P3.0 exploration, not an assumed/illustrative list.
// ---------------------------------------------------------------------------
export const LEGACY_VOCABULARY_RECONCILIATION: readonly LegacyVocabularyMapping[] = [
  // uploaded_files.document_subtype (11 real values)
  { legacyVocabulary: "document_subtype", legacyValue: "base_lease", mappingType: "direct", canonicalProfiles: ["base_lease"], reason: "Direct 1:1 match on name and meaning." },
  { legacyVocabulary: "document_subtype", legacyValue: "amendment", mappingType: "direct", canonicalProfiles: ["lease_amendment"], reason: "Direct match." },
  { legacyVocabulary: "document_subtype", legacyValue: "assignment", mappingType: "direct", canonicalProfiles: ["lease_assignment"], reason: "Direct match." },
  { legacyVocabulary: "document_subtype", legacyValue: "extension", mappingType: "direct", canonicalProfiles: ["lease_extension"], reason: "Direct match." },
  { legacyVocabulary: "document_subtype", legacyValue: "addendum", mappingType: "ambiguous", canonicalProfiles: ["rent_addendum", "cam_addendum"], reason: "document_subtype's bare 'addendum' value does not distinguish rent vs. CAM -- both are real candidate profiles; disambiguation requires content signal, not a forced pick." },
  { legacyVocabulary: "document_subtype", legacyValue: "generic", mappingType: "direct", canonicalProfiles: ["unknown_supported_document"], reason: "The explicit catch-all -- maps to the explicit unknown-but-supported profile, never silently to base_lease." },
  { legacyVocabulary: "document_subtype", legacyValue: "consent", mappingType: "unsupported", canonicalProfiles: [], reason: "A landlord-consent document is not one of the 13 canonical lease-document profiles; documented as unsupported rather than silently dropped or forced into a nearby profile." },
  { legacyVocabulary: "document_subtype", legacyValue: "expense_backup", mappingType: "unsupported", canonicalProfiles: [], reason: "A supporting financial attachment, not a lease-document profile." },
  { legacyVocabulary: "document_subtype", legacyValue: "cam_support", mappingType: "unsupported", canonicalProfiles: [], reason: "A supporting financial attachment, not a lease-document profile." },
  { legacyVocabulary: "document_subtype", legacyValue: "budget_support", mappingType: "unsupported", canonicalProfiles: [], reason: "A supporting financial attachment, not a lease-document profile." },
  { legacyVocabulary: "document_subtype", legacyValue: "rent_roll", mappingType: "unsupported", canonicalProfiles: [], reason: "A supporting financial attachment, not a lease-document profile." },

  // document_profile classifier output (7 real values)
  { legacyVocabulary: "document_profile", legacyValue: "full_lease", mappingType: "direct", canonicalProfiles: ["base_lease"], reason: "Same real-world concept, different name." },
  { legacyVocabulary: "document_profile", legacyValue: "assignment", mappingType: "direct", canonicalProfiles: ["lease_assignment"], reason: "Direct match." },
  { legacyVocabulary: "document_profile", legacyValue: "amendment", mappingType: "direct", canonicalProfiles: ["lease_amendment"], reason: "Direct match." },
  { legacyVocabulary: "document_profile", legacyValue: "assignment_amendment", mappingType: "direct", canonicalProfiles: ["assignment_and_amendment"], reason: "Direct match -- the existing classifier already detects this combined case." },
  { legacyVocabulary: "document_profile", legacyValue: "exhibit", mappingType: "direct", canonicalProfiles: ["exhibit"], reason: "Direct match." },
  { legacyVocabulary: "document_profile", legacyValue: "addendum", mappingType: "ambiguous", canonicalProfiles: ["rent_addendum", "cam_addendum"], reason: "Same ambiguity as document_subtype's 'addendum' -- the classifier's bare 'addendum' output does not distinguish rent vs. CAM." },
  { legacyVocabulary: "document_profile", legacyValue: "abstract", mappingType: "unsupported", canonicalProfiles: [], reason: "A lease abstract/summary document is a distinct concept from any of the 13 canonical profiles; documented as unsupported." },
];

/** Canonical profiles with NO legacy value mapping into them at all --
 *  confirmed net-new during P3.0 exploration, reachable only through future
 *  classification logic (P3.4+) or explicit reviewer selection. Documented
 *  here so the gap is visible, not silently absent from the matrix. */
export const CANONICAL_PROFILES_WITH_NO_LEGACY_MAPPING: readonly DocumentProfileKey[] = [
  "guaranty",
  "commencement_certificate",
  "lease_renewal",
  "work_letter",
];

export function resolveLegacyValue(
  legacyVocabulary: "document_subtype" | "document_profile",
  legacyValue: string,
): LegacyVocabularyMapping | undefined {
  return LEGACY_VOCABULARY_RECONCILIATION.find(
    (m) => m.legacyVocabulary === legacyVocabulary && m.legacyValue === legacyValue,
  );
}

export interface RegistryValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateDocumentProfileRegistry(): RegistryValidationResult {
  const errors: string[] = [];

  const seenKeys = new Set<string>();
  for (const profile of DOCUMENT_PROFILES) {
    if (seenKeys.has(profile.profileKey)) errors.push(`Duplicate profile key: ${profile.profileKey}`);
    seenKeys.add(profile.profileKey);
  }

  for (const mapping of LEGACY_VOCABULARY_RECONCILIATION) {
    if (mapping.mappingType === "direct" && mapping.canonicalProfiles.length !== 1) {
      errors.push(`Direct mapping for ${mapping.legacyVocabulary}:${mapping.legacyValue} must have exactly one canonical profile`);
    }
    if (mapping.mappingType === "ambiguous" && mapping.canonicalProfiles.length < 2) {
      errors.push(`Ambiguous mapping for ${mapping.legacyVocabulary}:${mapping.legacyValue} must have at least two candidate profiles`);
    }
    if (mapping.mappingType === "unsupported" && mapping.canonicalProfiles.length !== 0) {
      errors.push(`Unsupported mapping for ${mapping.legacyVocabulary}:${mapping.legacyValue} must have zero canonical profiles`);
    }
    for (const key of mapping.canonicalProfiles) {
      if (!seenKeys.has(key)) errors.push(`Reconciliation entry ${mapping.legacyVocabulary}:${mapping.legacyValue} references unknown profile ${key}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Deterministic hash of the registry content (profiles + reconciliation
 *  matrix) -- what the generated DB snapshot's registry_hash must match,
 *  same pattern as concept-registry.ts's computeRegistryHash. */
export async function computeDocumentProfileRegistryHash(): Promise<string> {
  const profilePart = DOCUMENT_PROFILES
    .map((p) => [
      p.profileKey, p.displayName, [...p.allowedRelationshipRoles].sort().join(","),
      p.supportsSegmentation, [...p.expectedClaimSignals].sort().join(","),
      [...p.permittedOverrideDomains].sort().join(","), p.requiresBaseDocument, p.introducedIn,
    ].join("|"))
    .sort()
    .join("\n");
  const reconciliationPart = LEGACY_VOCABULARY_RECONCILIATION
    .map((m) => [m.legacyVocabulary, m.legacyValue, m.mappingType, [...m.canonicalProfiles].sort().join(",")].join("|"))
    .sort()
    .join("\n");
  const bytes = new TextEncoder().encode(`${DOCUMENT_PROFILE_REGISTRY_VERSION}\n${profilePart}\n${reconciliationPart}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
