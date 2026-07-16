# Phase 52C Timeout Postmortem

## Executive Summary

Phase 52C completed postmortem instrumentation for the internal-only Phase 52 Vertex diagnostic path. No VertexAI, Gemini, OpenAI, Azure, parse, extraction, deploy, database access, or endpoint invocation occurred in this phase.

The prior live diagnostic request reached the local Edge function and passed internal authentication and request validation, but it did not return normally. The Edge isolate emitted a wall-clock warning after roughly three minutes and was terminated early. No usable HTTP response and no local diagnostic artifact were produced.

The provider-call budget is therefore treated as consumed or indeterminate. No retry is approved.

Recommendation remains: **No Gate**.

## Phase 52 Live Diagnostic Result

| Area | Result |
| --- | --- |
| internal authentication | passed |
| request validation | passed |
| request entered diagnostic handler | confirmed |
| provider response | not received |
| Edge isolate | terminated after wall-clock timeout |
| output artifact | not created |
| provider-call budget | indeterminate / treated as consumed |
| retry approved | no |
| recommendation | No Gate |

## Blocking Operation Trace

The diagnostic helper now traces the operations that can block or fail before a response is returned.

| Operation | Blocking Risk | Phase 52C Handling |
| --- | --- | --- |
| service-account credential parsing | malformed or missing local runtime credentials can fail before auth | emits `auth_config_loaded`; errors are categorized as `auth_or_credentials` |
| JWT signing | private-key import/signing can fail before OAuth | emits `jwt_created` after JWT creation; no JWT is logged or returned |
| Google OAuth token request | network request can hang or return non-2xx | emits `oauth_request_started` and `oauth_request_completed`; bounded by short timeout; timeout category is `oauth_timeout` |
| Vertex `generateContent` request | network/model request can hang or return non-2xx | emits `vertex_request_started` and `vertex_response_received`; bounded timeout; timeout category is `vertex_timeout` |
| response body parsing | response can be invalid JSON or malformed | emits `response_parsed` after body parse and extraction |

## Diagnostic Stage Timing Added

Safe stage names are now available in the sanitized endpoint response:

- `auth_config_loaded`
- `jwt_created`
- `oauth_request_started`
- `oauth_request_completed`
- `vertex_request_started`
- `vertex_response_received`
- `response_parsed`

The stages expose names and elapsed milliseconds only. They do not include credentials, JWTs, access tokens, authorization headers, private keys, request bodies, or response bodies containing secrets.

## Explicit Timeout Behavior

Phase 52C added explicit `AbortController` timeouts around the two external network operations:

| Network Operation | Default Timeout | Sanitized Category |
| --- | ---: | --- |
| OAuth token request | 5000 ms | `oauth_timeout` |
| Vertex `generateContent` request | 30000 ms | `vertex_timeout` |

Non-2xx OAuth responses are categorized as `oauth_error`. Non-2xx Vertex responses are categorized as `vertex_error`. Provider response text is sanitized and truncated before being returned.

## Secret Safety

The implementation and tests verify that these values are not logged or returned:

- credentials
- JWTs
- access tokens
- authorization headers
- private keys
- service-account JSON
- raw stack traces containing environment data

The diagnostic endpoint returns only safe metadata such as provider, model, location, latency, token usage if available, stage timings, sanitized response text, or sanitized error category.

## GOOGLE_SERVICE_ACCOUNT_KEY Dotenv Inspection

The local dotenv-format inspection was presence and shape only. No values were printed.

| File | GOOGLE_SERVICE_ACCOUNT_KEY | JSON Validity | Required Fields |
| --- | --- | --- | --- |
| `.env` | missing | not applicable | not applicable |
| `.env.production` | missing | not applicable | not applicable |

Because the variable is absent locally, there was no service-account JSON to validate for `client_email`, `private_key`, and `project_id`.

## Verification

| Check | Result |
| --- | --- |
| `deno check supabase/functions/_tests/phase52-vertex-diagnostic.test.ts` | passed |
| `deno test --allow-env --allow-read supabase/functions/_tests/phase52-vertex-diagnostic.test.ts` | passed outside sandbox: 10 tests |
| OAuth timeout mocked test | passed; returns `oauth_timeout` |
| Vertex timeout mocked test | passed; returns `vertex_timeout` |
| non-2xx OAuth sanitized test | passed |
| non-2xx Vertex sanitized test | passed |
| exactly one Vertex `generateContent` request test | passed |
| no retry/model fallback/location fallback test | passed |
| no DB / no alternate provider source test | passed |
| QA JSON parse | passed after update |

No real external provider request was made during verification.

## Files Changed

- `supabase/functions/_shared/vertex-ai.ts`
- `supabase/functions/phase52-vertex-diagnostic/index.ts`
- `supabase/functions/_tests/phase52-vertex-diagnostic.test.ts`
- `docs/document-intelligence-v3-phase52C-timeout-postmortem.md`
- `docs/document-intelligence-v3-batch-audit-qa.md`
- `docs/document-intelligence-v3-batch-audit-qa.json`

## Recommendation

Recommendation remains: **No Gate**.

Do not retry the provider diagnostic yet. The next phase should review these timeout/stage diagnostics and decide whether to approve a single new invocation. Any future invocation should remain internal-only, sample-text-only, non-DB, non-deployed unless explicitly approved, and should stop immediately after one bounded provider attempt.