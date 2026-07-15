# Enterprise Document Intelligence v3 - Phase 52A Internal Dry-Run Path

## Executive Summary

Phase 52A prepared the internal Supabase Edge dry-run invocation path for a future provider test. No VertexAI, Gemini, OpenAI, Azure, parse, extraction, deploy, remote write, Supabase secret change, normal `file_id` normalize call, table write, provider output creation, or secret-value exposure occurred.

Conclusion: **no existing safe caller currently satisfies the full Phase 52 requirement as-is**.

The closest existing caller is `pipeline-health-check`, which is admin-only and already calls `normalize-pdf-output` with `dry_run=true`; however, it sends a generic sample and does not pass `debug_business_extraction_provider="vertex_fact_ledger"`. Separately, the existing `vertex_fact_ledger` pipeline cannot guarantee exactly one Vertex model request because it calls a profile classifier and then fact extraction, and the Vertex client can retry model/location attempts.

Recommendation remains: **No Gate**.

## Existing Safe Caller Found

| Question | Answer |
| --- | --- |
| existing trusted caller found for exact required invocation | no |
| nearest existing caller | `supabase/functions/pipeline-health-check/index.ts` |
| why it is close | admin-only diagnostic; calls `normalize-pdf-output` with internal auth and `dry_run=true` |
| why it is insufficient | does not pass `debug_business_extraction_provider`, does not use representative Craven text, and does not constrain Vertex to exactly one model request |
| existing internal worker pattern | `lease-extraction-worker` has `callInternalFunction(...)` and `buildInternalFunctionHeaders(...)`, but its production normalize call uses the normal `file_id` body |

## Relevant Code Findings

| Area | Code path | Finding |
| --- | --- | --- |
| internal auth headers | `supabase/functions/lease-extraction-worker/auth.ts` lines 39-52 | internal calls can set `Authorization`, `apikey`, `x-internal-service-key`, `x-worker-secret`, and `x-internal-org-id` from Edge runtime secrets |
| worker internal caller | `supabase/functions/lease-extraction-worker/index.ts` lines 95-104 | reusable internal-call pattern exists |
| worker normalize call | `supabase/functions/lease-extraction-worker/index.ts` line 945 | current worker sends `{ file_id, pipeline_job_id, worker_attempt }`, which is the DB-writing path |
| health-check normalize caller | `supabase/functions/pipeline-health-check/index.ts` lines 437-466 | admin-only diagnostic calls `normalize-pdf-output` with internal service key and `dry_run=true` |
| health-check sample | `supabase/functions/pipeline-health-check/index.ts` lines 54-58 | sample is generic rent/address text, not Craven text |
| normalize dry-run branch | `supabase/functions/normalize-pdf-output/index.ts` lines 1860-1922 | `dry_run=true` + `sample_text` branch has no `file_id` and returns message: no file processed, no DB writes |
| scoped provider override | `supabase/functions/normalize-pdf-output/index.ts` lines 1875-1877 | `debug_business_extraction_provider` is honored only when `isInternalCall(req)` is true |
| profile classifier call | `supabase/functions/_shared/extraction/vertex-fact-ledger/profile-classifier.ts` lines 76-85 | one `callVertexAIJSON(...)` call is made for document profile classification |
| fact extraction calls | `supabase/functions/_shared/extraction/vertex-fact-ledger/fact-ledger-extractor.ts` lines 176-184 | text mode chunks the document and calls Vertex once per chunk, capped at 4 chunks |
| Vertex retry behavior | `supabase/functions/_shared/vertex-ai.ts` lines 355-364 and 401-405 | one logical `callVertexAI(...)` can attempt multiple model/location requests on 404/network conditions |

## Required Internal Auth Mechanism

The future safe invocation must run inside a trusted Supabase Edge Function context that already has access to internal secrets. The caller should use placeholders in documentation only and never expose values:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- optionally `WORKER_INTERNAL_SECRET`
- `x-internal-service-key: <SUPABASE_SERVICE_ROLE_KEY>`
- `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`
- optional `x-worker-secret: <WORKER_INTERNAL_SECRET>`

Do not use `SUPABASE_SERVICE_ROLE_KEY` locally. Do not print it. Do not paste it into chat. Do not commit it.

## Target Dry-Run Payload

The intended `normalize-pdf-output` request body shape is:

```json
{
  "dry_run": true,
  "sample_text": "THIS LEASE AGREEMENT made and entered into this 8th day of September 2020, by and between Markets at Choto, LLC, as Landlord, and Cress Family Restaurants, LLC, as Tenant. The Premises are Building 9, Suites 3 and 4, approximately 3,002 rentable square feet, located at 12350 South Northshore, Knoxville, Tennessee, in The Markets at Choto. Tenant shall pay its pro-rata share of real estate taxes, insurance premiums, and common area maintenance expenses. CAM estimate for 2021 is $5.25 per leasable square foot. Tenant shall also pay a 5 percent administrative or management fee. Security Deposit Addendum states a total security deposit of $15,535.36.",
  "debug_business_extraction_provider": "vertex_fact_ledger"
}
```

This payload must not include `file_id`.

## Zero-DB Confirmation

The `normalize-pdf-output` dry-run branch returns before the normal `file_id` path. Code comments identify it as no DB writes and no uploaded-file row. It builds an in-memory `dryRunDocling` object from `sample_text` and returns a dry-run response.

The zero-DB condition depends on all of the following:

1. `dry_run=true`
2. `sample_text` present
3. no `file_id`
4. internal auth so the debug provider override is honored
5. no use of the normal `file_id` normalize path

## One-Call Confirmation

Cannot confirm with the existing `vertex_fact_ledger` pipeline.

Reasons:

1. `classifyDocumentProfile(...)` makes one Vertex request for profile classification.
2. `extractFactLedger(...)` then makes at least one Vertex request for fact extraction when the text is long enough.
3. Fact extraction can process multiple chunks, capped at 4.
4. The low-level Vertex helper may retry across model/location attempts.

Therefore, one internal dry-run request is possible, but exactly one Vertex model request is **not guaranteed** by the current code path.

## Gemini/OpenAI Fallback Confirmation

The `vertex_fact_ledger` modules inspected use `callVertexAIJSON(...)` / `callVertexAIFileJSON(...)`. They do not call OpenAI or the Gemini Developer API helpers directly. The low-level Vertex helper can retry Vertex model/location attempts and logs guidance about Gemini fallback, but it does not itself call `callGeminiWithAPIKey(...)` in the inspected path.

Risk: if the debug provider override is not honored, `normalize-pdf-output` falls back to `legacy_hybrid`, which may use the legacy LLM stack. That is why internal auth is mandatory before any future call.

## Exact Human Action Needed

Do not run this yet. Before Phase 52, choose one of these safe implementation routes.

### Route A - Minimal Temporary Admin-Only Diagnostic Function

Create but do not deploy until explicitly approved:

- `supabase/functions/phase52-vertex-dry-run/index.ts`
- admin-only entrypoint using existing `verifyUser(...)`
- accepts no `file_id`
- uses fixed representative Craven `sample_text`
- internally calls `normalize-pdf-output` with:
  - `dry_run=true`
  - `sample_text=<representative Craven sample>`
  - `debug_business_extraction_provider="vertex_fact_ledger"`
- uses Edge runtime internal auth headers from secrets
- returns only summarized response fields and no secret values
- does not write to tables
- deletes/removes function after the one approved diagnostic if desired

Placeholder operator command, not to run in Phase 52A:

```powershell
# After separate approval and deployment of the temporary admin-only diagnostic function:
Invoke-RestMethod `
  -Method Post `
  -Uri "https://<project-ref>.supabase.co/functions/v1/phase52-vertex-dry-run" `
  -Headers @{ Authorization = "Bearer <ADMIN_USER_JWT>"; apikey = "<SUPABASE_ANON_KEY>" } `
  -Body '{}' `
  -ContentType 'application/json'
```

This route avoids local service-role use. It still does not solve the exact one Vertex model request constraint unless the temporary diagnostic function calls a deliberately one-call helper rather than full `runVertexFactLedgerPipeline(...)`.

### Route B - Source-Level One-Request Diagnostic Option

Add a temporary or test-only diagnostic option that enforces one model request before invocation. Examples:

- bypass profile classifier and provide `documentSubtype="base_lease"` / deterministic profile input
- cap fact extraction to one chunk
- disable Vertex model/location retry attempts for diagnostic mode
- call `callVertexAIJSON(...)` once with a combined classification/fact-extraction prompt

This route needs a small source phase before Phase 52. It is the only way to honestly satisfy **exactly one Vertex model request**.

## Recommended Next Step Before Phase 52

Run a Phase 52B implementation-prep phase that creates the minimal admin-only diagnostic function or one-request diagnostic option, with tests proving:

1. no `file_id` is accepted
2. dry-run body includes `debug_business_extraction_provider="vertex_fact_ledger"`
3. no Supabase table writes occur
4. secrets are never returned
5. request count is bounded to exactly one provider model request, or the test explicitly fails
6. no Gemini/OpenAI/Azure paths are called

Do not invoke Vertex until that one-request bound is implemented and separately approved.

## Recommendation

Recommendation remains: **No Gate**.
