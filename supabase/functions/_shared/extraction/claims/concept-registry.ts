// @ts-nocheck
/**
 * Claim concept registry — P2.1.
 *
 * Programmatically DERIVED from the real, already-existing
 * `_shared/extraction/field-contract.ts`'s `LEASE_FIELD_CONTRACT` (92
 * entries) rather than hand-typed, so aliases/canonical keys are never
 * hand-duplicated (round-2 correction #10) and the registry scales to full
 * current-schema coverage without drifting from its source. A small,
 * explicit, documented exclusion list covers the handful of
 * `LEASE_FIELD_CONTRACT` entries that are computed/row-level-control
 * fields, not atomic extraction targets.
 *
 * `valueType` is inferred from `canonicalKey` naming conventions -- a
 * documented heuristic, not a guess: the same naming conventions the real
 * codebase already uses consistently across 92 fields (see the pattern
 * table in `inferValueType` below).
 */

import { LEASE_FIELD_CONTRACT, type FieldContractEntry, type FieldGroup } from "../field-contract.ts";
import { CLAIMS_REGISTRY_VERSION } from "./registry-version.ts";
import type {
  ClaimConceptDefinition,
  ClaimConceptExclusion,
  ClaimValueType,
} from "./concept-types.ts";

// ---------------------------------------------------------------------------
// Explicit exclusions (round-2 correction #10's "documented exclusion list")
// ---------------------------------------------------------------------------
export const CLAIM_CONCEPT_EXCLUSIONS: readonly ClaimConceptExclusion[] = [
  {
    key: "tenant_pro_rata_share",
    reason: "computed: true in field-contract.ts -- always calculator-derived from square_footage/building_rsf, never itself a direct extraction target. Represented as a 'calculated' assertion_status on a claim deriving from those two concepts, not its own registered concept in lease-claims-v1.",
  },
  {
    key: "document_profile",
    reason: "inLeaseSchema: false, group 'approval_controls' -- a row-level pipeline classification (document_subtype), not an atomic fact extracted from document text. Already tracked via uploaded_files.document_subtype outside the claims ledger.",
  },
  {
    key: "approval_status",
    reason: "inLeaseSchema: false, group 'approval_controls' -- a workflow/review status (abstract_status/review_status), not an atomic extracted fact. Owned by the existing review-readiness/approval machinery (P0), not the claims ledger.",
  },
];

const EXCLUDED_KEYS = new Set(CLAIM_CONCEPT_EXCLUSIONS.map((e) => e.key));

// ---------------------------------------------------------------------------
// FieldGroup -> domain (documentation/grouping only, not DB-enforced)
// ---------------------------------------------------------------------------
const GROUP_TO_DOMAIN: Record<FieldGroup, string> = {
  document_identity: "document",
  parties: "parties",
  property_premises: "premises",
  term_dates: "term",
  rent_charges: "rent",
  expenses_recoveries: "expenses",
  cam_rules: "cam",
  taxes: "taxes",
  insurance: "insurance",
  utilities: "utilities",
  repairs_maintenance: "repairs",
  legal_options: "options",
  critical_dates: "critical_dates",
  notices: "notices",
  signatures: "signatures",
  budget_inputs: "budget",
  approval_controls: "approval",
};

// ---------------------------------------------------------------------------
// Value-type inference -- documented heuristic over real canonicalKey
// naming conventions already consistently used across all 92 entries.
// ---------------------------------------------------------------------------
export function inferValueType(canonicalKey: string): ClaimValueType {
  if (/_date$/.test(canonicalKey)) return "date";
  if (/_months$|_days$/.test(canonicalKey)) return "integer";
  if (/_rate$|_pct$|_percent$/.test(canonicalKey)) return "percentage";
  if (/address$/.test(canonicalKey)) return "address";
  if (/^square_footage$|_rsf$/.test(canonicalKey)) return "decimal";
  if (
    /_amount$|rent$|_deposit$|allowance$|_stop$|_threshold$|_consideration$|_multiplier$/.test(canonicalKey)
  ) return "money";
  if (/_required$|_enabled$/.test(canonicalKey)) return "boolean";
  return "string";
}

function comparisonStrategyFor(valueType: ClaimValueType): string {
  switch (valueType) {
    case "money": return "money_decimal_equal";
    case "decimal": return "decimal_equal";
    case "percentage": return "percentage_decimal_equal";
    case "integer": return "integer_exact_equal";
    case "date": return "date_normalized_equal";
    case "boolean": return "boolean_canonical_equal";
    case "address": return "address_conservative_equal";
    default: return "string_trimmed_case_aware_equal";
  }
}

function normalizationStrategyFor(valueType: ClaimValueType): string {
  switch (valueType) {
    case "money": return "money_to_decimal";
    case "decimal": return "decimal_parse";
    case "percentage": return "percentage_to_decimal";
    case "integer": return "integer_parse";
    case "date": return "date_to_iso";
    case "boolean": return "boolean_parse";
    case "address": return "address_normalize";
    default: return "string_trim";
  }
}

function toConceptDefinition(entry: FieldContractEntry): ClaimConceptDefinition {
  const valueType = inferValueType(entry.canonicalKey);
  return {
    conceptKey: entry.canonicalKey,
    domain: GROUP_TO_DOMAIN[entry.group],
    valueType,
    cardinality: "single",
    instanceStrategy: "singleton",
    evidenceRequired: entry.evidenceRequired,
    projectionFieldKey: entry.canonicalKey,
    compatibilitySection: entry.group,
    aliases: entry.aliases,
    comparisonStrategy: comparisonStrategyFor(valueType),
    normalizationStrategy: normalizationStrategyFor(valueType),
    introducedIn: CLAIMS_REGISTRY_VERSION,
    active: true,
  };
}

export const CLAIM_CONCEPTS: readonly ClaimConceptDefinition[] = LEASE_FIELD_CONTRACT
  .filter((entry) => !EXCLUDED_KEYS.has(entry.canonicalKey))
  .map(toConceptDefinition);

const _conceptIndex = new Map<string, ClaimConceptDefinition>();
for (const concept of CLAIM_CONCEPTS) {
  _conceptIndex.set(concept.conceptKey, concept);
}

export function getClaimConcept(conceptKey: string): ClaimConceptDefinition | undefined {
  return _conceptIndex.get(conceptKey);
}

/** dynamic.<normalized_key> namespace for unregistered/discovered claims
 * (round-1 decision #3, from unmapped_llm_keys). Mirrors the normalization
 * already used elsewhere in the codebase for key-safety: lowercase,
 * non-alphanumeric runs collapsed to a single underscore, trimmed. */
export function normalizeDynamicKey(rawKey: string): string {
  const normalized = String(rawKey ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `dynamic.${normalized || "unknown"}`;
}

// ---------------------------------------------------------------------------
// Registry validation -- run as unit tests, not just at import time, so a
// failure is loud and attributable rather than a silent startup crash.
// ---------------------------------------------------------------------------
export interface RegistryValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateClaimConceptRegistry(): RegistryValidationResult {
  const errors: string[] = [];

  // No duplicate concept keys.
  const seenKeys = new Set<string>();
  for (const concept of CLAIM_CONCEPTS) {
    if (seenKeys.has(concept.conceptKey)) {
      errors.push(`Duplicate concept key: ${concept.conceptKey}`);
    }
    seenKeys.add(concept.conceptKey);
  }

  // No duplicate projection-field mappings for single-cardinality concepts.
  const projectionFieldOwners = new Map<string, string[]>();
  for (const concept of CLAIM_CONCEPTS) {
    if (concept.cardinality !== "single" || !concept.projectionFieldKey) continue;
    const owners = projectionFieldOwners.get(concept.projectionFieldKey) ?? [];
    owners.push(concept.conceptKey);
    projectionFieldOwners.set(concept.projectionFieldKey, owners);
  }
  for (const [fieldKey, owners] of projectionFieldOwners) {
    if (owners.length > 1) {
      errors.push(`projectionFieldKey '${fieldKey}' is claimed by multiple single-cardinality concepts: ${owners.join(", ")}`);
    }
  }

  // Every alias resolves deterministically -- no alias string collides with
  // a DIFFERENT concept's own conceptKey or another concept's alias set.
  const aliasOwners = new Map<string, string>();
  for (const concept of CLAIM_CONCEPTS) {
    for (const alias of concept.aliases) {
      const existing = aliasOwners.get(alias);
      if (existing && existing !== concept.conceptKey) {
        errors.push(`Alias '${alias}' is claimed by both '${existing}' and '${concept.conceptKey}'`);
      }
      aliasOwners.set(alias, concept.conceptKey);
    }
    if (aliasOwners.has(concept.conceptKey) && aliasOwners.get(concept.conceptKey) !== concept.conceptKey) {
      errors.push(`conceptKey '${concept.conceptKey}' collides with another concept's alias`);
    }
  }

  // No dynamic namespace registered as a standard concept.
  for (const concept of CLAIM_CONCEPTS) {
    if (concept.conceptKey.startsWith("dynamic.")) {
      errors.push(`Standard registry must not contain a dynamic.* concept key: ${concept.conceptKey}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Deterministic hash of the registry content -- what the generated DB
 * snapshot (lease_claim_registry_versions.registry_hash) must match.
 * Field order within each concept is fixed explicitly (not relying on
 * object key insertion order) so the hash is stable across Node/Deno/V8
 * versions. */
export async function computeRegistryHash(): Promise<string> {
  const canonical = CLAIM_CONCEPTS
    .map((c) => [
      c.conceptKey, c.domain, c.valueType, c.cardinality, c.instanceStrategy,
      c.evidenceRequired, c.projectionFieldKey ?? "", c.compatibilitySection ?? "",
      [...c.aliases].sort().join(","), c.comparisonStrategy, c.normalizationStrategy,
      c.introducedIn, c.active,
    ].join("|"))
    .sort()
    .join("\n");
  const bytes = new TextEncoder().encode(`${CLAIMS_REGISTRY_VERSION}\n${canonical}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
