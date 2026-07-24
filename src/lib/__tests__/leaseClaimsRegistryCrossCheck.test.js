// P2.1 round-2 correction #10 — cross-check all three existing field
// registries (LEASE_REVIEW_FIELDS, LEASE_FIELD_CONTRACT, FIELD_ALIASES)
// against the new claims concept registry, so a field known to only one of
// the three vocabularies can never be silently unrepresented in the ledger.
//
// This test imports both frontend (src/lib) and backend
// (supabase/functions/_shared) modules directly. It must run under Vitest,
// not Deno: leaseReviewSchema.js/leaseFieldResolver.js use extensionless
// relative imports (bundler-resolved), which Deno's module resolver does
// not accept without an explicit file extension.
import { describe, it, expect } from "vitest";
import { LEASE_REVIEW_FIELDS } from "../leaseReviewSchema";
import { FIELD_ALIASES, getFieldAliases, normalizeLeaseFieldKey } from "../leaseFieldResolver";
import {
  LEASE_FIELD_CONTRACT,
  resolveCanonicalKey,
  getFieldContract,
} from "../../../supabase/functions/_shared/extraction/field-contract.ts";
import {
  CLAIM_CONCEPTS,
  CLAIM_CONCEPT_EXCLUSIONS,
  getClaimConcept,
  validateClaimConceptRegistry,
} from "../../../supabase/functions/_shared/extraction/claims/concept-registry.ts";

// ---------------------------------------------------------------------------
// Resolution bridge: a LEASE_REVIEW_FIELDS key may match a claim concept
// directly, via field-contract.ts's own alias index, or via the separate
// FIELD_ALIASES resolver bridge (the two registries use different canonical
// spellings for some of the same real fields -- e.g. premises_address vs.
// property_address -- bridged only by FIELD_ALIASES today).
// ---------------------------------------------------------------------------
function resolveToConcept(key) {
  if (getClaimConcept(key)) return key;
  const viaContract = resolveCanonicalKey(key);
  if (viaContract !== key && getClaimConcept(viaContract)) return viaContract;
  for (const candidate of getFieldAliases(key)) {
    if (getClaimConcept(candidate)) return candidate;
    const viaContractFromCandidate = resolveCanonicalKey(candidate);
    if (getClaimConcept(viaContractFromCandidate)) return viaContractFromCandidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Explicit, documented exclusion list (round-2 correction #10's mandated
// "or appears in an explicit, documented exclusion list" clause) for
// LEASE_REVIEW_FIELDS keys that have no representation anywhere in
// LEASE_FIELD_CONTRACT / FIELD_ALIASES today. This is a pre-existing gap in
// the extraction contract (not something P2.1 introduces or is scoped to
// fix -- P2 policy is no canonical-layout redesign), documented here so it
// is never silently unrepresented.
// ---------------------------------------------------------------------------
const REVIEW_FIELD_EXCLUSIONS = {
  parking_rights: "Not present in LEASE_FIELD_CONTRACT or FIELD_ALIASES at all -- pre-existing UI-only field with no extraction-contract counterpart.",
  common_area_description: "Not present in LEASE_FIELD_CONTRACT or FIELD_ALIASES at all -- pre-existing UI-only field with no extraction-contract counterpart.",
  late_fee_grace_days: "Not present in LEASE_FIELD_CONTRACT or FIELD_ALIASES -- distinct from late_fee_amount ($) and late_fee_percent (%), neither of which covers a grace-period day count.",
  late_fee_percent: "FIELD_ALIASES has a 'late_fee_percent' entry but none of its aliases (late_fee, late_charge_percent) are LEASE_FIELD_CONTRACT canonicalKeys -- the contract only models late_fee_amount ($), not a percentage variant.",
  default_interest_rate_formula: "FIELD_ALIASES models a related 'default_interest_percent' key, but its normalized form does not match this UI key, and neither resolves to a LEASE_FIELD_CONTRACT canonicalKey -- pre-existing gap.",
  renewal_option: "Distinct boolean UI flag ('does a renewal option exist') from the registered 'renewal_options' concept (the detail/type field). FIELD_ALIASES lists 'renewal_option' only as a value under the 'renewal_options' key, not as its own resolvable entry, so the boolean flag itself has no LEASE_FIELD_CONTRACT concept.",
  termination_option: "Distinct from the registered 'early_termination_option' concept; LEASE_FIELD_CONTRACT does not separately model a general (non-early) termination option flag.",
  sublease_rights: "Not present in LEASE_FIELD_CONTRACT or FIELD_ALIASES at all -- pre-existing UI-only field with no extraction-contract counterpart.",
  holdover_rent_multiplier: "FIELD_ALIASES has a 'holdover_multiplier' entry (not an exact key match for this UI field's normalized name) whose aliases are not LEASE_FIELD_CONTRACT canonicalKeys -- pre-existing gap.",
  floor_plan_reference: "The 'Documents / Exhibits' UI tab (floor_plan_reference, exhibit_reference, guaranty_reference) has no corresponding FieldGroup in LEASE_FIELD_CONTRACT at all -- an entire pre-existing UI section absent from the extraction contract.",
  exhibit_reference: "See floor_plan_reference -- same 'Documents / Exhibits' tab gap.",
  guaranty_reference: "See floor_plan_reference -- same 'Documents / Exhibits' tab gap.",
};

describe("P2.1 cross-registry audit (LEASE_REVIEW_FIELDS / LEASE_FIELD_CONTRACT / FIELD_ALIASES / claim concepts)", () => {
  it("registry validation passes with zero errors", () => {
    const result = validateClaimConceptRegistry();
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("every LEASE_REVIEW_FIELDS key resolves to exactly one claim concept, or is on a documented exclusion list", () => {
    const conceptExcludedKeys = new Set(CLAIM_CONCEPT_EXCLUSIONS.map((e) => e.key));
    const unexplained = [];
    for (const field of LEASE_REVIEW_FIELDS) {
      const resolved = resolveToConcept(field.key);
      // A review field resolves via field-contract's canonical/alias index even
      // when the underlying concept was deliberately excluded from CLAIM_CONCEPTS
      // (e.g. tenant_pro_rata_share -- computed, documented in
      // CLAIM_CONCEPT_EXCLUSIONS) -- that's the concept registry's own exclusion
      // list already satisfying this requirement, not a second undocumented gap.
      const viaConceptExclusion = conceptExcludedKeys.has(resolveCanonicalKey(field.key));
      const excluded = Object.prototype.hasOwnProperty.call(REVIEW_FIELD_EXCLUSIONS, field.key);
      if (!resolved && !viaConceptExclusion && !excluded) unexplained.push(field.key);
    }
    expect(unexplained).toEqual([]);
  });

  it("every documented REVIEW_FIELD_EXCLUSIONS entry is a real LEASE_REVIEW_FIELDS key and genuinely does not resolve", () => {
    const reviewKeys = new Set(LEASE_REVIEW_FIELDS.map((f) => f.key));
    for (const [key, reason] of Object.entries(REVIEW_FIELD_EXCLUSIONS)) {
      expect(reviewKeys.has(key), `'${key}' is not a real LEASE_REVIEW_FIELDS key`).toBe(true);
      expect(reason.length, `exclusion for '${key}' needs a real documented reason`).toBeGreaterThan(20);
      expect(resolveToConcept(key), `'${key}' is documented as excluded but actually resolves now -- remove the stale exclusion`).toBeNull();
    }
  });

  it("no LEASE_REVIEW_FIELDS key is both resolvable and mistakenly also excluded", () => {
    for (const field of LEASE_REVIEW_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(REVIEW_FIELD_EXCLUSIONS, field.key)) {
        expect(resolveToConcept(field.key)).toBeNull();
      }
    }
  });

  // -------------------------------------------------------------------------
  // FIELD_ALIASES consistency: no single FIELD_ALIASES entry may bundle
  // together alias strings that resolve to two DIFFERENT, unrelated
  // registered claim concepts -- that would mean the frontend resolver
  // silently conflates two distinct real-world facts. A resolved pair IS
  // allowed when LEASE_FIELD_CONTRACT itself documents them as a deliberate
  // "OR-alternate" pair via `alternateFieldKeys` (e.g. commencement_date /
  // start_date) -- self-documenting via the contract, no manual list needed.
  // Anything else must appear in the small, manually-reasoned
  // KNOWN_ALIAS_AMBIGUITIES list below, or the test fails.
  // -------------------------------------------------------------------------
  const KNOWN_ALIAS_AMBIGUITIES = {
    assignment_rights: "FIELD_ALIASES bundles 'assignment_provisions' (general lease provisions about assignment) and 'landlord_consent' (a specific, document-profile-scoped consent field) under one 'assignment_rights' alias entry. These are NOT declared as alternateFieldKeys of each other in LEASE_FIELD_CONTRACT -- a genuine pre-existing looseness in the frontend resolver, not introduced or fixed by P2.1 (out of scope: no canonical-layout redesign).",
  };

  function areAlternateFields(a, b) {
    const entryA = getFieldContract(a);
    const entryB = getFieldContract(b);
    return Boolean(
      entryA?.alternateFieldKeys?.includes(b) || entryB?.alternateFieldKeys?.includes(a),
    );
  }

  it("every FIELD_ALIASES entry resolves to a single canonical concept, or is a documented alternateFieldKeys pair, or a documented known ambiguity", () => {
    const unexplained = [];
    for (const [aliasKey, values] of Object.entries(FIELD_ALIASES)) {
      const resolvedConcepts = new Set();
      for (const value of values) {
        const norm = normalizeLeaseFieldKey(value);
        const viaContract = resolveCanonicalKey(norm);
        if (getClaimConcept(viaContract)) resolvedConcepts.add(viaContract);
        else if (getClaimConcept(norm)) resolvedConcepts.add(norm);
      }
      if (resolvedConcepts.size <= 1) continue;

      const concepts = [...resolvedConcepts];
      const allPairsAreAlternates = concepts.every((c1, i) =>
        concepts.slice(i + 1).every((c2) => areAlternateFields(c1, c2)),
      );
      if (allPairsAreAlternates) continue;
      if (Object.prototype.hasOwnProperty.call(KNOWN_ALIAS_AMBIGUITIES, aliasKey)) continue;

      unexplained.push({ aliasKey, resolvedConcepts: concepts });
    }
    expect(unexplained).toEqual([]);
  });

  it("every KNOWN_ALIAS_AMBIGUITIES entry is a real FIELD_ALIASES key with a real reason", () => {
    for (const [key, reason] of Object.entries(KNOWN_ALIAS_AMBIGUITIES)) {
      expect(Object.prototype.hasOwnProperty.call(FIELD_ALIASES, key), `'${key}' is not a real FIELD_ALIASES key`).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("projectionFieldKey is unique across single-cardinality concepts", () => {
    const owners = new Map();
    for (const concept of CLAIM_CONCEPTS) {
      if (concept.cardinality !== "single" || !concept.projectionFieldKey) continue;
      const existing = owners.get(concept.projectionFieldKey) ?? [];
      existing.push(concept.conceptKey);
      owners.set(concept.projectionFieldKey, existing);
    }
    const duplicates = [...owners.entries()].filter(([, owners]) => owners.length > 1);
    expect(duplicates).toEqual([]);
  });

  it("every LEASE_FIELD_CONTRACT entry is registered as a concept or on the concept-registry's own exclusion list", () => {
    const excludedKeys = new Set(CLAIM_CONCEPT_EXCLUSIONS.map((e) => e.key));
    const unexplained = LEASE_FIELD_CONTRACT
      .filter((entry) => !getClaimConcept(entry.canonicalKey) && !excludedKeys.has(entry.canonicalKey))
      .map((entry) => entry.canonicalKey);
    expect(unexplained).toEqual([]);
  });
});
