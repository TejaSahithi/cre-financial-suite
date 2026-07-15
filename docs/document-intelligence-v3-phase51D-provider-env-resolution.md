# Enterprise Document Intelligence v3 - Phase 51D Provider Env Resolution

## Executive Summary

Phase 51D inspected the provider-selection and credential-resolution code paths only. No VertexAI, Gemini, OpenAI, Azure, parse, extraction, deploy, remote write, Supabase secret change, provider flag change, diagnostic output creation, or secret-value exposure occurred.

Recommendation remains: **No Gate**.

## Code Paths Inspected

| Area | Code path | Finding |
| --- | --- | --- |
| business extraction provider selection | `supabase/functions/normalize-pdf-output/index.ts` lines 113-135 | `BUSINESS_EXTRACTION_PROVIDER` selects `vertex_fact_ledger`; default remains `legacy_hybrid`. |
| scoped business provider override | `supabase/functions/normalize-pdf-output/index.ts` lines 119-124, 1875-1877, 2284-2286 | `debug_business_extraction_provider` is accepted only when `isInternalCall(req)` is true. |
| parser/layout provider selection | `supabase/functions/_shared/extraction/extraction-provider.ts` lines 1-40 | `EXTRACTION_PROVIDER` controls parser/layout modes such as Azure Document Intelligence, not `vertex_fact_ledger`. |
| Vertex credential resolution | `supabase/functions/_shared/vertex-ai.ts` lines 97-105, 180-188, 347-352, 543-544 | Vertex uses `VERTEX_PROJECT_ID` or `GOOGLE_PROJECT_ID`, plus `GOOGLE_SERVICE_ACCOUNT_KEY` or split `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`; `VERTEX_LOCATION` or `GOOGLE_LOCATION` can override the default location. |
| v3 canonical layout/index behavior | `supabase/functions/_shared/extraction/vertex-fact-ledger/document-index-v3.ts` lines 123-160 | `ENABLE_DOCUMENT_INTELLIGENCE_V3` controls whether the provider tries the canonical-layout-backed index; otherwise it falls back to the legacy evidence index. |
| v3 side-write behavior | `supabase/functions/normalize-pdf-output/index.ts` lines 2520-2535 | v3 side-write is attempted after uploaded-file payload persistence and is gated inside the helper by `ENABLE_DOCUMENT_INTELLIGENCE_V3`. |
| internal-only auth gate | `supabase/functions/_shared/internal-auth.ts` lines 16-26 | internal calls require `WORKER_INTERNAL_SECRET` or `SUPABASE_SERVICE_ROLE_KEY`-backed headers. Values were not read or printed. |

## Correct Env Names

| Purpose | Correct names |
| --- | --- |
| business extraction provider | `BUSINESS_EXTRACTION_PROVIDER` |
| parser/layout provider | `EXTRACTION_PROVIDER` |
| v3 side-write / canonical-layout behavior | `ENABLE_DOCUMENT_INTELLIGENCE_V3` |
| Vertex project | `VERTEX_PROJECT_ID` or `GOOGLE_PROJECT_ID` |
| Vertex location | `VERTEX_LOCATION` or `GOOGLE_LOCATION`, with code fallback to `us-central1` |
| Vertex credentials, JSON form | `GOOGLE_SERVICE_ACCOUNT_KEY` |
| Vertex credentials, split form | `GOOGLE_CLIENT_EMAIL` plus `GOOGLE_PRIVATE_KEY` |

## Why `EXTRACTION_PROVIDER` Should Not Be Reused

`EXTRACTION_PROVIDER` resolves to parser/layout modes: `legacy`, `azure_document_intelligence`, `azure_with_legacy_fallback`, or `shadow_compare`. It is used to decide Azure/layout parser behavior.

`vertex_fact_ledger` is selected by `BUSINESS_EXTRACTION_PROVIDER`, not `EXTRACTION_PROVIDER`. Reusing `EXTRACTION_PROVIDER` for `vertex_fact_ledger` would mix two separate concerns:

- parser/layout acquisition, such as Azure Document Intelligence
- business extraction / claim-ledger reasoning, such as `legacy_hybrid` versus `vertex_fact_ledger`

The safe path is to leave `EXTRACTION_PROVIDER` unchanged for Phase 52.

## Scoped Override Availability

A scoped override is available: request body field `debug_business_extraction_provider` can choose `vertex_fact_ledger` for a single request, but only when the request passes `isInternalCall(req)`.

Implications:

- Normal browser/user requests cannot select the provider through this field.
- The override avoids changing the `BUSINESS_EXTRACTION_PROVIDER` project secret/global default.
- The override is suitable for controlled internal testing only.
- The override itself does not make every route no-DB; write behavior depends on which request branch is used.

## DB Write Behavior

| Path | Can use scoped override? | DB writes? | Phase 52 suitability |
| --- | --- | --- | --- |
| `dry_run=true` + `sample_text` branch in `normalize-pdf-output` | yes, if internal call | no uploaded-file row exists; code comments identify this as zero-DB-write comparison path | safe but limited, because it tests sample text rather than the full uploaded-file payload |
| normal `file_id` normalize path | yes, if internal call | yes; sets status, persists `normalized_output`, `ui_review_payload`, counts, and may run v3 side-write | not suitable for first provider call |
| direct local no-DB harness importing `runVertexFactLedgerPipeline(...)` | not via request override; it calls orchestrator directly | no DB writes if it never instantiates Supabase client or side-write helpers | preferred first provider test, but local credentials must be supplied securely |

## Supabase Secrets and Runtime Boundary

Supabase secrets are available to code running inside the Supabase Edge Function runtime through `Deno.env`. A standalone local no-DB harness cannot use hosted Supabase secrets unless those values are separately provided to that local process.

Safe interpretation:

- If using Supabase-hosted secrets without copying them locally, the test must run inside the Supabase Edge Function runtime.
- If using a local no-DB harness, credentials must be supplied to the local runtime securely and transiently, without printing values or committing files.
- Do not use `SUPABASE_SERVICE_ROLE_KEY` directly in the local harness.
- Do not set `BUSINESS_EXTRACTION_PROVIDER` globally.

## Safe First Vertex Test Path

Preferred Phase 52 path remains:

1. Use the no-DB direct diagnostic harness design.
2. Load only the approved Craven export: `uploaded_files_0155251a.json`.
3. Build context from existing `docling_raw`, `normalized_output`, and `ui_review_payload`.
4. Supply Vertex credentials securely to the local runtime or choose a Supabase Edge `dry_run` approach if the goal is to use hosted Supabase secrets without local copying.
5. Call `runVertexFactLedgerPipeline(...)` exactly once only after explicit Phase 52 approval.
6. Write output only under ignored `tmp/phase52-*` artifact paths.
7. Do not invoke the normal `file_id` normalize path for the first provider call.

## Exact Next Step Before Phase 52

Before Phase 52 starts, choose one of these two safe modes:

| Mode | Required approval/input |
| --- | --- |
| local no-DB harness | explicit approval for one provider call; secure local Vertex env setup by name only; confirm no Supabase client/write helpers; output under ignored `tmp/phase52-*` |
| Supabase Edge dry-run | explicit approval for one internal dry-run provider call; use hosted secrets inside Edge runtime; provide sample text only; confirm no uploaded-file `file_id` normalize path |

Do not proceed to Phase 52 until the user explicitly approves one provider call and confirms the credential/runtime mode.

## Recommendation

Recommendation remains: **No Gate**.
