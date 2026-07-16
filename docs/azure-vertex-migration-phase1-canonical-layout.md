# Azure + Vertex Canonical Pipeline Migration — Phase 1: Canonical Layout Contract & Azure Adapter

Date: 2026-07-15
Branch: `feature/document-intelligence-v3` (continued on the existing long-lived migration branch; working tree was clean, so no new branch was created)
Scope: contract + validation + adapter + compatibility tests only. **No runtime behavior changed. No database migration. No deploy. No live Azure or Vertex call.**
Recommendation: **No Gate**

## 1. Executive summary

Phase 1 introduces a single, authoritative, provider-neutral `CanonicalDocumentLayout` contract and a new adapter that can build it losslessly, directly from Azure Document Intelligence's raw `analyzeResult` — preserving real polygons, spans, reading order, and merged-cell structure for the first time. Nothing in the running pipeline calls the new adapter yet: it is additive, tested in isolation, and does not touch `parse-pdf-docling`, `normalize-pdf-output`, the worker, or Lease Review. A pre-existing but lossy canonical-layout module (derived from `docling_raw`, always producing empty polygons) was evolved in place rather than duplicated, with its original export kept as a permanent-until-migrated deprecated alias so no existing caller could break. All touched and created files pass `deno check`, and 59 new/extended Deno tests pass (30 adapter tests, 18 new contract/compatibility tests, 1 extended document-index test, 1 extended side-write test, plus 9 pre-existing tests re-verified unchanged) — see §12. The full `npm run lint`/`typecheck`/`test`/`build` frontend gate remains green because Phase 1 touches no frontend file.

## 2. Current pipeline map

```
Upload
  → uploaded_files row
  → ingest-file / lease-extraction-worker
  → parse-pdf-docling (parser.ts → resolveExtractionProvider(): legacy | azure_document_intelligence | ...)
      → azure-layout-adapter.ts: Azure raw analyzeResult → DoclingOutput (lossy: no polygons/spans)
      → uploaded_files.docling_raw
  → normalize-pdf-output
      → BUSINESS_EXTRACTION_PROVIDER: legacy_hybrid (default) | vertex_fact_ledger
      → normalized_output + ui_review_payload  (unchanged by Phase 1)
      → ENABLE_DOCUMENT_INTELLIGENCE_V3=true → side-write.ts (diagnostic, opt-in, best-effort)
          → document-intelligence-v3/canonical-layout.ts: docling_raw → CanonicalDocumentLayout (Phase 1: evolved in place)
          → vertex-fact-ledger/document-index-v3.ts: same layout → CanonicalLayoutDocumentIndex
  → LeaseUpload → Lease Review (unchanged by Phase 1)
```

Phase 1's new pieces sit entirely outside this diagram today: `azure/azure-to-canonical-layout.ts` is called only by its own test suite.

## 3. Existing canonical-layout limitations (pre-Phase-1)

`document-intelligence-v3/canonical-layout.ts` already defined `CanonicalDocumentLayout`/`CanonicalPage`/`LayoutBlock`/`CanonicalTable`/`CanonicalTableCell`/`EvidenceAnchor`, built by `buildCanonicalLayoutFromAzureLikeOutput()` from `docling_raw` — not from Azure's real response. Because `azure-layout-adapter.ts` (the Azure→`docling_raw` step) never carried polygon/bounding-box data in the first place, every `polygon` field this path ever produced was a hard-coded `[]`. It had exactly two consumers, both v3-diagnostic: `vertex-fact-ledger/document-index-v3.ts` and `document-intelligence-v3/side-write.ts` (for `layout_summary`/`content_hash`).

## 4. New authoritative canonical contract

**Architecture ownership** (documented in-file and enforced by the leakage rule below):
- **Azure** owns physical document understanding — OCR, page structure, reading order, tables, coordinates, spans, selection marks.
- **Canonical Layout** owns provider-neutral structure only.
- **Vertex** owns semantic understanding — document profile, parties, dates, rent, CAM/expenses, clauses, evidence-backed claims. Canonical Layout never infers business meaning; it only preserves physical anchors. Evidence ownership belongs to Vertex.
- **Lease Review** owns policy.

**Consumer rule**: consumers may only consume `CanonicalDocumentLayout`; only adapters understand a specific provider's raw shape.

`document-intelligence-v3/canonical-layout.ts` was evolved additively (no field removed or renamed):
- New shared types: `CanonicalSpan { offset, length }`, `CanonicalBoundingRegion { page_number, polygon }`, `CanonicalWarning { code, path?, message, severity: "recoverable" | "fatal" }`.
- New constants: `CANONICAL_LAYOUT_SCHEMA_VERSION = 1`, `MINIMUM_SUPPORTED_SCHEMA_VERSION = 1`.
- New constrained type: `CanonicalLayoutProvider = "azure_document_intelligence" | "legacy_docling_compatibility" | "unknown"`.
- New optional fields on every existing interface (`CanonicalDocumentLayout.schema_version/provider/provider_model_id/provider_api_version/warnings`; `CanonicalPage.page_unit/spans/bounding_regions`; `LayoutBlock.role/spans/bounding_regions/reading_order_index`; `CanonicalTable.row_count/column_count/spans/bounding_regions`; `CanonicalTableCell.row_span/column_span/kind/spans/bounding_regions`; `EvidenceAnchor.spans/bounding_regions`).
- **Stable IDs**: the existing `block_id`/`table_id`/`cell_id` fields are the contract's stable-id mechanism (Azure itself guarantees none). Phase 1's Azure adapter populates them deterministically from position (`page-2-block-17`, `table-3-cell-r2-c4`).

**Compatibility policy**: a layout built under schema version X must remain readable by any consumer supporting `MINIMUM_SUPPORTED_SCHEMA_VERSION <= X <= CANONICAL_LAYOUT_SCHEMA_VERSION`; consumers must ignore unknown additive fields and never require provider-specific fields.

**Schema evolution rules**: fields may only be added, never removed in place; existing fields cannot change semantics/type; any removal/semantic change requires an explicitly-approved schema version bump — not a Phase 1 action.

**Future-provider goal**: a future AWS Textract / Google Document AI adapter should be able to populate this same contract without contract changes.

### Contract invariants and the validator

Documented invariants: page numbers unique; `block_id`/`table_id`/`cell_id` unique; spans never overlap within one block; `reading_order_index` unique per page; every `bounding_regions[].page_number` references a real page; `schema_version` set on every newly-built layout; every page belongs to exactly one document (enforced by construction, not runtime-checked).

New export `validateCanonicalLayout(layout): { valid, errors: CanonicalWarning[], warnings: CanonicalWarning[] }` — pure, O(n) over the layout, never throws. Fatal (invalidates): page-count mismatch, duplicate ids, overlapping/invalid/out-of-range spans, `bounding_regions` referencing a nonexistent page, inconsistent table dimensions, duplicate `reading_order_index`, missing content, missing `schema_version`. Recoverable (logged, does not invalidate): malformed/non-finite polygons, unrecognized-but-preserved paragraph roles.

**Scope boundary**: `validateCanonicalLayout()` validates only structural correctness. It never validates lease semantics, business rules, approval rules, or extraction quality — those belong to Vertex's output and Lease Review's policy layer. It must remain provider-neutral forever.

## 5. Azure adapter boundary

New file `supabase/functions/_shared/extraction/azure/azure-to-canonical-layout.ts`, exporting `azureAnalyzeResultToCanonicalLayout(analyzeResult: AzureAnalyzeResultLike, context?) => CanonicalDocumentLayout`.

- **Pure, synchronous, deterministic.** No network, no `Deno.env`, no DB, no Azure client call, no runtime registration in Phase 1.
- **Azure input types** (`AzureAnalyzeResultLike`, `AzurePageLike`, `AzureLineLike`, `AzureParagraphLike`, `AzureTableLike`, `AzureTableCellLike`, `AzureBoundingRegionLike`, `AzureSpanLike`) are minimal, isolated to this file, and never bound to any Azure SDK type.
- **Leakage rule**: Azure-specific enums/shapes/REST payload types never appear outside this file. A test (`no Azure-specific raw field names leak into the canonical output`) asserts the serialized output never contains raw Azure key names like `boundingRegions`/`pageNumber`/`rowIndex`.
- **Input boundary**: accepts only the inner `analyzeResult` object, not the outer polling envelope (`status`/`operationLocation`). No silent double-unwrapping.
- **`content_hash` is intentionally left `null`** — the existing hash uses `crypto.subtle.digest` (async); this pure/sync adapter does not compute it. No production hash semantics changed.

## 6. Deterministic text/reading-order rules

1. Paragraphs are the primary semantic block collection when present.
2. Page lines are fallback blocks only when paragraphs are absent globally — never unioned with paragraphs (verified by a dedicated test).
3. Tables remain separate structured objects.
4. Reading order (`reading_order_index`) is assigned per-page in the order paragraphs/lines already appear in Azure's own array (which is already reading-order), not re-derived from polygon coordinates.
5. Stable ids are position-derived, never random.

## 7. Geometry/span preservation ("losslessness over interpretation")

The adapter stores Azure's raw spans and the authoritative top-level `content` as source of truth: `text_projection` is `content`, verbatim — no `[[PAGE n]]` marker synthesis is needed (unlike the legacy path, which must synthesize markers because it has no real page-span data). Per-page `plain_text` is populated only for backward compatibility with the existing required field, via a new, separately-named, explicitly-called helper `reconstructPageTextFromSpans()` (added to `canonical-layout.ts`, provider-neutral) — never folded silently into the adapter's main path. **All** bounding regions are preserved (`bounding_regions: CanonicalBoundingRegion[]`), not just the first; a first-region `polygon` compatibility field is also set but never replaces the full list. Merged-cell `row_span`/`column_span`, table dimensions, paragraph roles, and cell kinds are all preserved.

**Performance budget** (met and spot-checked by a 200-page × 5-paragraph test completing in low single-digit milliseconds): adapter construction is O(n) over the Azure payload; the validator is O(n) over the resulting layout; no second full traversal; no allocation proportional to `page_count²`; no recursion proportional to document depth.

## 8. Legacy compatibility behavior

`buildCanonicalLayoutFromAzureLikeOutput` was renamed internally to `legacyDoclingToCanonicalLayout` (identical logic). The original name remains exported as a literal alias:

```ts
export const buildCanonicalLayoutFromAzureLikeOutput = legacyDoclingToCanonicalLayout;
```

Per explicit direction, **no import sites were mechanically migrated in Phase 1** — `vertex-fact-ledger/document-index-v3.ts` and `document-intelligence-v3/side-write.ts` are untouched and still import the old name, which resolves correctly via the alias. This kept the Phase 1 diff to a single modified existing file (`canonical-layout.ts`) plus new files. Import migration to the clearer name is deferred to a later, gradual, unrelated cleanup, removed only after several releases.

## 9. Hash compatibility result

`content_hash` computation (`sha256Hex` over `full_text`, via Web Crypto) is untouched. New regression tests prove: the alias and renamed function are the exact same function reference; they produce deep-equal output for the same fixture; `content_hash` is exactly unchanged for a fixed `contentHash` context (the idempotency-key input `side-write.ts` actually uses); `summarizeCanonicalLayout` output is unchanged; and the new optional fields (`provider_model_id`, `provider_api_version`, `warnings`) are never set to an explicit `undefined` on the legacy path (only `schema_version`/`provider` are populated there — see §14) so no serialization/equality check downstream is affected. A DB-backed test against a local Supabase instance additionally proves `document_intelligence_runs.layout_summary` is byte-for-byte what `legacyDoclingToCanonicalLayout` + `summarizeCanonicalLayout` produce directly, post-rename.

## 10. Files changed

**Modified** (one existing file only): `supabase/functions/_shared/extraction/document-intelligence-v3/canonical-layout.ts`.

**Created**:
- `supabase/functions/_shared/extraction/azure/azure-to-canonical-layout.ts`
- `supabase/functions/_tests/azure-to-canonical-layout.test.ts`
- `supabase/functions/_tests/fixtures/azure-layout-sanitized.json`
- `docs/azure-vertex-migration-phase1-canonical-layout.md` (this file)

**Test files extended** (no production logic changed): `supabase/functions/_tests/document-intelligence-v3-canonical-layout.test.ts`, `supabase/functions/_tests/document-intelligence-v3-document-index.test.ts`, `supabase/functions/_tests/document-intelligence-v3-side-write.property.test.ts`.

`vertex-fact-ledger/document-index-v3.ts` and `document-intelligence-v3/side-write.ts` were **not modified** (§8).

## 11. Tests added

Three distinct groups, per plan:

1. **Canonical contract validation** (`document-intelligence-v3-canonical-layout.test.ts`, extended): 18 new tests — alias/rename equivalence, content_hash/summary compatibility, schema-version constants, and one test per `validateCanonicalLayout` invariant (duplicate page/block/cell ids, duplicate reading-order index, unknown-page bounding regions, overlapping spans, out-of-range spans, malformed/non-finite polygons as recoverable, table-dimension conflicts, page-count mismatch, missing schema_version).
2. **Azure adapter validation** (new `azure-to-canonical-layout.test.ts`): 30 tests — positive coverage against the sanitized fixture (page count, page text via real spans, paragraph precedence, reading order, table/merged-cell/polygon preservation, all bounding regions, spans, page unit, schema/provider metadata, zero warnings + `validateCanonicalLayout` valid, determinism, no-leakage) plus every edge case from the plan (null/undefined input, empty result, missing `pages[]` with reconciliation, missing content, spans-absent page-text fallback, paragraphs-absent/lines-present, both-present-no-duplication, malformed/non-finite polygons, invalid page number, out-of-range span, unrecognized role, missing table dimensions, multi-page table regions, Unicode round-trip, 200-page/1000-paragraph performance check).
3. **Legacy compatibility regression**: extended `document-intelligence-v3-document-index.test.ts` (+1 test) and `document-intelligence-v3-side-write.property.test.ts` (+1 DB-backed test), plus a full re-run of `vertex-fact-ledger.test.ts` as an indirect-consumer regression check.

## 12. Test results

| Command | Result |
| --- | --- |
| `deno check` on `canonical-layout.ts`, `azure-to-canonical-layout.ts`, `document-index-v3.ts`, `side-write.ts` | ✅ all pass |
| `deno test` `document-intelligence-v3-canonical-layout.test.ts` | ✅ 30/30 |
| `deno test` `azure-to-canonical-layout.test.ts` | ✅ 30/30 |
| `deno test` `document-intelligence-v3-document-index.test.ts` | ✅ 13/13 |
| `deno test` `document-intelligence-v3-side-write.property.test.ts` (against local Supabase) | ✅ 16/16 |
| `deno test` `vertex-fact-ledger.test.ts` (regression, mocked Vertex) | ✅ 13/13 |
| `npm run lint` | ✅ clean |
| `npm run typecheck` | ✅ clean |
| `npm run test` (vitest) | ✅ 657/657 |
| `npm run build` | ✅ succeeds (pre-existing chunk-size warning only, unrelated) |
| `git diff --check` | ✅ clean |
| Secret scan of diff | ✅ none found |

## 13. Compatibility risks

- **Naming duplication across two "canonical layout" concepts is resolved, not merely documented**: Phase 1 evolved the one existing module in place rather than creating a second, so there is exactly one `CanonicalDocumentLayout` type going forward.
- **Deferred import migration** (§8) means `document-index-v3.ts`/`side-write.ts` still reference the deprecated alias name. This is intentional (smaller diff, no merge-conflict risk) but is technical debt that must eventually be cleaned up — tracked, not forgotten.
- **Two validation-worthy fields carry the same first-region data** (`polygon` compat field and `bounding_regions[0]`): `validateCanonicalLayout()` checks both independently, so a single malformed source polygon can produce two warnings rather than one. This is documented and intentional (both are real, independently-typed fields), not a bug, but worth knowing when reading validator output.
- **`Object.hasOwnProperty` checks** were added as explicit regression tests to guard against a future edit accidentally setting new optional fields to `undefined` on the legacy path (which would be invisible to `JSON.stringify`-based equality but visible to key-enumeration-based logic).

## 14. Dual-fidelity limitation

The legacy path (`legacyDoclingToCanonicalLayout`) remains lossy by construction — it still derives from `docling_raw`, so every `polygon`/`bounding_regions`/`spans`/`reading_order_index` it produces is empty/absent; only `schema_version` and `provider: "legacy_docling_compatibility"` are newly populated there. The Azure-native adapter (`azureAnalyzeResultToCanonicalLayout`) is the only path with real geometry, and **nothing in the running pipeline calls it yet**. This is intentional and expected until a future phase wires a real consumer to it (§16) — it is not a defect to fix within Phase 1.

## 15. Explicitly out of scope for Phase 1 (confirmed unchanged)

No production/Supabase deployment. No database migration or writes (the one DB-backed test targets a local dev Supabase instance already used by pre-existing tests in the same file, and only reads/writes the same diagnostic tables those tests already exercise). No live Azure or Vertex call (all tests use synthetic/hand-built fixtures; Vertex tests use pre-existing mocks). No Gemini/OpenAI/Vision-OCR/Docling call. No parse or extraction rerun. No approval-gating change. No v3 hard gate. `BUSINESS_EXTRACTION_PROVIDER`/`EXTRACTION_PROVIDER` untouched and not globally set. No Docling/Vision code removed. `docling_raw` not renamed or dropped. `parse-pdf-docling`, `normalize-pdf-output`, `lease-extraction-worker`, and all Lease Review files untouched. `normalized_output`/`ui_review_payload`/`parsed_data` contracts untouched. No secrets in any new file (verified by diff review).

## 16. Phase 2+ proposal (not started)

Phase 2 is **not** Vertex integration and does **not** assume database persistence. Prototype the canonical layout as a transient, computed-on-demand representation first; measure actual downstream needs (memory, latency, repeat-access patterns); persist only if that measurement shows a real consumer requires it. Phase 3 — migrate readers to `canonical_layout` first (transient or persisted per the Phase 2 outcome), `docling_raw` remains fallback. Phase 4 — introduce `parse-document-layout`, keep `parse-pdf-docling` as a compatibility wrapper. Phase 5 — Vertex consumes `CanonicalDocumentLayout` through a dedicated extraction interface; Vertex never directly consumes Azure output. Phase 6 — controlled Azure+Vertex end-to-end test. Phase 7 — controlled provider rollout. Phase 8 — remove Docling/Vision runtime paths and dependencies. Phase 9 — stop legacy dual-write (if any was introduced), final naming/schema cleanup.

**Adapter registry** (documentation-only, not implemented): once a second provider adapter exists, `azure_document_intelligence → azureAnalyzeResultToCanonicalLayout()`, `future_textract → textractToCanonicalLayout()`, `future_document_ai → documentAIToCanonicalLayout()` is the intended shape.

**Observability** (documentation-only, not implemented): a future runtime-wired phase should emit `adapter_duration_ms`, `validation_duration_ms`, `warning_count`, `fatal_error_count`, `pages_processed`, `tables_processed`, `blocks_processed`, `provider_name`, `schema_version`.

**Rollback**: Phase 1 introduces only additive types, a new validator, a new adapter, new tests, and a deprecated alias — no existing behavior changed, no migration ran, no persisted state touched. Rollback is reverting the Phase 1 commit(s); nothing else is required.

## 17. Recommendation

**No Gate.** Phase 1 is contract, validation, and adapter work only, fully additive, with the only existing-file edit (`canonical-layout.ts`) proven behaviorally inert to its two real consumers by dedicated regression tests, one of them DB-backed. Stop here — Phase 2 does not begin automatically.
