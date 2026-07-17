# Azure + Vertex Canonical Pipeline Migration - Phase 4E Local Implementation

**No deployment occurred. No live Azure or Vertex provider call was made. `BUSINESS_EXTRACTION_PROVIDER` remains `legacy_hybrid` by default.**

## Executive Result

Phase 4E is implemented and validated against the local Supabase stack. The opt-in `vertex_primary_legacy_fallback` mode now routes through `business-extraction-orchestrator.ts`, attaches provenance to the unchanged `ExtractionPipelineResult` shape, supports a hardened localhost-only Vertex mock seam, and preserves the legacy default path.

**Verdict: `LOCAL IMPLEMENTATION COMPLETE WITH CONDITIONS — DEPLOYMENT AND ACTIVATION BLOCKED`.**

This is a local implementation report only. It does not claim staging, production, live Azure, or live Vertex readiness.

## Local Edge Runtime Used

Local Edge Functions were restarted through an env-file served process using these Phase 4E guard settings:

```text
ENABLE_LOCAL_PROVIDER_MOCKS=true
DISABLE_EXTERNAL_PROVIDER_CALLS=true
LOCAL_SUPABASE_RUNTIME=true
NORMALIZE_INLINE_ENRICHMENT=true
```

`docker inspect supabase_edge_runtime_cre-financial-suite-main` showed those flags inside the edge-runtime container before the localhost HTTP suite ran. Inside the local Supabase Docker network, `SUPABASE_URL=http://kong:8000`; `kong` is accepted only when the full local mock gate is present, including the explicit `LOCAL_SUPABASE_RUNTIME=true` marker and `DISABLE_EXTERNAL_PROVIDER_CALLS=true` kill switch. It is not treated as independent proof of locality.

`NORMALIZE_INLINE_ENRICHMENT=true` was included so the local HTTP race test exercises the final persist/CAS branch instead of returning immediately after the minimal persist.

## Implemented Changes

| Area | Result |
|---|---|
| Provider dispatch | `normalize-pdf-output` now routes real and dry-run dispatch through `runBusinessExtraction()`. |
| Orchestrator | Supports `legacy_hybrid`, `vertex_fact_ledger`, and opt-in `vertex_primary_legacy_fallback`. |
| Acceptance | Uses structured classifications and deterministic acceptance states, including `accepted_needs_review` for conflicting facts. |
| Provenance | Persists `attempt_id`, correlation/provider fields, semantic schema, canonical layout schema, source content hash, mock markers, and persisted timestamp. |
| Local Vertex mocks | Require internal auth, `ENABLE_LOCAL_PROVIDER_MOCKS=true`, `DISABLE_EXTERNAL_PROVIDER_CALLS=true`, and verified local runtime; remote URLs reject. |
| External call guard | `vertex-ai.ts` refuses to call OAuth, Vertex, or Gemini endpoints when `DISABLE_EXTERNAL_PROVIDER_CALLS=true`. |
| Deadline | The Vertex model/location sweep checks the absolute deadline before each attempt and clamps each request timeout to remaining budget via `AbortSignal.timeout()`. |
| CAS race handling | A race winner is reused only when durable output is meaningful and attempt/correlation/provider/schema/hash metadata is compatible. Incompatible meaningful winners return `CAS_RACE_INCOMPATIBLE_RESULT` instead of being overwritten. |
| Reviewer state | Lease review draft rebuilds preserve existing `field_reviews` while refreshing automated fields. |

## Hardened Mock Gate

Added direct tests for the `kong` runtime edge case:

| SUPABASE_URL | Other gates | Expected | Result |
|---|---|---|---|
| `http://kong:8000` | local marker + kill switch | Mock permitted | Passed |
| `http://kong:8000` | missing local marker or missing kill switch | Mock rejected | Passed |
| Remote URL | marker and kill switch present | Mock rejected | Passed |

## Localhost HTTP Matrix

The real local HTTP suite exercised `normalize-pdf-output` at `http://127.0.0.1:54321/functions/v1/normalize-pdf-output` with real local Postgres persistence.

| Scenario | Expected | Result |
|---|---|---|
| Vertex success | Vertex accepted, no fallback | Passed |
| Vertex timeout | Legacy fallback | Passed |
| Vertex 429 | Legacy fallback | Passed |
| Vertex 5xx | Legacy fallback | Passed |
| Malformed Vertex output | Legacy fallback | Passed |
| Empty Vertex output | Legacy fallback | Passed |
| Auth/config error | No fallback, manual review | Passed |
| Conflicting facts | `accepted_needs_review` | Passed |
| Missing mock scenario while external calls disabled | Fail closed | Passed |
| Overlapping normalize requests | CAS loser compares metadata, not only meaningful content | Passed |

The Vertex fixture now flows through the actual `normalize-pdf-output` workflow and persisted output contract. The assertions verify provenance and metadata in both `normalized_output.metadata.provenance` and `ui_review_payload.metadata.provenance`, including `provider_mocked=true`, `mock_scenario`, schema fields, source content hash, and persisted timestamp.

## CAS Race Proof

The overlapping-request test creates one uploaded file and fires two real localhost HTTP requests with different debug timing delays. The observed loser response includes:

```text
race_lost=true
race_compare_reason=compatible_attempt_schema_hash
race_winner_attempt_id=<present>
current_attempt_id=<present and distinct>
```

The code no longer treats meaningful durable content as sufficient by itself. Meaningful content is required before reuse, but compatibility is decided by provenance metadata: attempt identity presence, correlation id, requested provider, semantic schema version, canonical layout schema version, and source content hash.

## No External Hostname Contact

The local proof used defense in depth rather than packet capture:

1. Edge Functions were served with `DISABLE_EXTERNAL_PROVIDER_CALLS=true`.
2. `vertex-ai.ts` now checks that guard before OAuth, Vertex, and Gemini fetches.
3. The localhost HTTP matrix used `debug_vertex_mock_scenario` and asserted `provider_mocked=true` in persisted provenance.
4. A no-scenario localhost HTTP test passed by failing closed with a `400`, proving Vertex mode cannot silently proceed to a real provider under the guard.
5. The hardened mock-gate unit tests prove `kong` is accepted only with the local marker and kill switch, and remote URLs reject.

Based on these controls and assertions, the Phase 4E localhost tests did not intentionally contact external provider hostnames.

## Secret Scan

Changed implementation files, tests, and this report were scanned for:

- Supabase service-role secrets
- Azure Document Intelligence keys
- Vertex service-account private keys
- OAuth access tokens
- Production project references used as credentials
- Real customer document content

Result: no real secrets, production credential references, or customer document content found. The broad regex scan only matched sanitizer/test scaffolding: a `vertex-ai.ts` private-key redaction pattern and a `vertex-ai-structured-errors.test.ts` PEM wrapper generated at test runtime from an ephemeral crypto key.

The new local HTTP test no longer commits a local Supabase default service-role fallback; it requires `SUPABASE_SERVICE_ROLE_KEY` from the test environment.

## Literal Regression Results

```text
Full backend regression command: deno test --allow-env --allow-read --allow-net --no-lock <baseline backend file set from the P0/Phase 4E reports>
Result: 182 passed | 1 failed
Full backend regression: 182 / 183 passed
Known pipeline-status-edge.test.ts failure: still pre-existing, unchanged assertion at pipeline-status-edge.test.ts:65 (`string` actual vs `object` expected)
New unexplained failures: 0
```

```text
deno test --allow-env --allow-read --allow-net --no-lock supabase/functions/_tests/business-extraction-acceptance.test.ts supabase/functions/_tests/business-extraction-orchestrator.test.ts supabase/functions/_tests/fact-ledger-chunk-aggregation.test.ts supabase/functions/_tests/vertex-ai-structured-errors.test.ts supabase/functions/_tests/review-approve-reviewer-state-preservation.test.ts supabase/functions/_tests/business-extraction-mock-gate.test.ts
Result: ok | 53 passed | 0 failed
```

```text
deno test --allow-env --allow-read --allow-net --no-lock supabase/functions/_tests/business-extraction-local-integration.property.test.ts
Result: ok | 4 passed | 0 failed (3s)
```

```text
deno check supabase/functions/_tests/business-extraction-local-integration.property.test.ts supabase/functions/_tests/business-extraction-mock-gate.test.ts supabase/functions/normalize-pdf-output/index.ts
Result: passed
```

```text
Secret scan fixed-string result: no matches
Secret scan broad-regex result: no real secrets; only sanitizer/test PEM wrapper literals
```

Previously completed post-change checks retained for closure:

```text
npm run lint
Result: passed

npm run typecheck
Result: passed

npm test
Result: 56 passed (56) test files | 657 passed (657) tests

npm run build
Result: passed; Vite completed successfully with pre-existing chunk/dynamic-import warnings

git diff --check
Result: passed; only CRLF warnings were printed for existing Windows line endings
```

Sandbox notes: `supabase status` and `supabase functions serve` needed escalation because the CLI writes telemetry under the user profile; sandboxed `npm test` failed at Vite/esbuild startup with `spawn EPERM`, then passed outside the sandbox.

## Remaining Conditions

- No deployment occurred.
- No live Azure/Vertex provider validation occurred.
- `BUSINESS_EXTRACTION_PROVIDER` remains unset/defaulted to `legacy_hybrid`; `vertex_primary_legacy_fallback` is opt-in only.
- The local mock seam is for local/internal validation only and is not a production activation mechanism.
- `callVertexAIWithFile()` remains a separate opt-in file-mode path and is not the Phase 4E text/chunked path proven here.
- Phase 4F has not begun.

# LOCAL IMPLEMENTATION COMPLETE WITH CONDITIONS — DEPLOYMENT AND ACTIVATION BLOCKED