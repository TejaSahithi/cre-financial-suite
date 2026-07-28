// @ts-nocheck
/**
 * Phase 6A shadow diagnostics (6A.7, corrections G/H).
 *
 * authoritativeMutationCount is MEASURED (before/after snapshot diff of the
 * authoritative objects this layer reads), not hard-coded to 0 -- a real
 * runtime tripwire against accidental shared-reference mutation, not just
 * a "nothing here calls .update()" assumption. runStatus records WHY the
 * layer produced whatever it produced, so an empty
 * canonical_expense_obligations array is never ambiguous between "flag
 * off" and "5 specialists ran and genuinely found nothing."
 */

import type { ExpenseObligation } from "./expense-obligation.ts";
import type { DedupeExpenseObligationsResult } from "./expense-obligation-dedup.ts";
import type { ExpenseCanonicalMappingProposal, ExpenseDynamicRowProposal } from "./expense-obligation-projection.ts";

export type CanonicalExpenseRunStatus =
  | "success"
  | "flag_off"
  | "organization_not_admitted"
  | "specialist_output_missing"
  | "no_obligations"
  | "conversion_failed";

export interface CanonicalExpenseMetrics {
  runStatus: CanonicalExpenseRunStatus;

  specialistObligationCount: number;
  canonicalObligationCount: number;

  obligationsWithValidEvidence: number;
  obligationsNeedingReview: number;
  conflictingObligations: number;

  exactCanonicalMappings: number;
  dynamicRowProposals: number;

  duplicateObligationsCollapsed: number;
  corroboratingEvidenceMerged: number;

  invalidObligationCount: number;
  authoritativeMutationCount: number;
}

export function computeCanonicalExpenseMetrics(args: {
  runStatus: CanonicalExpenseRunStatus;
  specialistObligationCount: number;
  invalidObligationCount: number;
  dedupResult: Pick<DedupeExpenseObligationsResult, "duplicateObligationsCollapsed" | "corroboratingEvidenceMerged" | "conflictingObligations">;
  finalObligations: ExpenseObligation[];
  canonicalMappings: ExpenseCanonicalMappingProposal[];
  dynamicRows: ExpenseDynamicRowProposal[];
  authoritativeMutationCount: number;
}): CanonicalExpenseMetrics {
  return {
    runStatus: args.runStatus,
    specialistObligationCount: args.specialistObligationCount,
    canonicalObligationCount: args.finalObligations.length,
    obligationsWithValidEvidence: args.finalObligations.filter((o) => o.verificationStatus === "verified").length,
    obligationsNeedingReview: args.finalObligations.filter((o) => o.requiresReview).length,
    conflictingObligations: args.dedupResult.conflictingObligations,
    exactCanonicalMappings: args.canonicalMappings.length,
    dynamicRowProposals: args.dynamicRows.length,
    duplicateObligationsCollapsed: args.dedupResult.duplicateObligationsCollapsed,
    corroboratingEvidenceMerged: args.dedupResult.corroboratingEvidenceMerged,
    invalidObligationCount: args.invalidObligationCount,
    authoritativeMutationCount: args.authoritativeMutationCount,
  };
}

export function emptyCanonicalExpenseMetrics(runStatus: CanonicalExpenseRunStatus, authoritativeMutationCount = 0): CanonicalExpenseMetrics {
  return {
    runStatus,
    specialistObligationCount: 0,
    canonicalObligationCount: 0,
    obligationsWithValidEvidence: 0,
    obligationsNeedingReview: 0,
    conflictingObligations: 0,
    exactCanonicalMappings: 0,
    dynamicRowProposals: 0,
    duplicateObligationsCollapsed: 0,
    corroboratingEvidenceMerged: 0,
    invalidObligationCount: 0,
    authoritativeMutationCount,
  };
}

// ── Authoritative-mutation tripwire (correction G) ───────────────────────────
//
// stableCanonicalize/deepEqual/countChangedPaths are generic (not specific
// to ExpenseObligation) -- orchestrator.ts snapshots whatever authoritative
// objects this layer reads (fieldSnapshot, mapped.records) before and after
// invoking the canonical-expense pipeline and diffs them with these.

export function stableCanonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableCanonicalize);
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = stableCanonicalize((value as Record<string, unknown>)[key]);
  return out;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(stableCanonicalize(a)) === JSON.stringify(stableCanonicalize(b));
}

/** Counts leaf-value differences between two canonicalized structures --
 *  used only for a diagnostic count (how many paths changed), not for
 *  identifying WHICH paths (not needed by any current caller). */
export function countChangedPaths(before: unknown, after: unknown): number {
  const a = stableCanonicalize(before);
  const b = stableCanonicalize(after);
  if (a === b) return 0;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
  }
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return 1;
  if (aIsArray && bIsArray) {
    const maxLen = Math.max(a.length, b.length);
    let changed = 0;
    for (let i = 0; i < maxLen; i++) changed += countChangedPaths(a[i], b[i]);
    return changed;
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  let changed = 0;
  for (const key of keys) changed += countChangedPaths((a as any)[key], (b as any)[key]);
  return changed;
}
