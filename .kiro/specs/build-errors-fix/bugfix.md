# Bugfix Requirements Document

## Introduction

The `cre-financial-suite` Vite/React app fails to produce a production build due to two separate bugs. The first is a Rollup module resolution failure caused by an unused import in `src/pages/OrgSettings.jsx` that breaks the module graph and prevents `UserService` from being resolved. The second is a duplicate object key `"draft"` in `src/pages/Workflows.jsx` that esbuild rejects during the transform phase. Both bugs must be fixed for `vite build` to succeed.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `vite build` is run THEN the system fails with `"UserService" is not exported by "src/services/api.js", imported by "src/pages/OrgSettings.jsx"` even though `UserService` is defined and exported in `api.js`

1.2 WHEN `OrgSettings.jsx` is parsed by Rollup THEN the system encounters an unused import `{ inviteUser }` from `@/services/users` on line 4 that is never referenced in the component body, causing the module graph resolution to fail and cascade into a false-positive export error on `UserService`

1.3 WHEN `vite build` transforms `src/pages/Workflows.jsx` THEN the system fails with `Duplicate key "draft" in object literal` because the `statusConfig` object contains two entries with the key `"draft"`

1.4 WHEN either build error is present THEN the system produces no output bundle and the deployment fails entirely

### Expected Behavior (Correct)

2.1 WHEN `vite build` is run THEN the system SHALL complete successfully with no errors related to `UserService` or module resolution in `OrgSettings.jsx`

2.2 WHEN `OrgSettings.jsx` is processed by Rollup THEN the system SHALL resolve `UserService` and `OrganizationService` from `@/services/api` without error, as the unused `inviteUser` import from `@/services/users` has been removed

2.3 WHEN `vite build` transforms `src/pages/Workflows.jsx` THEN the system SHALL parse `statusConfig` without error because the duplicate `"draft"` key has been removed, leaving only one `draft` entry

2.4 WHEN both fixes are applied THEN the system SHALL produce a complete production bundle in the `dist/` directory

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a user navigates to the OrgSettings page THEN the system SHALL CONTINUE TO display organization profile, modules, users, CAM defaults, and notification tabs

3.2 WHEN a user clicks "Invite User" in OrgSettings THEN the system SHALL CONTINUE TO invoke the `invite-user` Supabase edge function directly via `supabase.functions.invoke` (the removed `inviteUser` import was unused and not wired to this flow)

3.3 WHEN a user navigates to the Workflows page THEN the system SHALL CONTINUE TO display budget, lease, and reconciliation approval queues with correct status badge rendering

3.4 WHEN a workflow item has status `"draft"` THEN the system SHALL CONTINUE TO render the `Draft` badge with `bg-slate-100 text-slate-700` styling

3.5 WHEN `UserService.list()` is called from OrgSettings THEN the system SHALL CONTINUE TO fetch and display the user list in the Users & Roles tab
