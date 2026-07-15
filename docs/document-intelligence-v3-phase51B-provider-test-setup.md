# Enterprise Document Intelligence v3 - Phase 51B Provider Test Setup

## Executive Summary

Phase 51B prepared the safe shape of a future provider-backed extraction test environment without making any provider call. No VertexAI, Gemini, OpenAI, Azure, parse, extraction, deployment, remote read/write, production write, or secret-value exposure occurred.

Chosen execution mode: **no-DB direct diagnostic harness**.

The future Phase 52 test should load the local Craven uploaded-file export, call the provider only after explicit approval, compare the provider result against the current normalized Lease Review output, and write only a local diagnostic artifact. It must not use the DB-writing `normalize-pdf-output` path for the first provider call.

Recommendation remains: **No Gate**.

## Approved Future Target

| Item | Value |
| --- | --- |
| uploaded_file_id | `0155251a-b911-408c-ae83-469d8d6eb534` |
| file | `Craven Wings Lease Executed 1.pdf` |
| document subtype | `base_lease` |
| reason | CAM/expense-heavy document that exposed the largest no-provider coverage gaps |

## Execution Mode Decision

| Mode | Phase 51B decision | Notes |
| --- | --- | --- |
| No-DB direct diagnostic harness | chosen | Preferred first provider-backed test path. It should read local exports, call the provider only in Phase 52 after approval, keep results in memory, and write only a local artifact/report. |
| DB-writing normalize path | deferred | Use only if explicitly approved later. This path can write `uploaded_files` payloads/status/counts, v3 rows, package graph rows, and pipeline logs. It is not appropriate for the first provider call. |

## Required Config Names

Values were not printed or inspected. The local check reported only present/missing by variable name.

| Config name | Local readiness | Phase 52 handling |
| --- | --- | --- |
| `ENABLE_DOCUMENT_INTELLIGENCE_V3` | missing locally | supply manually if needed for diagnostic behavior; do not enable globally |
| `BUSINESS_EXTRACTION_PROVIDER` | missing locally | keep scoped to one execution only if used; do not set global default |
| `VERTEX_PROJECT_ID` | missing locally | user/admin must supply if Vertex is selected |
| `GOOGLE_PROJECT_ID` | missing locally | user/admin must supply if used instead of `VERTEX_PROJECT_ID` |
| `VERTEX_LOCATION` | missing locally | user/admin must supply |
| `VERTEX_MODEL` | missing locally | user/admin must supply or confirm repo default |
| `GEMINI_MODEL` | missing locally | user/admin must supply only if this path is used |
| `GOOGLE_APPLICATION_CREDENTIALS` | missing locally | user/admin must supply securely if file-based auth is used |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | missing locally | user/admin must supply securely if JSON auth is used |
| `GOOGLE_CLIENT_EMAIL` | missing locally | user/admin must supply securely if split credentials are used |
| `GOOGLE_PRIVATE_KEY` | missing locally | user/admin must supply securely if split credentials are used |
| `GEMINI_API_KEY` | missing locally | optional fallback only; not required for Vertex-only test |
| `GOOGLE_API_KEY` | missing locally | optional fallback only; not required for Vertex-only test |
| `OPENAI_API_KEY` | missing locally | optional fallback only; not required for Vertex-only test |

Remote/staging configuration remains unknown because Phase 51B did not perform remote reads or inspect hosted secrets.

## Secret Hygiene Check

| Check | Result |
| --- | --- |
| `.env` files ignored | yes: `.env`, `.env.local`, `.env.production`, `.env.development.local`, `.env.test.local`, `.env.production.local`, and `.env/` are ignored |
| tracked credential-like files | no tracked credential/private-key/service-account file names found; only `.env.example` is tracked |
| service-account JSON committed | no service-account JSON file names were found in tracked files |
| secret values printed | no |
| docs/logs checked | docs contain configuration names from prior reports, not secret values |
| future output path hygiene | top-level `tmp/` is not currently ignored by the observed `.gitignore`; Phase 52 must add/confirm an ignored local artifact path before writing `tmp/phase52-vertex-craven-diagnostic.json` |

## Existing Harness Status

No existing no-DB Phase 52 diagnostic harness was found.

Relevant existing implementation points identified for a future harness:

| Area | Existing path |
| --- | --- |
| provider orchestrator | `supabase/functions/_shared/extraction/vertex-fact-ledger/orchestrator.ts` |
| provider entrypoint function | `runVertexFactLedgerPipeline(...)` |
| DB-writing normalize entry | `supabase/functions/normalize-pdf-output/index.ts` |
| v3 side-write path | `supabase/functions/_shared/extraction/document-intelligence-v3/side-write.ts` |
| v3 mapper | `supabase/functions/_shared/extraction/document-intelligence-v3/fact-mapper.ts` |
| provider tests | `supabase/functions/_tests/vertex-fact-ledger.test.ts` |

## Proposed Phase 52 Harness Design

Do not implement or run this until Phase 52 is explicitly approved.

1. Create a local diagnostic script, for example `scripts/phase52-vertex-craven-diagnostic.mjs` or a Deno equivalent.
2. Read only `uploaded_files_0155251a.json` from the approved local export path.
3. Build provider context from existing `docling_raw`, `normalized_output`, `ui_review_payload`, and any parsed text already present in the export.
4. Call `runVertexFactLedgerPipeline(...)` exactly once only after explicit Phase 52 approval.
5. Keep all provider output in memory; do not instantiate a Supabase client and do not call DB write helpers.
6. Produce a local artifact at `tmp/phase52-vertex-craven-diagnostic.json` only after confirming that path is ignored.
7. Include provider claims, evidence anchors, canonical projections, validation drops, and comparison against current normalized Lease Review output.
8. Record diagnostics in a report, not in production tables.

## Expected Phase 52 Output Artifact

`tmp/phase52-vertex-craven-diagnostic.json`

Expected sections:

| Section | Purpose |
| --- | --- |
| `provider_claims` | raw or normalized claim ledger from the provider response |
| `evidence_anchors` | page/source anchors returned by the provider path |
| `canonical_projections` | mapped CRE fields from provider-backed claims |
| `validation_drops` | fields/facts rejected by schema or validation rules |
| `current_lease_review_comparison` | diff against current normalized uploaded-file-only Lease Review output |
| `safety` | confirms no DB writes, no deployment, no parse/extraction rerun, and one approved file scope |

## Write Behavior Decision

The no-DB harness should avoid all Supabase writes.

The DB-writing normalize path remains explicitly deferred. If approved in a later phase, it may write:

- `uploaded_files.normalized_output`
- `uploaded_files.ui_review_payload`
- uploaded file status/count/debug columns
- `document_intelligence_runs`
- `document_claims`
- `document_claim_evidence`
- `document_canonical_field_projections`
- `document_validation_drops`
- package graph rows if available
- pipeline logs
- possibly `leases.extraction_data`, depending on the invoked server flow

## Can Phase 52 Run Now?

No.

Blockers:

1. Required provider configuration is missing locally.
2. Remote/staging secret readiness is unknown and was not inspected.
3. No existing no-DB diagnostic harness exists yet.
4. Top-level `tmp/` is not currently ignored by the observed `.gitignore`.
5. The user has not yet approved exactly one provider call for Phase 52.

## Exact Approval Needed Before Phase 52

Before any provider call, the user/admin must explicitly approve:

1. Exactly one provider call for `uploaded_file_id=0155251a-b911-408c-ae83-469d8d6eb534`.
2. The provider and model to use, such as Vertex/Gemini via the existing `vertex_fact_ledger` path.
3. Scoped local or staging credentials/configuration, supplied without exposing values in chat or committing files.
4. No-DB direct diagnostic harness mode.
5. A local ignored output path for `tmp/phase52-vertex-craven-diagnostic.json` or an equivalent ignored artifact path.
6. No production writes, no global provider flag change, and no DB-writing normalize path.

## Recommendation

Recommendation remains: **No Gate**.

Recommended Phase 52: after explicit approval and scoped provider configuration, implement or run a no-DB direct diagnostic harness for exactly one Craven provider call and write only a local ignored diagnostic artifact.
