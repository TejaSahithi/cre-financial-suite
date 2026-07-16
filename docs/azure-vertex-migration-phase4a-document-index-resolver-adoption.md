# Azure + Vertex Canonical Pipeline Migration — Phase 4a: document-index-v3 Resolver Adoption

Date: 2026-07-16
Branch: `feature/document-intelligence-v3`. Phase 1 `62678ec`, Phase 2 `f6c9674`, Phase 3 `2c5c544`, Phase 3A `991fed7`, Phase 3B `479b121`.
Scope: adopt `resolveCanonicalDocumentLayout()` in `document-index-v3.ts` only. **No other consumer migrated. No deployment. No database/schema change. No live Azure/Vertex call. No persistence of canonical layout.**
Recommendation: **No Gate**

## 1. Executive summary

`vertex-fact-ledger/document-index-v3.ts` is the first (and, per Phase 4a's explicit scope, only) consumer migrated onto the Phase 3 resolver. `resolveDocumentIndex()` now calls `resolveCanonicalDocumentLayout({ doclingRaw })` instead of importing and calling `buildCanonicalLayoutFromAzureLikeOutput()` directly. Equivalence was proven, not assumed: three representative `docling_raw` fixtures produce a whole-object deep-equal `CanonicalLayoutDocumentIndex` between the old direct-builder path and the new resolver path. One intentional, fully-documented behavior change resulted from correctly implementing the adoption contract's "never return a silent empty-but-successful document index" requirement — see §6. A pre-existing, unrelated bug was found (not fixed, out of scope) in the shared legacy fallback module — see §11.

## 2. Previous direct path

```ts
import { buildCanonicalLayoutFromAzureLikeOutput, type CanonicalDocumentLayout, type BuildCanonicalLayoutContext } from "../document-intelligence-v3/canonical-layout.ts";
// ...
const layout = await buildCanonicalLayoutFromAzureLikeOutput(doclingRaw, options.context ?? {});
if (layout.pages.length === 0 && !layout.text_projection) {
  throw new Error("canonical layout has no pages and no text_projection");
}
return { index: buildCanonicalDocumentIndexFromLayout(layout), indexSource: "canonical_layout", fallbackReason: null };
```

Any thrown error (the explicit degenerate-layout check, or a genuine build failure such as a `crypto.subtle` failure) was caught, logged via `console.warn`, and fell back to `buildCanonicalDocumentIndex(doclingRaw)` (the pre-existing `legacy_evidence_index` path) with `fallbackReason: "canonical_layout_failed: <message>"`.

The only real runtime caller is `orchestrator.ts:94`, which calls `resolveDocumentIndex(doclingRaw)` with no `options` — confirmed by grep before making any change. No test passed an explicit `options.context` either. `options.context` (`BuildCanonicalLayoutContext`) was therefore already dead in practice.

## 3. New resolver path

```ts
import { resolveCanonicalDocumentLayout } from "../document-intelligence-v3/canonical-layout-resolver.ts";
// ...
const resolution = await resolveCanonicalDocumentLayout({ doclingRaw });

if (!resolution.layout) {
  throw new Error(`canonical layout resolution returned no layout (source: ${resolution.source})`);
}
if (resolution.validation && !resolution.validation.valid) {
  const fatalCodes = resolution.validation.errors.map((e) => e.code).join(", ") || "unspecified";
  throw new Error(`canonical layout failed validation (fatal: ${fatalCodes})`);
}

const layout = resolution.layout;
if (layout.pages.length === 0 && !layout.text_projection) {
  throw new Error("canonical layout has no pages and no text_projection");
}

return { index: buildCanonicalDocumentIndexFromLayout(layout), indexSource: "canonical_layout", fallbackReason: null };
```

The surrounding `try`/`catch`/fallback/log shape is byte-for-byte unchanged from before — only what triggers the `throw` changed, so the existing, already-tested fallback mechanism (same `console.warn` message format, same `fallbackReason` prefix) is reused rather than reimplemented. No direct import of `buildCanonicalLayoutFromAzureLikeOutput`, `legacyDoclingToCanonicalLayout`, or the Azure adapter remains anywhere in this file — confirmed by grep (the only remaining textual mentions are in the module's own doc comment, describing what was removed).

`buildCanonicalDocumentIndexFromLayout()` and `enrichFactWithBlockEvidence()` are both unchanged — they already operated purely on a `CanonicalDocumentLayout` object regardless of how it was constructed, so neither needed to know the resolver exists.

## 4. Adoption contract

- **Expected source**: `legacy_docling_raw` — this consumer's current input is always `docling_raw` (Phase 2's durable-input finding), so `resolveCanonicalDocumentLayout({ doclingRaw })` only ever exercises the resolver's `doclingRaw`-only path.
- **Accepted fidelity**: `legacy_lossy` — explicitly accepted, not treated as a degradation. The resolver's `lossless` Azure-native fidelity is supported by its contract but is unreachable from this consumer's current input (no raw `analyzeResult` is ever passed in), consistent with Phase 3A's architectural observation.
- **Null behavior**: `resolution.layout == null` (e.g. no `doclingRaw` at all, so all three resolver inputs are absent and `source: "none"`) explicitly triggers the existing fallback — never a silent empty-but-successful index.
- **Fatal validation behavior**: `resolution.validation.valid === false` explicitly triggers the existing fallback, with the fatal error codes folded into the `fallbackReason` string for diagnostics, before any index is built from that layout.
- **Rollback**: reverting this one commit restores the direct legacy-builder path exactly (no other file depends on the new code).

## 5. Null handling

`resolveCanonicalDocumentLayout({ doclingRaw: null })` or `{ doclingRaw: undefined })` resolves to `source: "none"`, `layout: null` (per Phase 3's contract — never throws for ordinary missing input). `resolveDocumentIndex()` now explicitly checks `if (!resolution.layout)` and throws into its own existing catch block, producing the same `legacy_evidence_index` fallback with a diagnostic `fallbackReason` naming the resolved `source` (`"none"`). Verified for both `null` and `undefined` inputs, and for a structurally empty object `{}` input.

## 6. Fatal validation handling

`validateCanonicalLayout()` (Phase 1) correctly flags a structurally-empty resolved layout (a document with zero real content) as fatal (`missing_content`) — a check the *old* code never performed. **This surfaces one intentional, documented behavior change**: pre-Phase-4a, a fully content-free `docling_raw` (e.g. `{ full_text: "", pages: [], text_blocks: [], tables: [] }`) synthesized a single empty page and reported `indexSource: "canonical_layout"` with `fullText: ""` — a silent, hollow "successful" index. Phase 4a's adoption contract explicitly prohibits exactly this ("never return a silent empty-but-successful document index"), so the new code now correctly falls back to `legacy_evidence_index` for this input, with `missing_content` visible in `fallbackReason` for diagnostics. The pre-existing test asserting the old behavior (`document-intelligence-v3-document-index.test.ts`) was updated to assert the new, correct behavior, with the change explained inline.

## 7. Fidelity decision

Every successful resolution in this consumer resolves `fidelity: "legacy_lossy"` — verified directly (an explicit test) and indirectly (every other passing test exercises the same `doclingRaw`-only call pattern). No fidelity-based branching was added; fidelity is accepted uniformly for any successfully-validated layout, consistent with "accept `legacy_lossy` for current behavior" rather than treating it as second-class.

## 8. Equivalence results

Three representative fixtures (two-page lease, CAM-heavy with a table, single-page assignment-scale) were run through both the old path (`legacyDoclingToCanonicalLayout()` + `buildCanonicalDocumentIndexFromLayout()` called directly, replicating pre-Phase-4a code exactly) and the new path (`resolveDocumentIndex(doclingRaw, { strategy: "canonical_layout" })`). For each fixture, `assertEquals` was run field-by-field (`fullText`, `pageCount`, `blockIds`, projected `text_blocks` ordering, projected `tables`, table/figure/signature placeholders, `headTailExcerpt`, `content_hash`, `evidenceIndex`) **and** as a single whole-object deep-equal on the entire returned index — all passed for all three fixtures, with zero divergence. `content_hash` equivalence is structural, not coincidental: both paths ultimately call the same `legacyDoclingToCanonicalLayout()` function with the same arguments internally.

## 9. Files changed

Modified: `supabase/functions/_shared/extraction/vertex-fact-ledger/document-index-v3.ts` (import swap + `resolveDocumentIndex()` body + doc comments), `supabase/functions/_tests/document-intelligence-v3-document-index.test.ts` (one test's expectation corrected to the new, documented behavior — see §6).

Created: `supabase/functions/_tests/document-index-v3-resolver-adoption.test.ts` (12 tests), `docs/azure-vertex-migration-phase4a-document-index-resolver-adoption.md` (this file).

No other file touched — confirmed by `git diff --stat` (2 files modified, exactly matching the two above) and `git status` (exactly the two new files above, nothing else).

## 10. Tests and results

| Command | Result |
| --- | --- |
| `deno check` (document-index-v3.ts + both test files) | ✅ clean |
| `deno test document-intelligence-v3-document-index.test.ts` | ✅ 13/13 (1 test's expectation updated, see §6) |
| `deno test document-index-v3-resolver-adoption.test.ts` (new) | ✅ 12/12 |
| `deno test` (adapter + contract + document-index + resolver-adoption + resolver + vocabulary, combined) | ✅ 112/112 |
| `deno test vertex-fact-ledger.test.ts` (indirect consumer via `orchestrator.ts`, mocked Vertex) | ✅ 13/13, including the `ENABLE_DOCUMENT_INTELLIGENCE_V3=true` canonical_layout path exercising this exact change end-to-end |
| `npm run lint` | ✅ clean |
| `npm run typecheck` | ✅ clean |
| `npm run test` (vitest) | ✅ 657/657 |
| `npm run build` | ✅ succeeds (pre-existing chunk-size warning only) |
| `git diff --check` | ✅ clean |
| Secret scan of changed/new files | ✅ none found |
| grep for `buildCanonicalLayoutFromAzureLikeOutput`/`legacyDoclingToCanonicalLayout`/adapter import in `document-index-v3.ts` | ✅ zero functional references (only doc-comment prose) |

Task C's edge-case list, each with a dedicated test: valid `docling_raw` (3 fixtures, equivalence), missing `doclingRaw` (null + undefined), malformed `doclingRaw` (empty object — see §11 for why not a bare primitive), resolver returns null, fatal validation, unsupported schema version (explicitly marked not-applicable/not-reachable from this consumer's call pattern, with a test asserting why), `legacy_lossy` fidelity accepted, warnings-never-drive-control-flow (source-scan assertion), deterministic repeated output, no input mutation.

## 11. Risks

- **The `missing_content` behavior change (§6)** makes this consumer stricter than before for a specific degenerate input (fully empty `docling_raw`). This is intentional and required by the adoption contract, but is a genuine, if narrow, behavior change worth flagging explicitly rather than treating as pure equivalence.
- **Pre-existing, unrelated bug found in `_shared/extraction/evidence-index.ts`**: `buildEvidenceIndex()` unconditionally calls `_indexCache.set(doclingRaw, index)` (a `WeakMap`), which throws `TypeError: Invalid value used as weak map key` if `doclingRaw` is a truthy primitive (e.g. a bare string) rather than an object. This is reachable via the `legacy_evidence_index` fallback path — identically before and after this phase, since that function is untouched. **Not fixed** — out of Phase 4a's explicit scope (`document-index-v3.ts` and its tests only). Noted here for future attention.
- `options.context` on `ResolveDocumentIndexOptions` is now structurally unable to reach the resolver-based canonical path (the Phase 3 resolver's `doclingRaw` input has no generic context passthrough). Confirmed zero real impact — no current caller (runtime or test) ever set it — but flagged as a known, minor API-surface gap should a future caller want to set `documentId`/`uploadedFileId`/`orgId` context on this path.

## 12. Rollback

Revert the one commit containing this phase's changes. No other file imports anything new from this change, so rollback is a single, clean `git revert` with no downstream cleanup required.

## 13. Explicitly out of scope (confirmed unchanged)

`side-write.ts`, `fact-mapper.ts`, `document-intelligence-v3-readiness`, `normalize-pdf-output`, the parser, the worker, Lease Review, database migrations, and provider configuration/flags — none touched, confirmed by `git diff --stat`. No deployment. No database/schema change. No remote reads or writes. No live Azure or Vertex call. No persistence of canonical layout. No removal of the legacy builder or its deprecated alias (`legacyDoclingToCanonicalLayout`/`buildCanonicalLayoutFromAzureLikeOutput` are both still fully intact and used elsewhere, e.g. `side-write.ts`, untouched by this phase).

## 14. Phase 4b proposal (not started)

Per Phase 3A's roadmap: Phase 4b adopts the resolver in `side-write.ts` only, following the same discipline — characterize current behavior, adopt, prove equivalence for `layout_summary`/`content_hash` (already regression-tested in Phase 1/2 against the legacy builder directly), handle null/fatal-validation explicitly, document, verify, stop. Not started in this phase.

## 15. Recommendation: No Gate

Phase 4a adopts the resolver in exactly one consumer, proves equivalence empirically (not assumed), and transparently documents the one intentional behavior change and one pre-existing unrelated bug it surfaced. Stop here — Phase 4b does not begin automatically.
