// @ts-nocheck
/**
 * Phase 6A deduplication (6A.5, correction B — the most important fix in
 * this phase's review pass).
 *
 * Deliberately NOT one flat grouping key like dedupeFacts()'s
 * (category|sourcePage|sourceText|value|llmProposedFieldKey) -- that shape
 * would put "real estate taxes: tenant" and "real estate taxes: landlord"
 * into DIFFERENT groups (different value in the key) and they would never
 * even be compared, silently missing the exact conflict this layer exists
 * to catch. Two separate concepts instead:
 *
 *  - subject identity: WHAT is being obligated (category/subcategory/
 *    obligationType/effectivePeriod/controllingDocumentId, scoped to one
 *    org/file/generation). Two obligations about the same real-world thing
 *    always share a subject key, regardless of what value each one claims.
 *  - value fingerprint: WHO/HOW (responsibleParty/beneficiaryParty/
 *    paymentMechanism/allocationMethod/amountType/amount/percentage/cap).
 *
 * Group by subject only. Within one subject group: same fingerprint + same
 * evidence -> exact duplicate (collapse); same fingerprint + different
 * evidence -> merge evidence (corroboration); different fingerprint ->
 * conflict group, every member kept, each flagged. Different subject (even
 * same category) is never touched by this function at all.
 */

import type { ExpenseObligation } from "./expense-obligation.ts";
import type { EvidenceReference } from "../evidence-reference.ts";
import { stableHash } from "./expense-obligation-identity.ts";

export function obligationSubjectKey(o: ExpenseObligation): string {
  return stableHash({
    organizationId: o.organizationId,
    fileId: o.fileId,
    generationId: o.generationId,
    category: o.category,
    subcategory: o.subcategory,
    obligationType: o.obligationType,
    effectivePeriod: o.effectivePeriod,
    controllingDocumentId: o.controllingDocumentId,
  });
}

export function obligationValueFingerprint(o: ExpenseObligation): string {
  return stableHash({
    responsibleParty: o.responsibleParty,
    beneficiaryParty: o.beneficiaryParty,
    paymentMechanism: o.paymentMechanism,
    allocationMethod: o.allocationMethod,
    amountType: o.amountType,
    amount: o.amount,
    percentage: o.percentage,
    cap: o.cap,
  });
}

function evidenceKey(evidence: EvidenceReference[]): string {
  return stableHash([...evidence].map((e) => ({ page: e.pageNumber, quote: e.quote })).sort((a, b) => (a.quote ?? "").localeCompare(b.quote ?? "")));
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/** Within a group that already shares subject + value fingerprint: collapse
 *  byte-identical-evidence duplicates first, then merge whatever distinct
 *  evidence sets remain into one corroborated obligation. */
function resolveWithinFingerprint(members: ExpenseObligation[]): { obligations: ExpenseObligation[]; duplicatesCollapsed: number; evidenceMerged: number } {
  const byEvidence = groupBy(members, (o) => evidenceKey(o.evidence));
  let duplicatesCollapsed = 0;
  const representatives: ExpenseObligation[] = [];
  for (const group of byEvidence.values()) {
    representatives.push(group[0]);
    duplicatesCollapsed += group.length - 1;
  }

  if (representatives.length === 1) {
    return { obligations: representatives, duplicatesCollapsed, evidenceMerged: 0 };
  }

  const [first, ...rest] = representatives;
  const mergedEvidence: EvidenceReference[] = [...first.evidence];
  const mergedClaimIds = [...first.sourceClaimIds];
  for (const r of rest) {
    for (const e of r.evidence) {
      if (!mergedEvidence.some((existing) => existing.quote === e.quote && existing.pageNumber === e.pageNumber)) {
        mergedEvidence.push({ ...e, role: "corroborating" });
      }
    }
    for (const id of r.sourceClaimIds) if (!mergedClaimIds.includes(id)) mergedClaimIds.push(id);
  }
  const merged: ExpenseObligation = { ...first, evidence: mergedEvidence, sourceClaimIds: mergedClaimIds };
  return { obligations: [merged], duplicatesCollapsed, evidenceMerged: rest.length };
}

export interface DedupeExpenseObligationsResult {
  deduped: ExpenseObligation[];
  duplicateObligationsCollapsed: number;
  corroboratingEvidenceMerged: number;
  conflictingObligations: number;
}

export function dedupeExpenseObligations(obligations: ExpenseObligation[]): DedupeExpenseObligationsResult {
  const bySubject = groupBy(obligations, obligationSubjectKey);

  const deduped: ExpenseObligation[] = [];
  let duplicateObligationsCollapsed = 0;
  let corroboratingEvidenceMerged = 0;
  let conflictingObligations = 0;

  for (const subjectGroup of bySubject.values()) {
    const byFingerprint = groupBy(subjectGroup, obligationValueFingerprint);

    const resolvedPerFingerprint: ExpenseObligation[][] = [];
    for (const members of byFingerprint.values()) {
      const resolved = resolveWithinFingerprint(members);
      duplicateObligationsCollapsed += resolved.duplicatesCollapsed;
      corroboratingEvidenceMerged += resolved.evidenceMerged;
      resolvedPerFingerprint.push(resolved.obligations);
    }

    if (resolvedPerFingerprint.length === 1) {
      // Only one distinct value fingerprint for this subject -- no conflict.
      deduped.push(...resolvedPerFingerprint[0]);
      continue;
    }

    // 2+ distinct value fingerprints for the SAME subject -- a real
    // conflict (e.g. real estate taxes: tenant vs real estate taxes:
    // landlord). Every member across every fingerprint sub-group is kept,
    // each flagged, counted as ONE conflict group regardless of how many
    // obligations it contains.
    conflictingObligations++;
    const allIds = resolvedPerFingerprint.flat().map((o) => o.obligationId);
    for (const bucket of resolvedPerFingerprint) {
      for (const o of bucket) {
        const otherIds = allIds.filter((id) => id !== o.obligationId);
        const reason = `Conflicts with obligation(s): ${otherIds.join(", ")}`;
        deduped.push({
          ...o,
          status: "conflicting",
          requiresReview: true,
          reviewReasons: o.reviewReasons.includes(reason) ? o.reviewReasons : [...o.reviewReasons, reason],
        });
      }
    }
  }

  return { deduped, duplicateObligationsCollapsed, corroboratingEvidenceMerged, conflictingObligations };
}
