-- Debug property/building RLS for an invited CRE user.
-- Replace the three values below, then run with psql against the target DB.
--
-- This simulates Supabase's authenticated role for one user and prints:
--   1. the user's membership row
--   2. relevant policy definitions
--   3. page-write helper results used by properties/buildings/units RLS
--
-- Do not commit real user IDs/emails into source control.

BEGIN;

-- Required: replace these before running.
SELECT set_config('request.jwt.claim.sub', '<USER_ID>', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;

WITH target AS (
  SELECT
    '<ORG_ID>'::uuid AS org_id,
    '<USER_ID>'::uuid AS user_id,
    '<OPTIONAL_PORTFOLIO_ID_OR_NULL>'::text AS portfolio_id_text
),
membership AS (
  SELECT
    m.user_id,
    m.org_id,
    m.role,
    m.status,
    m.page_permissions,
    m.capabilities,
    COALESCE(m.capabilities->'roles', '[]'::jsonb) AS capability_roles
  FROM public.memberships m
  JOIN target t ON t.user_id = m.user_id AND t.org_id = m.org_id
)
SELECT 'membership' AS section, to_jsonb(membership.*) AS result
FROM membership;

SELECT
  'policy' AS section,
  schemaname,
  tablename,
  policyname,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('properties', 'buildings', 'units')
ORDER BY tablename, policyname;

WITH target AS (
  SELECT
    '<ORG_ID>'::uuid AS org_id,
    NULLIF('<OPTIONAL_PORTFOLIO_ID_OR_NULL>', 'NULL')::uuid AS portfolio_id
)
SELECT
  'helper_results' AS section,
  public.can_write_page(org_id, 'Properties') AS can_write_properties,
  public.can_write_page(org_id, 'Buildings') AS can_write_buildings,
  public.can_write_page(org_id, 'BuildingsUnits') AS can_write_buildings_units,
  CASE
    WHEN portfolio_id IS NULL THEN NULL
    ELSE public.can_access_portfolio(portfolio_id)
  END AS can_access_target_portfolio
FROM target;

ROLLBACK;
