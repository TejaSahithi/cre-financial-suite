# Azure + Vertex Canonical Pipeline Migration — Phase 3A: Architecture Verification

Date: 2026-07-16
Branch: `feature/document-intelligence-v3`. Phase 1 `62678ec`, Phase 2 `f6c9674`, Phase 3 `2c5c544`.
Scope: review and documentation only. **No code changed. No consumer migrated. No schema/deploy/provider change.**
Recommendation: **No Gate**

## 1. Executive summary

Before wiring any real consumer to Phase 3's resolver, this phase verified the dependency graph, audited two design properties, and produced a corrected roadmap. Bottom line: the boundary is architecturally sound, but Phase 4 is riskier than "swap an import" implies (see §2), one warning code leaks the provider name into the shared contract (§4), and — critically — every currently-reachable consumer will only ever get `legacy_lossy` fidelity through this resolver until something upstream starts passing a raw Azure response through (§5). Phase 4 is restructured into independently-approved sub-phases (§8), each required to answer a five-question adoption contract (§6) and, for the first one, meet an explicit equivalence test (§9).

## 2. Dependency-graph verification, per consumer

All 5 consumers inventoried in Phase 3 (`docs/azure-vertex-migration-phase3-canonical-layout-resolver.md` §10) currently only have `docling_raw` available — Phase 2 confirmed raw Azure `analyzeResult` isn't stored by default. Re-confirmed now: each would call `resolveCanonicalDocumentLayout({ doclingRaw })`, requiring **zero Azure-specific or Docling-internal imports** in any consumer's own code (`doclingRaw` is typed `unknown` at the resolver boundary; `AzureAnalyzeResultLike` is only ever imported by the adapter itself and its test). **The dependency boundary holds.**

This does **not** mean adoption is mechanical. Each consumer today calls a direct builder function and gets a `CanonicalDocumentLayout` back unconditionally. The resolver instead returns a richer, structurally different result — `source`, `fidelity`, a `validation` object that can be fatal, `warnings`, and the possibility of `layout: null` — none of which the current call sites have any code path for. **Migration risk is narrow in code size, not narrow in required verification.** Every sub-phase below must explicitly test null, invalid, unsupported-version, and legacy-lossy resolutions for its target consumer, not just confirm the happy path still works.

## 3. Warnings-as-informational-only

Re-confirmed by grep: the resolver never reads `.warnings` conditionally anywhere in its own logic — every reference is an append into an output array (`[...priorWarnings, ...layout.warnings]` etc.); all of the resolver's own branching uses `source`, `schemaStatus`, `validation.valid`, and the provenance-comparison result. No currently-planned consumer needs warning-code branching for its actual data needs (text, pages, blocks, tables, `content_hash`). **Holds today, with no violation found.** Recommendation: this becomes an explicit one-line doc-comment rule on the resolver as part of Phase 4a's own change (not applied now, since Phase 3A makes no code changes).

## 4. Provider-neutrality audit

All 23 warning/error codes across the validator (`canonical-layout.ts`), the adapter (`azure-to-canonical-layout.ts`), and the resolver were enumerated and classified by scope:

- **`canonical_structure`** (validator-emitted structural invariants — must be provider-neutral): `bounding_region_unknown_page`, `duplicate_block_id`, `duplicate_cell_id`, `duplicate_page_number`, `duplicate_reading_order_index`, `duplicate_table_id`, `invalid_span`, `missing_content`, `missing_layout`, `missing_schema_version`, `overlapping_spans`, `page_count_mismatch`, `table_dimensions_conflict` — all clean.
- **`resolver_policy`** (resolver-emitted decisions — must be provider-neutral): `canonical_azure_authority_undetermined`, `canonical_layout_schema_version_missing`, `canonical_layout_schema_version_too_new`, `canonical_layout_schema_version_too_old`, `canonical_layout_structurally_invalid`, `canonical_layout_superseded_by_newer_azure_result` — all provider-neutral *concepts*, though several literally contain the word "azure"/"canonical" in a way that names the resolver's own comparison, not a foreign provider; judged acceptable since these describe the resolver's decision about *itself*, not a structural layout concept.
- **`adapter_input`** (provider-scoped by design — allowed to name the provider): `missing_analyze_result`, `empty_content`, `page_synthesized_from_content`, `page_text_from_lines_fallback`, `paragraph_missing_bounding_region`, `table_missing_bounding_region`, `table_spans_multiple_pages` — adapter-local, acceptable.

**One finding**: `"duplicate_azure_page_number"` is `adapter_input`-scoped by location but describes an entirely `canonical_structure`-level concept (a page number appearing twice) — it bakes the provider name into what should be a provider-neutral concept, and it flows into the shared `CanonicalWarning[]` on any Azure-sourced layout. **This is a real, small abstraction leak.** Not fixed in Phase 3A (no code changes) — routed to Phase 3B (§8).

## 5. Architectural observation — current reachable fidelity

Because every current consumer only has `docling_raw`, Phase 4 adoption will route `docling_raw → legacyDoclingToCanonicalLayout → resolver → consumer`, not `Azure analyzeResult → Azure-native adapter → resolver → consumer`. **Phase 4 proves the resolver integration, not the lossless Azure-native path.** The lossless path becomes reachable only when an upstream runtime path passes the raw Azure `analyzeResult` into the resolver — either transiently during the same pipeline run, or through an explicitly approved durable representation — not from the commonly persisted reduced `docling_raw` shape alone. That upstream change is separate and not yet scheduled. This is consistent with Phase 2's transient decision (transient doesn't require persistence, but it does require *something* passing the raw result through, which nothing currently does) — it should not be mistaken for the Azure migration being complete once Phase 4 lands.

## 6. Adoption contract (required template for every Phase 4 sub-phase)

Every future Phase 4 sub-phase's own plan must answer, before being approved:
1. What resolver `source` is expected for this consumer?
2. What `fidelity` is acceptable (e.g. document-index may accept `legacy_lossy`; a future geometry-dependent consumer might require `lossless`)?
3. What happens when `layout` is `null`?
4. What happens when `validation` is fatal?
5. What is the rollback path?

## 7. Legacy-builder retirement — exit conditions, not fixed phase numbers

Given how much the roadmap has already expanded, retirement of `legacyDoclingToCanonicalLayout`/the `buildCanonicalLayoutFromAzureLikeOutput` alias is governed by conditions, not a bare phase number (indicative targets only: Phase 8 freeze, Phase 9 compatibility-only, Phase 10 delete):

- **Legacy entry freeze**: no new direct callers of `legacyDoclingToCanonicalLayout`.
- **Compatibility-only state**: all active consumers use `resolveCanonicalDocumentLayout`.
- **Removal eligibility**: zero direct runtime callers; historical payload tests pass through the resolver; the Azure-native path has completed controlled end-to-end QA; rollback no longer depends on the legacy builder; at least one stabilization release has completed.

## 8. Corrected roadmap

- **Phase 3B** — rename `duplicate_azure_page_number` → `duplicate_page_number` in the adapter. Guard test classifies codes by scope (§4) rather than a blunt string search, so legitimate `adapter_input` codes like `missing_analyze_result` are never wrongly flagged; only `canonical_structure`/`resolver_policy` codes are asserted provider-name-free. Small, isolated, own commit.
- **Phase 4a** — adopt the resolver in `document-index-v3.ts` only.
- **Phase 4b** — adopt the resolver in `side-write.ts` only.
- **Phase 4c** — review evidence enrichment; migrate only if it independently resolves a layout. Per Phase 3's inventory it currently reuses document-index's in-memory layout — likely "not applicable, inherits 4a," confirmed when 4a lands.
- **Phase 4d** — diagnostics/readiness: skip unless a demonstrated need exists; record "not applicable" rather than forcing a migration that isn't needed (readiness reads only durable claim/evidence tables today, never a layout).
- **Phase 4e** — normalize pipeline, last, highest blast radius, requires controlled verification.

## 9. Phase 4a acceptance criteria

Must all hold before Phase 4a is approved to start:
- Only `document-index-v3.ts` and its tests change.
- The resolver is the only layout-construction entry point for that consumer.
- No direct adapter import remains in the consumer.
- No direct legacy-builder import remains in the consumer.
- **For every supported existing `docling_raw` fixture, resolver-based document indexing must produce a deep-equal document index to the current direct legacy-builder path, including block ordering, text, page mapping, content hash, and evidence-enrichment inputs.**
- `legacy_lossy` fidelity is explicitly accepted.
- Fatal validation does not produce a misleadingly-valid index.
- A `null` layout returns the existing safe fallback or an explicit error, never a silent empty-but-"successful" result.
- No provider call, database change, deployment, or approval-behavior change.

## 10. Recommendation

**No Gate.** Neither Phase 3B nor Phase 4a begins automatically — each requires separate approval.

**Scorecard**: Dependency boundary: **holds**. Warnings as control flow: **no current violation**. Provider-neutral vocabulary: **one structural leak found**, routed to Phase 3B. Current reachable fidelity: **`legacy_lossy` only**, for normal persisted inputs. Phase 4 adoption risk: **narrow, but not mechanical**. Next approved unit: **Phase 3B only**.
