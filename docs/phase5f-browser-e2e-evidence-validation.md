# Phase 5F Browser E2E, Evidence Navigation, and Visual Workflow Validation

Date: 2026-07-17
Branch: feature/document-intelligence-v3
Verdict: PHASE 5F COMPLETE — BROWSER WORKFLOW, EVIDENCE UX, AND REVIEWER PROJECTION VALIDATED

## Scope

Phase 5F validates the authenticated local browser path from deterministic seeded Lease Upload through Lease Review evidence navigation, reviewer correction, approval, downstream financial state checks, and approved source-document/version linkage.

Final closure also resolves the reviewer projection defect for Security Deposit and recovers the related backend regression in Linux Deno.

No Azure, Vertex, Docling, parser, worker, deployment, remote Supabase, migration, provider change, package-current-truth promotion, or Phase 5G work was performed. Document Intelligence V3 remains advisory / No Gate.

## Starting Point

- Initial Phase 5F working tree was clean before the browser harness was added.
- Current branch: `feature/document-intelligence-v3`.
- Recent baseline commits:
  - `71c4885 Complete Phase 5E package current truth audit`
  - `3fd4ea6 Validate Phase 5D source linkage RPC security`
  - `fc595a0 update`
  - `38fda0f update`
  - `ef99701 Complete Phase 5C authenticated local workflow validation`

## Local Runtime

- Local Supabase only.
- Local API: `http://127.0.0.1:54321`
- Local Studio: `http://127.0.0.1:54323`
- Local DB: `127.0.0.1:54322`
- Local Edge Functions were served from `http://127.0.0.1:54321/functions/v1/<function-name>` while browser tests ran.
- Local function runtime flags:
  - `DISABLE_EXTERNAL_PROVIDER_CALLS=true`
  - `ENABLE_LOCAL_PROVIDER_MOCKS=false`
  - `BUSINESS_EXTRACTION_PROVIDER=legacy_hybrid`
  - `LOCAL_DEVELOPMENT=true`

Temporary env files used for local Edge Functions and Linux Deno verification were removed after use.

## Browser Harness

Phase 5F added Playwright as a dev dependency and preserved the local browser harness:

- `@playwright/test@^1.61.1`
- `playwright.config.js`
- `scripts/phase5f-start-vite.mjs`
- `e2e/helpers/phase5fLocalSupabase.mjs`
- `e2e/phase5f/lease-review-workflow.spec.js`

Configured projects:

- `phase5f-desktop`: 1440x900
- `phase5f-laptop`: 1280x720

Artifacts are gitignored:

- `/test-results/phase5f/`
- `/test-results/phase5f-html/`
- `/playwright/.auth/`

## Security Deposit Root Cause

The reproduced authority path was:

1. The Phase 5F fixture seeded extracted Security Deposit as `30000` under `leases.extraction_data.fields.security_deposit` and field evidence.
2. The reviewer edited Security Deposit to `32500` and saved successfully.
3. Persistence was correct:
   - `leases.security_deposit = 32500`
   - `leases.extraction_data.field_reviews.security_deposit.value = 32500`
4. After browser reload, the Rent & Charges table still displayed the stale extractor value because `normalizeStandardFields()` read `readFieldValue(lease, canonicalKey)` before applying reviewer state or the typed reviewed column.
5. In canonical mode, `resolveLeaseField()` checks extracted payloads before top-level lease columns, so the standard row was generated with the extracted `30000` value.
6. Dynamic-field suppression was working: `security_deposit` maps to an existing canonical contract row and was not duplicated as a dynamic row.
7. `LeaseReviewTabTable` rendered `formatValue(row.value ?? row.normalized_value ?? row.normalizedValue)`, so it correctly reflected the normalized row it was given; the defect was upstream in normalization authority, not the table component.

## Authority Fix

The narrow fix is in `src/lib/leaseReviewFieldNormalizer.js`.

Standard-field display authority is now:

1. reviewer-resolved field review value from `field_reviews`
2. typed reviewed lease column value
3. normalized/extracted resolver fallback

Details:

- `normalizeLeaseReviewData(lease)` and `normalizeStandardFields(lease)` now default to `lease.extraction_data.field_reviews` when a separate `fieldReviews` map is not passed.
- `readResolvedReviewValue()` applies only resolved review statuses.
- `readTypedLeaseColumnValue()` checks the typed lease column aliases before extracted fallback.
- Reviewer evidence is merged when review source page/text exists; otherwise extracted source evidence remains attached.
- Persistence and approval behavior were not changed.
- No component-level redesign or Security Deposit-only special case was added.

## Browser Post-Reload Result

The existing Phase 5F Playwright workflow now asserts after save and browser reload:

- Security Deposit row visibly displays `32500`.
- Security Deposit row does not display `30000` as the current row value.
- Opening the edit control shows current editable value `32500`.
- Approval still succeeds.
- Approved persistence remains correct:
  - `leases.status = approved`
  - `leases.abstract_status = approved`
  - `leases.source_file_id = seeded upload id`
  - approved abstract snapshot `monthly_rent.value = 23500`
  - `leases.security_deposit = 32500`
  - one `lease_abstract_versions` row
  - version snapshot source document references the seeded upload id
  - source `document_links` row exists
  - no duplicate lease expense rule keys

Final screenshot artifacts are under the gitignored `test-results/phase5f/...` project directories.

## Network and Provider Evidence

The Playwright context aborts known external font assets before egress and fails on unexpected external hostnames. Final browser runs passed with no unexpected external requests.

Local Edge Function log scan:

```powershell
rg -n -i "vertex|azure|docling|parse-pdf|normalize-pdf|ingest-file|analyze|provider|external" C:\tmp\phase5f-functions.out.log C:\tmp\phase5f-functions.err.log
```

Result: no provider/parser matches in the local Phase 5F workflow logs.

Observed local workflow functions only included review/status/compute paths such as:

- `pipeline-status`
- `save-lease-expense-rule-set`
- `update-lease-expense-rule-set-status`
- `update-lease-field-and-columns`
- `save-lease-review-draft`
- `compute-lease`

## Linux Deno Backend Recovery

Windows Deno 2.7.12 continued to panic in the local pipe/channel runner before usable counts. Backend recovery was run in Docker Linux with `denoland/deno:2.7.12`, the same working tree, local Supabase through `host.docker.internal`, and a temporary env file that was deleted afterward.

Command shape:

```powershell
docker run --rm --env-file C:\tmp\phase5f-deno-linux.env --add-host=host.docker.internal:host-gateway -v "${PWD}:/workspace" -w /workspace denoland/deno:2.7.12 deno test --no-check --allow-env --allow-read --allow-net=host.docker.internal:54321,0.0.0.0:8000,127.0.0.1:8000,localhost:8000 supabase/functions/_tests/approve-lease-workflow.test.ts supabase/functions/_tests/review-approve-reviewer-state-preservation.test.ts supabase/functions/_tests/document-intelligence-v3-package-graph.test.ts supabase/functions/_tests/document-intelligence-v3-temporal-supersession.test.ts
```

Result:

```text
ok | 25 passed | 0 failed (320ms)
```

Per-file counts:

- `approve-lease-workflow.test.ts`: 5 passed
- `review-approve-reviewer-state-preservation.test.ts`: 5 passed
- `document-intelligence-v3-package-graph.test.ts`: 5 passed
- `document-intelligence-v3-temporal-supersession.test.ts`: 10 passed

The first Linux attempt allowed host Supabase but not the local `Deno.serve` listener and failed with `NotCapable` for `0.0.0.0:8000`; rerun with that local listener permission passed. This was a permission-list correction, not a backend assertion failure.

## Dependency Audit Classification

Command:

```powershell
npm audit --omit=dev
```

Result:

```text
found 0 vulnerabilities
```

Classification: no high-severity issue affects the production dependency tree.

Playwright is dev-only:

- Present in `package.json` / `package-lock.json` dev dependency metadata.
- Not found in the production Vite `dist` bundle scan.

## Final Verification Results

Command:

```powershell
npx vitest run src/lib/__tests__/leaseReviewFieldNormalizer.test.js
```

Result:

```text
Test Files 1 passed (1)
Tests 70 passed (70)
```

Command:

```powershell
npm run test:e2e:phase5f -- --project=phase5f-desktop
```

Result:

```text
1 passed
```

Command:

```powershell
npm run test:e2e:phase5f
```

Result:

```text
Running 2 tests using 1 worker
ok 1 [phase5f-desktop] Phase 5F seeded authenticated Lease Upload to Review approval workflow
ok 2 [phase5f-laptop] Phase 5F seeded authenticated Lease Upload to Review approval workflow
2 passed (1.4m)
```

Command:

```powershell
npx vitest run src/components/lease-review/__tests__/SourceFileLink.test.jsx src/components/lease-review/__tests__/phase5dSourceLinkContract.test.js src/lib/__tests__/leaseReviewCurrentPolicy.test.js src/components/lease-review/utils/__tests__/applyLatestExtractionMerge.test.js src/components/lease-review/utils/__tests__/documentIntelligenceV3Diagnostics.test.js src/components/lease-review/utils/__tests__/leaseReviewEvidenceContract.test.js src/components/lease-review/utils/__tests__/evidenceUtils.test.js
```

Result:

```text
Test Files 7 passed (7)
Tests 193 passed (193)
```

Command:

```powershell
npm test
```

Result:

```text
Test Files 61 passed (61)
Tests 677 passed (677)
```

Command:

```powershell
npm run lint
```

Result:

```text
eslint . --quiet
Exit code 0
```

Command:

```powershell
npm run typecheck
```

Result:

```text
tsc -p ./jsconfig.json
Exit code 0
```

Command:

```powershell
npm run build
```

Result:

```text
vite v6.4.1 building for production...
3325 modules transformed.
built in 12.54s
Exit code 0
```

Build warnings were existing chunk/dynamic-import warnings, not Phase 5F failures.

Command:

```powershell
git diff --check
```

Result:

```text
Exit code 0
Line-ending warnings only.
```

## Secret and Data Hygiene

The fixture uses sanitized synthetic lease facts only. No real customer document text, raw provider payloads, Azure keys, Vertex service-account private keys, OAuth tokens, Supabase service-role secret values, or production credential references are included in the report or committed source changes.

Changed-file value-pattern scan result:

```text
No secret value matches.
```

Temporary credentials removed:

- `C:\tmp\phase5f-functions.env`: removed
- `C:\tmp\phase5f-deno-linux.env`: removed

## Final Gate

Phase 5F browser workflow, evidence UX, reviewer projection, and related backend regression are validated locally.

Final verdict: PHASE 5F COMPLETE — BROWSER WORKFLOW, EVIDENCE UX, AND REVIEWER PROJECTION VALIDATED
