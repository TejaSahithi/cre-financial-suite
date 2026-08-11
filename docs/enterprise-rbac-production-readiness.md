# Enterprise RBAC Production Readiness

This runbook covers the enterprise CRE RBAC, scope, approvals, notifications, tenant-email, audit, UI, and regression package.

## Code-side readiness gates

Run these locally before promoting a build:

```bash
npm run check:enterprise-rbac-readiness
npm run lint
npm run typecheck
npm run test
npm run build
git diff --check
```

The readiness checker must return:

```json
{
  "status": "static_ready_db_verification_required",
  "failures": [],
  "warnings": []
}
```

That status means the application code, migration text, tests, UI registrations, services, and postflight script are present. It does not mean the database has already been migrated.

## Manual Supabase deployment gate

Apply the migration manually using the deployment path for the target environment, then run:

```bash
psql "$DATABASE_URL" -f scripts/enterprise-rbac-postflight.sql
```

The postflight must return:

```json
{
  "schemaVersion": "enterprise-rbac-db-postflight-v1",
  "status": "passed"
}
```

Do not promote to production until the postflight passes against the target database.

## Implemented phase coverage

1. Repository analysis and architecture mapping: existing memberships, page permissions, access grants, audit, notifications, expenses, budgets, leases, CAM, critical dates, and module routing were extended in place.
2. Role/permission/scope foundation: `authorizationEngine`, DB helpers, and `user_scope_assignments` enforce role plus scope plus permission.
3. Standard roles: organization owner, organization admin, portfolio manager, property manager, lease admin, leasing agent, finance, property owner, auditor, tenant, and custom role are seeded and tested.
4. Custom roles: custom role payloads, cloning, membership capability merging, approval limits, and notification preferences use the same authorization engine.
5. Approval policy engine: organization, portfolio, property, and system policy resolution uses most-specific-wins precedence.
6. Expense approval workflow: expense submission and action paths are wired into the generic workflow bridge.
7. Budget approval workflow: budget review, approval, rejection, and history paths are wired into the generic workflow bridge.
8. Lease workflow: lease approval/rejection paths use mandatory rejection context and generic workflow action recording.
9. CAM workflow: CAM submit, approve, reject, and notification paths are wired into the generic workflow bridge.
10. Rent schedules and critical dates: critical-date rule planning and tenant-facing rent/CAM email foundations are present.
11. Notification/email engine: centralized notification events and tenant email event queuing are wired to workflow actions.
12. Tenant-email logic without tenant portal: tenant contacts and email events are modeled while `tenant_portal_enabled` defaults to false.
13. Approval inbox and user-management UI: approval inbox, approval policies, scoped user assignment, approval authority, notification preferences, and custom role controls are registered.
14. Audit/security hardening: sensitive role, policy, workflow, tenant email, and delegated actions write audit-ready payloads; DB RLS policies enforce org and scope boundaries.
15. Testing and regression verification: targeted unit tests plus full local gates cover role isolation, delegation, self-approval prevention, workflow routing, tenant email, critical dates, and static production contracts.

## Production invariants

- Role alone never grants access.
- Scope is required for entity access.
- Finance validation is separate from final business approval.
- Organization Admin does not receive unlimited financial approval by default.
- Organization Owner can delegate selected authority with date, scope, limit, and audit metadata.
- Property Owner access is property-scoped.
- Tenant portal UI is not enabled in V1.
- Tenant email records are part of V1.
- Rejection and return-for-changes require comments, reason, actor, stage, and entity version.
- Creators do not automatically approve their own transactions.
- Custom roles use the same permission engine as standard roles.
- Backend/RLS authorization remains the production security boundary.
