# Rule/CAM Hardening Plan

## Goal

Create one canonical rule and CAM status engine before moving rule approval, rejection, or CAM publication into server-owned workflows.

This sprint must not serverize duplicated or inconsistent client/service logic as-is. The first job is to make financial decisions deterministic, tested, and owned by one module.

## Sequencing

1. Canonical status engine.
2. Server-owned rule approve/reject workflows.
3. Server-owned publish-to-CAM workflow.
4. Finance-chain integration tests.
5. Repo hygiene only after financial behavior is green.

## Non-Negotiable Invariant

There must be exactly one source of truth for:

- rule status
- recoverability decision
- `not_applicable` / exclusion decision
- CAM eligibility
- publish-to-CAM eligibility

Any page, service, Edge Function, or RPC that needs these decisions must call the canonical engine or consume values produced by it. No caller should re-derive these decisions independently.

## Canonical Engine Target

Create a dedicated rule decision module, then route existing helpers through it:

- `src/features/lease-rules/domain/ruleDecisionEngine.js`
- or, if feature folders are not ready yet, `src/services/utils/ruleDecisionEngine.js`

The engine should expose pure functions:

- `deriveRuleDecision(rule)`
- `deriveRecoverabilityDecision(rule)`
- `deriveExclusionDecision(rule)`
- `deriveCamEligibility(rule)`
- `derivePublishToCamEligibility(rule)`
- `deriveRuleSetStatus(rules)`

The output should be structured, not just strings:

```js
{
  status: "approved" | "rejected" | "needs_review" | "not_applicable" | "draft",
  recoverability: "recoverable" | "not_recoverable" | "conditional" | "unknown",
  exclusion: "not_applicable" | "excluded" | "included" | "unknown",
  camEligibility: "eligible" | "not_eligible" | "conditional" | "unknown",
  publishToCamEligibility: "eligible" | "blocked" | "already_published",
  blockingReasons: [],
}
```

## Client Boundary

The browser may:

- display review state
- collect reviewer intent
- submit approve/reject/publish requests
- refetch workflow results

The browser must not directly write:

- final rule approval status
- CAM publication rows
- audit rows for server-owned actions
- notification side effects for server-owned actions

## Server Workflow Requirements

Every server-owned financial workflow must require `idempotency_key`.

Reusing the same `idempotency_key` with the same request payload must return the same result without duplicated side effects.

Reusing the same `idempotency_key` with a different request payload must be rejected.

Every server-owned approve/reject/publish action must create an immutable audit row with:

- `org_id`
- `actor_user_id`
- `source = 'edge_function'`
- `workflow_run_id`
- before/after status where applicable
- reason/comment where applicable

Every RPC and Edge Function must verify:

- user belongs to org
- acting org is valid
- target lease/rule belongs to same org
- user has permission for the action

## Implementation Plan

### Phase 1: Canonicalize Rule/CAM Decisions

Status: implemented as the first hardening cut.

- Inventory all current decision call sites in:
  - `src/lib/ruleStatus.js`
  - `src/lib/expenseEligibility.js`
  - `src/services/utils/leaseExpenseRuleStatus.js`
  - `src/services/utils/leaseExpenseRuleDecisions.js`
  - `src/services/leaseExpenseRuleService.js`
  - `src/services/expenseService.js`
- Added the canonical engine as `src/services/utils/ruleDecisionEngine.js`.
- Moved status, recoverability, exclusion, CAM eligibility, and publish-to-CAM eligibility into that engine.
- Kept old exports temporarily as compatibility wrappers.
- Replaced high-risk direct checks in lease expense rule status, expense eligibility, and CAM publishability with calls to the canonical engine.
- Added decision matrix tests in `src/services/utils/ruleDecisionEngine.test.js`.

### Phase 2: Server-Owned Rule Approve/Reject

Status: implemented as the second hardening cut.

- Added `lease_expense_rule_workflow_runs` for idempotency, payload replay protection, and retry observability.
- Added the transactional `public.review_lease_expense_rule_workflow(...)` RPC for approve, reject, and not-applicable review actions.
- Added Edge Functions:
  - `approve-lease-expense-rule`
  - `reject-lease-expense-rule`
  - `mark-lease-expense-rule-not-applicable`
- Moved final rule status writes, immutable audit rows, notification inserts, and rule-set status recalculation server-side.
- Updated `LeaseExpenseRules.jsx` so the browser submits review intent instead of writing final approval/rejection/not-applicable state directly.
- Stopped the rule edit path from recomputing `published_to_cam`; publish-to-CAM remains blocked until Phase 3.

### Phase 3: Server-Owned Publish-To-CAM

Status: implemented as the third hardening cut.

- Added `lease_expense_rule_cam_publish_runs` for idempotency, payload replay protection, and retry observability.
- Added the transactional `public.publish_lease_expense_rule_to_cam_workflow(...)` RPC.
- Added the Edge Function:
  - `publish-lease-expense-rule-to-cam`
- Validate publish eligibility before updating `published_to_cam`.
- Reject idempotency key reuse with a different request payload.
- Return the stored response for idempotent retries.
- Return `already_published: true` without duplicate audit or notification side effects.
- Updated the client CAM publish path so rule publication goes through the server workflow.

### Phase 4: Finance-Chain Tests

Status: started. Focused unit and Edge Function tests now cover the decision engine and server workflow request boundaries. A DB-backed integration suite is still required once migrations are applied in a test Supabase environment.

Add integration-style tests for:

`approve lease -> approve/reject rules -> publish eligible rules to CAM -> classify expense -> audit trail`

Current coverage includes:

- canonical rule/CAM decision matrix tests
- rule approve/reject/not-applicable Edge payload validation tests
- publish-to-CAM Edge payload and blocker tests
- client workflow wrapper tests confirming browser intent goes through Edge Functions

### Phase 5: Repo Hygiene

Status: deferred. Keep destructive cleanup deferred until the financial workflow migrations are applied and DB-backed tests are green.

Only after financial behavior is green:

- remove scratch scripts
- remove generated artifacts
- clean tracked logs/binaries
- reorganize docs and feature modules

## Required Tests

Before implementation is accepted, tests must cover:

- approved rule
- rejected rule
- `needs_review` rule
- explicit exclusion / `not_applicable` rule
- CAM eligible approved rule
- already published rule
- missing mapping or blocking reason
- duplicate publish attempt
- cross-org denial
- non-authorized user denial
- idempotent retry
- idempotency key reused with different payload

## Acceptance Criteria

Sprint 2 is done enough when:

- one canonical engine owns every rule/CAM decision listed above
- old helper modules delegate to the canonical engine or are removed
- tests cover the required decision matrix
- no server workflow is added until canonical decision tests pass
- approve/reject workflows require idempotency and audit rows
- publish-to-CAM workflow requires idempotency and canonical eligibility
- browser code submits intent but does not write final server-owned side effects
