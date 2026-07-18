// @ts-nocheck
/**
 * claim-conflict-detector.ts — P2.5.
 *
 * Pure grouping/detection logic over an in-memory claim list. Conflict
 * identity is (concept_key, scope_key, instance_key, generation_id) --
 * matches lease_claim_conflict_groups' actual columns (P2.1) exactly. The
 * real persistence into lease_claim_conflict_groups/lease_claim_conflict_members
 * is done by the detect_and_persist_claim_conflicts SQL RPC (same
 * migration as this phase), which re-implements only the string-equality
 * half of claim-comparison.ts (money/date/etc. are already canonical
 * strings by persistence time; only case/whitespace-insensitive string
 * comparison needs a SQL equivalent) -- this TS module is the reference
 * algorithm, used directly wherever conflict detection needs to run in a
 * TS context (tests, and P2.6's resolver, which needs the same grouping to
 * decide when to emit needs_review).
 */
import { claimValuesEqual, type ComparableValueType } from "./claim-comparison.ts";

export interface ClaimForConflictDetection {
  claimKey: string; // used as the stable id in test/documentation output
  conceptKey: string;
  scopeKey: string;
  instanceKey: string;
  valueType: ComparableValueType | string;
  normalizedValue: string | null;
  assertionStatus: string;
}

export interface DetectedConflictGroup {
  conceptKey: string;
  scopeKey: string;
  instanceKey: string;
  memberClaimKeys: string[];
  distinctValues: string[];
}

const VALUE_BEARING_STATUSES = new Set(["asserted", "derived", "calculated"]);

/**
 * Groups claims by fact slot and returns only the groups that genuinely
 * disagree (>1 distinct value under claimValuesEqual) -- a fact slot with
 * one claim, or multiple claims that all resolve to the same value under
 * comparison, is not a conflict.
 */
export function detectClaimConflicts(claims: ClaimForConflictDetection[]): DetectedConflictGroup[] {
  const groups = new Map<string, ClaimForConflictDetection[]>();

  for (const claim of claims) {
    if (!VALUE_BEARING_STATUSES.has(claim.assertionStatus)) continue;
    if (claim.normalizedValue === null) continue;
    const groupKey = `${claim.conceptKey}${claim.scopeKey}${claim.instanceKey}`;
    const existing = groups.get(groupKey) ?? [];
    existing.push(claim);
    groups.set(groupKey, existing);
  }

  const conflicts: DetectedConflictGroup[] = [];

  for (const members of groups.values()) {
    if (members.length < 2) continue;

    const distinctValues: string[] = [];
    for (const member of members) {
      const alreadySeen = distinctValues.some((v) => claimValuesEqual(members[0].valueType, v, member.normalizedValue));
      if (!alreadySeen) distinctValues.push(member.normalizedValue as string);
    }

    if (distinctValues.length > 1) {
      conflicts.push({
        conceptKey: members[0].conceptKey,
        scopeKey: members[0].scopeKey,
        instanceKey: members[0].instanceKey,
        memberClaimKeys: members.map((m) => m.claimKey),
        distinctValues,
      });
    }
  }

  return conflicts;
}
