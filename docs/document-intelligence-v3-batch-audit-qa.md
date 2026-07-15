# Document Intelligence v3 Batch Advisory Audit QA

Generated: 2026-07-15
Phase: 24
Status: Local diagnostic backfill attempted, stopped before write

## 1. Executive Summary

Phase 24 attempted to perform a local-only, no-LLM, no-Azure diagnostic v3 backfill from the approved JSON exports.

Approved IDs:

- uploaded_file_id: `fc8181e6-766d-49c7-b81b-b5d961160207`
- lease_id: `7b21f353-579d-48e8-b3dd-8e8c49743fe2`
- run_ids: none found

Result: **backfill not performed**.

Reason: the local target was proven to be loopback/local-only, but the approved `uploaded_files` and `leases` source rows do not exist in the local database. The local v3 schema requires `document_intelligence_runs.uploaded_file_id` to reference `uploaded_files(id)`, and `lease_id` references `leases(id)`. Phase 24 explicitly forbids writing to `uploaded_files` or `leases`, so creating a local v3 run would violate FK constraints or require a prohibited source-table write.

Recommendation remains: **No Gate**.

## 2. Local-Only Target Proof

Local target checked before any write:

- Supabase REST/API endpoint: `http://127.0.0.1:54321`
- Local database port: `127.0.0.1:54322`
- Both endpoints are loopback addresses.
- No hosted Supabase URL was used.
- No remote write endpoint was used.
- No service key, secret file, or `SUPABASE_ACCESS_TOKEN` was used.

Confirmation: the target was local-only, but the local source rows required by FK constraints were missing.

## 3. Scope Controls

Honored constraints:

- No deployment.
- No remote reads.
- No production writes.
- No service key or secret inspection.
- No `SUPABASE_ACCESS_TOKEN` use.
- No Azure call.
- No Vertex/Gemini call.
- No parse rerun.
- No extraction rerun.
- No approval behavior change.
- No Lease Review business-row change.
- No global `vertex_fact_ledger` enablement.
- No `BUSINESS_EXTRACTION_PROVIDER` change.
- No replacement of `ui_review_payload` or `normalized_output`.
- No local v3 writes were made.
- No writes were made to `uploaded_files` or `leases`.

## 4. Approved Export Validation

| Export file | Accepted type | Rows | Scope result |
| --- | --- | ---: | --- |
| `C:\Users\tejas\v3-phase-exports\uploaded_files_fc8181e6.json` | uploaded_files | 1 | Accepted; `id` matches approved uploaded_file_id. |
| `C:\Users\tejas\v3-phase-exports\leases_7b21f353.json` | leases | 1 | Accepted; `id` matches approved lease_id. |
| `C:\Users\tejas\v3-phase-exports\pipeline_logs_fc8181e6.json` | pipeline_logs | 21 | Accepted; all rows match approved upload via `file_id`. |
| `C:\Users\tejas\v3-phase-exports\document_intelligence_runs_fc8181e6_schema_missing.json` | document_intelligence_runs marker | 0 | Accepted as missing-run evidence; table relation missing, no rows. |

Rows accepted: **23** logical rows/markers

Rows rejected or ignored: **0**

Out-of-scope rows: **0**

Exported `org_id` match:

- uploaded_files export `org_id`: `1307dd95-e7c5-4e08-833e-749444e8f4c8`
- leases export `org_id`: `1307dd95-e7c5-4e08-833e-749444e8f4c8`
- org IDs match: yes

## 5. Local Prerequisite Checks

Local exact-ID checks before write:

| Local table | Approved filter | Result |
| --- | --- | --- |
| `uploaded_files` | `id = fc8181e6-766d-49c7-b81b-b5d961160207` | Missing: `[]` |
| `leases` | `id = 7b21f353-579d-48e8-b3dd-8e8c49743fe2` | Missing: `[]` |
| `document_intelligence_runs` | approved uploaded_file_id | Missing: `[]` |
| `document_intelligence_runs` | approved lease_id | Missing: `[]` |

Local v3 schema constraint:

- `document_intelligence_runs.uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE`
- `document_intelligence_runs.lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL`

Conclusion: Phase 24 cannot create a valid local v3 run under current constraints because the required source FK rows are absent locally and writing those source rows is prohibited.

## 6. Backfill Execution Status

Local diagnostic backfill performed: **no**

Local run_id: **none**

Status: **blocked_before_write**

Reason: missing local source FK rows.

Local tables written: **none**

External calls made: **none**

Production writes: **none**

## 7. Run Summary

No local v3 run was created.

| Metric | Value |
| --- | ---: |
| claims_count | 0 |
| evidence_count | 0 |
| projections_count | 0 |
| validation_drops_count | 0 |
| package graph rows created | 0 |

Additional status:

- layout_summary present: no local run created
- advisory readiness available: no local run created
- completed v3 run now available locally: no
- Phase 17 audit can now run: no

## 8. Source Artifacts Still Available

The approved exports remain sufficient for a local-only no-LLM diagnostic backfill plan if the local source-row prerequisite is resolved in a later, explicitly approved phase.

Available source inputs:

- `uploaded_files.docling_raw`
- `uploaded_files.normalized_output`
- `uploaded_files.ui_review_payload`
- `uploaded_files.parsed_data`
- `uploaded_files.reviewed_output`
- `leases.extraction_data`
- `leases.extracted_fields`
- `leases.abstract_snapshot`
- pipeline log metadata

No claims were fabricated. No fact ledger data was assumed beyond approved exports.

## 9. Idempotency Plan For A Future Approved Attempt

If a later phase explicitly approves local source-row staging or another FK-safe local method:

- Use a deterministic key from approved uploaded_file_id, approved lease_id, source artifact fingerprint/content hash, contract version, and diagnostic backfill version.
- Reuse or replace only local rows tied to that idempotency key.
- Do not duplicate local v3 runs for identical source exports.
- Never write to production.

## 10. Risks And Limitations

- No completed v3 run exists locally.
- Phase 17 advisory audit still cannot run.
- A valid local v3 run cannot be inserted without local source FK rows or a schema-safe local staging strategy.
- Phase 24 does not approve writing to `uploaded_files` or `leases`.
- Any future local source-row staging must be explicitly approved and must remain local-only.

## 11. Recommendation: Gate / No Gate

**Recommendation: No Gate.**

Until a completed local v3 run exists and a real advisory audit is run, v3 advisory output must remain diagnostic-only and must not become an approval gate.

## Phase 25 Recommendation

Phase 25 should explicitly choose one local-only path:

1. Approve local staging of the approved `uploaded_files` and `leases` export rows into a verified local database, then rerun the local v3 diagnostic backfill.
2. Or approve a FK-free scratch/read-only audit artifact approach that produces a local diagnostic JSON report without writing to v3 tables.

Either path must remain no-LLM, no-Azure, no-Vertex/Gemini, no extraction rerun, no production write, and no approval behavior change.
