// @ts-nocheck
/**
 * P3.5 package claim loader.
 *
 * This maps bounded package graph rows into the pure resolver input shape.
 * It is intentionally a helper, not a runtime call site.
 */

export function mapPackageResolutionRows(rows: {
  orgId: string;
  packageId: string;
  leaseId?: string | null;
  documents: unknown[];
  claims: unknown[];
  relationships: unknown[];
  requirements?: unknown[];
  reviewerDecisions?: unknown[];
}) {
  return {
    orgId: rows.orgId,
    packageId: rows.packageId,
    leaseId: rows.leaseId ?? null,
    documents: [...(rows.documents ?? [])],
    claims: [...(rows.claims ?? [])],
    relationships: [...(rows.relationships ?? [])],
    requirements: [...(rows.requirements ?? [])],
    reviewerDecisions: [...(rows.reviewerDecisions ?? [])],
  };
}

export function loadPackageResolutionInput(rows: Parameters<typeof mapPackageResolutionRows>[0]) {
  return mapPackageResolutionRows(rows);
}