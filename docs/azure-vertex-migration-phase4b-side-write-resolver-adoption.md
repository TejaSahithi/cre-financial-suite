# Azure + Vertex Canonical Pipeline Migration — Phase 4b: side-write Resolver Adoption

Date: 2026-07-16
Branch: `feature/document-intelligence-v3`. Phase 1 `62678ec`, Phase 2 `f6c9674`, Phase 3 `2c5c544`, Phase 3A `991fed7`, Phase 3B `479b121`, Phase 4a `cb77efb`.
Scope: adopt `resolveCanonicalDocumentLayout()` in `side-write.ts` only. **No other consumer migrated. No deployment. No database/schema change. No remote reads/writes. No live Azure/Vertex call. No canonical-layout persistence. No legacy-builder removal. The unrelated `evidence-index.ts` WeakMap bug was not touched.**
Recommendation: **No Gate**

## 1. Executive summary

`document-intelligence-v3/side-write.ts` is the second consumer migrated onto the Phase 3 resolver, and the second in Phase 3A's planned order (document-index → side-write). Unlike Phase 4a's `document-index-v3.ts` (which has an alternate `legacy_evidence_index` path to fall back to), `side-write.ts`'s `computeCanonicalLayoutAndSummary()` is a small, deliberately isolated, always-non-throwing helper — `layout_summary`/`content_hash` are diagnostic/idempotency inputs only, never load-bearing. The correct adoption pattern here was to route the layout construction through the resolver while reusing the exact existing degrade-in-place mechanism, not to introduce a new fallback path. Equivalence was proven both at the pure-function level and against a real local Postgres instance: `layout_summary` and `content_hash` are byte-for-byte unchanged for three representative fixtures, and a content-free `docling_raw` now degrades honestly (via the pre-existing `{ warnings: [...] }` shape) instead of silently succeeding with a hollow summary — while the run itself still completes, exactly as the adoption contract requires.

## 2. Previous direct path

```ts
import { buildCanonicalLayoutFromAzureLikeOutput, summarizeCanonicalLayout } from "./canonical-layout.ts";
// ...
async function computeCanonicalLayoutAndSummary(uploadedFile, context) {
  const doclingRaw = uploadedFile?.docling_raw;
  if (!doclingRaw) return { summary: {}, contentHash: null };
  try {
    const layout = await buildCanonicalLayoutFromAzureLikeOutput(doclingRaw, {
      uploadedFileId: context.uploadedFileId,
      orgId: context.orgId,
    });
    return { summary: summarizeCanonicalLayout(layout), contentHash: layout.content_hash };
  } catch (error) {
    return { summary: { warnings: [`layout_summary_computation_failed: ${error?.message ?? error}`] }, contentHash: null };
  }
}
```

Any failure — missing `docling_raw` (early return, no builder call at all) or a thrown error from the builder — degraded to a safe, non-throwing result. `computeCanonicalLayoutAndSummary`'s output feeds `document_intelligence_runs.layout_summary` and the idempotency key (`content_hash:<hash>` appended only when present); the rest of `runDocumentIntelligenceV3SideWrite()` (claims, evidence, validation drops, canonical field projections, package graph, temporal supersession, the upsert/delete-and-replace mechanics) does not depend on this helper succeeding.

## 3. New resolver path

```ts
import { resolveCanonicalDocumentLayout } from "./canonical-layout-resolver.ts";
// ...
async function computeCanonicalLayoutAndSummary(uploadedFile, context) {
  const doclingRaw = uploadedFile?.docling_raw;
  if (!doclingRaw) return { summary: {}, contentHash: null };
  try {
    const resolution = await resolveCanonicalDocumentLayout({ doclingRaw });

    if (!resolution.layout) {
      throw new Error(`layout resolution returned no layout (source: ${resolution.source})`);
    }
    if (resolution.validation && !resolution.validation.valid) {
      const fatalCodes = resolution.validation.errors.map((e) => e.code).join(", ") || "unspecified";
      throw new Error(`layout failed validation (fatal: ${fatalCodes})`);
    }

    return { summary: summarizeCanonicalLayout(resolution.layout), contentHash: resolution.layout.content_hash };
  } catch (error) {
    return { summary: { warnings: [`layout_summary_computation_failed: ${error?.message ?? error}`] }, contentHash: null };
  }
}
```

The existing catch block, message prefix, and non-throwing return shape are byte-for-byte unchanged — a null layout and a fatally-invalid layout both now explicitly `throw` into that same, already-battle-tested degrade path, exactly mirroring how Phase 4a reused its own existing catch/fallback rather than inventing a new one. No direct import of `buildCanonicalLayoutFromAzureLikeOutput`, `legacyDoclingToCanonicalLayout`, or the Azure adapter remains anywhere in `side-write.ts` — confirmed by grep (only the module's own doc comment mentions the old names, describing what was removed) and by a dedicated test asserting the file's import statements.

## 4. Adoption contract

- **Expected source**: `legacy_docling_raw` — this consumer's current input is always `docling_raw` (Phase 2's durable-input finding).
- **Accepted fidelity**: `legacy_lossy` — accepted implicitly by proceeding whenever a layout is present and valid; not treated as a degradation.
- **Null behavior**: `resolution.layout == null` now explicitly throws into the existing catch, which has always degraded to `{ summary: { warnings: [...] }, contentHash: null }` — never a misleading successful `layout_summary`.
- **Fatal validation**: `resolution.validation.valid === false` explicitly throws into the same existing catch, with the fatal error codes folded into the degrade message, before any content_hash or summary based on that layout is used. The rest of the side-write (claims, evidence, etc.) is completely unaffected — it never depended on this succeeding.
- **Warnings**: never read for control flow anywhere in `side-write.ts` — confirmed by a source-scan test (mirroring Phase 4a's).
- **Rollback**: reverting this one commit restores the direct legacy-builder path exactly; no other file depends on the new code.

## 5. Null and fatal-validation behavior

Both cases route through the exact same, pre-existing, already-tested degrade-in-place mechanism — there was no alternate "index" to fall back to here (unlike Phase 4a), so the correct design was to make the resolver's failure modes indistinguishable, from the rest of the function's perspective, from any other layout-computation failure that already degraded gracefully. Verified directly: a missing `docling_raw` resolves to `source: "none"` / `layout: null` (though `side-write.ts`'s own early-return guard means this specific resolver call never actually happens in production for a truly absent `docling_raw`); an empty-object or content-free `docling_raw` resolves to a layout that fails `validateCanonicalLayout()`'s `missing_content` check — both proven with dedicated unit tests and a DB-backed test confirming the persisted row reflects the degraded shape, not a fabricated success.

## 6. Legacy fidelity decision

Every successful resolution in this consumer resolves `fidelity: "legacy_lossy"` — verified directly for all three fixture scales. No fidelity-based branching was added or is needed; fidelity is accepted uniformly for any successfully-validated layout.

## 7. Summary/hash equivalence

**Verified, not assumed** (Task A): `content_hash` (`sha256Hex(full_text)`) and `summarizeCanonicalLayout()`'s output depend only on the layout's `text_projection`/`pages`/`page_count`/`layout_provider`/`layout_api_version`/`metadata` fields — none of which are affected by whether `{ uploadedFileId, orgId }` context is passed (the resolver's `doclingRaw` path always calls the legacy builder with `{}`, the same gap already documented in Phase 4a's report for `document-index-v3.ts`). This was proven at two levels:
- **Pure-function**: for base-lease-scale, assignment-scale, and CAM-table-heavy-scale fixtures, `resolveCanonicalDocumentLayout({ doclingRaw }) + summarizeCanonicalLayout()` produces output deep-equal to `legacyDoclingToCanonicalLayout(doclingRaw, {}) + summarizeCanonicalLayout()` called directly.
- **DB-backed**: the same three fixtures, run through the real `runDocumentIntelligenceV3SideWrite()` against a local Postgres instance, produce a `document_intelligence_runs.layout_summary` and `idempotency_key` (containing `content_hash:<hash>`) identical to the independently-computed expectation.

## 8. Local DB regression

Extended `document-intelligence-v3-side-write.property.test.ts` (local Supabase at `127.0.0.1:54321`, confirmed reachable before starting) with 5 new tests: 3 equivalence tests (one per fixture scale) plus the content-free-input degrade test plus the retry/idempotency test (§9). All 16 pre-existing tests in this file continued to pass **unmodified** — unlike Phase 4a, no existing test needed a behavior-change correction, because the file's one docling_raw-bearing fixture (`azureLikeDoclingRawFixture()`) is realistic and non-degenerate, so it was never at risk of the `missing_content` divergence Phase 4a found. This was verified empirically (baseline run before any code change, then re-run after) rather than assumed. No remote database access anywhere.

## 9. Retry and idempotency behavior

Unchanged — the upsert-on-`(org_id, idempotency_key)` and delete-and-replace mechanics were not touched at all. A new DB-backed test proves a retry through the resolver-routed path still reuses the same `run_id` and does not duplicate `document_claims` rows, exactly matching the pre-existing retry test's assertions for the pre-Phase-4b path.

## 10. Files changed

Modified: `supabase/functions/_shared/extraction/document-intelligence-v3/side-write.ts` (import swap + `computeCanonicalLayoutAndSummary()`'s try block + doc comments), `supabase/functions/_tests/document-intelligence-v3-side-write.property.test.ts` (5 new tests appended; zero existing tests modified).

Created: `supabase/functions/_tests/side-write-resolver-adoption.test.ts` (11 tests), `docs/azure-vertex-migration-phase4b-side-write-resolver-adoption.md` (this file).

No other file touched — confirmed by `git diff --stat` (2 files modified, exactly matching the two above) and `git status` (exactly the two new files above).

## 11. Tests and results

| Command | Result |
| --- | --- |
| `deno check` (side-write.ts + both test files) | ✅ clean |
| `deno test side-write-resolver-adoption.test.ts` (new, pure-function) | ✅ 11/11 |
| `deno test document-intelligence-v3-side-write.property.test.ts` (DB-backed, local Postgres) | ✅ 21/21 (16 pre-existing unmodified + 5 new) |
| `deno test` (adapter + contract + document-index + resolver-adoption ×2 + resolver + vocabulary, combined pure-function) | ✅ 123/123 |
| `deno test vertex-fact-ledger.test.ts` (indirect consumer, mocked Vertex) | ✅ 13/13 |
| `npm run lint` | ✅ clean |
| `npm run typecheck` | ✅ clean |
| `npm run test` (vitest) | ✅ 657/657 |
| `npm run build` | ✅ succeeds (pre-existing chunk-size warning only) |
| `git diff --check` | ✅ clean |
| Secret scan of changed/new files | ✅ none found |
| grep for `buildCanonicalLayoutFromAzureLikeOutput`/`legacyDoclingToCanonicalLayout`/adapter import in `side-write.ts` | ✅ zero functional references (only doc-comment prose) |

Task C's edge-case list, each with a dedicated test: valid fixtures ×3 (equivalence), missing `doclingRaw`, malformed `doclingRaw` (empty object), content-free `doclingRaw`, resolver returns null, fatal validation, `legacy_lossy` accepted, warnings-never-affect-persistence, deterministic repeated output, no input mutation.

## 12. Risks

- Same known, minor API-surface gap as Phase 4a: the resolver's `doclingRaw` path has no generic context passthrough, so `layout.document_id`/`uploaded_file_id`/`org_id` are no longer populated on the resolved layout in this path. Confirmed to have zero effect on `content_hash` or `layout_summary` (§7) — no downstream consumer in `side-write.ts` reads those three fields from the layout.
- The content-free-input degrade behavior (§5) is a direct carry-forward of Phase 4a's finding, not a new risk — but it does mean a `docling_raw` row that previously produced an empty-but-"successful"-looking `layout_summary` (if such a row exists in any historical data, which is unlikely given the same fixture realism argument in §8) will now show a `{ warnings: [...] }` shape instead. This is diagnostic-only data with no other consumer, per Phase 3A's inventory, so no other system is affected.

## 13. Rollback

Revert the one commit containing this phase's changes. No other file imports anything new from this change, so rollback is a single, clean `git revert` with no downstream cleanup required.

## 14. Explicitly out of scope (confirmed unchanged)

`document-index-v3.ts`, `fact-mapper.ts`, `evidence-index.ts` (including its known, pre-existing, unrelated WeakMap bug — explicitly not touched, per this phase's hard constraint), `document-intelligence-v3-readiness`, `normalize-pdf-output`, the parser, the worker, Lease Review, database migrations, and provider configuration/flags — none touched, confirmed by `git diff --stat`. No deployment. No database/schema change. No remote reads or writes beyond the existing local-only Supabase test methodology. No live Azure or Vertex call. No persistence of canonical layout. No removal of the legacy builder or its deprecated alias (both fully intact, used elsewhere).

## 15. Phase 4c recommendation (not started)

Per Phase 3A's roadmap and Phase 4a's inventory: Phase 4c should **review** evidence-enrichment paths (`fact-mapper.ts`, `enrichFactWithBlockEvidence`) and migrate only if that code independently resolves a layout rather than reusing one already resolved by `document-index-v3.ts` in the same run. Based on Phase 3's original consumer inventory, evidence enrichment currently consumes the in-memory layout `document-index-v3.ts` already built — meaning Phase 4c is likely to conclude "not applicable, inherits Phase 4a" rather than requiring a code change. This should be confirmed, not assumed, at the start of that phase. Not started here.

## 16. Recommendation: No Gate

Phase 4b adopts the resolver in exactly one consumer, reuses its existing non-throwing degrade-in-place design faithfully rather than inventing new fallback logic, and proves equivalence at both the pure-function and real-database level. Stop here — Phase 4c does not begin automatically.
