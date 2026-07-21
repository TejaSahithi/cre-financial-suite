# Release 4B: Canonical Hybrid Review Rollout

## Purpose

Release 4B activates canonical review payloads without making the switch all-or-nothing. The legacy review payload remains available for rollback and shadow comparison, while canonical hybrid and strict modes can be enabled by organization.

## Rollout Modes

- `legacy`: legacy `uploaded_files.ui_review_payload` remains the reviewer source of truth.
- `shadow`: the backend builds and persists enterprise canonical payloads for metrics, but the UI remains legacy-authoritative.
- `canonical_hybrid`: the UI uses the enterprise canonical review payload, allowing documented legacy fallback fields.
- `canonical_strict`: the UI uses the enterprise canonical review payload and approval readiness is fail-closed on missing required canonical coverage.

Resolution order is organization config, then environment, then `legacy` default. Unknown organizations default to `legacy`; strict mode requires explicit org or environment configuration.

## Configuration

Organization-specific configuration lives in `public.canonical_review_rollout_configs`:

```sql
insert into public.canonical_review_rollout_configs (org_id, mode, enabled, document_family, reason)
values ('<org-id>', 'shadow', true, 'lease', 'Release 4B shadow rollout');
```

Useful environment flags:

- `CANONICAL_REVIEW_ROLLOUT_MODE=legacy|shadow|canonical_hybrid|canonical_strict`
- `ENABLE_CANONICAL_REVIEW_PAYLOAD_SHADOW=true` for environment-level shadow mode
- `ENABLE_CANONICAL_REVIEW_PAYLOAD=true` and `ENABLE_CANONICAL_REVIEW_PAYLOAD_STRICT=true` for backward-compatible Release 4A flags
- `ENABLE_CANONICAL_APPROVAL_GATING=false` by default; keep false until approval gating is separately approved
- `ENABLE_CANONICAL_HYBRID_EMERGENCY_FALLBACK=true` to allow hybrid/shadow payload build failures to fall back to legacy responses

## Operational Checks

The readiness endpoint is `document-intelligence-v4-readiness-metrics`. It returns metrics derived only from backend durable rows:

- payload build success rate
- canonical coverage rate
- approval-critical coverage rate
- evidence coverage rate
- legacy fallback rate
- material mismatch rate
- reviewer override rate
- unresolved blocking finding rate
- cross-run and cross-generation integrity violation counts

Example request body:

```json
{
  "uploaded_file_id": "<file-id>",
  "limit": 200
}
```

## Stale Generation Behavior

Reviewer actions and v4 payload reads reject stale generations with HTTP `409` and `errorCode: "stale_review_generation"`. The response includes `currentRunId` and `currentGenerationId` so clients can refetch the current review state.

## Rollback

1. Set the org config to `legacy`, or disable the org config and remove environment rollout flags.
2. If an emergency response is needed in hybrid/shadow, set `ENABLE_CANONICAL_HYBRID_EMERGENCY_FALLBACK=true`.
3. Confirm the v4 review endpoint returns `mode: "legacy"` or `uiAuthority: "legacy"`.
4. Keep enterprise payload rows for audit and metrics; they are additive and do not mutate legacy review payloads.

## Verification

Run the focused backend regression suite:

```bash
deno test --no-check --fail-fast supabase/functions/_tests/document-intelligence-v4-hybrid-rollout.test.ts
```

Then run the standard verification set:

```bash
deno check supabase/functions/_shared/extraction/document-intelligence-v3/canonical-review-rollout.ts supabase/functions/_shared/extraction/document-intelligence-v3/canonical-review-readiness-metrics.ts supabase/functions/document-intelligence-v4-review-payload/index.ts supabase/functions/document-field-review-action/index.ts supabase/functions/document-intelligence-v4-readiness-metrics/index.ts
node scripts/compare-deno-baseline.mjs
npm run typecheck
npm run lint
npm run test
npm run build
```
