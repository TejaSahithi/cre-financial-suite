# Lease Financial Platform Architectural Principles

These are the standing rules for every financial evaluator added to this
platform: resolved lease terms, management fee, percentage rent, CPI/reference
data, and later charge orchestration. They codify patterns CAM Engine V2
already proved out; new work follows them rather than re-deriving its own.

## 1. Deterministic Calculations

Same approved inputs produce the same output every time. No calculation may
read wall-clock time, random values, or any other non-reproducible input as
part of its core logic. `asOfDate` is always an explicit parameter.

## 2. Frozen Inputs

A calculation function receives one snapshot, built once, and never re-queries
mid-calculation. CAM V2 already follows this pattern; the lease-terms facade
does the same split: a loader performs I/O once, then pure functions resolve
and calculate from that frozen snapshot.

## 3. Immutable Approved State

Approved or posted results change only through a new version, a recalculation,
or an explicit approved adjustment. Approved lease abstractions, approved rent
schedule rows, and approved expense rule sets are authority boundaries.

## 4. AI Is Not An Accounting Authority

Extraction candidates never reach a financial calculation directly. Financial
flows consume human-approved data from `leases.abstract_snapshot`,
`rent_schedules`, and approved rule sets. AI may propose evidence; approval
creates authority.

## 5. External Data Provenance

When a calculation depends on external data, such as CPI from BLS, the stored
observation must carry provider, series id, observation period, value,
retrieved-at timestamp, and payload fingerprint. Calculations consume stored,
approved observations, not live refetches.

## 6. Fail Closed

Never substitute zero, false, empty string, or an assumed value for missing
financial input. Return a named, structured exception or unresolved term so a
reviewer can fix the data intentionally.

## 7. Effective Dating

Every rule that can change over time resolves against the period it applies to,
not the latest value. Where a domain has no per-period model yet, the result
must say `effectiveDatingSupported: false`.

## 8. Multi-Tenancy And Access

Every new organization-owned domain must preserve `org_id` isolation and use
the existing edge-function auth pattern: `verifyUser`, `getUserOrgId`,
`assertPageAccess`, then org-scoped queries. Client-supplied organization ids
are never trusted as financial authority.
