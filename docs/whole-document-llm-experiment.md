# Whole-document LLM extraction experiment

This path tests whether TypeScript evidence routing and field remapping are
the dominant causes of lease-extraction errors.

## Runtime behavior

When `LEASE_WHOLE_DOCUMENT_LLM_V1=active` for a lease:

1. `parse-document-azure` builds and persists a compact document from the
   complete Azure layout before the legacy persistence caps are applied.
2. The OpenAI fact-ledger orchestrator calls one strict-schema model request
   with the complete compact document.
3. The model selects its own pages and table rows and assigns values directly
   to `LEASE_SCHEMA` field keys.
4. TypeScript checks only schema types, duplicate/missing field keys, evidence
   node existence, and verbatim quote containment.
5. The section router, deterministic readiness gate, fact-field mapper, and
   dynamic rescue mapper are bypassed.
6. Legacy semantic fallback is suppressed while the experiment is active so
   the result remains measurable.

The flag defaults off.

## Scoped staging activation

Set both server-side secrets:

```sh
supabase secrets set BUSINESS_EXTRACTION_PROVIDER=openai_fact_ledger
supabase secrets set LEASE_WHOLE_DOCUMENT_LLM_V1=active
```

The path never silently truncates an oversized model input. The default
serialized compact-document ceiling is 400,000 characters; override it only
after validating the selected deployment's context budget:

```sh
supabase secrets set LEASE_WHOLE_DOCUMENT_LLM_MAX_INPUT_CHARS=400000
```

Deploy the changed parse, normalize, and worker dependencies, then upload a
new lease. A new upload is important because only newly parsed documents
receive the complete pre-cap compact artifact. Existing rows can still run,
but diagnostics will identify `available_docling` and warn when the source
was already truncated.

The result is identifiable at:

```text
normalized_output.metadata.extractionDebug.openai_fact_ledger.extraction_mode
  = "whole_document_llm_v1"
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
