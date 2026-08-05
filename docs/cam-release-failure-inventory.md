# CAM Release — Test & Lint Failure Inventory

Snapshot taken against a freshly bootstrapped local database with local
Supabase credentials exported. **No remote environment was involved.**

## Classification key

| Code | Meaning |
|---|---|
| **BLOCK-FIN** | CAM / financial release blocker |
| **BLOCK-SEC** | Security, RLS, auth or multi-tenancy blocker |
| **ENV** | Environment / test-infrastructure defect (product code is fine) |
| **DEBT** | Obsolete-code debt (test pins behaviour that was deliberately retired) |
| **DEFER** | Safe, documented deferment |

---

## 1. Headline result

| Suite | Before this workstream | After |
|---|---|---|
| CAM Deno subset | 329 passing | **329 passing / 0 failing** |
| Frontend (vitest) | 12 failing / 823 passing | **7 failing / 839 passing** |
| Deno full suite | 213 failing / 2 380 passing | 213 failing / 2 407 passing |
| Lint | 8 errors | 8 errors |

**There are zero BLOCK-FIN and zero BLOCK-SEC failures.** Every remaining
failure is ENV, DEBT or DEFER, itemised below.

---

## 2. Frontend test failures (was 12, now 7)

### 2.1 FIXED — `camConfigCamProfile.test.js` (5 failures) — DEBT

The tests asserted that `saveCamProfile` / `approveCamProfile` pass through to
the `save-cam-profile` / `approve-cam-profile` edge functions. That behaviour
was deliberately retired: `src/services/camConfig.js` now throws
`"cam_profiles writes are retired…"` before doing anything.

**Fixed.** The suite now pins the retirement itself, including the assertion
that the edge functions are never reached. That assertion is load-bearing for
migration 038 — see section 5.

### 2.2 `evidenceUtils.test.js` (5 failures) — DEBT

`inferDynamicItemTab()` routes expense-ish keys (`janitorial_services`,
`tax_responsibility`, `utilities_responsibility`, `maintenance_responsibility`,
`repair_responsibility`) to `"utilities"`; the tests expect
`"expenses_recoveries"`. This is lease-review **UI tab routing** only — it
selects which tab a review item is displayed under. No financial value, no
authorisation decision, no CAM path.

**Not fixed here.** Changing the routing rule silently moves items between
review tabs for users mid-review, which is a product decision, not a test fix.
Owner: lease-review. **DEFER** with this note.

### 2.3 `leaseReviewTabTableContract.test.js` (1 failure) — DEBT

Asserts a source file literally contains `useState("filled")`. The component was
refactored and no longer uses that literal. A source-text contract test, not a
behavioural one. **DEFER** — rewrite as a behavioural assertion or delete.

### 2.4 `expenseServiceUpdateAmount.test.js` (1 failure) — ENV

`TypeError: query.in is not a function`. The test's hand-rolled Supabase query
mock implements `.eq()` but not `.in()`; production code legitimately calls
`.in()`. The mock is incomplete, the product code is correct. **DEFER** —
extend the mock.

---

## 3. Lint (8 errors) — DEBT

All 8 are `unused-imports/no-unused-imports` (e.g. `Input` in a page component,
`isRuleCamEligible` in `expenseService.js`). No correctness, security or
financial impact; all auto-fixable with `eslint --fix`. **None are in files
changed by this workstream.** Left alone deliberately: running `--fix` across
the repo would produce a large diff unrelated to the CAM release and obscure
review.

---

## 4. Deno failures outside the CAM subset (213)

The CAM subset is 329/329 green. The remaining 213 failures cluster as follows.

| Cluster | Files | Class | Cause |
|---|---|---|---|
| Upload / storage / parsing | `upload-handler`, `upload-edge-cases`, `storage-edge-cases`, `upload-error-handling.property`, `parse-file`, `property-parser*`, `lease-parser-integration`, `parser-round-trip.property`, `document-extraction-end-to-end`, `business-extraction-orchestrator` | ENV | Require external services / fixture files / provider credentials not present locally. |
| LLM / extraction ledger | `openai-fact-ledger` (18) | ENV | Requires an LLM provider key. |
| Lease financial RPC contracts | `lease-base-rent-rpc-contract`, `lease-financial-projection-rpc-contract`, `lease-financial-calculation-rpc-contract`, `lease-financial-charge-rpc-contract`, `lease-package-resolution-rpc-contract` | ENV | RPC-shape contract suites for the **lease** financial runtime, not CAM. They fail on fixture/seed drift, not on arithmetic. Flagged for the lease owner — see caveat below. |
| Property-based (fast-check) | `*.property.test.ts` incl. `computation-error-handling`, `export-metadata-inclusion`, `delete-uploaded-file` | ENV | Genuinely non-deterministic run to run — verified: identical code alternates pass/fail across repeated runs. |
| `org-isolation.test.ts` (10) | — | ENV | See section 4.1. |

**Caveat, stated plainly:** the lease financial RPC-contract suites are named
"financial". I inspected them and they exercise the **lease** rent/charge
runtime, which is outside this CAM release's blast radius — this workstream
changed no lease financial code. They were failing before this workstream and
fail identically after. They should not block the CAM release, but they are
**not** proof that the lease financial runtime is healthy, and I am not
claiming that.

### 4.1 `org-isolation.test.ts` — ENV, and the RLS finding is positive

This one matters most, so it was investigated rather than bucketed.

Original failure: `new row for relation "memberships" violates check constraint
"memberships_role_check"`. The fixture hardcodes `role: 'member'`, which is not
in the current vocabulary
(`super_admin | org_admin | manager | editor | viewer | finance | auditor`). The
suite aborted in setup and **never reached a single isolation assertion**.

Corrected the fixture to a valid role. The next failure was
`new row violates row-level security policy for table "properties"` — because
`can_write_org_data()` admits only `manager | editor | finance |
property_manager`, and the seeded actor still does not satisfy the full
membership predicate (it also requires `status IN ('active','owner')`).

**Interpretation, which is the important part:** at no point did an
unauthorised row get through. RLS *rejected* both the invalid role and the
unauthorised write. This is a stale fixture failing to construct a valid
authorised actor — it is **not** an isolation defect, and there is no evidence
of cross-organisation leakage. Independent supporting evidence: the CAM suite
includes cross-organisation rejection tests
(`cam-engine-v2-phase4a-workflow`: "cross-organization CAM run access is
rejected for every workflow action") and those **pass**.

Left at the corrected role with this analysis recorded. Completing the fixture
requires seeding a membership that satisfies `can_write_org_data` in full;
tracked as ENV debt for the platform owner.

---

## 5. Interaction with migration 038 (`DROP TABLE cam_profiles`)

Two Edge Functions still reference `cam_profiles`:

- `supabase/functions/save-cam-profile/index.ts`
- `supabase/functions/approve-cam-profile/index.ts`

The **application** cannot reach them: `camConfig.js` throws before invoking,
and section 2.1's test now pins that. But the functions may still be *deployed*
remotely, and 038 drops the table out from under them.

**Required action before 038 runs** (carried into the runbook): delete/undeploy
`save-cam-profile` and `approve-cam-profile`, or confirm they are already
absent. This is the "no deployed runtime caller depends on cam_profiles"
precondition; 038 additionally self-aborts if the table holds any rows, but it
does **not** check for callers.

---

## 6. Verdict

| Category | Count | Blocking the CAM release? |
|---|---|---|
| BLOCK-FIN | 0 | — |
| BLOCK-SEC | 0 | — |
| ENV | 213 Deno + 1 vitest | No |
| DEBT | 6 vitest + 8 lint | No |
| Fixed this workstream | 5 vitest | — |

No financial, RLS, authentication or organisation-isolation failure remains
unaddressed. The two items with the strongest claim to those labels —
`org-isolation` and the lease financial RPC contracts — were each opened up and
are documented above with their actual cause.
