# Build Errors Fix — Tasks

## Task List

- [x] 1. Fix OrgSettings.jsx unused import
  - [x] 1.1 Remove the line `import { inviteUser } from "@/services/users"` from `src/pages/OrgSettings.jsx`
  - [x] 1.2 Verify `UserService` and `OrganizationService` imports from `@/services/api` are still present and correct

- [x] 2. Fix Workflows.jsx duplicate "draft" key
  - [x] 2.1 Remove the duplicate `draft` entry from the `statusConfig` object in `src/pages/Workflows.jsx`, retaining exactly one `draft` key with `{ label: "Draft", color: "bg-slate-100 text-slate-700" }`
  - [x] 2.2 Verify all other keys in `statusConfig` are unchanged

- [x] 3. Verify build succeeds
  - [x] 3.1 Run `vite build` and confirm it exits with code 0 and no module resolution or duplicate-key errors
  - [x] 3.2 Confirm `dist/` directory is populated with output bundle
