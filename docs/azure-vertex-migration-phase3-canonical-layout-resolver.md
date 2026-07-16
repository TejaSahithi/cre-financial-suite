# Azure + Vertex Canonical Pipeline Migration — Phase 3: Canonical Layout Resolver

Date: 2026-07-16
Branch: `feature/document-intelligence-v3`. Phase 1 committed as `62678ec`, Phase 2 as `f6c9674`.
Scope: introduce the resolver and its tests only. **No runtime consumer migrated. No deployment. No database migration or schema change. No live Azure/Vertex call.**
Recommendation: **No Gate**

## 1. Executive summary

Phase 3 adds `resolveCanonicalDocumentLayout()` — a single, provider-neutral entry point for obtaining a `CanonicalDocumentLayout` from whichever inputs a caller has (an already-resolved layout, a raw Azure `analyzeResult`, or a legacy `docling_raw` object), with explicit source/fidelity reporting, schema-version enforcement, and conflict handling that never silently prefers a stale layout over fresher input. It is deliberately **not a first-non-null helper**: every precedence decision is explicit, every fallback is warned about, and every case where authority between two sources can't be safely established is flagged rather than guessed. The resolver is new, additive, and **unwired** — confirmed by grep, no existing file imports it. 19 focused tests cover every case in the task list; all pass, alongside zero regression in Phase 1's 73 existing Deno tests plus Phase 2's harness-adjacent suite (92 total in the combined run).

## 2. Phase 2 decision (carried forward)

Phase 2 concluded: keep `CanonicalDocumentLayout` transient, do not persist it (confidence: medium, synthetic fixtures only), and identified that current durable production input is normally the reduced `docling_raw`-compatible shape, not the full Azure `analyzeResult` (`STORE_FULL_AZURE_RAW_RESPONSE` is off by default). This directly shapes the resolver's design: it must gracefully handle "only `docling_raw` is available" as the *common* case, not an edge case, and must report that path's `legacy_lossy` fidelity honestly rather than implying parity with the lossless Azure-native path.

## 3. Resolver boundary

New file: `supabase/functions/_shared/extraction/document-intelligence-v3/canonical-layout-resolver.ts`. Imports `legacyDoclingToCanonicalLayout`, `validateCanonicalLayout`, `CANONICAL_LAYOUT_SCHEMA_VERSION`, `MINIMUM_SUPPORTED_SCHEMA_VERSION` from Phase 1's contract module, and `azureAnalyzeResultToCanonicalLayout` from Phase 1's Azure adapter. Imports nothing from any runtime consumer, and no runtime consumer imports it back — confirmed by a repo-wide grep for `canonical-layout-resolver`/`resolveCanonicalDocumentLayout` outside this file and its test.

**Purity** (Task D): pure, deterministic, no network, no `Deno.env`, no database, no global cache, no runtime memoization. Declared `async` uniformly — `legacyDoclingToCanonicalLayout` is inherently async (Web Crypto for `content_hash`), so a single consistent `Promise<CanonicalLayoutResolutionResult>` return type is used regardless of which internal path executes, rather than a conditional sync/async signature. Complexity is O(n) in the size of whichever single source ends up being converted (the resolver itself does no additional traversal beyond the O(n) adapter/validator calls Phase 1 already proved); no unnecessary deep clones — inputs are read, never copied wholesale, and the returned `layout` is the same object reference the underlying builder produced (or the caller's own `canonicalLayout` object, unmodified).

## 4. Input/result contracts

```ts
interface ResolveCanonicalDocumentLayoutInput {
  canonicalLayout?: CanonicalDocumentLayout | null;
  azureAnalyzeResult?: AzureAnalyzeResultLike | null;
  doclingRaw?: unknown;
  sourceMetadata?: {
    sourcePayloadHash?: string | null;
    generatedAt?: string | null;
    provider?: string | null;
    providerModelId?: string | null;
    providerApiVersion?: string | null;
  };
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

Implemented exactly as suggested, with one addition: `sourceMetadata.generatedAt` is compared against `canonicalLayout.metadata.generated_at` (Phase 1's existing freeform `metadata` bag on `CanonicalDocumentLayout` — no new typed field added to the contract) when hash comparison isn't possible. This keeps Phase 3 from touching `canonical-layout.ts`'s type surface at all.

## 5. Source precedence

No source supplied → `source: "none"`, `layout: null`, never throws. Exactly one source supplied → resolved directly via that source's rule (no conflict possible). Multiple sources supplied → `canonicalLayout` (if schema-compatible and structurally valid) wins over `azureAnalyzeResult` **only when provenance confirms the same generation**; `azureAnalyzeResult` always wins over `doclingRaw` when both present (no staleness concern between those two — a document's own raw response is never "worse" than its lossy derivative); a `canonicalLayout` that fails schema/structural checks falls through to `azureAnalyzeResult` then `doclingRaw` in order, with the rejection always warned about. If a rejected `canonicalLayout` is the *only* input, it is still returned — data is never discarded — with `validation.valid === false` and the warnings fully visible.

## 6. Conflict handling

`compareProvidedLayoutAgainstNewSource()` tries two signals, most reliable first:
1. **`content_hash` match**: if both `canonicalLayout.content_hash` and `sourceMetadata.sourcePayloadHash` are present, an exact match means same generation (canonical wins, no recompute); a mismatch means the newly-supplied source is a different generation — **the stale canonical layout is never silently preferred**; the Azure result wins with a `canonical_layout_superseded_by_newer_azure_result` warning.
2. **`generated_at` comparison**: when hash comparison isn't possible, `canonicalLayout.metadata.generated_at` vs. `sourceMetadata.generatedAt` are parsed and compared; the newly-supplied source being demonstrably newer triggers the same supersession path.
3. **Undetermined**: if neither signal is comparable, the resolver does **not guess** — it still returns a usable result (the Azure result, as the safer freshly-supplied default) but attaches a loud `canonical_azure_authority_undetermined` warning so the ambiguity is visible to the caller rather than silently resolved.

## 7. Schema-version handling

| `schema_version` | Classification | Resolver behavior |
| --- | --- | --- |
| `=== CANONICAL_LAYOUT_SCHEMA_VERSION` | `current` | Accepted, no schema warning |
| `MINIMUM_SUPPORTED_SCHEMA_VERSION <= v < CANONICAL_LAYOUT_SCHEMA_VERSION` | `older_supported` | Accepted, no schema warning |
| `null`/`undefined` | `missing` | Accepted, but **fidelity forced to `"unknown"`** regardless of the layout's own `provider` field, plus a `canonical_layout_schema_version_missing` recoverable warning — this is the one deliberate override of `validateCanonicalLayout()`'s own fatal `missing_schema_version` check, scoped narrowly (every *other* fatal error still blocks usability exactly as the validator reports it) |
| `< MINIMUM_SUPPORTED_SCHEMA_VERSION` | `too_old` | **Not accepted as authoritative** — fatal `canonical_layout_schema_version_too_old` warning, falls back to the next source |
| `> CANONICAL_LAYOUT_SCHEMA_VERSION` | `too_new` | **Not accepted as authoritative** — fatal `canonical_layout_schema_version_too_new` warning, falls back to the next source |

## 8. Provenance and fidelity

`fidelity` is never assumed — it's derived from the actual source: `"lossless"` only for a fresh Azure-native conversion or a provided layout whose own `provider === "azure_document_intelligence"` (and a known-current-or-older schema version); `"legacy_lossy"` for the docling_raw path or a provided layout with `provider === "legacy_docling_compatibility"`; `"unknown"` for anything else, including every schema-version-missing historical layout regardless of what its `provider` field claims. `provenance` surfaces `provider`/`providerModelId`/`providerApiVersion` (from the winning layout itself, falling back to caller-supplied `sourceMetadata`) plus whatever `sourcePayloadHash`/`generatedAt` the caller supplied — never fabricated.

## 9. Validation behavior

Every returned result carries the **real** `validateCanonicalLayout()` output for whichever layout won — including a `validation.valid === false` result with its actual fatal errors when that's genuinely the case (e.g. the schema-version-missing test still shows the raw validator's fatal `missing_schema_version` finding in `validation.errors`, even though the resolver's own policy layer accepted the layout at `source`/`fidelity` level). The resolver's own decisions (fallback taken, conflict detected) are layered on top as `warnings`, never by silently rewriting `validation` itself. **Never throws** for missing-input or unresolvable-authority cases — always returns a `CanonicalLayoutResolutionResult`.

## 10. Consumer migration inventory (Task F — documented, not implemented)

Recommended adoption order, building on Phase 2's evidence-linked consumer inventory:

| Order | Consumer | Current input | Resolver input it would provide | Expected source/fidelity | Rollback path | Test required before switching |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | v3 document indexing (`vertex-fact-ledger/document-index-v3.ts#resolveDocumentIndex`) | `docling_raw` via `buildCanonicalLayoutFromAzureLikeOutput` | `{ doclingRaw }` (Azure raw response not durably available in the common case, per Phase 2 §2) | `legacy_docling_raw` / `legacy_lossy` | Revert the one call site back to the direct `buildCanonicalLayoutFromAzureLikeOutput` import (still available as the Phase 1 deprecated alias) | A behavioral-parity test proving `resolveCanonicalDocumentLayout({ doclingRaw }).layout` is deep-equal to today's `buildCanonicalLayoutFromAzureLikeOutput(doclingRaw)` output for the same fixture |
| 2 | v3 side-write (`document-intelligence-v3/side-write.ts#computeCanonicalLayoutAndSummary`) | `docling_raw` via the same builder, rebuilt on every call including retries | `{ doclingRaw }` | `legacy_docling_raw` / `legacy_lossy` | Same as #1 — the alias remains available indefinitely | Same parity test as #1, plus confirmation the idempotency-key `content_hash` input is unchanged (Phase 1/2 already regression-test this exact value) |
| 3 | Evidence-enrichment paths (`fact-mapper.ts`, `document-index-v3.ts#enrichFactWithBlockEvidence`) | The in-memory layout already built by #1 in the same run | No separate resolver call needed — these consume #1's already-resolved layout in-memory, not a fresh input | N/A (inherits #1's source/fidelity) | N/A — migrating #1 alone migrates this transitively | Covered by #1's own tests; no additional test needed here specifically |
| 4 | Diagnostics/readiness (`document-intelligence-v3-readiness`) — **only if needed** | Durable claim/evidence tables only, never `docling_raw` (Phase 2 §2 #4) | Not applicable today — this consumer doesn't build a layout at all; only migrate if a future need arises for it to read one | N/A | N/A | Only relevant if/when this consumer's scope changes |
| 5 | Normalize pipeline (`normalize-pdf-output/index.ts`) — **only after controlled verification** | `docling_raw`, read at most once per request, no layout built here today | `{ doclingRaw }`, if this consumer is ever changed to build one | `legacy_docling_raw` / `legacy_lossy` | Revert to not building a layout here at all (today's behavior) | Full integration test against a controlled upload, given this is the highest-blast-radius consumer in the pipeline |

Lease Review is intentionally absent from this table: Phase 2 confirmed there is no current frontend consumer of layout/geometry data anywhere in `src/`, so there is nothing to migrate.

**None of the above is implemented in Phase 3.** This is a plan for a future phase's approval, not a commitment made now.

## 11. Files changed

Created: `supabase/functions/_shared/extraction/document-intelligence-v3/canonical-layout-resolver.ts`, `supabase/functions/_tests/canonical-layout-resolver.test.ts`, `docs/azure-vertex-migration-phase3-canonical-layout-resolver.md` (this file).

No existing file is modified in Phase 3.

## 12. Tests and results

19 new focused tests in `canonical-layout-resolver.test.ts`, covering every case in the task list: provided valid canonical layout (both lossless and legacy_lossy provenance), Azure analyzeResult conversion, legacy docling_raw conversion, no source supplied, invalid canonical layout (with and without a fallback source available), unsupported old schema, unsupported future schema, missing historical schema version, current-schema-version no-warning case, canonical+Azure same-source agreement, canonical+Azure conflicting hashes, canonical older than Azure via `generated_at` metadata, missing metadata where authority cannot be established, legacy/Azure fidelity explicitly reported, validation errors preserved, deterministic repeat output, no input mutation, no Azure-specific key leakage into the result.

| Command | Result |
| --- | --- |
| `deno check` (resolver + test file) | ✅ clean |
| `deno test canonical-layout-resolver.test.ts` | ✅ 19/19 |
| `deno test` (resolver + Phase 1 adapter/contract/document-index, combined run) | ✅ 92/92 |
| `deno test` `document-intelligence-v3-side-write.property.test.ts` (DB-backed regression) | ✅ 16/16 |
| `npm run lint` | ✅ clean |
| `npm run typecheck` | ✅ clean |
| `npm run test` (vitest) | ✅ 657/657 |
| `npm run build` | ✅ succeeds (pre-existing chunk-size warning only) |
| `git diff --check` | ✅ clean |
| Secret scan of new files | ✅ none found |
| grep for resolver usage outside its own file/test | ✅ zero matches — confirmed unwired |

## 13. Risks

- **The `generated_at`-in-`metadata` comparison is a soft convention, not a typed contract field** — since it lives in `CanonicalDocumentLayout.metadata` (a freeform `Record<string, unknown>`), any future producer that doesn't set `metadata.generated_at` degrades that comparison path to "undetermined" (safe, but less precise) rather than failing. This was a deliberate scope-minimizing choice to avoid touching `canonical-layout.ts` in Phase 3; a future phase could promote it to a typed field if the convention proves useful.
- **"Undetermined" defaults to preferring the newly-supplied source** (Azure over a stale-unknown canonical) rather than refusing to resolve at all — this is a judgment call favoring availability over strict caution, always accompanied by a loud warning so a caller can override it. A stricter policy (returning `layout: null` on undetermined conflicts) was considered and rejected as less useful for a resolver whose whole purpose is to produce a usable layout.
- Since nothing calls this resolver yet, its real-world behavior against actual multi-source scenarios (e.g. genuinely concurrent normalize+side-write requests) is unverified beyond the synthetic test cases — this is expected and appropriate for a Phase 3 that explicitly does not migrate consumers.

## 14. Explicitly out of scope (confirmed unchanged)

No deployment. No remote reads/writes. No database migration. No database schema change. No `canonical_layout` column. No live Azure or Vertex call. No parse or extraction rerun. No parser-routing change. No `normalize-pdf-output` behavior change. No `lease-extraction-worker` change. No Lease Review change. No provider-flag change. No approval-gating change. Docling/Vision code untouched. `docling_raw` not renamed. No existing consumer changed to use the resolver — confirmed by the grep in §12.

## 15. Phase 4 proposal (not started)

Per Phase 2's decision-independent sequencing (§17 there) and this phase's consumer migration inventory (§10): Phase 4 would route consumer #1 (v3 document indexing) through the resolver first, behind the exact behavioral-parity test named in §10's table, as the lowest-blast-radius candidate (already opt-in behind `ENABLE_DOCUMENT_INTELLIGENCE_V3`, already has fallback-on-failure behavior proven in Phase 1's tests). Consumer #2 (side-write) would follow only after #1 is verified stable. Consumers #3-5 remain explicitly out of scope until #1/#2 are proven. This is a proposal for separate approval, not a commitment.

## 16. Recommendation: No Gate

Phase 3 is contract and test work only — one new, unwired module. No runtime consumer changed, no schema changed, no provider called. Stop here — Phase 4 does not begin automatically and requires separate approval per the task's explicit instruction.
