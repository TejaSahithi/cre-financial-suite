# Azure + Vertex Canonical Pipeline Migration — Consolidated Audit Report

Date: 2026-07-16
Branch: `feature/document-intelligence-v3`
Phases covered: 1, 2, 3, 3A, 3B, 4a, 4b (all complete and committed)
Overall recommendation across every phase: **No Gate**

This report consolidates the seven individual phase reports already committed under `docs/azure-vertex-migration-phase*.md` into one document. Every fact below is drawn from those reports (or, where noted, verified directly against the repository state at the time of writing) — nothing here is a new decision or a re-litigation of a prior one.

---

## 1. Executive summary

The target architecture is: **Azure Document Intelligence owns physical layout** (OCR, pages, reading order, tables, coordinates) → **one provider-neutral `CanonicalDocumentLayout` contract** → **Vertex AI owns semantic extraction** (parties, dates, rent, CAM, clauses, evidence-backed claims) → **claims/evidence** → **Lease Review**.

Seven phases have been completed toward this target, each scoped narrowly, each verified before the next began, each stopping for separate approval rather than cascading automatically:

| # | Phase | Commit | Nature | Runtime changed? |
|---|---|---|---|---|
| 1 | Canonical Layout Contract & Azure Adapter | `62678ec` | Additive contract + adapter | No |
| 2 | Transient vs. Persisted Decision | `f6c9674` | Measurement + written decision | No |
| 3 | Canonical Layout Resolver | `2c5c544` | Additive resolver | No |
| 3A | Architecture Verification | `991fed7` | Review only, zero code | No |
| 3B | Warning Vocabulary Fix | `479b121` | Hygiene fix + guard test | No |
| 4a | document-index-v3 Resolver Adoption | `cb77efb` | First real consumer migration | `document-index-v3.ts` only |
| 4b | side-write Resolver Adoption | `23ba755` | Second real consumer migration | `side-write.ts` only |

**What has not changed, across all seven phases, confirmed at every single phase boundary**: the upload → parse → normalize → Lease Review runtime pipeline; `parse-pdf-docling`; `normalize-pdf-output`'s orchestration; `lease-extraction-worker`; any Lease Review file; `docling_raw`, `normalized_output`, `ui_review_payload`; any database schema; any provider flag (`EXTRACTION_PROVIDER`, `BUSINESS_EXTRACTION_PROVIDER`, `ENABLE_DOCUMENT_INTELLIGENCE_V3`'s meaning); approval-gating behavior. No production deploy has occurred. No live Azure or Vertex call has been made outside of pre-existing, already-mocked test paths.

**Current state of consumer adoption**: of the five consumers Phase 3 inventoried as candidates for the resolver, two are migrated (`document-index-v3.ts`, `side-write.ts`), both proven equivalent to their pre-migration behavior before the switch, not after. Three remain: evidence-enrichment (expected to be a no-op review, since it already reuses the layout `document-index-v3.ts` resolves), diagnostics/readiness (expected "not applicable" — it never reads a layout), and the normalize pipeline (not started, explicitly deferred as the highest-blast-radius candidate).

**The one architectural fact that threads through every phase from Phase 2 onward**: production `docling_raw` does not durably store Azure's full raw response by default. This means the *lossless* Azure-native adapter path built in Phase 1 remains structurally unreachable from any currently-migrated consumer — every real resolution today reports `source: "legacy_docling_raw"` / `fidelity: "legacy_lossy"`. This is not a defect anywhere in the migration; it is a correctly identified, explicitly documented boundary condition that a future, separately-scoped phase would need to address (by passing a raw Azure response through, transiently or durably) before the lossless path becomes reachable in production.

---

## 2. Architecture and terminology

**Ownership model** (established in Phase 1, unchanged since):
- **Azure** owns physical document understanding — OCR, page structure, reading order, tables, coordinates, spans, selection marks.
- **Canonical Layout** owns provider-neutral structure only, and nothing else.
- **Vertex** owns semantic understanding — document profile, parties, dates, rent, CAM/expenses, clauses, evidence-backed claims. It never infers business meaning inside the canonical layout itself.
- **Lease Review** owns policy and reviewer-facing presentation.

**Consumer rule**: consumers may only consume `CanonicalDocumentLayout`; only provider-specific adapters may understand a specific provider's raw response shape. This rule is what Phase 3A's dependency-graph verification confirmed actually holds in practice.

**Key types and functions, in the order they were introduced**:
- `CanonicalDocumentLayout`, `CanonicalPage`, `LayoutBlock`, `CanonicalTable`, `CanonicalTableCell`, `EvidenceAnchor`, `CanonicalWarning`, `CanonicalSpan`, `CanonicalBoundingRegion` — the contract itself (Phase 1, in `document-intelligence-v3/canonical-layout.ts`).
- `CANONICAL_LAYOUT_SCHEMA_VERSION = 1`, `MINIMUM_SUPPORTED_SCHEMA_VERSION = 1` — schema-compatibility constants (Phase 1).
- `validateCanonicalLayout(layout)` — pure, O(n) structural validator; never validates business/lease semantics (Phase 1).
- `azureAnalyzeResultToCanonicalLayout(analyzeResult, context?)` — pure, synchronous, lossless Azure-native adapter, in `_shared/extraction/azure/azure-to-canonical-layout.ts` (Phase 1).
- `legacyDoclingToCanonicalLayout(doclingRaw, context)` — the renamed, behaviorally identical legacy builder; `buildCanonicalLayoutFromAzureLikeOutput` remains exported as a permanent-until-migrated alias pointing at the same function (Phase 1).
- `resolveCanonicalDocumentLayout(input)` — the single entry point a consumer should call, in `document-intelligence-v3/canonical-layout-resolver.ts`; returns `{ layout, source, fidelity, validation, warnings, provenance }` (Phase 3).

---

## 3. Phase 1 — Canonical Layout Contract & Azure Adapter

**Commit**: `62678ec` · **Scope**: contract + validation + adapter + compatibility tests only.

### What it did
Introduced the single, authoritative, provider-neutral `CanonicalDocumentLayout` contract and a new adapter that can build it losslessly, directly from Azure Document Intelligence's raw `analyzeResult` — preserving real polygons, spans, reading order, and merged-cell structure for the first time. Nothing in the running pipeline calls the new adapter yet.

A pre-existing but lossy canonical-layout module (derived from `docling_raw`, always producing empty polygons because `azure-layout-adapter.ts`, the Azure→`docling_raw` step, never carried polygon data) was **evolved in place** rather than duplicated — the alternative of creating a second "canonical layout" concept was explicitly rejected. Its original export, `buildCanonicalLayoutFromAzureLikeOutput`, was renamed internally to `legacyDoclingToCanonicalLayout` and kept exported as a literal alias, so no existing caller (`vertex-fact-ledger/document-index-v3.ts`, `document-intelligence-v3/side-write.ts`) needed to change and none did.

### Key design decisions
- **Deterministic text/reading-order rules**: paragraphs are the primary semantic block collection when present; page lines are fallback blocks only when paragraphs are globally absent, never unioned with paragraphs; tables remain separate structured objects; `reading_order_index` is assigned per-page in Azure's own already-ordered array sequence, never re-derived from polygon coordinates; stable IDs (`block_id`/`table_id`/`cell_id`) are position-derived, never random.
- **Losslessness over interpretation**: the adapter stores Azure's raw spans and treats the top-level `content` field as the authoritative `text_projection`, verbatim — no `[[PAGE n]]` marker synthesis needed (unlike the legacy path, which must synthesize markers because it lacks real page-span data). All bounding regions are preserved, not just the first.
- **Leakage rule, enforced by a test**: Azure-specific enums/shapes/REST payload types never appear outside `azure-to-canonical-layout.ts`. A dedicated test asserts the serialized canonical output never contains raw Azure key names like `boundingRegions`/`pageNumber`/`rowIndex`.
- **`content_hash` intentionally left `null`** in the Azure-native adapter's own output — the existing hash uses `crypto.subtle.digest` (async); this adapter is deliberately pure/sync. No production hash semantics changed by this choice.
- **Performance budget met**: adapter construction is O(n) over the Azure payload; the validator is O(n) over the resulting layout; a 200-page × 5-paragraph synthetic test completed in low single-digit milliseconds.

### Validator invariants
`validateCanonicalLayout()` treats as **fatal** (invalidates the layout): page-count mismatch, duplicate `block_id`/`table_id`/`cell_id`/page number, overlapping/invalid/out-of-range spans, `bounding_regions` referencing a nonexistent page, inconsistent table dimensions, duplicate `reading_order_index`, missing content, missing `schema_version`. Treats as **recoverable** (logged, does not invalidate): malformed/non-finite polygons, unrecognized-but-preserved paragraph roles.

### Files changed
- **Modified** (one existing file only): `supabase/functions/_shared/extraction/document-intelligence-v3/canonical-layout.ts`.
- **Created**: `_shared/extraction/azure/azure-to-canonical-layout.ts`; `_tests/azure-to-canonical-layout.test.ts`; `_tests/fixtures/azure-layout-sanitized.json`; `docs/azure-vertex-migration-phase1-canonical-layout.md`.
- **Test files extended, no production logic changed**: `_tests/document-intelligence-v3-canonical-layout.test.ts`; `_tests/document-intelligence-v3-document-index.test.ts`; `_tests/document-intelligence-v3-side-write.property.test.ts`.
- `vertex-fact-ledger/document-index-v3.ts` and `document-intelligence-v3/side-write.ts` were **not modified**.

### Tests and results

| Command | Result |
|---|---|
| `deno test document-intelligence-v3-canonical-layout.test.ts` | ✅ 30/30 |
| `deno test azure-to-canonical-layout.test.ts` | ✅ 30/30 |
| `deno test document-intelligence-v3-document-index.test.ts` | ✅ 13/13 |
| `deno test document-intelligence-v3-side-write.property.test.ts` (local Supabase) | ✅ 16/16 |
| `deno test vertex-fact-ledger.test.ts` (regression, mocked Vertex) | ✅ 13/13 |
| `npm run lint` / `typecheck` / `build` | ✅ clean |
| `npm run test` (vitest) | ✅ 657/657 |
| `git diff --check` | ✅ clean |

59 new/extended Deno tests in total: 30 adapter tests, 18 new contract/compatibility tests, plus 1 extended document-index test and 1 extended (DB-backed) side-write test, plus 9 pre-existing tests re-verified unchanged.

### Risks / compatibility notes carried forward
- **Deferred import migration**: `document-index-v3.ts`/`side-write.ts` still referenced the deprecated alias name after Phase 1 — intentional (smaller diff, no merge-conflict risk), tracked as technical debt, not forgotten. (Resolved for these two files specifically by Phases 4a/4b, below.)
- **Dual-fidelity limitation**: the legacy path remains lossy by construction (empty polygons/spans/reading-order); the Azure-native adapter is the only lossless path and nothing called it yet. Explicitly flagged as expected, not a defect, until a future consumer is wired to it — which Phase 2 and Phase 3A later confirm is *still* the case even after two consumers were migrated (§9 of this report).

### Recommendation
No Gate. Contract, validation, and adapter work only, fully additive.

---

## 4. Phase 2 — Transient vs. Persisted Decision

**Commit**: `f6c9674` · **Scope**: measurement, comparison, and a written recommendation only.

### What it did
Before anything is wired to consume `CanonicalDocumentLayout`, this phase answered: should a canonical layout be persisted to the database, or computed transiently on demand? The decision was made **evidence-based**, with decision thresholds predeclared before any measurement was taken, specifically to avoid confirmation bias.

### Method
A standalone, offline, permission-scoped diagnostic harness (`_tests/diagnostics/phase2-canonical-layout-harness.ts`) was built and run against five fixtures generated by a self-verifying builder (spans are always derived programmatically from `content.indexOf(...)`, never hand-maintained):
- `assignment-scale-synthetic.json` — 2 pages, 3 blocks, no tables.
- `base-lease-scale-synthetic.json` — 18 pages, 72 blocks, 2 tables.
- `cam-table-scale-synthetic.json` — 10 pages, 10 blocks, 4 tables (72 cells).
- `large-lease-scale-synthetic.json` — **stress fixture**, 80 pages, 367 blocks, 4 tables (204 cells), deliberately including repeated headers/footers, amendment sections, appendix/exhibit sections, 5 genuinely empty/no-text pages, landscape pages, and one table spanning two pages.
- `current-persisted-docling-raw-azure-shape.json` — built to mirror the *actual* durable `docling_raw` shape persisted today (no raw Azure response), run through the legacy path.

The harness measured, per fixture: cold vs. warm build/validation timing (min/median/p95 across 20 warm iterations), byte-accurate input/output/text/geometry sizes, a gzip compression estimate, canonical fidelity (input counts must exactly equal output counts), a deterministic-hash check across all 20 warm runs, and a one-time validator self-audit (deliberately malformed "poison" layouts proving all 13 known invariant-check categories still fire).

### Result

**Decision: `CanonicalDocumentLayout` stays transient. Do not persist a full canonical layout.**

Every "prefer transient" threshold was met with wide margin, even on the 80-page stress fixture:

| Metric | Threshold | Measured (worst case) |
|---|---|---|
| Combined adapter + validation time | < 100 ms | 0.555 ms |
| p95 combined time | < 250 ms | 1.227 ms |
| Canonical output size | < 5 MB | 274,846 bytes (~275 KB) |

The legacy path's `geometry_bytes_estimate` was 34 bytes — essentially zero — versus 70,809 bytes for the Azure-native path on the same-scale stress fixture, empirically confirming Phase 1's documented dual-fidelity gap: the durable stored shape carries almost no real geometry today.

**Confidence: medium**, not high — fixtures are synthetic. The explicit path to high confidence: a real Azure `analyzeResult` export → tested against a real production-scale lease → repeated measurements across several real documents → stable results.

**If a future need for persistence ever appears**: prefer a separate `document_layouts` table or object storage + metadata row over adding a large geometry blob to `uploaded_files` directly (JSONB TOAST overhead, backup/replication cost, accidental full-column selects all cited as reasons). Request-scoped memoization was identified as a lower-risk intermediate step if side-write's per-call reconstruction is ever judged to matter operationally — quantified at roughly 14 seconds of CPU-time per year under illustrative assumptions, i.e., not currently a real cost.

### Architectural observation carried forward
Today's pipeline already persists enough evidence for Lease Review (`block_ids`/`polygon` on `document_claim_evidence` rows) but does **not** persist enough raw Azure output for full lossless canonical reconstruction later (`STORE_FULL_AZURE_RAW_RESPONSE` is off by default). The real emerging question for later phases is *"what is the authoritative durable document representation going forward?"* — not just a persistence toggle on one new table.

### Files changed
Created only: `_tests/diagnostics/phase2-canonical-layout-harness.ts`; `_tests/fixtures/phase2-harness/build-fixtures.ts` plus its 5 generated JSON fixtures; `docs/azure-vertex-migration-phase2-transient-persistence-decision.md`. No existing file modified.

### Recommendation
No Gate. Measurement and analysis only.

---

## 5. Phase 3 — Canonical Layout Resolver

**Commit**: `2c5c544` · **Scope**: introduce the resolver and its tests only.

### What it did
Added `resolveCanonicalDocumentLayout()` — a single, provider-neutral entry point for obtaining a `CanonicalDocumentLayout` from whichever inputs a caller has (an already-resolved layout, a raw Azure `analyzeResult`, or a legacy `docling_raw` object). Deliberately **not** a first-non-null helper: every precedence decision is explicit, every fallback is warned about, and every case where authority between two sources can't be safely established is flagged rather than guessed.

### Contract

```ts
interface ResolveCanonicalDocumentLayoutInput {
  canonicalLayout?: CanonicalDocumentLayout | null;
  azureAnalyzeResult?: AzureAnalyzeResultLike | null;
  doclingRaw?: unknown;
  sourceMetadata?: { sourcePayloadHash?, generatedAt?, provider?, providerModelId?, providerApiVersion? };
}

interface CanonicalLayoutResolutionResult {
  layout: CanonicalDocumentLayout | null;
  source: "provided_canonical_layout" | "azure_analyze_result" | "legacy_docling_raw" | "none";
  fidelity: "lossless" | "legacy_lossy" | "unknown";
  validation: CanonicalLayoutValidationResult | null;
  warnings: CanonicalWarning[];
  provenance: { provider?, providerModelId?, providerApiVersion?, sourcePayloadHash?, generatedAt? };
}
```

### Precedence and conflict handling
No source → `source: "none"`, never throws. Exactly one source → resolved directly. Multiple sources → `canonicalLayout` wins over `azureAnalyzeResult` *only* when provenance confirms the same generation; `azureAnalyzeResult` always wins over `doclingRaw`. `compareProvidedLayoutAgainstNewSource()` tries, most reliable first: (1) exact `content_hash` match → same generation, canonical wins, no recompute; a mismatch → the newly-supplied source wins, a stale canonical layout is **never** silently preferred; (2) `generated_at` metadata comparison when hashes aren't comparable; (3) if neither signal is comparable, the resolver does not guess — it still returns a usable result (the newly-supplied source, as the safer default) but attaches a loud "undetermined" warning.

### Schema-version handling

| `schema_version` | Classification | Behavior |
|---|---|---|
| `=== CANONICAL_LAYOUT_SCHEMA_VERSION` | current | Accepted, no warning |
| `MINIMUM_SUPPORTED ≤ v <` current | older_supported | Accepted, no warning |
| `null`/`undefined` | missing | Accepted, fidelity forced to `"unknown"`, recoverable warning |
| `< MINIMUM_SUPPORTED` | too_old | **Rejected** as authoritative, falls back |
| `> current` | too_new | **Rejected** as authoritative, falls back |

### Purity and wiring
Pure, deterministic, no network/env/database/global cache/runtime memoization. Complexity O(n) in the size of whichever single source is converted. No unnecessary deep clones. Confirmed **unwired** by repo-wide grep — no runtime consumer imported it at the end of this phase.

### Consumer migration inventory (documented, not implemented in this phase)

| Order | Consumer | Current input | Expected source/fidelity | Test required before switching |
|---|---|---|---|---|
| 1 | `document-index-v3.ts#resolveDocumentIndex` | `docling_raw` via direct builder call | `legacy_docling_raw` / `legacy_lossy` | Deep-equal parity test vs. current output |
| 2 | `side-write.ts#computeCanonicalLayoutAndSummary` | `docling_raw`, rebuilt every call incl. retries | `legacy_docling_raw` / `legacy_lossy` | Same parity test + confirm idempotency-key `content_hash` unchanged |
| 3 | Evidence-enrichment (`fact-mapper.ts`, `enrichFactWithBlockEvidence`) | Reuses #1's in-memory layout | N/A — inherits #1 | Covered by #1's own tests |
| 4 | Diagnostics/readiness — only if needed | Durable claim/evidence tables only, never `docling_raw` | N/A | Only relevant if scope changes |
| 5 | Normalize pipeline — only after controlled verification | No layout built here today | `legacy_docling_raw` / `legacy_lossy` if ever added | Full integration test, highest blast radius |

### Files changed
Created only: `_shared/extraction/document-intelligence-v3/canonical-layout-resolver.ts`; `_tests/canonical-layout-resolver.test.ts`; `docs/azure-vertex-migration-phase3-canonical-layout-resolver.md`. No existing file modified.

### Tests and results
19 new focused tests covering every case in the task list (provided layout, Azure conversion, legacy conversion, no source, invalid layout with/without fallback, unsupported old/future schema, missing historical schema, same-source agreement, conflicting hashes, staleness via `generated_at`, undetermined authority, fidelity reporting, validation-errors preserved, determinism, no mutation, no Azure-key leakage). Combined with Phase 1's suite: 92/92. DB-backed side-write regression: 16/16. Full npm gates clean; vitest 657/657.

### Risks noted
- The `generated_at`-in-`metadata` comparison is a soft convention (freeform `Record<string, unknown>`), not a typed contract field — a deliberate scope-minimizing choice to avoid touching `canonical-layout.ts`'s type surface in this phase.
- "Undetermined" defaults to preferring the newly-supplied source rather than refusing to resolve — a judgment call favoring availability, always accompanied by a loud warning.

### Recommendation
No Gate. One new, unwired module — contract and test work only.

---

## 6. Phase 3A — Architecture Verification

**Commit**: `991fed7` · **Scope**: review and documentation only. Zero code changed.

### What it did
Before wiring any real consumer to the Phase 3 resolver, this phase verified the dependency graph actually holds, audited two design properties, and produced a corrected, more cautious roadmap.

### Findings

1. **Dependency boundary: holds.** All 5 inventoried consumers currently only have `docling_raw` available. Each would call the resolver as `resolveCanonicalDocumentLayout({ doclingRaw })` — zero Azure-specific or Docling-internal imports required in any consumer's own code.
2. **Migration risk framing corrected**: adoption is *not* "mechanical." Each consumer today calls a direct builder and gets a layout back unconditionally; the resolver instead returns a richer, structurally different result (`source`, `fidelity`, a `validation` that can be fatal, `warnings`, a possible `null` layout) that no current call site has any code path for. Every sub-phase must explicitly test null, invalid, unsupported-version, and legacy-lossy resolutions, not just the happy path.
3. **Warnings-as-informational-only: holds, no violation found.** The resolver never branches on an externally-produced warning's contents anywhere in its own logic.
4. **Provider-neutrality audit** of all 23 warning/error codes across the validator, adapter, and resolver, classified into three scopes: `canonical_structure` (validator invariants, must be provider-neutral), `resolver_policy` (resolver decisions, must be provider-neutral), `adapter_input` (adapter-local, provider names permitted). **One finding**: `duplicate_azure_page_number` bakes the provider name into an otherwise provider-neutral structural concept. Not fixed here — routed to Phase 3B.
5. **Architectural observation, stated plainly**: because every current consumer only has `docling_raw`, Phase 4 adoption routes `docling_raw → legacyDoclingToCanonicalLayout → resolver → consumer`, not the Azure-native lossless path. Phase 4 proves the *resolver integration*, not the lossless Azure-native migration — the lossless path becomes reachable only once an upstream runtime path passes a raw Azure response through, transiently or durably, which nothing currently does.

### Deliverables for future phases

**Adoption contract** — every future consumer-adoption phase must answer, before approval: (1) what resolver `source` is expected; (2) what `fidelity` is acceptable; (3) what happens when `layout` is `null`; (4) what happens when `validation` is fatal; (5) what is the rollback path.

**Legacy-builder retirement, as exit conditions rather than fixed phase numbers**: legacy entry freeze (no new direct callers) → compatibility-only state (all active consumers use the resolver) → removal eligibility (zero direct runtime callers, historical payload tests pass through the resolver, Azure-native path has completed controlled end-to-end QA, rollback no longer depends on the legacy builder, at least one stabilization release complete). None of the three conditions have been reached as of this report.

**Corrected roadmap**: Phase 3B (vocabulary fix) → Phase 4a (`document-index-v3.ts` only) → Phase 4b (`side-write.ts` only) → Phase 4c (evidence enrichment — review, migrate only if it independently resolves a layout) → Phase 4d (diagnostics/readiness — skip unless demonstrated need) → Phase 4e (normalize pipeline — last, highest blast radius).

**Phase 4a acceptance criteria** (all subsequently met — see §8): only `document-index-v3.ts` and its tests change; resolver is the only layout-construction entry point; no direct adapter/legacy-builder import remains; deep-equal document index for every supported fixture including block ordering, text, page mapping, content hash, evidence-enrichment inputs; `legacy_lossy` explicitly accepted; fatal validation never produces a misleadingly-valid index; `null` layout returns the existing safe fallback, never a silent empty "success"; no provider/DB/deploy/approval-behavior change.

### Recommendation
No Gate. Scorecard: dependency boundary holds; warnings-as-control-flow clean; one vocabulary leak found (routed to 3B); current reachable fidelity is `legacy_lossy` only; Phase 4 adoption risk narrow but not mechanical; next approved unit was Phase 3B only.

---

## 7. Phase 3B — Warning Vocabulary Fix

**Commit**: `479b121` · **Scope**: rename 3 warning `code` strings + add one scoped guard test.

### What it did
Fixed the one leak Phase 3A found — and, while scoping the fix by applying Phase 3A's own classification rule against the actual resolver source, found two more instances of the same pattern in the resolver's own conflict-handling codes. All three were renamed together rather than carrying a partial fix forward:

| File | Old code | New code |
|---|---|---|
| `azure-to-canonical-layout.ts:210` | `duplicate_azure_page_number` | `duplicate_page_number` |
| `canonical-layout-resolver.ts:330` | `canonical_layout_superseded_by_newer_azure_result` | `canonical_layout_superseded_by_newer_source` |
| `canonical-layout-resolver.ts:341` | `canonical_azure_authority_undetermined` | `canonical_source_authority_undetermined` |

Only the `code` identifier changed at each site — `message`/`severity`/`path` are unchanged; messages may still describe Azure in human-readable prose where accurate. **Note**: `duplicate_page_number` already existed as a separate emission site inside `validateCanonicalLayout()` (fires when the *output* layout has a duplicate page number). After the rename, the adapter's pre-conversion input-duplicate check emits the same string for the same underlying structural concept surfaced at an earlier pipeline stage — intentional per Phase 3A's own classification rule, and the two emission sites remain distinguishable by `severity` (recoverable from the adapter, fatal from the validator).

### Guard test design
New file `_tests/canonical-warning-vocabulary.test.ts` classifies every warning code by scope (`adapter_input` / `canonical_structure` / `resolver_policy`) in a hand-maintained, test-local map, with:
- **Token-aware denylist matching** — codes split on `_` and checked by token membership, not substring search (`missing_analyze_result` is never flagged for containing "analyze"; a code containing "document" or "ai" alone is never flagged by the multi-token `google_document_ai` rule).
- **Two-way completeness/drift guard** — the test reads all three source files' text directly and extracts every emitted code via regex; the discovered set is asserted equal to the classification map's keys, so a code emitted in source but unclassified fails, and a classified-but-no-longer-emitted code also fails. This was **empirically verified during implementation**: a temporary stale map entry and a temporary removal of a real classified entry were each injected, confirmed to fail the guard with the expected message, then reverted.

### Persistence/consumption check
Grepped `src/` (frontend) and `supabase/migrations/` for all three old code strings, both before and after the rename — zero matches either time. Expected, since the resolver and Azure-native adapter remain entirely unwired. No compatibility alias was needed.

### Files changed
Modified: `azure-to-canonical-layout.ts` (1 line), `canonical-layout-resolver.ts` (3 lines: 2 code constants + 1 doc comment), `canonical-layout-resolver.test.ts` (3 assertion strings). Created: `_tests/canonical-warning-vocabulary.test.ts`, `docs/azure-vertex-migration-phase3b-warning-vocabulary-fix.md`.

### Tests and results
8 new vocabulary tests. Combined regression (adapter + contract + document-index + resolver + vocabulary): 100/100. Full npm gates clean; vitest 657/657. Zero remaining references to the 3 old code strings anywhere in `supabase/functions`. Zero runtime consumer imports the resolver, still.

### Recommendation
No Gate. Three renames, one new guard test, empirically verified to catch drift in both directions.

---

## 8. Phase 4a — document-index-v3 Resolver Adoption

**Commit**: `cb77efb` · **Scope**: adopt the resolver in `document-index-v3.ts` only — the first real consumer migration.

### What it did
`resolveDocumentIndex()` now calls `resolveCanonicalDocumentLayout({ doclingRaw })` instead of importing and calling `buildCanonicalLayoutFromAzureLikeOutput()` directly — the only layout-construction entry point in this consumer. The existing try/catch/fallback/log shape (falling back to the `legacy_evidence_index` path on any failure) is unchanged; only what *triggers* the fallback changed:

```ts
const resolution = await resolveCanonicalDocumentLayout({ doclingRaw });
if (!resolution.layout) {
  throw new Error(`canonical layout resolution returned no layout (source: ${resolution.source})`);
}
if (resolution.validation && !resolution.validation.valid) {
  const fatalCodes = resolution.validation.errors.map((e) => e.code).join(", ") || "unspecified";
  throw new Error(`canonical layout failed validation (fatal: ${fatalCodes})`);
}
// ... unchanged degenerate-layout check, then buildCanonicalDocumentIndexFromLayout(layout)
```

### Equivalence proof
Three representative fixtures (two-page lease, CAM-heavy with a table, single-page assignment-scale) were run through both the old path (`legacyDoclingToCanonicalLayout()` + `buildCanonicalDocumentIndexFromLayout()`, replicating pre-Phase-4a code exactly) and the new resolver-based path. Every field (`fullText`, `pageCount`, `blockIds`, projected `text_blocks` ordering, projected `tables`, table/figure/signature placeholders, `headTailExcerpt`, `content_hash`, `evidenceIndex`) **and** a whole-object deep-equal comparison passed for all three fixtures — zero divergence.

### Intentional behavior change, found and documented (not hidden)
`validateCanonicalLayout()` correctly flags a structurally-empty resolved layout as fatal (`missing_content`) — a check the *old* code never performed. Pre-Phase-4a, a fully content-free `docling_raw` (e.g. `{ full_text: "", pages: [], text_blocks: [], tables: [] }`) synthesized a single empty page and reported `indexSource: "canonical_layout"` with `fullText: ""` — a silent, hollow "successful" index. The adoption contract explicitly prohibits exactly this. The new code now correctly falls back to `legacy_evidence_index` for this input, with `missing_content` visible in `fallbackReason` for diagnostics. The one pre-existing test asserting the old behavior was updated, with the reasoning explained inline in the test itself.

### Pre-existing, unrelated bug found and explicitly not fixed
`_shared/extraction/evidence-index.ts`'s `buildEvidenceIndex()` unconditionally calls `_indexCache.set(doclingRaw, index)` (a `WeakMap`), which throws `TypeError: Invalid value used as weak map key` if `doclingRaw` is a truthy primitive (e.g. a bare string) rather than an object. Reachable via the `legacy_evidence_index` fallback path, identically before and after this phase, since that function is untouched. Out of Phase 4a's explicit scope; flagged for future attention, not fixed.

### Files changed
Modified: `_shared/extraction/vertex-fact-ledger/document-index-v3.ts`; `_tests/document-intelligence-v3-document-index.test.ts` (one test's expectation corrected, per the finding above). Created: `_tests/document-index-v3-resolver-adoption.test.ts` (12 tests); `docs/azure-vertex-migration-phase4a-document-index-resolver-adoption.md`. No other file touched, confirmed by `git diff --stat`.

### Tests and results

| Command | Result |
|---|---|
| `deno test document-intelligence-v3-document-index.test.ts` | ✅ 13/13 (1 corrected) |
| `deno test document-index-v3-resolver-adoption.test.ts` (new) | ✅ 12/12 |
| Combined pure-function regression | ✅ 112/112 |
| `deno test vertex-fact-ledger.test.ts` (indirect consumer, mocked Vertex) | ✅ 13/13 |
| npm gates | ✅ all clean, vitest 657/657 |
| `git diff --check` | ✅ clean |

### Risks
- The `missing_content` behavior change makes this consumer stricter than before for a specific degenerate input — intentional and required, but a genuine (narrow) behavior change, flagged rather than treated as pure equivalence.
- The pre-existing `evidence-index.ts` WeakMap bug (above).
- `ResolveDocumentIndexOptions.context` can no longer reach the resolver-based canonical path (the resolver's `doclingRaw` input has no generic context passthrough) — confirmed zero real impact, since no current caller (runtime or test) ever set it.

### Recommendation
No Gate. First consumer migration, equivalence proven empirically, both findings transparently documented.

---

## 9. Phase 4b — side-write Resolver Adoption

**Commit**: `23ba755` · **Scope**: adopt the resolver in `side-write.ts` only — the second real consumer migration.

### What it did
`side-write.ts`'s `computeCanonicalLayoutAndSummary()` — a small, deliberately isolated, **always-non-throwing** helper whose output (`layout_summary`, `content_hash`) is diagnostic/idempotency input only, never load-bearing — now obtains its layout via the resolver. This consumer has a **structurally different design** from Phase 4a: there is no alternate "index" to fall back to, so the correct adoption pattern was to route a null layout or fatal validation into the *exact same, pre-existing* degrade-in-place mechanism, not to introduce new fallback logic:

```ts
const resolution = await resolveCanonicalDocumentLayout({ doclingRaw });
if (!resolution.layout) {
  throw new Error(`layout resolution returned no layout (source: ${resolution.source})`);
}
if (resolution.validation && !resolution.validation.valid) {
  const fatalCodes = resolution.validation.errors.map((e) => e.code).join(", ") || "unspecified";
  throw new Error(`layout failed validation (fatal: ${fatalCodes})`);
}
return { summary: summarizeCanonicalLayout(resolution.layout), contentHash: resolution.layout.content_hash };
// (existing catch below, unchanged) → { summary: { warnings: [...] }, contentHash: null }
```

### Equivalence proof, at two levels
- **Pure-function**: for base-lease-scale, assignment-scale, and CAM-table-heavy-scale fixtures, `resolveCanonicalDocumentLayout({ doclingRaw }) + summarizeCanonicalLayout()` produces output deep-equal to `legacyDoclingToCanonicalLayout(doclingRaw, {}) + summarizeCanonicalLayout()` called directly.
- **DB-backed, against a real local Postgres instance**: the same three fixtures, run through the actual `runDocumentIntelligenceV3SideWrite()`, produce a `document_intelligence_runs.layout_summary` and `idempotency_key` (containing `content_hash:<hash>`) identical to the independently-computed expectation.

**Verified, not assumed**: `content_hash` and `summarizeCanonicalLayout()`'s output depend only on the layout's `text_projection`/`pages`/`page_count`/`layout_provider`/`layout_api_version`/`metadata` fields — none of which are affected by whether `{ uploadedFileId, orgId }` context is passed (the resolver's `doclingRaw` path always calls the legacy builder with `{}`, the same gap already documented in Phase 4a). This was confirmed by direct inspection of both functions' field usage before writing any test.

### Contrast with Phase 4a
Unlike Phase 4a, **no existing test needed a behavior-change correction** — all 16 pre-existing tests in `document-intelligence-v3-side-write.property.test.ts` passed unmodified, both before and after the code change. This was verified empirically (a baseline run before touching any code, then re-run after), not assumed — the file's one docling_raw-bearing fixture (`azureLikeDoclingRawFixture()`) is realistic and non-degenerate, so it was never at risk of the same `missing_content` divergence Phase 4a found. A new dedicated test was added proving the content-free-input case *does* still produce the same class of behavior change as Phase 4a (the run completes successfully; `layout_summary` degrades to `{ warnings: [...] }` instead of a hollow "successful" summary).

### Files changed
Modified: `_shared/extraction/document-intelligence-v3/side-write.ts`; `_tests/document-intelligence-v3-side-write.property.test.ts` (5 new tests appended, zero existing tests modified). Created: `_tests/side-write-resolver-adoption.test.ts` (11 tests); `docs/azure-vertex-migration-phase4b-side-write-resolver-adoption.md`. No other file touched.

### Tests and results

| Command | Result |
|---|---|
| `deno test side-write-resolver-adoption.test.ts` (new, pure-function) | ✅ 11/11 |
| `deno test document-intelligence-v3-side-write.property.test.ts` (DB-backed, local Postgres) | ✅ 21/21 (16 pre-existing unmodified + 5 new) |
| Combined pure-function regression | ✅ 123/123 |
| `deno test vertex-fact-ledger.test.ts` | ✅ 13/13 |
| npm gates | ✅ all clean, vitest 657/657 |
| `git diff --check` | ✅ clean |

### Risks
- Same minor `context`-passthrough gap as Phase 4a — confirmed zero effect on `content_hash`/`layout_summary`.
- The content-free-input degrade behavior is a direct carry-forward of Phase 4a's finding, not a new risk; diagnostic-only data with no other consumer per Phase 3A's inventory.

### Retry and idempotency behavior
Unchanged — the upsert-on-`(org_id, idempotency_key)` and delete-and-replace mechanics were not touched at all. A new DB-backed test proves a retry through the resolver-routed path still reuses the same `run_id` and does not duplicate `document_claims` rows.

### Recommendation
No Gate. Second consumer migration, reused the existing non-throwing design faithfully, equivalence proven at both the pure-function and real-database level.

---

## 10. Consolidated risk register

| # | Risk | First identified | Status |
|---|---|---|---|
| 1 | Lossless Azure-native path structurally unreachable in production (no raw Azure response durably stored) | Phase 2 | **Open** — architectural, not a bug; requires a separately-scoped future phase |
| 2 | `evidence-index.ts` WeakMap-key crash on non-object `doclingRaw` in the legacy fallback path | Phase 4a | **Open** — pre-existing, unrelated to this migration, explicitly out of scope for 4a/4b |
| 3 | `ResolveDocumentIndexOptions.context` / side-write's context param can no longer reach the resolver-based path | Phase 4a, confirmed again Phase 4b | **Open, but confirmed zero real impact** — no caller ever set it |
| 4 | Content-free `docling_raw` input now correctly fails fatal validation instead of producing a hollow "successful" result | Phase 4a, recurred Phase 4b | **Resolved as intended behavior** in both migrated consumers — documented, not a defect |
| 5 | Two "canonical layout" naming concepts existing in parallel | Phase 1 | **Resolved** — evolved in place, one contract only |
| 6 | Deferred import migration from the deprecated alias name | Phase 1 | **Resolved for `document-index-v3.ts` and `side-write.ts`** (Phases 4a/4b); other callers of the alias, if any remain, not yet audited in this report |
| 7 | Provider-name leaks in the shared warning vocabulary | Phase 3A | **Resolved** — 3 codes renamed in Phase 3B, two-way drift guard added |

## 11. Consolidated roadmap — proposed, none started, each requires separate approval

| Next unit | Proposal | Expected outcome |
|---|---|---|
| Phase 4c | Review evidence-enrichment paths (`fact-mapper.ts`, `enrichFactWithBlockEvidence`) | Likely "not applicable" — per Phase 3's inventory it already reuses Phase 4a's in-memory layout rather than resolving one independently; to be confirmed, not assumed, at the start of that phase |
| Phase 4d | Diagnostics/readiness | Likely "not applicable" — it reads only durable claim/evidence tables, never a layout, today |
| Phase 4e | Normalize pipeline | Not started — highest blast radius of all five inventoried consumers, requires controlled end-to-end verification before any change |
| Legacy retirement | Entry freeze → compatibility-only → removal-eligible (Phase 3A's exit conditions) | Not started — both migrated consumers still explicitly accept `legacy_lossy` fidelity from the legacy builder |
| Lossless path reachability | A future, separately-scoped phase would need to pass a raw Azure `analyzeResult` through (transiently or durably) before `fidelity: "lossless"` becomes reachable from any real consumer | Not proposed or scheduled by any phase to date |

## 12. Consolidated test totals

| Suite | Count |
|---|---|
| Combined pure-function Deno regression (adapter + contract + document-index + resolver-adoption + resolver + vocabulary + side-write-resolver-adoption) | 123/123 |
| DB-backed side-write suite (local Postgres) | 21/21 |
| `vertex-fact-ledger.test.ts` (indirect consumer, mocked Vertex) | 13/13 |
| Frontend `npm run test` (vitest) | 657/657 — unchanged across all 7 phases |

## 13. What was never touched, across all seven phases

Parser routing (`EXTRACTION_PROVIDER`); `normalize-pdf-output`'s orchestration; `lease-extraction-worker`; any Lease Review file; `docling_raw`'s shape or name; `normalized_output`/`ui_review_payload`/`parsed_data` contracts; any database migration or schema; any provider flag's meaning (`BUSINESS_EXTRACTION_PROVIDER`, `ENABLE_DOCUMENT_INTELLIGENCE_V3`); approval-gating behavior; any production deploy; any live Azure or Vertex call outside pre-existing mocked test paths; the legacy builder or its deprecated alias (both fully intact and in active use).

## 14. Overall recommendation

**No Gate**, consistently, across all seven phases. The migration has proceeded in small, independently-verified, independently-approved units, each proving equivalence to the prior behavior before switching (not after), each transparently documenting every finding — including two genuine behavior changes and one pre-existing unrelated bug — rather than treating "the tests still pass" as sufficient on its own. Two of five inventoried consumers are now on the resolver. The next proposed unit is Phase 4c, and it does not begin automatically.
