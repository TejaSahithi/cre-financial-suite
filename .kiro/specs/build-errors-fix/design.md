# Build Errors Fix — Bugfix Design

## Overview

Two separate bugs prevent `vite build` from producing a production bundle. The fixes are purely surgical deletions — no logic changes, no new code.

1. `src/pages/OrgSettings.jsx` contains an unused import `{ inviteUser }` from `@/services/users` (a file that does not exist). Rollup fails to resolve it, which cascades into a false-positive error claiming `UserService` is not exported by `api.js`. Fix: delete that import line.

2. `src/pages/Workflows.jsx` contains a duplicate `"draft"` key in the `statusConfig` object literal. esbuild rejects this during the transform phase. Fix: remove the duplicate entry.

## Glossary

- **Bug_Condition (C)**: The condition that triggers a build failure — either the non-existent import is present, or the duplicate key exists in source.
- **Property (P)**: The desired post-fix state — the offending line/key is absent and the build succeeds.
- **Preservation**: All runtime behavior of OrgSettings and Workflows that must remain identical after the deletions.
- **inviteUser import**: The line `import { inviteUser } from "@/services/users"` in `OrgSettings.jsx` — unused in the component body and referencing a non-existent module.
- **statusConfig**: The object literal in `Workflows.jsx` mapping workflow status strings to display label and color class.
- **duplicate "draft" key**: A second `draft:` entry in `statusConfig` that JavaScript silently overwrites at runtime but esbuild rejects at build time.

## Bug Details

### Bug Condition

**Bug 1 — OrgSettings unused import**

The build fails when Rollup encounters `import { inviteUser } from "@/services/users"` in `OrgSettings.jsx`. The module `@/services/users` does not exist, so Rollup cannot resolve it. This causes a cascade where the subsequent `UserService` import from `@/services/api` is also reported as unresolvable.

```
FUNCTION isBugCondition_OrgSettings(fileContent)
  INPUT: fileContent — string contents of OrgSettings.jsx
  OUTPUT: boolean

  RETURN fileContent CONTAINS 'import { inviteUser } from "@/services/users"'
END FUNCTION
```

**Bug 2 — Workflows duplicate key**

The build fails when esbuild transforms `Workflows.jsx` and finds two entries with the key `"draft"` in the `statusConfig` object literal.

```
FUNCTION isBugCondition_Workflows(fileContent)
  INPUT: fileContent — string contents of Workflows.jsx
  OUTPUT: boolean

  occurrences := COUNT_OCCURRENCES(fileContent, '"draft":')
  RETURN occurrences > 1
END FUNCTION
```

### Examples

- **OrgSettings bug**: Running `vite build` produces `"UserService" is not exported by "src/services/api.js", imported by "src/pages/OrgSettings.jsx"` — even though `UserService` is correctly exported. Root cause is the unresolvable `@/services/users` import above it.
- **Workflows bug**: Running `vite build` produces `Duplicate key "draft" in object literal` pointing to `Workflows.jsx`. The second `draft` entry is redundant and identical in structure to the first.
- **After fix**: `vite build` exits 0, `dist/` is populated, no module resolution or duplicate-key errors.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- OrgSettings renders all five tabs (Organization, Modules, Users & Roles, CAM Defaults, Notifications) exactly as before.
- The "Invite User" dialog in OrgSettings continues to invoke `supabase.functions.invoke('invite-user', ...)` — the removed import was never wired to this flow.
- `UserService.list()` continues to fetch and display users in the Users & Roles tab.
- Workflows renders budget, lease, and reconciliation approval queues with correct status badge styling.
- Workflow items with status `"draft"` continue to render the `Draft` badge with `bg-slate-100 text-slate-700` styling (the surviving first `draft` entry is unchanged).

**Scope:**
All inputs that do NOT involve the deleted import line or the duplicate key are completely unaffected. This includes all other imports in both files, all component logic, all API calls, and all UI rendering paths.

## Hypothesized Root Cause

**Bug 1:**
1. **Non-existent module reference**: `@/services/users` was likely a leftover from a refactor where user-related helpers were consolidated into `@/services/api`. The import was never cleaned up.
2. **Rollup cascade**: Rollup processes imports sequentially; a resolution failure on one import can corrupt the module graph for subsequent imports in the same file, producing the misleading `UserService` error.

**Bug 2:**
1. **Copy-paste during object construction**: The `statusConfig` object was likely built incrementally. A `draft` entry was added early, then accidentally duplicated when another status was added nearby.
2. **Silent JS runtime, strict build-time**: Browsers and Node silently use the last duplicate key at runtime, so the bug was invisible during development but esbuild enforces strict mode and rejects it.

## Correctness Properties

Property 1: Bug Condition — OrgSettings Import Absent

_For any_ version of `OrgSettings.jsx` where `isBugCondition_OrgSettings` returns false (the unused import line is not present), Rollup SHALL resolve all imports in the file without error, and `vite build` SHALL NOT produce a `UserService` export error originating from `OrgSettings.jsx`.

**Validates: Requirements 2.1, 2.2**

Property 2: Bug Condition — Workflows Duplicate Key Absent

_For any_ version of `Workflows.jsx` where `isBugCondition_Workflows` returns false (exactly one `"draft"` key exists in `statusConfig`), esbuild SHALL transform the file without a duplicate-key error, and `vite build` SHALL NOT produce a `Duplicate key "draft"` error.

**Validates: Requirements 2.3, 2.4**

Property 3: Preservation — OrgSettings Runtime Behavior Unchanged

_For any_ user interaction with the OrgSettings page after the fix, the component SHALL behave identically to the pre-fix version: all tabs render, the invite flow calls `supabase.functions.invoke`, and `UserService.list()` returns user data.

**Validates: Requirements 3.1, 3.2, 3.5**

Property 4: Preservation — Workflows Status Badge Rendering Unchanged

_For any_ workflow item with status `"draft"`, the fixed `Workflows.jsx` SHALL render the `Draft` badge with `bg-slate-100 text-slate-700` styling, identical to the pre-fix behavior.

**Validates: Requirements 3.3, 3.4**

## Fix Implementation

### Changes Required

**File 1**: `src/pages/OrgSettings.jsx`

**Change**: Delete line 4 — `import { inviteUser } from "@/services/users";`

No other changes. The rest of the file is correct and untouched.

---

**File 2**: `src/pages/Workflows.jsx`

**Change**: Remove the duplicate `draft` entry from the `statusConfig` object. The object currently has two `draft:` keys; retain the first and delete the second (or vice versa — both are identical in value).

No other changes. All other keys in `statusConfig` are unique and correct.

## Testing Strategy

### Validation Approach

Two-phase: first confirm the bugs exist on unfixed code (exploratory), then verify the fixes resolve them without regressions (fix + preservation checking).

### Exploratory Bug Condition Checking

**Goal**: Confirm the bugs are present before applying fixes.

**Test Plan**: Inspect source files for the bug conditions using the pseudocode predicates above. Optionally run `vite build` on unfixed code and capture the error output.

**Test Cases**:
1. **OrgSettings import check**: Assert `isBugCondition_OrgSettings(readFile('src/pages/OrgSettings.jsx'))` returns `true` on unfixed code.
2. **Workflows duplicate key check**: Assert `isBugCondition_Workflows(readFile('src/pages/Workflows.jsx'))` returns `true` on unfixed code.
3. **Build failure confirmation**: Run `vite build` and assert non-zero exit code with expected error messages.

**Expected Counterexamples**:
- Build exits non-zero with `"UserService" is not exported` and `Duplicate key "draft"` errors.

### Fix Checking

**Goal**: Verify both bug conditions are false after the fix.

**Pseudocode:**
```
FOR EACH fix IN [OrgSettings_fix, Workflows_fix] DO
  result := applyFix(fix)
  ASSERT NOT isBugCondition(result)
END FOR

ASSERT vite_build() exits with code 0
ASSERT dist/ directory is populated
```

### Preservation Checking

**Goal**: Verify that non-buggy behavior is unchanged after the fix.

**Pseudocode:**
```
FOR ALL userInteraction WHERE NOT isBugCondition(source) DO
  ASSERT behavior_fixed(userInteraction) = behavior_original(userInteraction)
END FOR
```

**Test Plan**: Verify the surviving `draft` entry in `statusConfig` is identical to the original first entry. Verify `OrgSettings.jsx` still imports `UserService` and `OrganizationService` from `@/services/api`.

**Test Cases**:
1. **Draft badge preservation**: Assert `statusConfig['draft']` equals `{ label: "Draft", color: "bg-slate-100 text-slate-700" }` after fix.
2. **OrgSettings imports intact**: Assert `UserService` and `OrganizationService` imports from `@/services/api` are still present.
3. **No other statusConfig keys removed**: Assert all other keys in `statusConfig` are present and unchanged.
4. **Build success**: Assert `vite build` exits 0 and `dist/` is populated.

### Unit Tests

- Assert `OrgSettings.jsx` does not contain `import { inviteUser }` after fix.
- Assert `Workflows.jsx` contains exactly one `"draft":` key in `statusConfig` after fix.
- Assert the surviving `draft` entry has the correct label and color values.

### Property-Based Tests

- For any file content where the unused import is absent, `isBugCondition_OrgSettings` returns false.
- For any object literal with exactly one `"draft"` key, `isBugCondition_Workflows` returns false.
- For any number of non-`draft` status keys added to `statusConfig`, the `draft` entry remains unchanged.

### Integration Tests

- Run `vite build` after both fixes and assert exit code 0.
- Verify `dist/index.html` and JS chunks are present in the output.
- Smoke-test OrgSettings and Workflows pages in a dev server to confirm no runtime regressions.
