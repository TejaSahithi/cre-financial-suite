-- PRE-AZ-HOTFIX-1: close a direct-RPC authorization bypass on the two
-- "flagship" lease RPCs (approve_lease_workflow, delete_lease_cascade).
--
-- Both are SECURITY DEFINER and, prior to this migration, grant EXECUTE to
-- anon and authenticated (in addition to service_role) -- a leftover from
-- Phase 0/5B-1, before this codebase's later RPCs standardized on
-- service_role-only + edge-function-owned access (see
-- docs/server-owned-workflow-pattern.md). Neither function body performs
-- any internal caller-authorization check (no auth.uid(), no
-- is_member_of_org/can_write_page lookup) -- both trust their
-- client-supplied p_org_id/p_actor_user_id/p_actor_email parameters purely
-- for business logic and audit metadata, not for authorization. Combined
-- with the anon/authenticated grant, this let any authenticated (or anon)
-- caller invoke either RPC directly via PostgREST
-- (POST /rest/v1/rpc/<function>), bypassing both RLS (irrelevant to
-- SECURITY DEFINER) and the owning edge function's verifyUser/
-- getUserOrgId/assertPageAccess checks entirely -- approving or
-- cascade-deleting any lease in any organization.
--
-- Investigation (PRE-AZ-HOTFIX-1) confirmed:
--   - approve_lease_workflow has zero browser/client callers anywhere in
--     src/ -- the frontend exclusively calls the approve-lease-workflow
--     edge function (leaseApprovalWorkflowService.js ->
--     invokeEdgeFunction("approve-lease-workflow", ...)), which already
--     calls this RPC via its service-role supabaseAdmin client
--     (supabase/functions/approve-lease-workflow/index.ts). No RPC body
--     change is required -- only the grant needs to change.
--   - delete_lease_cascade *was* called directly from the browser, via the
--     regular (non-service-role) authenticated client, in
--     src/services/leaseService.js. That call site, and the direct-write
--     deleteLeaseCascadeFallback() it fell back to on RPC unavailability,
--     are being replaced in this same change with a new
--     delete-lease-cascade edge function (server-owned: verifyUser,
--     getUserOrgId, assertPageAccess, explicit lease-org-ownership check
--     since this RPC itself takes no p_org_id, then calls the RPC via
--     service_role). See supabase/functions/delete-lease-cascade/index.ts
--     and src/services/leaseService.js.
--
-- This migration only changes grants -- it does not alter either
-- function's body, and does not touch any other RPC, RLS policy, or
-- unrelated table.

REVOKE ALL ON FUNCTION public.approve_lease_workflow(
  UUID,
  UUID,
  UUID,
  TEXT,
  TEXT,
  TIMESTAMPTZ,
  TEXT,
  TEXT,
  JSONB,
  JSONB,
  JSONB,
  TEXT,
  JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.approve_lease_workflow(
  UUID,
  UUID,
  UUID,
  TEXT,
  TEXT,
  TIMESTAMPTZ,
  TEXT,
  TEXT,
  JSONB,
  JSONB,
  JSONB,
  TEXT,
  JSONB
) TO service_role;

REVOKE ALL ON FUNCTION public.delete_lease_cascade(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.delete_lease_cascade(UUID, UUID, TEXT) TO service_role;
