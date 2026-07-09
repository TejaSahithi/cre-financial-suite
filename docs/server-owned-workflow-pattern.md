# Server-Owned Workflow Pattern (Canonical Template)

## Goal

`docs/lease-approval-server-workflow.md` and `docs/rule-cam-hardening-plan.md` each shipped a server-owned workflow independently (lease approval; rule approve/reject/publish-to-CAM). Read together, both landed on the same shape. This doc names that shape once so every future workflow (expense classification, CAM/lease config writes, budget generation, and anything else on `docs/enterprise-repo-structure.md`'s refactor list) is built from the same mold instead of a fresh variant.

This is documentation only — it does not change the behavior of `approve_lease_workflow` or `send_expense_classification_to_cam_workflow`. It also records two drifts between them that new workflows should not copy, and that a later hardening pass should reconcile in the existing two.

## The template

**1. Idempotency-run table** (one per workflow, e.g. `lease_approval_workflow_runs`, `expense_classification_cam_send_runs`):

- `org_id`, an entity-id column (`lease_id`, `classification_id`, ...), `idempotency_key TEXT NOT NULL`, `status TEXT CHECK (IN ('started','completed','failed'))`, `request_payload`/`response_payload JSONB`, `error_message TEXT`, `actor_user_id`/`actor_email`, `started_at`/`completed_at`/`created_at`/`updated_at`.
- `UNIQUE (org_id, idempotency_key)`.
- RLS enabled: `SELECT`/`INSERT`/`UPDATE` policies gated by `is_super_admin() OR can_write_org_data(org_id)` (for `INSERT`/`UPDATE`) and `org_id = ANY(get_my_org_ids())` (for `SELECT`). The run table is not written by the browser directly — only by the RPC itself under `SECURITY DEFINER` — the RLS policies exist so authenticated org members can read run history, not to gate the RPC's own writes.
- `updated_at` maintained by the existing shared trigger `public.set_workflow_updated_at()` — reuse it, don't redefine it per workflow.

**2. The RPC itself:**

```
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
```

Body, in order:
1. Validate required params (`org_id`, entity id, `idempotency_key`, any business-required field) with `RAISE EXCEPTION` on missing/blank.
2. Insert the run row `ON CONFLICT (org_id, idempotency_key) DO NOTHING` (or `DO UPDATE SET updated_at = now()`), then re-`SELECT ... FOR UPDATE` the run row by key to lock it.
3. Defend the idempotency key against replay-with-different-input: if the locked run's entity id or `request_payload` doesn't match the current call, `RAISE EXCEPTION` rather than silently proceeding.
4. If the run is already `completed` and has a non-empty `response_payload`, `RETURN` it immediately — this is the actual idempotent-retry short-circuit, not just a nice-to-have.
5. Lock the target business row(s) `FOR UPDATE`, re-validate business state server-side (never trust client-asserted eligibility/status — re-derive it from the locked row).
6. Perform the mutation(s).
7. Insert exactly one `audit_logs` row in the same transaction.
8. Insert any `notifications` row(s) the workflow implies.
9. Mark the run `completed` with the final `response_payload`.
10. `RETURN` the response.

Wrap the whole body (from step 5 onward, or the whole thing) in:

```
EXCEPTION WHEN OTHERS THEN
  IF v_run.id IS NOT NULL THEN
    UPDATE <runs table> SET status = 'failed', error_message = SQLERRM WHERE id = v_run.id;
  END IF;
  RAISE;
```

**3. Grants:**

```
REVOKE ALL ON FUNCTION public.<workflow_fn>(...) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.<workflow_fn>(...) TO authenticated, service_role;
```

**4. The edge function calling it:**

`verifyUser(req)` → `getUserOrgId(user.id, supabaseAdmin, req)` → `assertPageAccess(req, orgId, [...pages], "write")` (all three from `supabase/functions/_shared/supabase.ts`, already shared — do not re-implement) → parse/validate the request body → **re-fetch the target row(s) with the service-role client and re-derive eligibility/blockers server-side** (this is the step that makes the pattern trustworthy — the client's opinion is only ever a UX pre-check) → call `supabaseAdmin.rpc(...)` → map the RPC's thrown error message to an HTTP status via a small keyword-matching `errorStatus()` helper (`unauthorized` → 401, `access denied|permission` → 403, `required|idempotency|payload|eligible|amount` → 400, `not found` → 404, else 500) → return `{ error: false, ...data }`.

## Two drifts found in the existing pair — do not copy into new workflows

Read directly from `supabase/migrations/20260602170000_lease_approval_workflow.sql` and `supabase/migrations/20260603110000_send_expense_classification_to_cam_workflow.sql`:

1. **`approve_lease_workflow` has no `EXCEPTION WHEN OTHERS` handler and no `REVOKE ALL FROM PUBLIC, anon`.** `send_expense_classification_to_cam_workflow` has both. New workflows should follow the newer (CAM-send) shape. Backfilling the older function is left to a later hardening migration (see "Deferred reconciliation" below) — not done as part of this doc.
2. **`audit_logs` column-shape drift.** `approve_lease_workflow` writes the older shape (`user_id`, `user_email`, `field_changed`, `old_value`, `new_value`). `send_expense_classification_to_cam_workflow` writes the newer, richer shape (`actor_user_id`, `actor_email`, `severity`, `source`, `workflow_run_id`, `before`, `after`, `metadata`, `property_id` — `workflow_run_id` was added to `audit_logs` by that same migration). **New workflows should use the newer shape.**
3. **Not previously flagged, found while writing this doc:** `send-expense-classification-to-cam-workflow.ts` (the edge function, not the RPC) inserts its *own second* `audit_logs` row after the RPC call succeeds (action `expense_classification_sent_to_cam`), on top of the row the RPC itself already inserted inside its transaction (action `send_expense_classification_to_cam`). This second insert is outside the RPC's transaction and its own failures are silently swallowed (`catch (auditErr) { console.error(...) }`). `approve-lease-workflow/index.ts` does **not** do this — it relies solely on the RPC's in-transaction audit insert. **New workflows should follow the lease-approval shape here: one audit insert, inside the RPC, done.** The CAM-send edge function's extra insert is redundant and should be removed in the Phase 5 audit-trail pass, not copied forward.

## Deferred reconciliation (not part of this doc's scope)

- Backfill `EXCEPTION WHEN OTHERS` + `REVOKE ALL FROM PUBLIC, anon` onto `approve_lease_workflow`.
- Normalize `audit_logs` columns so both shapes are queryable without a reader needing to know which workflow wrote which row (e.g. a view, or migrating the older rows/writers onto the newer shape).
- Remove the redundant edge-function-side audit insert in `send-expense-classification-to-cam-workflow.ts`.

These three are folded into Phase 5 (universal audit-trail pass) of the enterprise-readiness plan, since they're audit-log concerns, not new-workflow concerns.

## Shared helpers introduced alongside this doc

- Postgres: `public.begin_workflow_run(...)`, `public.complete_workflow_run(...)`, `public.fail_workflow_run(...)` (see accompanying migration) — factor out the run-table lock/insert/update boilerplate above so new workflow RPCs call these instead of re-writing steps 2-4 and 9-10 by hand each time.
- Edge function: `supabase/functions/_shared/workflow-helper.ts` — factors out the "verify → resolve org → check page access → call RPC → map error to HTTP status" shape from step 4 above.

Existing workflows (`approve_lease_workflow`, `send_expense_classification_to_cam_workflow`, `publish_lease_expense_rule_to_cam_workflow`, and their edge functions) are **not** refactored onto these helpers as part of this doc — they keep working as-is. The helpers exist for workflows built from here forward (starting with expense classification and CAM/lease config writes, per `docs/enterprise-repo-structure.md`'s "Next Refactor Targets").
