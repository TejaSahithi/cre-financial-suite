-- Approve all existing lease expense rules that have a valid lease_id.
-- Rules were stuck in draft/needs_review because auto-approval logic was added
-- after leases were originally processed. The classification engine requires
-- BOTH approval_status = 'approved' AND review_status IN ('approved','reviewed').
-- This migration runs as the postgres superuser, bypassing RLS.

UPDATE public.lease_expense_rules
SET
  approval_status = 'approved',
  review_status   = 'approved'
WHERE
  lease_id IS NOT NULL
  AND (
    approval_status IS DISTINCT FROM 'approved'
    OR review_status NOT IN ('approved', 'reviewed')
  );
