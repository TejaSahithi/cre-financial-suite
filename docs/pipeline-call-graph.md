# Pipeline Call Graph (Verified)

## Why this doc exists

`.kiro/specs/backend-driven-pipeline/` describes a generic Upload → Parse → Validate → Store → Compute pipeline (`upload-handler`, `parse-file`, `validate-data`, `store-data`, `compute-*`) with every task marked `[x]` done. Reading the actual `supabase/functions/` code, that generic pipeline is not a parallel or superseded system — it's the same pipeline the lease-document flow (`ingest-file` → `parse-pdf-docling`/`parse-file` → `validate-data` → `store-data`) runs on top of, entered through a second, more specific front door. There is one pipeline, two entry points. This doc records the verified call graph so nobody re-derives it or assumes the `.kiro` spec is stale/wrong.

Verified by reading the code directly (not inferred): `supabase/functions/ingest-file/index.ts`, `supabase/functions/_shared/compute-orchestrator.ts`, `supabase/functions/review-approve/index.ts`, and grepping `src/` for every caller of `upload-handler`.

## The graph

```
Generic bulk import (non-lease):
  FileUploader.jsx / BulkImportModal.jsx / Documents.jsx / parsingEngine.js
    --> upload-handler
          (stores file, creates uploaded_files row; does not itself parse)

Lease documents:
  LeaseUpload.jsx
    --> ingest-file
          routes by file format:
            csv / xlsx / text  --> parse-file           (existing CSV/Excel parser)
            pdf / doc / docx / image / unknown --> parse-pdf-docling --> normalize-pdf-output
                                                     (Docling OCR + LLM field mapping)
          both routes converge:
            --> validate-data --> store-data
          store-data fire-and-forget triggers:
            --> _shared/compute-orchestrator.ts
                  dispatches compute-lease / compute-revenue / compute-budget /
                  compute-expense / compute-cam / compute-reconciliation
                  based on engineTypeForFunction() + which entity types were stored

Human correction / re-submission:
  LeaseReview.jsx (via review-approve, action varies)
    --> review-approve
          re-invokes validate-data then store-data directly via fetch()
          (does not go back through ingest-file)

Final abstract approval (separate from the ingest/store/compute pipeline above):
  LeaseReview.jsx "Approve" button
    --> approve-lease-workflow
          --> approve_lease_workflow RPC (see docs/server-owned-workflow-pattern.md)
```

## What this means for future work

- `upload-handler`, `parse-file`, `validate-data`, `store-data` are **not dead code** and are **not a duplicate of `ingest-file`** — they are internal stages `ingest-file` and `review-approve` call into, plus `upload-handler` is the live entry point for non-lease bulk import. None of these should be retired.
- The one genuine problem was not pipeline duplication — it was `LeaseUpload.jsx` falling back to a client-side `leases` table insert (`createLeaseDraftFromUploadedFile`) when `review-approve` failed, bypassing this entire graph. That fallback has been removed (see below); on failure the UI now surfaces an error/retry state instead of writing lease data itself.
- `.kiro/specs/backend-driven-pipeline/tasks.md` describes the architecture accurately in spirit; it just predates `ingest-file`/`review-approve`/`approve-lease-workflow` as the concrete lease-specific realization of "Upload → Parse → Validate → Store → Compute". It is annotated as superseded/realized rather than deleted, since it's still an accurate historical record of intent.

## LeaseUpload.jsx backend-bypass removal

`src/pages/LeaseUpload.jsx`'s `ensureLeaseDraft()` previously fell through to `createLeaseDraftFromUploadedFile()` — a client-side function that built a lease row from `ui_review_payload` and inserted it directly into `leases` via `leaseService.create()` — whenever the `review-approve` edge function call failed. This meant a lease could exist in the system with no server-side validation, no `review-approve` audit trail, and a JSONB blob explicitly tagged `source: "client_fallback"`.

That fallback (and its exclusively-used helper functions — `asArrayOrNull`, `extractRowsFromUiReview`, `buildFieldsWithEvidence`, `buildFieldEvidenceMap`, `extractWorkflowOutputForFirstRow`, `collectConfidenceFromPayload`, `averageConfidence`, and the `cleanExtractedSourceText` alias) has been removed. `ensureLeaseDraft()` now falls straight through to the existing error/retry toast when `review-approve` fails — no client-side write happens. The two existing call sites (`openLeaseReview()` and the auto-prepare effect) already handled a `null` return correctly (showing a toast, or letting the auto-prepare effect retry on the next poll), so no other behavior changed.

Verified via `npm run build` (clean) and `npx eslint src/pages/LeaseUpload.jsx` (no new errors/warnings — the one pre-existing warning on an unrelated `eslint-disable` line is untouched by this change). No new Vitest spec was added for this: the repo's existing test suite only covers extracted pure functions/services, not full page-component rendering (no test in the repo calls React Testing Library's `render()`), so adding a from-scratch component-mount test here would introduce a testing pattern the codebase doesn't otherwise use rather than extend an existing one.
