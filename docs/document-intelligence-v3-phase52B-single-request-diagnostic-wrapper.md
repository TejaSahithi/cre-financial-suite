# Enterprise Document Intelligence v3 - Phase 52B Single-Request Diagnostic Wrapper

## Executive Summary

Phase 52B implemented a minimal internal-only diagnostic path capable of making exactly one future Vertex model request. No VertexAI, Gemini, OpenAI, Azure, OCR, parse, extraction, deploy, remote write, Supabase table read/write, provider output creation, global provider flag change, or secret-value exposure occurred.

Recommendation remains: **No Gate**.

## Implementation Location

| Area | Location | Purpose |
| --- | --- | --- |
| diagnostic endpoint | `supabase/functions/phase52-vertex-diagnostic/index.ts` | Internal-only Edge Function handler for a one-request diagnostic sample-text call |
| single-request helper | `supabase/functions/_shared/vertex-ai.ts::callVertexAISingleRequestDiagnostic(...)` | Low-level Vertex `generateContent` call with no model/location fallback and no retry loop |
| focused tests | `supabase/functions/_tests/phase52-vertex-diagnostic.test.ts` | Tests auth, rejection rules, no DB source, redaction, one helper call, no retry/fallback |

## Authentication Mechanism

The diagnostic endpoint does not import `createAdminClient`, `verifyUser`, or any Supabase client. It uses `isInternalCall(req)` only.

Accepted internal auth mechanisms are the existing server-side patterns:

- `x-worker-secret: <WORKER_INTERNAL_SECRET>`
- `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`
- `x-internal-service-key: <SUPABASE_SERVICE_ROLE_KEY>`

Secret values are never returned. The handler rejects ordinary unauthenticated calls before a provider helper can run.

## Request Contract

Accepted fields:

- `sample_text`
- `diagnostic_label` optional

Rejected fields include:

- `file_id`
- `uploaded_file_id`
- `lease_id`
- `run_id`
- `org_id`
- table/query/write words such as `select`, `insert`, `update`, `delete`, `upsert`, `rpc`
- provider override fields such as `debug_business_extraction_provider`, `business_extraction_provider`, `extraction_provider`, `provider`

The function is deliberately not a wrapper over the normal `file_id` normalize path.

## Exactly-One-Request Proof

The new helper bypasses `callVertexAI(...)`, which contains model/location fallback logic. `callVertexAISingleRequestDiagnostic(...)`:

1. resolves exactly one project
2. resolves exactly one location
3. resolves exactly one model
4. creates exactly one `generateContent` URL
5. performs exactly one `fetch(...)`
6. does not loop
7. does not call Gemini/OpenAI helpers
8. does not call the `vertex_fact_ledger` orchestrator
9. does not classify profile separately
10. does not chunk text

Unit coverage includes a mocked fetch test proving one `generateContent` call on success and one call on 404 failure with no retry/fallback.

Note: OAuth token acquisition may still occur when the helper is invoked without a test access token. That is not a Vertex model request. The exactly-one constraint here is for Vertex model `generateContent` requests.

## Zero-DB Proof

The diagnostic endpoint source was tested to ensure it does not import or call:

- `createClient`
- `createAdminClient`
- `verifyUser`
- `.from(...)`
- `.select(...)`
- `.insert(...)`
- `.update(...)`
- `.delete(...)`
- `.upsert(...)`
- `.rpc(...)`

The endpoint accepts no database identifiers and rejects all known DB-targeting request fields before any provider helper can run.

## Fallback-Disabled Proof

The diagnostic endpoint and helper do not call:

- Azure Document Intelligence
- Gemini Developer API helper
- OpenAI helper
- OCR or parser paths
- `runVertexFactLedgerPipeline(...)`
- profile classifier
- fact-ledger chunk extractor
- file-mode Vertex helper

The low-level helper also avoids the existing production `buildVertexAttempts(...)` fallback path.

## Safe Response Shape

The handler returns only:

- `success`
- `provider: "vertex"`
- `request_count: 1`
- model name
- location
- latency
- token usage when available
- sanitized response text
- parsed diagnostic facts when JSON parses
- sanitized error category/message on failure

It does not return access tokens, private keys, service-account JSON, internal secrets, authorization headers, or stack traces.

## Representative Test Sample

Tests use a short Craven excerpt only. It mentions:

- Markets at Choto, LLC as landlord
- Cress Family Restaurants, LLC as tenant
- Building 9, Suites 3 and 4 / 12350 South Northshore premises
- CAM estimate of `$5.25 per leasable square foot`
- 5 percent administrative fee
- `$15,535.36` security deposit

The full lease is not included.

## Deployment Status

Not deployed.

## Verification Performed

| Check | Result |
| --- | --- |
| `deno check supabase/functions/_tests/phase52-vertex-diagnostic.test.ts` | passed |
| targeted `deno test --allow-env --allow-read supabase/functions/_tests/phase52-vertex-diagnostic.test.ts` | passed outside sandbox: 7 tests |
| mocked Deno smoke script | passed; imported endpoint/helper, rejected `file_id`, invoked helper once, proved one mocked fetch |
| `npm run lint` | passed |
| `npm run typecheck` | passed |
| `npm run build` | passed |
| `npm run test` | passed outside sandbox after sandboxed `spawn EPERM`: 56 files / 657 tests |
| provider call | none |
| deployment | none |
| QA JSON parse | passed |

## Exact Approval Required Before Invocation

Before any Phase 52 provider invocation, the user must explicitly approve:

1. deployment or local serving of `phase52-vertex-diagnostic`, if using the Edge Function route
2. exactly one invocation
3. the internal execution environment that already has Vertex credentials and internal auth configured
4. the sample text to send
5. the model and location to use through environment values
6. no `file_id`, no DB writes, no provider fallback, and no normal normalize path

## Recommendation

Recommendation remains: **No Gate**.
