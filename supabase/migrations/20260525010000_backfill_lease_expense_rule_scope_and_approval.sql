-- Backfill lease expense rule approval + scope so Expense Classification
-- can read approved rules directly from public.lease_expense_rules.
-- This normalizes older rows where review_status was approved/reviewed but
-- approval_status stayed draft, and hydrates denormalized hierarchy fields
-- from the linked lease for direct scope filtering.

WITH rules_with_lease_scope AS (
  SELECT
    r.id,
    COALESCE(r.lease_id, rs.lease_id, l.id) AS effective_lease_id,
    l.org_id,
    l.property_id,
    l.building_id,
    l.unit_id,
    l.tenant_id
  FROM public.lease_expense_rules r
  LEFT JOIN public.lease_expense_rule_sets rs
    ON rs.id = r.rule_set_id
  LEFT JOIN public.leases l
    ON l.id = COALESCE(r.lease_id, rs.lease_id)
)
UPDATE public.lease_expense_rules r
SET
  lease_id = COALESCE(scope.effective_lease_id, r.lease_id),
  org_id = COALESCE(scope.org_id, r.org_id),
  property_id = COALESCE(scope.property_id, r.property_id),
  building_id = COALESCE(scope.building_id, r.building_id),
  unit_id = COALESCE(scope.unit_id, r.unit_id),
  tenant_id = COALESCE(scope.tenant_id, r.tenant_id),
  review_status = CASE
    WHEN lower(COALESCE(r.review_status, '')) IN ('approved', 'reviewed') THEN 'approved'
    ELSE r.review_status
  END,
  approval_status = CASE
    WHEN lower(COALESCE(r.review_status, '')) IN ('approved', 'reviewed') THEN 'approved'
    ELSE r.approval_status
  END,
  approved_at = CASE
    WHEN lower(COALESCE(r.review_status, '')) IN ('approved', 'reviewed')
      THEN COALESCE(r.approved_at, now())
    ELSE r.approved_at
  END,
  updated_at = now()
FROM rules_with_lease_scope scope
WHERE r.id = scope.id
  AND (
    r.lease_id IS DISTINCT FROM COALESCE(scope.effective_lease_id, r.lease_id)
    OR r.org_id IS DISTINCT FROM COALESCE(scope.org_id, r.org_id)
    OR r.property_id IS DISTINCT FROM COALESCE(scope.property_id, r.property_id)
    OR r.building_id IS DISTINCT FROM COALESCE(scope.building_id, r.building_id)
    OR r.unit_id IS DISTINCT FROM COALESCE(scope.unit_id, r.unit_id)
    OR r.tenant_id IS DISTINCT FROM COALESCE(scope.tenant_id, r.tenant_id)
    OR (
      lower(COALESCE(r.review_status, '')) IN ('approved', 'reviewed')
      AND (
        r.review_status IS DISTINCT FROM 'approved'
        OR COALESCE(r.approval_status, '') IS DISTINCT FROM 'approved'
        OR r.approved_at IS NULL
      )
    )
  );
