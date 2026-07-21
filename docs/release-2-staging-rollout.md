# Release 2 Staging Rollout — V3/Provenance Activation in Parallel

**Scope**: turn on `document-intelligence-v3` and extraction-provenance side-write paths in staging so they run in parallel with the live `ui_review_payload`, verify they write correct data, and measure legacy/canonical agreement. **No production flag changes. No UI source switch — the reviewer-facing Lease Review payload always stays `ui_review_payload`, never a canonical projection, in this release.**

This document is the operational counterpart to the code shipped in this release (`_shared/extraction/document-intelligence-v3/projection-diff.ts`, `run-metrics.ts`, `transport-readiness.ts`, the two new diagnostic edge functions, and the three new `ExtractionDebugPanel.jsx` sections). Nothing in this document was executed against a real staging project from within the implementation session — there is no staging Supabase project connected there (see the Release 2 plan's scope-boundary note). Everything below is precise and ready to run; you (or whoever owns the staging project) execute it.

## 1. Two test modes — read this before looking at any results

`document_claims` / `document_claim_evidence` / `document_canonical_field_projections` only populate when the extraction debug output has fact-ledger-shaped facts. This means:

- **Mode A — infrastructure verification** (`BUSINESS_EXTRACTION_PROVIDER=legacy_hybrid`, the production default): verifies run lifecycle, provenance stage tracking, failure isolation, generation supersession, and table integrity. Produces a `completed` `document_intelligence_runs` row with **zero** claims/evidence/projections — **this is correct, not a bug.** There is nothing to compare in this mode; do not expect or compute a meaningful agreement rate.
- **Mode B — canonical comparison** (`BUSINESS_EXTRACTION_PROVIDER=openai_fact_ledger`): the only mode where claims/evidence/projections populate and legacy-vs-canonical agreement is measurable.

Every diagnostic in this release reports a `comparison_status`: `"available" | "unavailable_no_fact_ledger" | "unavailable_no_projections"`. When not `"available"`, agreement-rate fields are `null`, never `0` — a `0` would misrepresent "nothing to compare" as "total disagreement." **Do not combine a `BUSINESS_EXTRACTION_PROVIDER` change with the V3 flag flip in one uncontrolled test** — run Mode A and Mode B as separate, deliberate configurations.

## 2. Staging secrets to set

On whichever Supabase project you designate as staging (via the dashboard's Edge Function secrets, or `supabase secrets set --project-ref <staging-ref>`):

```
ENABLE_DOCUMENT_INTELLIGENCE_V3=true
ENABLE_EXTRACTION_PROVENANCE=true
BUSINESS_EXTRACTION_PROVIDER=legacy_hybrid        # Mode A run, or:
BUSINESS_EXTRACTION_PROVIDER=openai_fact_ledger   # Mode B run — pick one per test, don't mix
```

Set `BUSINESS_EXTRACTION_PROVIDER` explicitly rather than relying on its unset default — this document assumes you know which mode a given corpus run used. Keep both `ENABLE_*` flags **unset or `false` in production** — no production flag changes in this release.

## 3. Known, documented limitations (do not read these as failures)

- **`provider_invocations` and `extraction_artifacts` will show zero rows regardless of flags.** The transport wrappers (`provenance/transport/azure.ts`, `provenance/transport/openai.ts`) are fully built and unit-tested but have no production caller — every real Azure/OpenAI call bypasses them. Wiring them in is future work, not part of this release. The new "Provenance / Table-Write Health" panel labels this `may_be_zero`, not broken.
- **`document_intelligence_runs.readiness` and `document_claims.importance` are dead columns** — never persisted; every diagnostic recomputes them live and tags the value with `readiness_source: "computed"` / `importance_source: "computed"` plus a version, so nothing is mistaken for a historical snapshot.
- **Azure canonical layout always resolves through the lossy `legacyDoclingToCanonicalLayout()` path** — `canonical_layout_fidelity` will read `"legacy_lossy"` with empty polygons in every diagnostic this release. Fixing this is Release 3 scope.
- **The OpenAI provider-constraint concern raised during planning was already resolved** by a prior migration (`20260855000000_provider_invocations_add_openai.sql`) — `provider_invocations.provider` accepts `'openai'` today, confirmed by a live insert test (`extraction-provenance-transport-readiness.test.ts`). The remaining, still-true fact is that neither transport wrapper has a live caller — that's the "unwired" limitation above, not a schema blocker.

## 4. Per-document verification checklist

After uploading a document with both flags on, open Lease Review as a super-admin, go to the Extraction Debug tab, and:

1. Click **Load v3 Diagnostics** — confirm a `document_intelligence_runs` row exists with `status: "completed"`.
2. Click **Load Run Metrics** — check the **Provenance / Table-Write Health** table. Every row should read "as expected" per the provider-aware matrix below; a red "missing expected rows" badge on `document_intelligence_runs`, `document_claims` (Mode B only), or `document_canonical_field_projections` (Mode B only) is a real problem.
3. Click **Load Projection Diff** — under Mode A, expect `comparison_status: unavailable_no_fact_ledger` (correct). Under Mode B, expect `comparison_status: available` with a real per-field diff table.
4. Confirm no orphan records: this is enforced at the DB FK level and covered by `extraction-provenance-table-integrity.property.test.ts`; spot-check by confirming every `document_claim_evidence`/`document_validation_drops` row's `claim_id` resolves to a `document_claims` row for the same run (the Run Metrics panel's counts should be internally consistent — `claims_with_evidence <= claims_extracted`).

### Provider-aware expected-row matrix

| Table | `legacy_hybrid` | `openai_fact_ledger` |
|---|---|---|
| `document_intelligence_runs` | Required | Required |
| `document_claims` | May be zero | Expected |
| `document_claim_evidence` | May be zero | Expected when claims exist |
| `document_validation_drops` | Optional | Optional |
| `document_canonical_field_projections` | May be zero | Expected |
| `extraction_runs` | Required (with provenance flag on) | Required (with provenance flag on) |
| `extraction_stage_runs` | Required (with provenance flag on) | Required (with provenance flag on) |

## 5. Staging corpus

Process each of these through both Mode A and Mode B (18 total upload/verify passes, or fewer if you only need one mode initially):

1. Simple single-tenant lease
2. Complex CAM lease
3. Lease with a percentage late fee
4. Lease with a management fee
5. Lease with renewal options
6. Lease plus amendment
7. Scanned or low-quality lease
8. Lease containing tables
9. Lease with missing pages

Do not judge Release 2 readiness from a single document.

## 6. Running the corpus acceptance harness

After processing the corpus, collect the resulting `uploaded_files.id` values and run:

```bash
SUPABASE_URL=<staging-url> SUPABASE_SERVICE_ROLE_KEY=<staging-service-role-key> \
  deno run --allow-net --allow-env \
  supabase/functions/_tests/diagnostics/release2-corpus-acceptance-harness.ts \
  <uploaded_file_id_1> <uploaded_file_id_2> ... <uploaded_file_id_9>
```

It prints a per-document summary, a corpus-level rollup (`aggregateRunMetrics()`), and a pass/fail check against the acceptance thresholds below — **agreement-rate thresholds are computed only over documents where `comparison_status === "available"`** (i.e., the Mode B subset); Mode A documents contribute to the infrastructure-only thresholds (pipeline completion) but never drag agreement rates toward zero.

### Acceptance thresholds

| Metric | Threshold |
|---|---|
| Pipeline completion | ≥ 98% |
| Claims with usable evidence | ≥ 95% |
| Critical-field agreement (Mode B only) | ≥ 95% |
| Overall normalized agreement (Mode B only) | ≥ 90% |
| Unexplained critical conflicts | 0 |
| Orphan records | 0 |

Thresholds may need adjustment after the first corpus run, but unexplained critical conflicts should stay at zero before promoting anything from Release 2's evidence toward Release 4 (canonical-projection promotion).

Critical fields (used for the critical-field agreement rate and for materiality classification throughout): `landlord_name`, `tenant_name`, `commencement_date`, `expiration_date`, `monthly_rent`, `lease_term_months`, `admin_fee_pct`, `responsibility_taxes`, `renewal_notice_months`, `option_exercise_deadline`.

## 7. Idempotency / retry behavior (already verified locally, re-verify in staging if desired)

Covered by `document-intelligence-v3-generation-lifecycle.property.test.ts` against the local Postgres harness: an initial upload sets `uploaded_files.active_generation_id`; a force-reextract supersedes (never deletes) the prior generation's `pipeline_jobs`/`extraction_runs` rows and mints a new generation; `extraction_runs(org_id, generation_id)` uniqueness holds even under a simulated concurrent double-insert; a reprocess's `document_canonical_field_projections` never shares evidence/claim IDs with the prior run's projections. If you want to re-confirm this against staging specifically: upload once, retry normalization, force-reextract, force a stage failure, and re-extract successfully — then confirm both the old and new `extraction_runs`/`document_intelligence_runs` rows are independently queryable and distinguishable by `status`.

## 8. Failure-isolation policy (decided, not left implicit)

**Provenance failures are non-blocking in staging** — matching the existing behavior: a v3 side-write failure is caught and reported (never thrown) by `normalize-pdf-output`'s surrounding try/catch, and `withExtractionStage()` only throws on a genuine configuration error (flag on, no `extraction_runs` row to attach to), not on transient failures. A forced stage failure (`stageHandle.fail()`) is durably visible (`extraction_stage_runs.status='failed'` with `error_code`/`error_message`) without blocking the caller's own business-result write — covered by `extraction-provenance-failure-isolation.property.test.ts`. Blocking is deferred to a future release if provenance ever becomes load-bearing for review readiness.

## 9. Rollback

```
ENABLE_DOCUMENT_INTELLIGENCE_V3=false
ENABLE_EXTRACTION_PROVENANCE=false
```

Safe by design: the reviewer-facing UI never reads v3/provenance tables in this release (`ui_review_payload` is the only source Lease Review renders from), so unsetting both flags restores exactly the pre-Release-2 behavior with no data migration. Existing v3/provenance rows are preserved for audit — not deleted — regardless of flag state.

## 10. Recommended commit sequence (if not already applied as one set of commits)

```
chore(staging): enable V3 and extraction provenance
feat(diagnostics): compare legacy and canonical projections
feat(provenance): expose run and stage health metrics
test(extraction): add V3 staging acceptance coverage
docs(architecture): record Release 2 rollout and rollback procedure
```

## 11. Explicit non-goals for Release 2

No production flag changes. No UI source switch to canonical projections (Release 4). No new DB tables. No wiring of the `provider_invocations`/transport-wrapper path. No fix to the Azure lossy-layout gap (Release 3). No fix to the `document_claims.importance`/`document_intelligence_runs.readiness` dead columns beyond tagging their diagnostic outputs as computed, not persisted.
