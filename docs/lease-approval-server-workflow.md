# Lease Approval Server Workflow

## Goal

Move lease approval from browser-orchestrated side effects into one server-owned workflow so approval, rule finalization, CAM publication, critical dates, notifications, and audit writes either complete consistently or fail with a clear retry state.

## Proposed Entry Point

Create a Supabase Edge Function or Postgres RPC named `approve_lease_workflow`.

Input:

- `lease_id`
- `org_id`
- `actor_user_id`
- `approval_note`
- optional `idempotency_key`

Output:

- approved lease row
- approved rule set id
- generated audit event ids
- downstream job ids for document, notification, and CAM sync steps

## Transaction Boundary

Run these steps in one database transaction:

1. Validate actor belongs to `org_id` and can approve the lease.
2. Lock the lease row by `lease_id` and `org_id`.
3. Validate the lease is in an approvable state.
4. Mark the lease approved.
5. Resolve the active lease expense rule set.
6. Finalize approved, not-applicable, and rejected rule states using the canonical rule decision helpers.
7. Write immutable audit events for lease approval and rule status changes.
8. Insert durable workflow step rows for downstream non-transactional work.

Run these steps after commit through durable jobs:

1. Generate documents.
2. Sync eligible rules/classifications to CAM.
3. Create critical date reminders.
4. Send notifications.

## Required Guards

- Every query must filter by `org_id`.
- Workflow must be idempotent by `lease_id` plus `idempotency_key`.
- CAM publication must only use finalized classifications and approved/published rules.
- Browser clients should call this workflow and then refetch state; they should not independently perform approval side effects.

## Tests To Add

- Approves a lease and writes an audit event.
- Rejects approval for a user outside the org.
- Does not duplicate side effects when retried with the same idempotency key.
- Does not publish excluded or not-applicable rules to CAM.
- Creates downstream workflow jobs only after the lease approval transaction succeeds.

## Implementation Status

First hardening cut implemented:

- `approve-lease-workflow` Edge Function validates/authenticates requests and calls the transactional RPC.
- `public.approve_lease_workflow` owns lease approval, abstract snapshot persistence, field review mirror writes, document creation, notification creation, audit logging, critical-date upsert, and idempotent workflow-run recording.
- `LeaseReview.jsx` now calls the server workflow for the core approval write path.

Second hardening cut implemented (enterprise-readiness Phase 2):

- `approve_lease_workflow` now also inserts an immutable `lease_abstract_versions` row (one per `(lease_id, version)`, locked down by construction — no client INSERT/UPDATE policy, only the RPC writes it) in the same transaction as the `leases` UPDATE. `leases.abstract_version`/`abstract_snapshot` remain the fast "current" pointer; the new table is the queryable history.
- `approve-lease-workflow`'s edge function now calls `compute-lease` synchronously (internal service-to-service call, same request/response cycle) immediately after the RPC returns, so the approved rent schedule (`rent_schedules` rows) is guaranteed to exist before the approval response comes back — instead of depending on a client-side fire-and-forget `triggerCompute("compute-lease", ...)` call that could silently never complete. Reuses `compute-lease`'s existing `ensureApprovedRentSchedules` idempotent refresh-on-version-change logic rather than duplicating it. A rent-schedule failure is surfaced in the response (`rent_schedule.status`) but does not roll back the already-committed approval.
- Verified end-to-end against a real local Supabase instance (HTTP call to the deployed edge function, not just the RPC) in `supabase/functions/_tests/lease-approval-rent-schedule-atomicity.property.test.ts`: confirms one version row and correct monthly `rent_schedules` rows are created, and that retrying with the same idempotency key duplicates neither.

Still intentionally deferred:

- Server-side rule generation.
- Server-side lease-derived expense sync.
- Server-side expense classification.
- Folding the multi-fiscal-year/multi-projection-mode snapshot warm-up (still triggered client-side from `LeaseReview.jsx` after approval, for the Rent Projection page's aggregate views) into the same synchronous server-side chain — only the single lease's own approved rent schedule was made synchronous, not the broader property-wide projection snapshots.
