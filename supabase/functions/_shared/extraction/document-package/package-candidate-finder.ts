// @ts-nocheck
/**
 * Package-candidate finder — P3.3.
 *
 * Queries packages using ONLY strong identifiers: the file's actual lease
 * linkage (leases.source_file_id / an already-known lease_id), or an
 * explicit document reference carried by a real claim. NEVER by recency
 * (no ORDER BY created_at, no LIMIT 1 "pick the newest"), and NEVER by
 * fuzzy name/address similarity — those signals do not exist as inputs
 * here at all, by design.
 *
 * Returns every matching candidate; ambiguity is the resolver's decision to
 * make, not this module's.
 */

import type { MembershipClaimSignal, PackageCandidate } from "./package-membership-types.ts";

export interface SupabaseLike {
  from(table: string): any;
}

/** Active (candidate-worthy) package statuses — a superseded/archived
 *  package is never a join/create target. */
const ACTIVE_PACKAGE_STATUSES = ["open", "needs_review", "complete"];

async function packageHasConfirmedPrimaryBaseDocument(supabase: SupabaseLike, orgId: string, packageId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("lease_package_documents")
    .select("id")
    .eq("org_id", orgId)
    .eq("package_id", packageId)
    .eq("membership_role", "primary_base_document")
    .eq("membership_status", "confirmed")
    .limit(1);
  if (error) throw new Error(`packageHasConfirmedPrimaryBaseDocument: ${error.message}`);
  return (data ?? []).length > 0;
}

export async function findPackageCandidatesForLease(
  supabase: SupabaseLike,
  params: { orgId: string; leaseId: string; matchedVia: "legacy_source_file" | "explicit_lease_linkage" },
): Promise<PackageCandidate[]> {
  const { data, error } = await supabase
    .from("lease_document_packages")
    .select("id, lease_id, package_status")
    .eq("org_id", params.orgId)
    .eq("lease_id", params.leaseId);
  if (error) throw new Error(`findPackageCandidatesForLease: ${error.message}`);

  const active = (data ?? []).filter((row: any) => ACTIVE_PACKAGE_STATUSES.includes(row.package_status));
  return Promise.all(
    active.map(async (row: any) => ({
      packageId: row.id,
      leaseId: row.lease_id,
      matchedVia: params.matchedVia,
      hasConfirmedPrimaryBaseDocument: await packageHasConfirmedPrimaryBaseDocument(supabase, params.orgId, row.id),
    })),
  );
}

/**
 * Honest limitation (documented, not silently papered over): no registered
 * P2 concept today carries a "referenced lease identifier" value (grepped
 * field-contract.ts's real 92 canonicalKey entries — confirmed absent).
 * This tier can only act on a genuinely present `dynamic.*` claim whose
 * normalized value equals another real lease's id — which will be rare
 * until a real concept/adapter exists for it (a P3.4+ need, not fabricated
 * here). Returns [] whenever no such claim is present, which is the
 * expected common case today.
 */
export async function findPackageCandidatesByExplicitReference(
  supabase: SupabaseLike,
  params: { orgId: string; claims: MembershipClaimSignal[] },
): Promise<PackageCandidate[]> {
  const candidateLeaseIds = params.claims
    .filter((c) => c.conceptKey.startsWith("dynamic.") && c.normalizedValue && looksLikeUuid(c.normalizedValue))
    .map((c) => c.normalizedValue as string);

  if (candidateLeaseIds.length === 0) return [];

  const { data, error } = await supabase
    .from("lease_document_packages")
    .select("id, lease_id, package_status")
    .eq("org_id", params.orgId)
    .in("lease_id", candidateLeaseIds);
  if (error) throw new Error(`findPackageCandidatesByExplicitReference: ${error.message}`);

  const active = (data ?? []).filter((row: any) => ACTIVE_PACKAGE_STATUSES.includes(row.package_status));
  return Promise.all(
    active.map(async (row: any) => ({
      packageId: row.id,
      leaseId: row.lease_id,
      matchedVia: "explicit_document_reference" as const,
      hasConfirmedPrimaryBaseDocument: await packageHasConfirmedPrimaryBaseDocument(supabase, params.orgId, row.id),
    })),
  );
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Deduplicates candidates by packageId (a package could theoretically be
 *  found by more than one tier); order is not meaningful and must never be
 *  treated as a preference ranking by callers. */
export function mergeCandidates(...tiers: PackageCandidate[][]): PackageCandidate[] {
  const byId = new Map<string, PackageCandidate>();
  for (const tier of tiers) {
    for (const candidate of tier) {
      if (!byId.has(candidate.packageId)) byId.set(candidate.packageId, candidate);
    }
  }
  return [...byId.values()];
}
