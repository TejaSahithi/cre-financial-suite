# Client Demo Data Readiness Runbook

Date prepared: 2026-08-07
Demo date referenced by owner: 2026-08-08

## Architecture Read

This codebase is a multi-tenant CRE SaaS built as a React/Vite SPA over Supabase Auth, Postgres, RLS, Storage, and Edge Functions. The app is broad: onboarding, users, portfolios, properties, tenants, leases, lease abstraction, expenses, CAM, budgets, billing, reporting, analytics, documents, integrations, and audit.

The demo should not be seeded as disconnected module samples. Seed it as one coherent tenant story:

1. Organization and org admin membership
2. Portfolio
3. Properties
4. Buildings
5. Units
6. Tenants
7. Leases linked to tenants, units, buildings, and properties
8. Vendors and chart of accounts
9. Expenses linked to properties, vendors, tenants, and leases where applicable
10. Budgets and budget line items
11. Critical dates derived from leases
12. CAM setup/run data only after property, lease, expense, and recovery-period data exists
13. Reports, actuals, variances, revenues, reconciliations, documents, workflows, notifications, and audit records

## Hard Truths Before Demo

- Do not use the in-memory seed data as proof of tenant correctness. It only loads when Supabase is unavailable.
- `org_id` is the primary safety boundary. Every real demo row should be scoped to exactly the org you created.
- A super admin without an active/acting org can read globally but cannot safely create org-scoped records through the generic service layer unless an org is selected.
- The frontend build and typecheck are clean, but the full unit suite is not green.
- CAM data has a contract mismatch: several dashboard/reporting screens ask for `CAMCalculation` rows with `annual_cam`, while `CAMCalculation` currently maps to `cam_runs`, which does not expose `annual_cam` directly.

## Verification Already Run

- `npm run build`: passed
- `npm run typecheck`: passed
- `npm run lint`: passed after unused-import cleanup
- `npm run test`: failed, 75 test files passed, 8 failed, 866 tests passed, 13 failed

Main failing areas:

- Lease Review dynamic field/evidence policy
- Lease Review enrichment-state helper for null status
- CAM canonical ownership guard references a retired legacy CAM symbol in a migration
- Expense service test mock does not implement `.in()` on a query chain
- Approved lease expense-rule fallback expected `repairs_maintenance` but output omitted it

## Demo Data Shape

Use one org, one portfolio, two properties, four tenants, four leases, and enough supporting data to make every module non-empty without making the walkthrough hard to explain.

### Portfolio

Name: Meridian Core Retail and Office Portfolio

### Property 1

Name: Lakeview Commerce Center
Type: Office
Address: 1200 Lakeview Parkway, Dallas, TX 75201
Total RSF: 185000
Leased RSF: 162500
Occupancy: 87.84 percent
Buildings: Tower A, Tower B

### Property 2

Name: Harbor Retail Commons
Type: Retail
Address: 455 Harbor Drive, Tampa, FL 33602
Total RSF: 96000
Leased RSF: 81500
Occupancy: 84.90 percent
Buildings: Main Retail, Pad Sites

### Tenants And Leases

Apex Imaging Partners
Property: Lakeview Commerce Center
Unit: Suite 210
RSF: 18500
Lease type: NNN
Start: 2024-01-01
End: 2029-12-31
Annual rent: 582750
Monthly rent: 48562.50
Rent PSF: 31.50
Security deposit: 97125
Renewal notice days: 180

NorthStar Legal Group
Property: Lakeview Commerce Center
Unit: Suite 410
RSF: 11250
Lease type: Full Service
Start: 2023-07-01
End: 2028-06-30
Annual rent: 382500
Monthly rent: 31875.00
Rent PSF: 34.00
Security deposit: 63750
Renewal notice days: 150

FreshMart Market
Property: Harbor Retail Commons
Unit: Anchor 100
RSF: 32000
Lease type: NNN
Start: 2022-04-01
End: 2032-03-31
Annual rent: 768000
Monthly rent: 64000.00
Rent PSF: 24.00
Security deposit: 128000
Renewal notice days: 270

CoreFit Studio
Property: Harbor Retail Commons
Unit: Shop 220
RSF: 9500
Lease type: Modified Gross
Start: 2025-02-01
End: 2030-01-31
Annual rent: 256500
Monthly rent: 21375.00
Rent PSF: 27.00
Security deposit: 42750
Renewal notice days: 180

Portfolio annual base rent: 1989750

## Data Loading Order

Load in this exact order:

1. Confirm org and membership
2. Insert portfolio
3. Insert properties
4. Insert buildings
5. Insert tenants
6. Insert units with tenant links
7. Insert leases with property, unit, tenant links
8. Backfill unit lease links
9. Insert vendors
10. Insert GL accounts
11. Insert expenses
12. Insert revenues and actuals
13. Insert budgets and budget line items
14. Insert variances
15. Insert rent and expense projections
16. Insert reconciliations
17. Insert critical dates
18. Insert documents
19. Insert workflows and notifications
20. Insert audit logs
21. Configure CAM V2 only if you have recovery calendars, recovery periods, pools, inputs, and run results ready

## Pre-Demo Tenant Isolation Checks

Run these in Supabase SQL Editor after loading. Replace the org identifier filter with your target org.

```sql
select id, name, status
from public.organizations
where name ilike '%your org name%';
```

```sql
select m.user_id, p.email, m.org_id, o.name as org_name, m.role, m.status
from public.memberships m
join public.profiles p on p.id = m.user_id
left join public.organizations o on o.id = m.org_id
where p.email = 'your-admin-email@example.com';
```

```sql
select 'properties' as table_name, count(*) from public.properties where org_id = 'YOUR_ORG_ID'
union all select 'buildings', count(*) from public.buildings where org_id = 'YOUR_ORG_ID'
union all select 'units', count(*) from public.units where org_id = 'YOUR_ORG_ID'
union all select 'tenants', count(*) from public.tenants where org_id = 'YOUR_ORG_ID'
union all select 'leases', count(*) from public.leases where org_id = 'YOUR_ORG_ID'
union all select 'expenses', count(*) from public.expenses where org_id = 'YOUR_ORG_ID'
union all select 'budgets', count(*) from public.budgets where org_id = 'YOUR_ORG_ID'
union all select 'vendors', count(*) from public.vendors where org_id = 'YOUR_ORG_ID'
union all select 'gl_accounts', count(*) from public.gl_accounts where org_id = 'YOUR_ORG_ID'
union all select 'critical_dates', count(*) from public.lease_critical_dates where org_id = 'YOUR_ORG_ID';
```

```sql
select
  p.name,
  p.total_sqft,
  coalesce(sum(case when l.status <> 'expired' then l.square_footage else 0 end), 0) as leased_sqft_from_leases,
  round(100 * coalesce(sum(case when l.status <> 'expired' then l.square_footage else 0 end), 0) / nullif(p.total_sqft, 0), 2) as occupancy_pct_from_leases,
  coalesce(sum(case when l.status <> 'expired' then l.annual_rent else 0 end), 0) as annual_base_rent
from public.properties p
left join public.leases l on l.property_id = p.id and l.org_id = p.org_id
where p.org_id = 'YOUR_ORG_ID'
group by p.id, p.name, p.total_sqft
order by p.name;
```

```sql
select
  l.tenant_name,
  p.name as property_name,
  u.unit_number,
  l.square_footage,
  l.annual_rent,
  round(l.annual_rent / nullif(l.square_footage, 0), 2) as rent_psf_check,
  round(l.annual_rent / 12, 2) as monthly_rent_check,
  l.monthly_rent
from public.leases l
left join public.properties p on p.id = l.property_id
left join public.units u on u.id = l.unit_id
where l.org_id = 'YOUR_ORG_ID'
order by p.name, l.tenant_name;
```

## Recommended Demo Talk Track

Use this flow:

1. Login as the org admin.
2. Show org settings/user management to prove tenant and role context.
3. Show dashboard, but avoid overemphasizing CAM totals until the CAMCalculation contract is fixed.
4. Open Properties and Property Detail to show property/building/unit hierarchy.
5. Open Tenants and Lease Detail to show tenancy and lease data.
6. Open Lease Review only with a prepared uploaded/review-ready lease. Do not live-upload unless Azure/OpenAI secrets and edge functions were verified within the last hour.
7. Show Expenses, Expense Review, Budget, Reports, and Critical Dates using the seeded data chain.
8. Show CAM Setup/CAM Run as an advanced workflow. Be clear that CAM V2 is workflow-backed and requires recovery calendars, recovery periods, pools, eligible expenses, and calculation results.
9. End with audit logs and role-based access.

## No-Go Statements

Do not claim these unless verified in production Supabase before the call:

- No cross-org leakage is impossible. Say RLS is designed to enforce org isolation and you have tenant-isolation tests.
- Lease extraction is fully accurate. Say it is approval-gated and source-evidence-backed.
- CAM is fully automated end-to-end. Say CAM is workflow-backed and can calculate from approved lease/expense setup.
- All dashboards are sourced from final ledger tables. There is currently a CAM summary contract mismatch to resolve.

## Priority Fixes After Demo

1. Resolve `CAMCalculation` read contract: either map dashboard/reporting CAM summary screens to a proper summary view, or update them to derive totals from `cam_run_lease_results`.
2. Make the full unit suite green, especially lease review dynamic field mapping and CAM canonical ownership tests.
3. Add a production-safe demo seed script with idempotency keys and a dry-run mode.
4. Remove stale legacy CAM references or update the canonical ownership guard baseline intentionally.
5. Replace in-memory seed fields that use non-canonical names such as `total_sf` with canonical DB names such as `total_sqft`, or normalize them centrally.