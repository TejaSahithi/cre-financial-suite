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

Still intentionally deferred:

- Server-side rule generation.
- Server-side lease-derived expense sync.
- Server-side expense classification.
- Server-side compute orchestration.
