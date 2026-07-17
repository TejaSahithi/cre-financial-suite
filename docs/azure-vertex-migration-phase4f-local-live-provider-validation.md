# Azure + Vertex Canonical Pipeline Migration Phase 4F - Local Live-Provider Validation

## 1. Executive Result

Phase 4F local live-provider validation did not proceed past preflight. The requested live Azure -> canonical layout -> Vertex -> normalized output -> Lease Review workflow was not executed because required local Azure Document Intelligence configuration was not available and no approved/sanitized lease document was available for the run.

No deployment occurred. No Supabase link was changed. No remote Supabase project was read from or written to. No database migration was created. No provider default was changed. No implementation code was modified.

## 2. Commit and Branch

- Branch: `feature/document-intelligence-v3`
- HEAD commit: `95668ae` - `Complete Phase 4E local provider fallback`
- Working tree before report creation: clean
- Recent log included `95668ae`, `8e382de`, `c17f7b2`, `f456e90`, and `f2043af`

## 3. Local Environment

`supabase status` was run outside the sandbox because the Supabase CLI writes telemetry under the user profile. Local Supabase was running at the local development URL `http://127.0.0.1:54321`. The Edge runtime was stopped before validation and remained stopped after preflight.

Stopped local services reported by Supabase included the Edge runtime container. A follow-up process/container check found:

- Supabase serve processes: none
- Edge runtime container: not running

## 4. Test-Document Profile

Blocked before selection.

Local file inventory found no approved/sanitized lease PDF available for this run. The only PDF found in the repo scan was `scratch/root-artifacts/dummy_lease.pdf`, length 4 bytes, which is not a usable lease document. No attached PDF/DOCX lease was provided with the Phase 4F request.

A synthetic lease could be generated in a later attempt if explicitly approved for this validation path, but this run was already blocked by missing Azure configuration.

## 5. Upload Method

Not run. No local upload was attempted.

## 6. Azure Validation

Blocked before Azure call.

Repository/env-name discovery confirmed the existing Azure configuration names used by the code:

- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`
- `AZURE_DOCUMENT_INTELLIGENCE_KEY`
- `AZURE_DOCUMENT_INTELLIGENCE_API_VERSION`
- `AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID`
- `AZURE_DOCUMENT_INTELLIGENCE_OUTPUT_FORMAT`
- `STORE_FULL_AZURE_RAW_RESPONSE`
- parser selector: `EXTRACTION_PROVIDER`

Presence check result, values not printed:

- Azure endpoint: absent
- Azure credential: absent
- Azure parser mode configuration: absent in local env files/process/user/machine env
- `STORE_FULL_AZURE_RAW_RESPONSE`: absent, therefore not set true

Azure was not called.

## 7. Canonical-Layout Validation

Not run. No Azure layout result was produced, so no canonical-layout resolver validation was possible.

## 8. Vertex Validation

Not run. Vertex was not called because the required Azure parser preflight failed first.

Repository/env-name discovery confirmed the existing Vertex configuration names used by the code:

- `VERTEX_PROJECT_ID` or `GOOGLE_PROJECT_ID`
- `VERTEX_LOCATION` or `GOOGLE_LOCATION`
- `VERTEX_MODEL` or `GEMINI_MODEL`
- `GOOGLE_SERVICE_ACCOUNT_KEY`, or `GOOGLE_CLIENT_EMAIL` plus `GOOGLE_PRIVATE_KEY`
- optional Gemini fallback: `GEMINI_API_KEY` or `GOOGLE_API_KEY`

Presence check result, values not printed:

- Vertex project: present in `.env.phase52.local`
- Vertex authentication: present in `.env.phase52.local`
- Vertex location/model configuration: location present in `.env.phase52.local`; model not confirmed

## 9. Acceptance Result

Not run. No business-extraction acceptance result was produced.

## 10. Provider Provenance

Not run. No new `normalized_output` or `ui_review_payload` was produced.

## 11. Normalized-Output Validation

Not run.

## 12. UI-Review-Payload Validation

Not run.

## 13. Source-Grounded Field Sample

Not run. No document was processed and no extracted field sample was generated.

## 14. Status Transitions

Not run. No `uploaded_files` row was created for Phase 4F.

## 15. Idempotency Result

Not run. The required first local live-provider workflow did not run, so the retry/idempotency check was not attempted.

## 16. CAS/Attempt-Identity Result

Not run.

## 17. Latency and Provider Usage

Not run.

No Azure duration, Vertex duration, token counts, request counts, or total processing duration were produced.

## 18. Regression Results

Not run for Phase 4F because live validation stopped at preflight before any implementation code changed. Phase 4E remains the latest committed validated baseline at `95668ae`.

The known `pipeline-status-edge.test.ts` baseline failure remains documented from Phase 4E and prior reports; it was not re-executed in this blocked Phase 4F preflight.

## 19. Security and Secret Checks

No secret values were printed in this report.

Preflight checked only presence/absence of required local configuration. The following required Phase 4F inputs were missing:

- Azure Document Intelligence endpoint
- Azure Document Intelligence credential
- Approved/sanitized lease document

No remote Supabase project was used. No production database or Storage access occurred. No Azure raw response was persisted because Azure was never called.

## 20. Runtime Cleanup

No live-provider runtime was started. No Edge Functions serve process remained active after preflight.

Safe-resting state confirmed:

- `BUSINESS_EXTRACTION_PROVIDER`: not changed by this run
- `ENABLE_LOCAL_PROVIDER_MOCKS`: not enabled by this run
- Edge runtime: stopped
- Supabase serve processes: none
- Git status before report creation: clean

## 21. Remaining Risks

- Real Azure Document Intelligence was not validated locally.
- Real Vertex AI was not validated in the end-to-end local workflow.
- No approved/sanitized lease document was processed.
- No output/provenance/idempotency evidence was produced for Phase 4F.

## 22. Next Production Decision

Remote activation is not under consideration from this blocked run. Before retrying Phase 4F, provide or configure all of the following locally without printing values:

1. `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`
2. `AZURE_DOCUMENT_INTELLIGENCE_KEY`
3. The intended parser mode via existing repository configuration, likely `EXTRACTION_PROVIDER=azure_document_intelligence` or the repository-approved equivalent
4. Vertex project/auth config loaded into the local Edge runtime
5. One approved/sanitized or explicitly synthetic commercial lease document for local-only testing

LOCAL LIVE-PROVIDER VALIDATION BLOCKED