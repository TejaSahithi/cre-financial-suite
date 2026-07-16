# Phase 52D Bounded Retry Precheck

## Executive Summary

Phase 52D performed a safe local runtime precheck for `.env.phase52.local` before any future bounded Vertex diagnostic retry. No VertexAI, Gemini, OpenAI, Azure, endpoint invocation, deploy, database access, network request, parse, extraction, or secret-value printing occurred.

The actual local runtime file contains a usable Vertex credential configuration for a future bounded attempt, subject to explicit approval before any invocation.

Recommendation remains: **No Gate**.

## Scope

| Area | Result |
| --- | --- |
| env file inspected | `.env.phase52.local` only |
| network requests | none |
| `phase52-vertex-diagnostic` invoked | no |
| VertexAI invoked | no |
| database accessed | no |
| secrets printed or changed | no |
| deploy | no |

## Safe Presence and Shape Checks

| Variable / Config | Result |
| --- | --- |
| `WORKER_INTERNAL_SECRET` | present |
| `VERTEX_PROJECT_ID` or `GOOGLE_PROJECT_ID` | present |
| `VERTEX_LOCATION` | present |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | present |
| split `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY` | missing |

The split credential pair is not required because `GOOGLE_SERVICE_ACCOUNT_KEY` is present and valid.

## GOOGLE_SERVICE_ACCOUNT_KEY Shape

The service-account JSON was parsed in memory only. No field values were printed.

| Check | Result |
| --- | --- |
| JSON parse | valid JSON |
| `type` | present |
| `project_id` | present |
| `private_key` | present |
| `client_email` | present |
| `token_uri` | present |
| private key BEGIN marker | present |
| private key END marker | present |

## Local Function Runtime Command

The local function should receive this env file through the Supabase Edge runtime command:

```powershell
supabase functions serve phase52-vertex-diagnostic --env-file .env.phase52.local --no-verify-jwt
```

This command was not run in Phase 52D. The next invocation must still be separately approved.

## Timeout Review

The Phase 52C diagnostic helper has bounded network timeouts:

| Operation | Timeout | Review |
| --- | ---: | --- |
| Google OAuth token request | 5000 ms | short, explicit, and fail-fast for token acquisition |
| Vertex `generateContent` request | 30000 ms | bounded but long enough for a single low-output diagnostic request under normal conditions |
| combined nominal network bound | about 35000 ms plus parsing overhead | safely below the prior roughly three-minute Edge isolate termination window |

If the environment or network is unusually slow, the request should now return a sanitized `oauth_timeout` or `vertex_timeout` instead of hanging until isolate termination.

## Stage Timing Readiness

A future bounded request can return safe stage timings for:

- `auth_config_loaded`
- `jwt_created`
- `oauth_request_started`
- `oauth_request_completed`
- `vertex_request_started`
- `vertex_response_received`
- `response_parsed`

Failure responses can return partial stage timings, which should identify whether the stall is before OAuth completion, during OAuth, during Vertex, or after the Vertex response.

## Precheck Verdict

| Area | Verdict |
| --- | --- |
| internal auth material available | yes |
| Vertex project config available | yes |
| Vertex location config available | yes |
| usable service-account JSON shape | yes |
| timeout instrumentation ready | yes |
| safe stage timings ready | yes |
| approved to retry | no |

## Recommendation

Recommendation remains: **No Gate**.

Recommended next step: only after explicit approval, run exactly one bounded internal sample-text diagnostic invocation using the prepared env file and stop immediately after the sanitized response or timeout category is captured.