# Enterprise Document Intelligence v3 - Phase 51A Vertex Provider Preflight

Date: 2026-07-15

Recommendation: **No Gate**

## Executive Summary

Phase 51A performed a provider-backed extraction preflight only. No VertexAI, Gemini, OpenAI, Azure, parse, extraction, deploy, remote write, or production write occurred. No secret values were printed or exposed.

Result: a safe provider-backed test is **not currently executable** from the inspected local environment because the required scoped provider configuration is missing. Remote/staging Supabase function secrets were not read in this phase, so their status is `unknown / inaccessible`.

The recommended future target remains one document only: **Craven Wings Lease Executed 1.pdf** (`uploaded_file_id=0155251a-b911-408c-ae83-469d8d6eb534`) because it is CAM-heavy and exposed the largest Track 1 coverage gaps.

## Task A - Safe Target Environment

| Environment | Status | Finding |
| --- | --- | --- |
| local | safest recommended target | Local environment was inspected by key presence only. Required provider keys are missing. A later local test could avoid production writes if run against local DB or a direct local diagnostic harness. |
| staging Supabase function | possible later, not verified | Not inspected because Phase 51A disallowed remote reads/secrets access. Would require explicit approval and scoped staging secrets. |
| production Supabase function | not recommended for first provider call | Not inspected. Production should not be used for the first provider-backed test because writes and runtime defaults are harder to isolate. |

Recommended environment for the first provider test: **local first**, or staging only after explicit approval and confirmation of scoped non-production secrets.

## Task B - Configuration Presence Only

Values were never printed. Presence was checked only by key name in the current process environment and local `.env`, `.env.production`, and `.env.example` files.

| Configuration | Local process env | Local env files | Remote/staging function secrets |
| --- | --- | --- | --- |
| `ENABLE_DOCUMENT_INTELLIGENCE_V3` | missing | missing | unknown / inaccessible |
| `BUSINESS_EXTRACTION_PROVIDER` | missing | missing | unknown / inaccessible |
| `VERTEX_PROJECT_ID` or `GOOGLE_PROJECT_ID` | missing | missing | unknown / inaccessible |
| Google service account full JSON (`GOOGLE_SERVICE_ACCOUNT_KEY`) | missing | missing | unknown / inaccessible |
| Google split credentials (`GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`) | missing | missing | unknown / inaccessible |
| `GOOGLE_APPLICATION_CREDENTIALS` | missing | missing | unknown / inaccessible |
| Vertex location/model config (`VERTEX_LOCATION`, `VERTEX_MODEL`) | missing | missing | unknown / inaccessible |
| optional Gemini fallback key (`GEMINI_API_KEY` / `GOOGLE_API_KEY`) | missing / not checked for `GOOGLE_API_KEY` in local files | missing / not checked for `GOOGLE_API_KEY` in local files | unknown / inaccessible |
| optional OpenAI fallback key (`OPENAI_API_KEY`) | missing | missing | unknown / inaccessible |

Blockers:

- Need `ENABLE_DOCUMENT_INTELLIGENCE_V3=true` scoped to the future execution only.
- Need `BUSINESS_EXTRACTION_PROVIDER=vertex_fact_ledger` scoped to the future execution only, or an internal debug override in a server-owned flow.
- Need `VERTEX_PROJECT_ID` or `GOOGLE_PROJECT_ID`.
- Need either `GOOGLE_SERVICE_ACCOUNT_KEY` or `GOOGLE_CLIENT_EMAIL` plus `GOOGLE_PRIVATE_KEY`.
- Need explicit user approval for exactly one provider call before any execution.

## Task C - One-Document Scope

Preferred target:

| Field | Value |
| --- | --- |
| uploaded_file_id | `0155251a-b911-408c-ae83-469d8d6eb534` |
| file | `Craven Wings Lease Executed 1.pdf` |
| document type | CAM-heavy base lease |
| reason | It exposed the largest Track 1 gaps: property address selection, CAM estimate, expense recovery, rent schedule, security deposit, and Clause Records quality. |

Alternative target: Phase 45 base lease (`f26f2cb5-4764-496c-a68f-484fc7a41085`) if the next step should be lower complexity.

No provider was run.

## Task D - Write Behavior If Later Approved

Provider selection happens in `normalize-pdf-output/index.ts`. The default provider is `legacy_hybrid`; `vertex_fact_ledger` is strictly opt-in through `BUSINESS_EXTRACTION_PROVIDER=vertex_fact_ledger` or an internal debug override. The Vertex path returns the same `ExtractionPipelineResult` contract as the legacy pipeline.

If a later approved test uses the normal `normalize-pdf-output` flow, expected writes include:

| Destination | Write Behavior |
| --- | --- |
| `uploaded_files.normalized_output` | updated with pipeline result and extraction debug metadata |
| `uploaded_files.ui_review_payload` | updated with Lease Review payload; enrichment may later patch JSONB status fields |
| `uploaded_files.parsed_data` / counts / statuses | updated by normalize flow depending on path/status |
| `document_intelligence_runs` | upserted when `ENABLE_DOCUMENT_INTELLIGENCE_V3=true` |
| `document_claims` | delete-and-replace for the same v3 `run_id` idempotency key, then inserted |
| `document_claim_evidence` | inserted for claim evidence; claim delete cascades prior evidence for same run |
| `document_validation_drops` | delete-and-replace for the same v3 `run_id` |
| `document_canonical_field_projections` | delete-and-replace for the same v3 `run_id` |
| package graph tables | may be upserted by `upsertPackageGraphForRun` if tables are available |
| pipeline logs | logger events may be written by the normalize/pipeline flow |
| `leases.extraction_data` | not directly written by the v3 side-write itself, but may be updated later by review/draft flows that consume the uploaded file payload |

Can writes be scoped or disabled?

- Scoped: yes, by one `uploaded_file_id`, one `org_id`, one provider config, and idempotency key.
- Disabled: partially. A direct local provider harness could call only `runVertexFactLedgerPipeline` and avoid DB writes, but it would not test the full normalize/side-write path. The normal `normalize-pdf-output` path writes `uploaded_files` payloads before v3 side-write.
- Production-safe disabled mode: not confirmed. Do not assume production dry-run safety without a separate implementation/verification phase.

## Task E - Rollback and Safety

Preferred safety sequence for a future approved provider test:

1. Use local DB only, or staging only if local is impossible.
2. Use only `uploaded_file_id=0155251a-b911-408c-ae83-469d8d6eb534` and the matching `org_id`.
3. Scope `ENABLE_DOCUMENT_INTELLIGENCE_V3=true` and `BUSINESS_EXTRACTION_PROVIDER=vertex_fact_ledger` to the single execution only.
4. Do not globally change project defaults.
5. Capture the v3 `run_id` and idempotency key.
6. If using DB writes, rollback by deleting rows for that `run_id` from v3 tables and reverting/removing only the local/staging uploaded-file payload changes created by that run.
7. Do not use production for the first provider-backed attempt.

## Safe Provider Test Possibility

Current answer: **not possible yet from the inspected local environment**.

Reason: provider configuration is missing locally and remote/staging secrets were intentionally not inspected.

Exact next approval needed:

- User explicitly approves exactly one provider call.
- User confirms target environment: local preferred, staging acceptable, production not recommended.
- User provides or confirms scoped non-production Vertex credentials are configured without exposing values in chat/logs.
- User confirms whether the future run should be DB-writing normalize path or no-DB direct provider diagnostic harness.

## Recommendation

**No Gate.**

Recommended Phase 51B: configure scoped local/staging provider credentials and choose one execution mode. Do not run the provider until that phase receives explicit approval for exactly one provider call.
