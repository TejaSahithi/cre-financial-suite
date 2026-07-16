# Azure Staging P0 — Controlled Deployment and Real-Document Retest

**No deploy occurred. No document was uploaded. No staging database was read or written.**

---

## 1. Executive verdict

# BLOCKED — DO NOT BEGIN PHASE 4E IMPLEMENTATION

This phase could not be executed. Before any deployment or upload was attempted, environment verification found that **the only Supabase project linked in this session's CLI is production** (`cjwdwuqqdokblakheyjb`, name "realestate"), confirmed by the user directly. This task's own hard constraints ("Staging only," "No production deployment") make deploying there categorically forbidden, regardless of how well-tested the P0 patch is. No staging project reference, staging credentials, or test document were available to substitute. Rather than guess at a project, temporarily treat production as staging, or fabricate retest results, this phase stopped at the read-only preflight stage and produced this report documenting exactly what is missing and what is required to unblock it.

---

## 2. Deployed commit

**None.** No deploy command was run against any project. Separately worth recording precisely: the P0 patch itself (`supabase/functions/lease-extraction-worker/index.ts`, the new test file, and the P0 report) is **not yet committed** to git — it exists only as uncommitted/untracked working-tree changes on `feature/document-intelligence-v3`, on top of commit `c17f7b2`. There is therefore no commit hash to record as "the version that would be deployed" — that would need to be created (a decision for the user, not made automatically here) before any future deploy.

---

## 3. Deployment scope

**Planned, not executed.** The approved scope, unchanged from the P0 phase's own plan, remains: deploy only `lease-extraction-worker`. Explicitly not to be deployed alongside it: `parse-pdf-docling`, `normalize-pdf-output`, `pipeline-status`, approval functions, Lease Review frontend, any V3 diagnostic function, or any other unrelated Edge Function.

---

## 4. Environment checks

| Check | Result |
|---|---|
| `supabase --version` | `2.105.0` — CLI is installed and functional |
| `supabase projects list` (read-only) | Exactly one project visible/linked: ref `cjwdwuqqdokblakheyjb`, name "realestate", org `czvaeowbqsjgayifhlek", region East US (North Virginia) |
| Is this project staging? | **No — confirmed by the user to be production.** |
| `.env` (`VITE_SUPABASE_URL`) | `http://127.0.0.1:54321` — points to a local Supabase instance, not any cloud project |
| `.env.production` (`VITE_SUPABASE_URL`) | Still the literal unfilled placeholder `https://YOUR_PROJECT_REF.supabase.co` — never completed |
| `.env.phase52.local` | No `SUPABASE_URL`/`VITE_SUPABASE_URL` line present |
| A usable staging project reference | **None found anywhere in this repo or CLI session.** |
| `STORE_FULL_AZURE_RAW_RESPONSE` in staging | **Cannot be checked — no staging access.** |
| Other provider-flag presence in staging (`EXTRACTION_PROVIDER`, `BUSINESS_EXTRACTION_PROVIDER`, Azure/Vertex config) | **Cannot be checked — no staging access.** |

No secret value was read, requested, or printed at any point during this verification.

---

## 5. Test-document profile

**Not executed.** No document was selected, uploaded, or retried. The original incident file (`7ee50442-188e-4a8c-895c-6e0483372646`) lives in what is now confirmed to be the production project — it is explicitly out of reach and out of scope for any future staging retest once a properly separated staging environment exists (see §16, Requirement 3).

---

## 6. Upload/retry method

**Not executed.** No upload or retry mechanism was invoked.

---

## 7. Initial database state

**Not captured.** No `uploaded_files` or `pipeline_jobs` row was read from any project during this phase.

---

## 8. Parser result summary

**Not executed — blocked on staging access.**

---

## 9. Worker reconciliation result

**Not executed — blocked on staging access.** The tri-state reconciliation logic (§11 of the P0 report) has been validated only against 19 mocked unit tests, not against a live compute-kill or transport failure in a real environment. This remains true until a staging retest actually runs.

---

## 10. Status-repair result

**Not executed — blocked on staging access.**

---

## 11. Normalize result

**Not executed — blocked on staging access.**

---

## 12. UI review result

**Not executed — blocked on staging access.** Lease Review was not opened against any real record in this phase.

---

## 13. Idempotency retest

**Not executed — blocked on staging access.**

---

## 14. Tenant-isolation check

**Not executed against a live environment.** Tenant scoping (`id` + `org_id` on every reconciliation read) was verified statically and by a dedicated mocked unit test during the P0 implementation phase (§16 of the P0 report) — that remains the only evidence of correctness until a live retest runs.

---

## 15. No-Gate confirmation

Unaffected by this phase — no code was deployed or changed here. Approval remains **No Gate**, as confirmed structurally through Phase 4D and unchanged by the P0 patch itself (§17 of the P0 report, "Confirmation of no Azure fallback to Docling/Vision" — the same reasoning applies: this phase touched nothing in the approval path).

---

## 16. Evidence matrix

Every row below is explicitly marked **not executed** rather than filled with an invented or assumed value.

| Check | Expected | Actual | Pass/Fail | Evidence |
|---|---|---|---|---|
| Worker deployment | One function only | Not deployed | N/A — blocked | No deploy command was run |
| Azure method | `azure_layout` | Not observed | N/A — blocked | No document processed |
| Azure provider | Correct metadata | Not observed | N/A — blocked | No document processed |
| Text length | Substantial | Not observed | N/A — blocked | No document processed |
| Page count | Greater than zero | Not observed | N/A — blocked | No document processed |
| Failed step | Cleared | Not observed | N/A — blocked | No document processed |
| Error message | Cleared | Not observed | N/A — blocked | No document processed |
| Processing status | Coherent | Not observed | N/A — blocked | No document processed |
| Manual fallback | Not used | Not observed | N/A — blocked | No document processed |
| Normalize executed | Yes | Not observed | N/A — blocked | No document processed |
| Meaningful normalized fields | Greater than zero | Not observed | N/A — blocked | No document processed |
| Meaningful review rows | Greater than zero | Not observed | N/A — blocked | No document processed |
| Duplicate lease | No | Not observed | N/A — blocked | No document processed |
| Retry idempotent | Yes | Not observed | N/A — blocked | No document processed |
| Reviewer state preserved | Yes | Not observed | N/A — blocked | No document processed |
| Approval unchanged | Yes | N/A (unaffected) | Pass | No code touched approval path |

---

## 17. Sanitized relevant logs

None captured — no execution occurred against any live system.

---

## 18. Remaining risks

Carried forward, unchanged, from the P0 report's own §23/§25:
- `STORE_FULL_AZURE_RAW_RESPONSE`'s value in any real environment remains unconfirmed.
- The tri-state reconciliation fix has only mocked-test coverage, not live-environment coverage, until a real retest runs.
- The P0 patch itself is still uncommitted in this repository (§2) — a future retest phase will need to decide whether/how to commit it first.

New risk surfaced by this phase specifically:
- **This session's Supabase CLI link defaults to production with no in-repo indicator distinguishing it from staging.** Any future automated or semi-automated phase that assumes "the linked project" is safe to deploy to would have made the same mistake this phase avoided only because the user was asked directly. Recommend the eventual staging setup (§16 below) include an explicit, checked-in, unambiguous marker (e.g., a `STAGING_PROJECT_REF` value recorded somewhere reviewed, or `.env.production`'s placeholder actually being filled in) so this ambiguity cannot recur silently.

---

## 19. Rollback status

Not applicable — nothing was deployed, so there is nothing to roll back.

---

## 20. Phase 4E readiness decision

**Deferred.** Phase 4E implementation readiness cannot be assessed without a real-document staging retest, which this phase could not perform. This is not a statement that the P0 patch is wrong — the P0 report's own mocked-test evidence stands as reported — only that end-to-end, live-environment validation remains outstanding.

---

## Unblock requirements (all three required before this phase can be re-attempted)

### Requirement 1 — a real staging Supabase project
Create or identify a Supabase project that is explicitly non-production. Collect: staging project name, staging project reference ID, staging environment owner, staging URL. Connect explicitly via `supabase link --project-ref <STAGING_PROJECT_REF>`, then **verify the link is staging before deploying anything** — never rely on the CLI's current link alone (this phase's own near-miss is the reason why); record the intended staging ref separately and compare it before every deployment.

### Requirement 2 — staging environment configuration
Confirm the *presence*, never the values, of: Azure Document Intelligence endpoint, Azure Document Intelligence credential, `EXTRACTION_PROVIDER`, `BUSINESS_EXTRACTION_PROVIDER`, `STORE_FULL_AZURE_RAW_RESPONSE`, Vertex configuration (if normalization currently requires it), Supabase service configuration. For the eventual retest, `STORE_FULL_AZURE_RAW_RESPONSE` must be confirmed unset or `false` unless explicitly revalidated otherwise. No secret value printed anywhere, terminal or report.

### Requirement 3 — an approved test document
Preferred: the user uploads an approved lease through the staging UI themselves. Alternative: the user provides an approved local test PDF and explicitly authorizes direct staging ingestion. **Never reuse or mutate the production incident row** (`7ee50442-188e-4a8c-895c-6e0483372646` — confirmed to live in production, out of reach and out of scope entirely once staging is properly separated).

**Safest workflow once unblocked**: agent verifies the staging link and deploys the worker → user uploads the document in staging → user provides the new `uploaded_file_id` → agent inspects sanitized status/summary data only → agent completes the retest report.

**Staging environment recommendation**: a fully separate Supabase project, separate Storage buckets, separate database, staging-only service credentials, non-production (or an approved shared) Azure credential, test organizations/users, sanitized or approved test leases, no production customer data — mirroring production schema and Edge Functions while remaining safe to retry and fail against.

**What not to do, restated for the record:** do not deploy the worker to the linked production project; do not temporarily treat production as staging; do not modify production records for testing; do not begin Phase 4E implementation without the real-document P0 retest; do not mark the P0 as staging-validated based only on mocked tests; do not invent values in the evidence matrix; do not expose staging or production secret values.
