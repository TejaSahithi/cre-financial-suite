# Phase 5D - Lease-to-Source-Document Linkage Hardening

Date: 2026-07-17
Branch: feature/document-intelligence-v3
Verdict: PHASE 5D COMPLETE — SOURCE LINKAGE AND RPC SECURITY VALIDATED

## 1. Executive Result

Phase 5D hardened the lease-to-source-document contract from upload handoff through Lease Review reload, source viewing, authenticated prepare retry, approval, and approved version traceability.

The durable source identity is now explicit and deterministic:

- `leases.source_file_id` is the typed authority.
- `leases.extraction_data.source_file_id` is preserved as the legacy/metadata mirror.
- `document_links` receives a source link during server-owned prepare.
- `abstract_snapshot.source_document` and `abstract_snapshot.uploaded_file_id` preserve the source identity at approval/version time.
- Lease Review no longer auto-writes heuristic same-org source matches.

No Azure, Vertex, parser, worker, deployment, remote Supabase, provider default, canonical-layout, or live-provider path was touched.

## 2. Scope and Constraints

In scope:

- Lease Upload `Open Lease Review` handoff.
- `review-approve` prepare/idempotency path.
- Source-file manual repair path.
- Lease Review source-file resolver and source-view target.
- Approval snapshot/version source traceability.
- Focused authenticated local validation.

Out of scope and not touched:

- Azure/Vertex/provider calls.
- Parser and worker implementation.
- Deployment or remote Supabase.
- Provider defaults and canonical layout.
- Broad UI redesign.
- Phase 5E.

## 3. Preflight

Preflight state:

- Branch: `feature/document-intelligence-v3`.
- Phase 5C was committed before Phase 5D work: `ef99701 Complete Phase 5C authenticated local workflow validation`.
- Local Supabase REST root was reachable at `http://127.0.0.1:54321`.
- Required local Edge Function endpoints responded to OPTIONS before implementation work.
- Focused baseline frontend suites before edits: `10 files / 116 tests passed`.

## 4. Audit Findings

Confirmed defects:

- Lease Upload source-link refresh checked/wrote only the JSON metadata path and did not treat top-level `leases.source_file_id` as the primary source authority.
- `review-approve` prepare idempotency looked up legacy JSON first and then could fall back to tenant/date matching. That fallback could select an unrelated same-org upload when two documents share similar tenant/property facts.
- Lease Review automatically wrote a guessed source link from same-org ranked candidates when no explicit source link existed.
- `SourceFileLink.findUploadedFileForLease` could fall back through `uploaded_files.reviewed_output.lease_review_ids` instead of requiring an explicit typed source ID or source `document_links` row.
- Approved abstract snapshots lacked explicit source-document metadata.

## 5. Implementation Changes

Implemented changes:

- `review-approve` now finds existing drafts only by explicit source identity: typed `source_file_id`, legacy source JSON paths, or explicit source `document_links`.
- `review-approve` syncs typed source ID, JSON source metadata, and `document_links` during create, existing-source reuse, and idempotent `lease_review_ids` retry.
- Lease Upload now resolves existing leases by typed source ID first, then legacy JSON, then explicit document link.
- Lease Review candidate scan remains visible but no longer performs an automatic source-link write.
- Manual source-link repair now goes through `update-lease-extraction-field` instead of direct table update.
- `update-lease-extraction-field` validates source uploads are in the authenticated org before source-link updates.
- `buildAbstractSnapshot` writes `source_document` and `uploaded_file_id` metadata.

## 6. Migration Decision

A migration was necessary after source inspection and test evidence.

Reason:

- Updating `leases.source_file_id` in the Edge Function after calling `update_lease_extraction_field` caused a second `leases` update and therefore a second trigger audit row.
- The existing one-canonical-audit-row contract for `update_lease_extraction_field` must remain intact.

Migration added:

- `supabase/migrations/20260820000001_phase5d_source_link_typed_source.sql`

The migration keeps typed `leases.source_file_id` updates inside the existing RPC transaction/audit boundary for `field_area = source_link`.

Local migration application:

- Command: `supabase db push --local --include-all`
- Result: PASS
- Applied: `20260820000001_phase5d_source_link_typed_source.sql`
- Note: Supabase also applied pre-existing pending local migration `20260823000000_document_intelligence_v3_package_graph.sql`; that file was already present and was not edited for Phase 5D.

## 7. Upload-to-Lease Contract

Validated behavior:

- Upload A prepare creates/reuses a lease linked to Upload A only.
- `leases.source_file_id = Upload A`.
- `leases.extraction_data.source_file_id = Upload A`.
- `document_links.file_id = Upload A` for the lease source link.
- Upload B with the same tenant/similar name is not selected as a fallback.

## 8. Prepare Idempotency

Validated behavior:

- First prepare for Upload A returns a lease ID.
- Repeating prepare for Upload A returns the same lease ID.
- Retry reports `inserted_count = 0` and `existing = true`.
- Reviewer field-review state survives the retry.
- Retry does not alter the source link away from Upload A.

## 9. Missing Link and Repair Behavior

Validated behavior:

- Missing explicit source link no longer triggers an automatic same-org write.
- Lease Review still shows ranked candidates for manual repair.
- Manual repair must call the authenticated source-link Edge Function.
- Cross-org source IDs are rejected before they can update lease metadata.

## 10. Multi-Tenant and Similar Upload Isolation

Authenticated local integration seeded:

- Two similar uploads in one organization, Upload A and Upload B.
- One upload in a second organization.
- Same tenant signal across uploads.

Validated behavior:

- Preparing Upload A never linked Upload B.
- Cross-org user preparing Upload A received HTTP 404.
- Same-org user attempting to link a second-org upload as source received HTTP 403.
- RLS/page access was not weakened.

## 11. Approval and Version Traceability

Validated behavior:

- Approval preserves `leases.source_file_id = Upload A`.
- Approval retry with the same idempotency key preserves the same source identity.
- Current lease `abstract_snapshot.uploaded_file_id = Upload A`.
- Current lease `abstract_snapshot.source_document.source_file_id = Upload A`.
- Unit test covers `buildAbstractSnapshot` source metadata directly.

## 12. Amendment/Base Source Separation

Authenticated local integration seeded a separate amendment upload with the same tenant signal.

Validated behavior:

- Amendment prepare creates/reuses a separate lease review row.
- Amendment lease `source_file_id = Amendment Upload`.
- Amendment lease source ID is not the base lease Upload A.
- Base lease source remains Upload A.

## 13. Source View Target Identity

Validated behavior:

- Source view resolver first loads exact typed `lease.source_file_id` within the lease org.
- If typed/legacy source is absent, resolver uses only explicit source `document_links`.
- Resolver no longer scans `uploaded_files.reviewed_output` as a loose fallback.
- Unit tests cover typed source ID, explicit document link, and missing explicit link.

## 14. Verification Results

Commands and literal results:

- `npx vitest run src/components/lease-review/__tests__/SourceFileLink.test.jsx src/components/lease-review/__tests__/phase5dSourceLinkContract.test.js src/lib/__tests__/leaseUploadReviewAction.test.js`
  - Result: `3 passed (3)` test files, `13 passed (13)` tests.

- `deno test --no-check --allow-env --allow-read supabase/functions/_tests/approve-lease-workflow.test.ts`
  - Result: `5 passed | 0 failed`.
  - Note: sandboxed Deno runner panicked on Windows pipe handling; outside-sandbox rerun passed.

- Local Supabase keys loaded into process env without echoing values, then `deno test --no-check --allow-env --allow-read --allow-net=127.0.0.1:54321 supabase/functions/_tests/approve-lease-workflow.test.ts supabase/functions/_tests/update-lease-extraction-field.property.test.ts`
  - Result: `18 passed | 0 failed`.

- `npx vitest run scripts/phase5d-source-document-linkage-integration.test.js`
  - Result: `1 passed (1)` test file, `1 passed (1)` test.

- `deno check supabase/functions/review-approve/index.ts supabase/functions/update-lease-extraction-field/index.ts supabase/functions/approve-lease-workflow/index.ts supabase/functions/_shared/lease-approval-workflow.ts`
  - Result: PASS for all four checked files.

- `npm test`
  - Result: `61 passed (61)` test files, `675 passed (675)` tests.

- `npm run lint`
  - Result: PASS.

- `npm run typecheck`
  - Result: PASS.

- `npm run build`
  - Result: PASS, built in `15.61s` with existing Vite chunk/dynamic-import warnings.

- `git diff --check`
  - Result: PASS; only Git line-ending warnings were reported.

## 15. Secret and Content Scan

Changed files and this report were checked for:

- Supabase service-role secrets.
- Azure Document Intelligence keys.
- Vertex service-account private keys.
- OAuth access tokens.
- Production credential references.
- Non-synthetic document text.

Result: PASS. Secret value scan passed for 13 files. No committed secrets or non-synthetic document text were found.

Notes:

- Phase 5D removed hardcoded local Supabase dev-key fallbacks from the touched source-link property test; local keys are supplied by environment during verification.
- Phase 5D fixtures use sanitized local-only text and `example.test` emails.

## 16. Final Gate - Migration Replay and RPC Authorization

Preserved state:

- Branch: `feature/document-intelligence-v3`.
- HEAD: `fc595a0`.
- Initial `git status --short`: clean in this checkout; Phase 5D implementation files were already tracked at HEAD before this final gate.
- Supabase CLI: `2.105.0`.
- Migration files around the Phase 5D timestamp were ordered as:
  - `20260819000000_document_intelligence_v3_scaffold.sql`
  - `20260820000000_document_intelligence_v3_idempotency.sql`
  - `20260820000001_phase5d_source_link_typed_source.sql`
  - `20260821000000_document_intelligence_v3_run_profile_columns.sql`
  - `20260822000000_document_intelligence_v3_layout_summary_column.sql`
  - `20260823000000_document_intelligence_v3_package_graph.sql`
- Duplicate migration timestamp check by filename prefix: PASS, no duplicate timestamp exists.

Clean local replay evidence:

- Local DB content check before reset showed synthetic/test fixture names only, e.g. `Audit Cleanup Org ...`; no non-synthetic document text was inspected.
- Migration file count: `170` SQL files.
- `supabase db reset --local`: SQL replay reached and applied `20260823000000_document_intelligence_v3_package_graph.sql`; process exit code `1` after SQL replay during local Supabase CLI post-reset `Updating vector buckets` with `FeatureNotEnabled`.
- `supabase db reset --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres`: same result; SQL replay reached and applied `20260823000000_document_intelligence_v3_package_graph.sql`; process exit code `1` at the same post-SQL vector-bucket step.
- Local migration table after replay: `170` recorded migrations.
- Phase 5D/package-graph ordering in `supabase_migrations.schema_migrations`: `20260820000000`, `20260820000001`, `20260823000000`.
- `supabase migration list --local`: PASS; local and database migration versions matched through `20260823000000`.
- `update_lease_extraction_field` final signature: `update_lease_extraction_field(uuid,uuid,uuid,text,text,text,text,jsonb)`.
- Overload count for `public.update_lease_extraction_field`: `1`.
- `leases.source_file_id`: present as nullable `uuid`.
- Constraint/index evidence: `leases_source_file_id_fkey` references `uploaded_files(id) ON DELETE SET NULL`; `idx_leases_source_file_id` exists; `idx_leases_extraction_source_file` exists.

RPC security posture:

- Function: `public.update_lease_extraction_field(uuid,uuid,uuid,text,text,text,text,jsonb)`.
- Security mode: `SECURITY DEFINER`.
- Owner: `postgres`.
- `search_path`: `public, pg_temp`.
- Grants: `PUBLIC=false`, `anon=false`, `authenticated=false`, `service_role=true`; function ACL is `postgres=X/postgres,service_role=X/postgres`.
- The function body does not reference `auth.uid()`.
- The function does not internally check organization membership.
- The function does not internally validate `source_file_id` ownership.
- Callers can supply actor identity parameters (`p_actor_user_id`, `p_actor_email`).
- Direct tenant/source authorization therefore remains intentionally outside this RPC and is enforced by the service-role Edge Function boundary.
- Browser/authenticated users cannot execute the RPC directly, so the lack of internal membership/source checks is not exploitable from browser direct RPC in the current local schema.

Direct authenticated RPC negative test:

- Added `scripts/phase5d-direct-rpc-authorization.test.js`.
- It seeds two orgs, one lease, same-org and different-org uploads, then calls PostgREST RPC directly as authenticated users, not through an Edge Function.
- A. Same-org authenticated user with valid same-org source upload: rejected because authenticated has no EXECUTE.
- B. Same-org authenticated user with different-org source upload: rejected because authenticated has no EXECUTE.
- C. Different-org authenticated user targeting the lease: rejected because authenticated has no EXECUTE.
- Failed calls left `leases.source_file_id` null, left `leases.extraction_data.source_file_id` null, and created `0` `source_file_manually_linked` audit rows.

Final verification after replay:

- Focused source-link Vitest: `3 passed (3)` test files, `13 passed (13)` tests.
- Phase 5D authenticated integration after replay/Kong refresh: `1 passed (1)` test file, `1 passed (1)` test.
- Direct RPC authorization test after replay/Kong refresh: `1 passed (1)` test file, `1 passed (1)` test.
- Related Deno backend after replay/Kong refresh: `18 passed | 0 failed`.
- Deno check: PASS for `review-approve`, `update-lease-extraction-field`, `approve-lease-workflow`, and shared lease approval workflow files.
- Full frontend regression: `61 passed (61)` test files, `675 passed (675)` tests.
- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS, built in `10.15s` with existing Vite chunk/dynamic-import warnings.
- `git diff --check`: PASS.
- Migration drift/status: PASS via `supabase migration list --local`; local DB recorded all `170` migrations.
- Local Auth 502s immediately after the second reset were traced to Kong routing to the pre-reset Auth container IP; `docker restart supabase_kong_cre-financial-suite-main` refreshed local routing, and a sanitized Auth admin probe returned HTTP `200` before final reruns.
- No Azure, Vertex, parser, worker, deployment, remote Supabase, provider default, canonical-layout, or live-provider path was touched.
## 17. Final Verdict

PHASE 5D COMPLETE — SOURCE LINKAGE AND RPC SECURITY VALIDATED

Deployment remains out of scope for this phase. No remote Supabase project was accessed, and no live provider call was made.
