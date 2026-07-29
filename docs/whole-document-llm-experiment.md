# Authoritative whole-document LLM extraction

This path tests whether TypeScript evidence routing and field remapping are
the dominant causes of lease-extraction errors.

## Runtime behavior

For leases this architecture is active by default. `LEASE_WHOLE_DOCUMENT_LLM_V1`
may be omitted or set to `active`:

1. `parse-document-azure` builds and persists a compact document from the
   complete Azure layout before the legacy persistence caps are applied.
2. The OpenAI fact-ledger orchestrator calls one strict-schema model request
   with the complete compact document.
3. The model performs a professional multi-pass lease review, selects its own
   pages and table rows, and assigns values directly to `LEASE_SCHEMA` fields.
4. A mandatory second sweep emits any number of evidence-grounded
   `dynamicFindings` with arbitrary suggested keys; these flow into the
   existing Lease Review dynamic-row and clause-record path.
5. TypeScript checks only schema types, duplicate/missing field keys, evidence
   node existence, and verbatim quote containment.
6. Only fixed claims with `status=found` may populate a value. Ambiguous,
   conflicting, or illegible claims retain evidence/alternatives but publish
   `value=null` for review safety.
7. The section router, deterministic readiness gate, fact-field mapper, and
   dynamic rescue mapper are bypassed.
8. Legacy semantic fallback is suppressed while the experiment is active so
   the result remains measurable.

The flag defaults active. Only the exact value `off` enables the legacy
fact-ledger/TypeScript mapper rollback.

Evidence/clause enrichment also defaults to the bounded ten-stage chain.
Only `ENRICH_BOUNDED_STAGE_MODE=off` restores the monolithic enrichment
function that is susceptible to Edge Function compute exhaustion.

## Scoped staging activation

The provider is selected automatically. These explicit settings are optional
but document the intended production state:

```sh
supabase secrets set BUSINESS_EXTRACTION_PROVIDER=openai_fact_ledger
supabase secrets set LEASE_WHOLE_DOCUMENT_LLM_V1=active
supabase secrets set ENRICH_BOUNDED_STAGE_MODE=active
```

The path never silently truncates an oversized model input. The default
combined system-prompt plus compact-document ceiling is 400,000 characters; override it only
after validating the selected deployment's context budget:

```sh
supabase secrets set LEASE_WHOLE_DOCUMENT_LLM_MAX_INPUT_CHARS=400000
```

For leases with many dynamic findings, use a deployment that supports a
larger structured response and set:

```sh
supabase secrets set LEASE_WHOLE_DOCUMENT_LLM_MAX_OUTPUT_TOKENS=32768
```

Deploy the changed parse, normalize, and worker dependencies, then upload a
new lease. A new upload is important because only newly parsed documents
receive the complete pre-cap compact artifact. Existing rows can still run,
but diagnostics will identify `available_docling` and warn when the source
was already truncated.

The result is identifiable at:

```text
normalized_output.metadata.extractionDebug.openai_fact_ledger.extraction_mode
  = "whole_document_llm_v2"
```

The same diagnostic object records schema/model versions, token usage,
compact-document size, evidence verification counts, per-field statuses and
the intentionally bypassed components.

## Comparison

Export the current and experimental normalized result JSON, then run:

```sh
node scripts/compare-whole-document-extraction.mjs \
  current-result.json \
  whole-document-result.json
```

The comparison is diagnostic, not a quality score. Accuracy must be measured
against independently reviewed ground truth, not agreement with the current
pipeline.

## Rollback

```sh
supabase secrets set LEASE_WHOLE_DOCUMENT_LLM_V1=off
```

No database migration or destructive rollback is required. Existing review
and approval payload contracts remain unchanged.
