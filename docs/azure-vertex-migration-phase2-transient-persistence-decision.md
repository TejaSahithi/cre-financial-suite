# Azure + Vertex Canonical Pipeline Migration — Phase 2: Transient vs. Persisted Decision

Date: 2026-07-16
Branch: `feature/document-intelligence-v3`. Phase 1 committed as `62678ec`.
Scope: measurement + comparison + written recommendation only. **No runtime behavior changed. No database schema changed. No live Azure/Vertex/Gemini/OpenAI/Docling call.**
Recommendation: **No Gate**

## 1. Executive decision

**`CanonicalDocumentLayout` should remain a transient, computed-on-demand representation. Do not persist a full canonical layout at this time.** Every current consumer either builds it once within a single request (Vertex indexing, evidence-anchor construction) or already gets its geometry through the existing `document_claim_evidence.block_ids`/`polygon` columns, not from a stored layout blob. Measured build cost is negligible (well under a millisecond for realistic document sizes) and canonical output size stays in the tens-to-low-hundreds of KB even for an 80-page stress fixture — orders of magnitude below the predeclared thresholds. If side-write's per-call reconstruction is ever judged to matter operationally, **request-scoped memoization** is the targeted fix, not a database column. **Confidence: medium** (synthetic fixtures only — see §18 for what would raise it).

## 2. Consumer inventory (evidence-linked)

| # | Consumer | File / function | Layout shape read | Rebuilds layout? | Crosses request boundary? | Needs geometry? |
|---|---|---|---|---|---|---|
| 1 | Vertex document indexing/chunking | `_shared/extraction/vertex-fact-ledger/document-index-v3.ts#resolveDocumentIndex`, called from `orchestrator.ts` | `docling_raw` via `buildCanonicalLayoutFromAzureLikeOutput` | Once per pipeline run only | No | No (projects back to text/block shape for chunking) |
| 2 | v3 side-write layout summaries | `document-intelligence-v3/side-write.ts#computeCanonicalLayoutAndSummary`, once per `normalize-pdf-output` request | `docling_raw` via the same builder | **On every call, including retries** (idempotent delete-and-replace, no cache) — the one candidate with real repeated-computation cost, quantified in §7 | No (rebuilds fresh rather than reusing) | No (only `summarizeCanonicalLayout()`'s small summary + `content_hash`) |
| 3 | Evidence anchor construction | `vertex-fact-ledger/fact-mapper.ts` + `document-index-v3.ts#enrichFactWithBlockEvidence` | The in-memory layout from #1, reused | No (reuses #1's in-memory layout) | No | Yes, but only at build time — `block_ids`/`polygon` are persisted onto `document_claim_evidence` rows; nothing re-derives them later |
| 4 | Validation/readiness diagnostics | `document-intelligence-v3-readiness/index.ts#evaluateDocumentIntelligenceV3Readiness`, invoked from `ExtractionDebugPanel.jsx` | Durable tables only (`document_claims`, `document_claim_evidence`, `document_canonical_field_projections` via `projection-reader.ts`) — never `docling_raw` | Never rebuilds a layout | **Yes — the one genuine cross-request consumer** | Only the already-persisted per-row `block_ids`/`polygon`, not a stored full layout |
| 5 | Normalized output construction | `normalize-pdf-output/index.ts` | `docling_raw`, read at most once per HTTP request (main flow or `mode=enrich`, never both in one request) | No layout built here today | `mode=enrich` is a legitimate separate later request that re-reads `docling_raw` again (not a canonical layout) | No |
| 6 | Lease Review source highlighting | Searched all of `src/components/lease-review/` | N/A | N/A | N/A | **Zero current frontend consumer of geometry anywhere in `src/`** — `SourceFileLink.jsx` only opens the raw PDF; `FieldDetailDrawer.jsx` shows plain `source_page`/`source_text` |

**Net finding**: no current consumer needs a *persisted* layout.

**Durable-input finding**: can a canonical layout be reconstructed later from what is *actually* stored today, not an idealized raw Azure response? `parse-pdf-docling`'s `azure-layout-adapter.ts` intentionally does **not** store Azure's full raw response by default (`STORE_FULL_AZURE_RAW_RESPONSE` is off; only `raw_response_summary` is kept). So `legacyDoclingToCanonicalLayout(docling_raw)` — the lossy path — is what's actually reconstructible from the durable stored shape in the common case, not `azureAnalyzeResultToCanonicalLayout(analyzeResult)` (the lossless path, which needs the raw response most rows don't have). This asymmetry is a first-class input to the recommendation, not a footnote — see §13's architectural observation.

**Separate track from Lease Review UI work**: this is an infrastructure decision. Lease Review already gets what it needs (`source_text`, `source_page`, claim evidence, clause records, expense/CAM rules) without full page geometry, regardless of this decision.

## 3. Measurement methodology

A standalone, offline, permission-scoped diagnostic harness (`supabase/functions/_tests/diagnostics/phase2-canonical-layout-harness.ts`) was built and run against five fixtures generated by a self-verifying builder (`supabase/functions/_tests/fixtures/phase2-harness/build-fixtures.ts` — content is always constructed first, every span offset is derived via `content.indexOf(...)`, and every fixture asserts its own spans match before being written, so offsets can never silently drift).

**Permissions** (structurally, not just conventionally offline):
```
deno run \
  --allow-read=supabase/functions/_tests/fixtures,supabase/functions/_shared,supabase/functions/_tests \
  --allow-write=scratch/root-artifacts \
  supabase/functions/_tests/diagnostics/phase2-canonical-layout-harness.ts <git-sha>
```
No `--allow-net`. No `--allow-env`. Read scoped to fixture/source directories only; write scoped to exactly the ignored artifact directory.

**Fixtures** (all synthetic — no real Azure export or customer document was used):
- `assignment-scale-synthetic.json` — 2 pages, 3 blocks, no tables.
- `base-lease-scale-synthetic.json` — 18 pages, 72 blocks, 2 tables.
- `cam-table-scale-synthetic.json` — 10 pages, 10 blocks, 4 tables (72 cells).
- `large-lease-scale-synthetic.json` — **stress fixture**, 80 pages, 367 blocks, 4 tables (204 cells), including: repeated `pageHeader`/`pageFooter` paragraphs on every text-bearing page, 3 amendment sections, 2 appendix/exhibit sections, 5 genuinely empty/no-text pages (covering both "empty page" and "scanned-image-only page" cases, which are structurally identical in Azure's schema), landscape pages (every 20th), and one table whose `boundingRegions` genuinely span two consecutive pages.
- `current-persisted-docling-raw-azure-shape.json` — 10 pages, built to mirror the *actual* durable `docling_raw` shape `azure-layout-adapter.ts` persists today (no raw Azure response), run through `legacyDoclingToCanonicalLayout()` instead of the Azure-native adapter.

**Per-fixture measurements**: `fixture_read_ms`/`json_parse_ms` isolated from adaptation; `cold_run_duration_ms` (first call) kept separate from 20 **warm** iterations reporting `min`/`median`/`p95` for `adapter_duration_ms` and `validation_duration_ms` independently; `serialization_duration_ms` timed on its own; byte-accurate sizes via `TextEncoder().encode(...).byteLength` (never `.length`) for input/output/text/geometry-estimate; a gzip compression estimate; page/block/table/cell/warning counts; a **canonical fidelity check** (input Azure paragraph/table/page counts must equal output block/table/page counts exactly — asserted, not just observed); unique-id checks; a **deterministic-hash check** (`SHA-256(JSON.stringify(layout))` identical across all 20 warm runs, with no key-sorting — if sorting were needed to stabilize the hash, that would mean the adapter itself isn't deterministic, which is what's actually being tested); and a one-time **validator self-audit** using two deliberately malformed "poison" layouts to confirm all 13 known `validateCanonicalLayout()` check categories still fire (this is what would catch a future edit silently disabling half the invariant checks).

**Limitation, stated plainly**: these are synthetic fixtures. Real Azure output typically has OCR noise, hundreds of spans, multi-region paragraphs, irregular tables, empty lines, denser Unicode, and real coordinate density that synthetic fixtures underrepresent. No real Azure export is available in this repo/environment. Results below are **directional, not production-grade**.

## 4. Measurement results

| Fixture | Pages | Blocks | Tables | Cells | Cold (ms) | Adapter median/p95 (ms) | Validation median/p95 (ms) | Canonical bytes | Gzip bytes (ratio) | Warnings | Valid | Fidelity match | Hash stable |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| assignment-scale | 2 | 3 | 0 | 0 | 0.614 | 0.010 / 0.067 | 0.006 / 0.029 | 2,600 | 778 (3.34×) | 0 | ✓ | ✓ | ✓ |
| base-lease-scale | 18 | 72 | 2 | 12 | 0.566 | 0.066 / 0.171 | 0.066 / 0.152 | 55,327 | 4,230 (13.08×) | 0 | ✓ | ✓ | ✓ |
| cam-table-scale | 10 | 10 | 4 | 72 | 0.166 | 0.036 / 0.145 | 0.035 / 0.081 | 26,551 | 2,170 (12.24×) | 0 | ✓ | ✓ | ✓ |
| large-lease-scale (stress) | 80 | 367 | 4 | 204 | 2.143 | 0.237 / 0.353 | 0.318 / 0.874 | 274,846 | 19,415 (14.16×) | 1 | ✓ | ✓ | ✓ |
| current-persisted-docling-raw (legacy path) | 10 | 10 | 1 | 6 | 0.902 | 0.058 / 0.109 | 0.011 / 0.018 | 6,822 | 1,002 (6.81×) | 0 | ✓ | ✓ | ✓ |

**Correctness**: all five fixtures — `validation.valid === true`, zero fatal errors, canonical fidelity exact (input paragraph/table/page counts equal output block/table/page counts on every fixture, including the 80-page stress fixture), all block/table/cell ids unique, deterministic hash identical across all 20 warm iterations. Validator self-audit: **13/13** expected check categories fired against the poison layouts.

**The one warning observed** (large-lease-scale, `table_spans_multiple_pages`, recoverable) is exactly the deliberately-constructed multi-page table — the adapter behaved as designed, preserving all bounding regions rather than dropping the extra page.

**Memory growth** (large-lease-scale, 50 repeated conversions, heap sampled at 10/20/30/40/50 iterations): `[23.2MB, 19.5MB, 16.4MB, 20.7MB, 17.2MB]` — fluctuates with GC, does not monotonically grow (`monotonically_increasing_beyond_50pct: false`). Labeled approximate only, per plan, not an acceptance gate.

## 5. Transient vs. persisted vs. hybrid vs. memoization comparison

| | Option 1: Transient | Option 2: Persisted (full) | Option 3: Hybrid (compact index) | Option 4: Request-scoped memoization |
|---|---|---|---|---|
| Latency | Sub-ms build cost measured (§4) — negligible | Avoided per-request, but write cost + read-path complexity added | Text/index cheap to persist; geometry still rebuilt on demand | Zero extra latency; reuses one build within a request |
| Repeated computation | Rebuilt every time (cheap, per §4) | Never rebuilt | Rebuilt only for geometry, if ever needed | Never rebuilt *within* a request |
| Storage cost | None | New JSONB column/table, sized like §6 | Smaller (text/index only) | None |
| Payload size | N/A | Up to 275KB/doc measured (stress fixture); real documents likely larger | Materially smaller (excludes geometry) | N/A |
| DB row bloat | None | Real risk on `uploaded_files` (§9) | Smaller but still additive | None |
| Update/versioning complexity | None (recomputed fresh, always current) | Real — needs schema-version + regeneration policy (§10) | Same, scoped to the smaller persisted subset | None |
| Evidence/highlighting needs | Not currently needed (§2 #6) | Would only help a future geometry-rendering UI that doesn't exist yet | Same | N/A |
| Vertex chunking needs | Already satisfied — single build per run (§2 #1) | No improvement over transient | No improvement | No improvement |
| Historical-row compatibility | N/A | Needs backfill policy (§10) | Needs backfill policy for the index subset | N/A |
| Retention/privacy | Best — nothing new at rest (§8) | Worst — a second full-text+geometry copy | Better than full persistence, still a second text copy | Best — nothing new at rest |
| Rollback complexity | N/A (nothing to roll back) | Real — a schema migration | Real, smaller scope | None |

**"Compact index metadata" for Option 3, defined precisely** (not left ambiguous): `page_offsets` (per-page span into the authoritative text), `block_ids` (stable ids, no geometry), `reading_order` (per-page block ordering), `text_projection` (full text, no polygons/spans), `content_hash`. Deliberately excludes `polygon`/`bounding_regions`/per-block `spans` — those would be reconstructed or fetched separately if/when a real geometry consumer exists.

## 6. Storage-size findings

Canonical JSON size scales with document complexity, not just page count: the 80-page stress fixture (274,846 bytes) is ~5× the 18-page base-lease fixture (55,327 bytes) — driven by paragraph/table density, not pages alone. `geometry_bytes_estimate` (polygons + spans + bounding regions) is 70,809 bytes (~26%) of the stress fixture's total — confirming geometry is the dominant storage-cost driver the plan predicted. The legacy (docling_raw-derived) path's `geometry_bytes_estimate` is 34 bytes — essentially zero, confirming Phase 1's documented dual-fidelity gap empirically: the durable stored shape carries almost no real geometry today.

Gzip compresses canonical JSON well (6.8×–14.2× observed) — informational only, does not change the recommendation, but relevant if persistence is ever revisited (§9).

## 7. Performance findings

All predeclared thresholds (§8) are met with wide margin on every fixture, including the stress fixture: median `adapter + validation` time is **0.555ms** on the 80-page fixture (threshold: <100ms), p95 combined **1.227ms** (threshold: <250ms), canonical bytes **275KB** (threshold: <5MB).

**Side-write retry cost, quantified**: side-write's actual input is `legacyDoclingToCanonicalLayout`, so the current-persisted-docling-raw fixture's numbers are what matter — adapter median 0.058ms + validation median 0.011ms ≈ **0.069ms per reconstruction**. Per successful run: 1 reconstruction. Under N retries (side-write has no cache): N reconstructions, each ~0.069ms. Even a pessimistic 5-retry worst case costs ~0.35ms cumulative — negligible.

**Annual operational-cost estimate** (illustrative, not measured production telemetry — none is available in this environment): `estimated CPU-time/year ≈ uploads/day × 365 × average retries × reconstruction time`. Using assumed illustrative inputs (50 uploads/day, 1.3 average reconstructions per successful run to account for occasional retries, and a conservative 0.6ms per reconstruction — rounded up from the largest fixture's combined Azure-native cost of 0.555ms as an upper bound, since real documents may exceed the stress fixture): 50 × 365 × 1.3 × 0.6ms ≈ 14,235ms ≈ **~14 seconds of CPU time per year**. Under these assumptions, side-write's repeated reconstruction is not an operational cost problem at any plausible current scale — the formula is provided so it can be re-run against real upload/retry telemetry later.

## 8. Predeclared decision thresholds, applied

Fixed before running the harness (§ Task D of the plan):
- **Prefer transient** when: median `adapter + validation` < 100ms (measured: 0.017ms–0.555ms ✓); p95 < 250ms on the largest fixture (measured: 1.227ms ✓); `canonical_json_bytes` < 5MB (measured: max 275KB ✓); no consumer needs the layout across independent requests (confirmed, §2 ✓); source input remains durably available (confirmed for the legacy/docling_raw path — see the durable-input finding in §2 and the architectural observation in §13 ⚠ partial).
- **Consider hybrid**: not triggered — no consumer currently needs even a compact index across requests (§2 #4 needs only already-persisted evidence-row fields).
- **Consider persistence**: not triggered — no multi-request reconstruction, no measured latency problem, no current UI reproducibility requirement.

**Result: all "prefer transient" criteria are met.** The one caveat is the durable-input asymmetry (§2, §13) — it doesn't change *this* decision (transient recomputation from `docling_raw` remains cheap and correct), but it is relevant to a broader, later architectural question.

## 9. Evidence/highlighting implications

None today (§2 #6 — zero frontend geometry consumer exists). If real polygon-based highlighting is ever built, it would be a new, separate, async "view evidence" fetch — not a reconstruction of an existing pattern — and would most plausibly consume the already-persisted `document_claim_evidence.block_ids`/`polygon` columns (already scoped to specific claims) rather than a full document layout.

## 10. Versioning and lifecycle

- `canonical_layout ?? legacyDoclingToCanonicalLayout(docling_raw)`: from a future consumer's point of view, if no persisted layout exists, fall back to building one from `docling_raw` on demand — exactly what the harness proves is cheap (§7).
- Schema-version compatibility: reuses Phase 1's policy verbatim — a layout built under schema version X must remain readable by any consumer supporting `MINIMUM_SUPPORTED_SCHEMA_VERSION <= X <= CANONICAL_LAYOUT_SCHEMA_VERSION`; consumers ignore unknown additive fields; no provider-specific field is ever required.
- Regeneration policy: since nothing is persisted, "regeneration" is just "the next call" — no explicit regeneration policy is needed until persistence exists.
- Immutable vs. replaceable versions: N/A while transient.
- Historical backfill: not applicable/needed while transient; if persistence is later added, backfill should be on-demand (Phase 7, §17), not a bulk migration.
- Azure model/API version changes: `azureAnalyzeResultToCanonicalLayout` already records `provider_model_id`/`provider_api_version` on every build (Phase 1), so even transient builds are traceable to the exact model/version that produced them, in logs/diagnostics if ever wired up (see the observability recommendation below).
- Rollback: trivial while transient (delete the harness/fixtures, nothing else references them).
- Retention: raw Azure output is not durably stored by default today (§2 durable-input finding); `docling_raw` follows `uploaded_files`' existing retention; derived claims/evidence follow `document_claims`/`document_claim_evidence`'s existing retention — none of this changes in Phase 2.

**Reproducibility criteria**: whether a layout can be exactly reproduced later depends on: source file hash (not currently captured on `docling_raw` rows), Azure model ID (captured in `_metadata.provider`/adapter output), Azure API version (captured), adapter version (not currently versioned beyond `CANONICAL_LAYOUT_SCHEMA_VERSION`), adapter code commit (recoverable via git history, not stored per-row). If Azure's own model output can vary over time for the same document, reconstructing later may **not** reproduce the exact original geometry — an independent reason (beyond latency) to eventually store *something* durable (raw Azure result, canonical layout, or a versioned evidence subset), orthogonal to the performance-driven criteria in §8. This is noted as a future consideration, not a Phase 2 trigger (no current consumer requires exact historical reproducibility).

**Observability recommendation** (documentation only, not implemented): a future runtime-wired phase should emit `canonical_layout_build_ms`, `canonical_validation_ms`, `canonical_bytes`, `canonical_pages`, `canonical_tables`, `canonical_schema_version`, `adapter_warning_count`.

## 11. Recommended storage strategy

**Transient (Option 1)**, with **request-scoped memoization (Option 4)** available as a zero-risk future addition if side-write's per-call reconstruction is ever judged worth eliminating (§7 shows it currently isn't a measurable cost). No hybrid or full-persistence work is justified by current evidence.

## 12. Proposed schema — not applied, for future reference only

If a future phase's evidence changes this recommendation, the schema shape to evaluate: `canonical_layout` as `jsonb` vs. a separate `document_layouts` table vs. object storage + metadata row; columns `canonical_layout_schema_version`, `layout_provider`, `provider_model_id`, `provider_api_version`, `canonical_content_hash`, optional `layout_geometry_hash`, `generated_at`, `source_payload_hash`.

**Postgres row-size operational risk**: JSONB supports large values, but large rows risk TOAST overhead, expensive row reads, larger backups, replication cost, accidental full-column selects, and slower admin/dashboard queries — `docling_raw` today has no DB-level size cap, only application-level char/count caps (`MAX_STORED_TEXT_CHARS=80,000`, `MAX_STORED_BLOCKS=1000`, etc.), and a full-geometry canonical layout would be **larger per document than `docling_raw`** (per §6, geometry alone is a substantial fraction of size). **If persistence is ever recommended, prefer a separate `document_layouts` table or object storage + metadata row over adding a large geometry blob directly to `uploaded_files`** — `uploaded_files.canonical_layout` is explicitly not assumed to be the right design.

**Security/privacy comparison**: a full canonical layout can contain nearly all document text plus detailed coordinates — persisting it creates another sensitive-data copy. Compared across data duplication, RLS requirements, backup retention, deletion propagation, legal-hold behavior, customer data residency, encryption, and access logging, transient/memoization have a structural security advantage: nothing new exists at rest, so none of these concerns apply to them at all.

## 13. Architectural observation (does not change Phase 2 scope)

The durable-input finding (§2) surfaces a bigger question than "should `CanonicalDocumentLayout` be persisted": today's pipeline already persists enough evidence for Lease Review (`block_ids`/`polygon` on `document_claim_evidence` rows) but does **not** persist enough raw Azure output for full lossless canonical reconstruction later. The real emerging question for later phases is **"what is the authoritative durable document representation going forward?"** — not just a persistence toggle on one new table. This doesn't change Phase 2's scope or deliverables, but is called out explicitly as a Phase 3+ consideration.

## 14. Risks

- Synthetic-fixture confidence ceiling: results are directional, not production-grade (§3, §18).
- The durable-input asymmetry (§2, §13 architectural observation) means the *lossless* Azure-native adapter path is currently unreachable in production (no raw response stored) — this is a Phase 1 fact, not new to Phase 2, but Phase 2's measurements mostly validate the *lossy* legacy path's cheapness, which is the one that actually runs today.
- If upload volume or retry rates are far higher than the illustrative assumptions in §7, the annual-cost conclusion should be re-run with real numbers before being treated as final.
- The `large-lease-scale` fixture, while stress-tested for structural variety, is still authored, not organically messy — real 100+ page CAM packets/amendments may have irregularities (malformed tables, inconsistent headers, OCR gaps) this fixture doesn't fully anticipate.

## 15. Explicitly out of scope (confirmed unchanged)

No production deploy. No remote reads/writes. No live Azure/Vertex/Gemini/OpenAI/Docling call. No parse or extraction rerun. No database migration or new column. No parser-routing, `normalize-pdf-output`, `lease-extraction-worker`, Lease Review, or provider-flag change. No approval-gating change. No secret access or output — enforced structurally by the harness's scoped `--allow-read`/`--allow-write` permissions (no `--allow-env`/`--allow-net`), verified by a secret-pattern scan of every new file.

## 16. Phase 2 exit criteria

- ✓ Persistence decision made: transient, with memoization as an available future refinement.
- ✓ Confidence level documented (medium), with the explicit medium→high path (§18).
- ✓ Predeclared thresholds applied against real measured numbers (§8), not adjusted after the fact.
- ✓ Consumer inventory evidence-linked and validated against actual code (§2), not assumed.
- ✓ No runtime behavior changed.
- ✓ No DB schema changed.
- ✓ Phase 3+ proposal stated below, for review — not presumed pre-approved.

## 17. Phase 3+ proposal (not started)

Decision-independent sequencing, so Phase 3 does not have to be revisited if a later phase's evidence changes the persistence conclusion:

- **Phase 3** — introduce a `resolveCanonicalDocumentLayout({ canonicalLayout, azureAnalyzeResult, doclingRaw })` resolver abstraction only. No consumers switched over yet.
- **Phase 4** — route selected consumers (from §2's inventory) through the resolver.
- **Phase 5** — add request-scoped memoization (Option 4) if Phase 4's real usage shows it's warranted.
- **Phase 6** — add persistence only if a measured need exists, re-evaluated against §8's criteria with real (not synthetic) usage data by then.
- **Phase 7** — backfill historical rows only if needed, preferably on-demand rather than a bulk migration.

Working-assumption resolver precedence (finalized during Phase 3, not presupposed now): (1) a persisted canonical layout, if Phase 6 ever adds one; (2) the Azure-native adapter, if a raw `analyzeResult` is available; (3) the current persisted Azure/`docling_raw`-compatible shape via `legacyDoclingToCanonicalLayout`; (4) legacy `docling_raw` fallback for non-Azure parser output.

## 18. Recommendation confidence

**Medium**, not high — fixtures are synthetic. Explicit path to high confidence: a real Azure `analyzeResult` export → tested against a real production-scale lease document → repeated measurements across several real documents → stable, consistent results across them. Until all four are true, medium is the ceiling regardless of how clean the synthetic numbers look.

## 19. Recommendation: No Gate

Phase 2 is measurement and analysis only. The evidence-based recommendation is transient computation (Option 1), with request-scoped memoization (Option 4) as an available, low-risk future refinement if operational data ever shows it's needed — not full or hybrid persistence. Stop here — Phase 3 does not begin automatically.
