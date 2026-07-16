# Azure + Vertex Canonical Pipeline Migration — Phase 3B: Warning Vocabulary Fix

Date: 2026-07-16
Branch: `feature/document-intelligence-v3`. Phase 1 `62678ec`, Phase 2 `f6c9674`, Phase 3 `2c5c544`, Phase 3A `991fed7`.
Scope: rename 3 warning `code` strings + add one scoped guard test. **No consumer migration, no resolver adoption, no schema/deploy/provider change.**
Recommendation: **No Gate**

## Root cause

Phase 3A's audit confirmed `duplicate_azure_page_number` (adapter-emitted) bakes the provider name into what should be a provider-neutral structural concept, flowing into the shared `CanonicalWarning[]` on any Azure-sourced layout. While scoping this phase, applying Task C's own rule ("`resolver_policy` warning codes contain no provider names") against the actual resolver source surfaced two more instances not caught by Phase 3A's narrower reading: `canonical_azure_authority_undetermined` and `canonical_layout_superseded_by_newer_azure_result`. All three describe entirely provider-neutral concepts (a duplicate page number; an unresolvable-authority conflict; a stale-vs-newer-source supersession) that happened to name the one provider the resolver currently compares against. Per your decision, all three were renamed together rather than carrying a partial fix forward.

## Exact renames

| File | Old code | New code |
| --- | --- | --- |
| `_shared/extraction/azure/azure-to-canonical-layout.ts:210` | `duplicate_azure_page_number` | `duplicate_page_number` |
| `_shared/extraction/document-intelligence-v3/canonical-layout-resolver.ts:330` | `canonical_layout_superseded_by_newer_azure_result` | `canonical_layout_superseded_by_newer_source` |
| `_shared/extraction/document-intelligence-v3/canonical-layout-resolver.ts:341` (+ doc comment at :287) | `canonical_azure_authority_undetermined` | `canonical_source_authority_undetermined` |
| `_tests/canonical-layout-resolver.test.ts:223,238,253` | same two resolver codes | same new names |

Only the `code` identifier changed at each site. `message`/`severity`/`path` are unchanged — messages still describe Azure in human-readable prose where accurate, since only the machine-classifiable `code` field needs to stay provider-neutral for `canonical_structure`/`resolver_policy` scope.

**Note on `duplicate_page_number`**: this string already existed as a separate emission site inside `validateCanonicalLayout()` (fires when the *output* layout's `pages[]` has a duplicate `page_number`). After the rename, the adapter's pre-conversion duplicate-Azure-input-page check now emits the same string for the same underlying structural concept surfaced at an earlier pipeline stage. This is intentional — Task C explicitly classifies `duplicate_page_number` as `canonical_structure` regardless of which module emits it — and the two emission sites remain distinguishable by `severity` (`recoverable` from the adapter, `fatal` from the validator) and `path`.

**Precise characterization of what changed**: this is a data-contract change (three diagnostic identifier strings), not a no-op, even though nothing branches on these codes anywhere today. No extraction, validation-severity, resolution, persistence, provider, or consumer-control-flow behavior changed.

**Persistence/consumption check**: grepped `src/` (frontend) and `supabase/migrations/` for all three old code strings both before and after the rename — zero matches either time. Expected: `azureAnalyzeResultToCanonicalLayout` and the resolver remain entirely unwired (Phase 3A), so nothing has ever persisted, displayed, or filtered on these strings. No compatibility alias was needed.

## Scope-classification rule

Warning codes across the validator, adapter, and resolver are classified into exactly one scope, encoded as a hand-maintained map in the new test (per your explicit allowance — "the classification may live in test code if adding production metadata would create unnecessary runtime surface"):

- **`adapter_input`** — provider-specific names permitted (describes the Azure adapter's own input/envelope contract, e.g. `missing_analyze_result`, `table_spans_multiple_pages`).
- **`canonical_structure`** — provider names forbidden (validator-emitted structural invariants, e.g. `duplicate_block_id`, `invalid_span`, `page_count_mismatch`).
- **`resolver_policy`** — provider names forbidden (resolver-emitted precedence/conflict/schema decisions, e.g. `canonical_layout_schema_version_too_old`).

This is deliberately not a blunt string search across every code — that would have wrongly flagged `missing_analyze_result` and similar legitimate adapter-local names.

**Token-aware denylist matching**: codes are split on `_` and checked by token membership, not substring search — `missing_analyze_result` is never flagged just because it contains "analyze," and a code containing "document" or "ai" in isolation is never flagged by the multi-token `google_document_ai` rule (which requires all three tokens in that exact sequence). Denylist: `azure`, `docling`, `gemini`, `vertex`, `textract` (single tokens) plus `google`+`document`+`ai` (multi-token sequence).

**Completeness/drift guard**: since none of the three modules export a shared list of their own code constants, the test reads all three source files' text directly and extracts every emitted `code` string via regex (covering both the validator/adapter's `code: "..."` object-literal style and the resolver's positional `pushWarning(list, "...", ...)` call style). The discovered set is asserted equal to the classification map's keys — two-way: a code emitted in source but missing from the map fails, and a map entry for a code no longer emitted anywhere fails. **This was empirically verified during implementation**, not just assumed from the design: a temporary stale map entry (`fake_unclassified_test_code`) was injected and confirmed to fail the guard with the exact expected message; a temporary removal of a real classified entry (`duplicate_table_id`) was also confirmed to fail; both mutations were then reverted, restoring the file to its clean, fully-passing state before commit.

## Tests added

New file: `supabase/functions/_tests/canonical-warning-vocabulary.test.ts` (8 tests) — the completeness/drift guard; `canonical_structure` codes are provider-neutral; `resolver_policy` codes are provider-neutral; `adapter_input` codes are exempt; `duplicate_page_number` classified `canonical_structure`; `missing_analyze_result` classified `adapter_input`; token-aware matching doesn't false-positive on "document"/"ai" alone while correctly firing on real provider tokens; a regression test proving a duplicate Azure `pageNumber` now emits `code: "duplicate_page_number"` with `severity: "recoverable"` (this path had no prior test coverage).

`canonical-layout-resolver.test.ts`'s three affected assertions were updated to the new code strings (mechanical, no new test logic).

## Files changed

Modified: `_shared/extraction/azure/azure-to-canonical-layout.ts` (1 line), `_shared/extraction/document-intelligence-v3/canonical-layout-resolver.ts` (3 lines: 2 code constants + 1 doc comment), `_tests/canonical-layout-resolver.test.ts` (3 assertion strings).

Created: `_tests/canonical-warning-vocabulary.test.ts`, `docs/azure-vertex-migration-phase3b-warning-vocabulary-fix.md` (this file).

## Verification results

| Command | Result |
| --- | --- |
| `deno check` (adapter, resolver, resolver test, vocabulary test) | ✅ clean |
| `deno test` (adapter + contract + document-index + resolver + vocabulary, combined) | ✅ 100/100 |
| `npm run lint` | ✅ clean |
| `npm run typecheck` | ✅ clean |
| `npm run test` (vitest) | ✅ 657/657 |
| `npm run build` | ✅ succeeds (pre-existing chunk-size warning only) |
| `git diff --check` | ✅ clean |
| grep for the 3 old code strings anywhere in `supabase/functions` | ✅ zero remaining references |
| grep for any runtime consumer importing the resolver | ✅ zero matches (only the vocabulary test's source-scan path constant, which reads the resolver's text for code extraction — not a functional import) |
| Secret scan of new/changed files | ✅ none found |

## No runtime migration occurred

No consumer imports or calls the resolver. No parser routing, worker, `normalize-pdf-output`, or Lease Review file touched. No database migration, schema change, deploy, or provider call. No provider-flag or approval-gating change. The only behavioral effect anywhere is that three diagnostic warning `code` strings are now spelled differently — nothing reads them yet.

## Recommendation: No Gate

Phase 3B is a narrowly-scoped vocabulary fix, exactly as planned — three renames, one new guard test, empirically verified to catch drift in both directions. Stop here — Phase 4a (document-index-v3 resolver adoption) does not begin automatically and requires separate approval.
