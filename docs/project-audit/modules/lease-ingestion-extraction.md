# Module: Lease Ingestion & AI Extraction Pipeline (Tier 1)

> Generated: 2026-07-20 · Revision: `34563cfaff4271b72d00b0841353dc2792f2f16a` · Canonical score **3.2 / 5**, criticality **17 (Critical)** — [03](../03-module-catalog-and-maturity.md) · Index: [04](../04-module-deep-dives.md)

## Functional view
- **Problem:** turn an uploaded lease PDF into structured, evidence-backed draft data without full manual re-keying. **Users:** analysts/asset managers uploading documents; the pipeline itself is the "user" of AI providers.
- **Inputs:** PDF/doc files (validated by magic bytes), org/property context. **Outputs:** `uploaded_files` row, `pipeline_jobs` lifecycle, draft claims/findings in the lease-intelligence tables, raw provider payloads in the `extraction-artifacts` bucket.
- **Business rules:** stage sequence `parse → normalize → review_draft → rule_extraction`; provider selection via `EXTRACTION_PROVIDER`/`BUSINESS_EXTRACTION_PROVIDER` env; `max_attempts 3`; per-stage timeouts (parse 140 s, normalize/enrich 240 s).
- **Preconditions:** valid file type/size; provider secrets configured (Vertex/Azure/Anthropic/Docling — any missing degrades or blocks the pipeline, `UNVERIFIED` which precisely). **Success:** job reaches `completed` with a reviewable draft. **Failure:** `failed` with `error_code`/`retryable`; **edge cases:** malformed PDFs, scanned/low-quality docs (OCR path via Vision), cancellation mid-stage (re-checked before every stage).

## Technical view
- **Boundaries:** `ingest-file`/`upload-handler`/`parse-file` (intake) → `lease-extraction-worker` (orchestrator) → `parse-pdf-docling` (Docling/Vision/Azure) → `normalize-pdf-output` (LLM extraction: Vertex Gemini or Anthropic `claude-sonnet-4-6`) → draft persistence.
- **Interfaces:** internal-secret auth between worker and parse/normalize functions ([SEC-003](../findings-register.md#sec-003)); `pipeline-status`/`pipeline-health-check` for observability surface.
- **DB:** `uploaded_files`, `pipeline_jobs` (queue index for draining), `pipeline_logs`, `extraction_runs` (provenance, org-scoped), lease-intelligence draft tables.
- **Events:** none pub/sub — direct function chaining. **Background processing:** the worker itself; no scheduler triggers it automatically ([OPS-006](../findings-register.md#ops-006)).
- **Caching:** none server-side. **Error handling/retry:** `_shared/error-handler.ts` structured envelopes; `failJob()`; durability reconciliation (`durable|not_durable|unknown`) distinguishes a transient read failure from a genuinely lost write via `selectWithRetry` — a notably mature pattern for this stage.
- **Idempotency:** `20260820000000_document-intelligence-v3-idempotency` migration; re-extraction via `send-lease-back-for-reextraction` is explicit, not automatic.
- **Concurrency:** `LLM_GROUP_CONCURRENCY` env suggests bounded parallelism for LLM calls; per-tenant fairness not evidenced ([OPS-007](../findings-register.md#ops-007) adjacent).
- **Security/tenant checks:** org-scoped storage paths; artifacts bucket default-deny + audited reader ([SEC-006](../findings-register.md#sec-006)).
- **Tests:** service-level units (parsingEngine consumers); `supabase/functions/_tests/` exists but unwired ([13](../13-testing-and-quality-engineering.md)); e2e exists but currently broken locally ([OPS-003](../findings-register.md#ops-003)).

## Workflow view
Happy path: see [02 §7](../02-current-state-architecture.md) data-flow diagram.

**Failure path:**
```mermaid
sequenceDiagram
    participant W as Worker
    participant S as Stage fn
    participant DB as pipeline_jobs
    W->>DB: mark stage running, set available_at
    W->>S: invoke with timeout
    alt provider error / timeout
      S-->>W: error_code + retryable
      W->>DB: attempt+1; requeue if <3 else status=failed
    else cancel_requested_at set
      W->>DB: status=cancelled
    else success but write uncertain
      W->>DB: selectWithRetry → durable/not_durable/unknown reconciliation
    end
```
**State model:** `queued→running→{completed|failed|cancelled}` per stage, rolling up to job status. **Data lifecycle:** raw payload → artifact bucket (no TTL) → structured draft → (on approval) promoted into `leases`/financial tables. **Recovery:** manual retry/re-extraction; no automatic dead-letter surfacing beyond the FileHistory UI.

## Assessment
**Strengths:** genuinely sophisticated reliability engineering (timeouts, cancel, durability reconciliation, structured errors) — above the maturity of the rest of the codebase; multi-provider abstraction with a kill-switch.
**Weaknesses:** no scheduler/reaper ([OPS-006](../findings-register.md#ops-006)); artifact retention unbounded (PII, [SEC-006](../findings-register.md#sec-006)); no per-tenant cost metering ([OPS-007](../findings-register.md#ops-007)); unauthenticated `extract-document-fields` cost surface ([SEC-008](../findings-register.md#sec-008)); e2e currently cannot verify this path end-to-end.
**Priority / complexity:** reaper+metering M, P1; artifact retention S, P2; e2e repair S, P1.
