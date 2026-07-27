# Lease Truth Assembly — Implementation Report

**Status: implemented, tested, wired into the active runtime path. Not deployed to production.**

This report documents a scoped, honest slice of the requested architecture. The
full request (sections A–O) describes an initiative on the scale of a
multi-week rebuild — a canonical Azure-layout document graph, a section
router, domain-specific evidence packages, an adaptive per-domain LLM router
with request/token budgets, ten named domain resolvers, versioned incremental
caching, and a frontend rewrite. Attempting all of it in one pass would have
produced exactly what this task explicitly forbids: a shallow, under-tested,
partially-wired change that *looks* complete. Instead, this report traces the
real system first, then implements and proves the highest-leverage slice that
closes the *systemic* bugs actually described, wired into the real runtime
path — and states plainly, section by section, what was and was not built.

---

## 1. Mandatory first action — the active path, as found

Traced directly from source (not assumed) before any code was written.

**Upload → parse → normalize → review, active today:**

1. `upload-handler` (storage + DB row only, no parsing) → `confirm-upload` →
   `ingest-file` (routes by MIME/extension; for leases, enqueues
   `lease-extraction-worker` via `start_lease_extraction_generation`, which
   establishes **generation fencing**).
2. `lease-extraction-worker` calls `parse-document-azure`, which is genuinely
   **Azure Document Intelligence** (`_shared/azure/document-intelligence.ts`
   — real `documentModels/{id}:analyze` submit + poll, `Ocp-Apim-Subscription-Key`
   auth, model `prebuilt-layout`). Its output is normalized into the
   `DoclingOutput`/`AzureDocumentOutput` shape
   (`_shared/extraction/azure-layout-adapter.ts`) — "Docling" is a retired
   internal type name only; no Docling library call exists anywhere in the
   active path (`extraction-provider.ts` explicitly throws on `vertex_ai` /
   `docling` / other legacy provider names).
3. `normalize-pdf-output` reads the parsed row, resolves
   `BUSINESS_EXTRACTION_PROVIDER` (default `openai_primary_legacy_fallback`),
   and calls `business-extraction-orchestrator.ts`'s `runBusinessExtraction()`,
   which runs `openai_fact_ledger` once and falls back to `legacy_hybrid`
   exactly once if rejected — never both blended.
4. The LLM is **OpenAI direct** (`api.openai.com`, model `gpt-4o-mini` by
   default) unless `AZURE_OPENAI_ENDPOINT` is set as a runtime secret, in
   which case the same call routes to Azure OpenAI instead — both paths go
   through the one file `_shared/llm.ts`. (Note for the record: this repo's
   own `.env.example`/`DEPLOY.md` document only the direct-OpenAI
   `gpt-4o-mini` configuration, not "Azure OpenAI 5.4-mini" — if a live
   deployment's secrets set `AZURE_OPENAI_DEPLOYMENT` to a 5.4-mini
   deployment, that is a runtime configuration this static checkout can't
   see either way. Nothing in this implementation depends on which branch is
   active.)
5. `normalize-pdf-output` persists a **transient, fast** payload via
   `buildMinimalReviewPayload()`, then (deferred, async, unless
   `NORMALIZE_INLINE_ENRICHMENT=true`) `buildReviewPayload()` recomputes a
   **richer, lasting** `ui_review_payload` — this is the payload that
   actually survives and is what the reviewer sees.
6. The frontend (`src/lib/leaseFieldResolver.js`) reads
   `lease.extraction_data.workflow_output.lease_fields` first, then
   `uploaded_files.ui_review_payload.records[0].{standard_fields,fields}`, in
   a documented fallback cascade — a **different, independent** frontend
   alias table (`FIELD_ALIASES`) does its own alias resolution on top of
   whatever the backend already resolved.

**Key finding this task explicitly asked to surface — a dormant, unused
parallel architecture already exists**, and repeats the exact anti-pattern
this task forbids: `_shared/extraction/document-intelligence-v3/` (36 files)
already implements a real canonical document graph
(`CanonicalSpan`/`CanonicalBoundingRegion`/`DocumentAsset`/`SelectionMark`/
`SignatureRegion`, section hierarchy, page-quality scoring) — but it is gated
off by default (`ENABLE_DOCUMENT_INTELLIGENCE_V3=false`), and even when
enabled, it runs as a **side-write** ("can never change this request's
outcome," per its own code comment) into separate tables, never reaching
`ui_review_payload`. This was treated as a warning, not a template: this
implementation does not add a second dormant system next to it.

**Also found and reused rather than rebuilt:** `field-contract.ts`'s
`resolveCanonicalKey()` — a real, tested, canonical-alias resolver — existed
with **zero production call sites**. `pipeline.ts`'s `snapshotFieldMap()` — a
pipeline-agnostic per-field evidence snapshotter both `legacy_hybrid` and
`openai_fact_ledger` already call identically, producing
`extractionDebug.merged_field_sources` in one shared shape. These two
existing, working, already-shared primitives are what this implementation is
built on top of.

---

## 2. What was implemented (sections actually built)

### 2.1 Shared semantic-role compatibility layer (pre-existing this session, extended here)

`_shared/extraction/semantic-compatibility.ts` (built in the prior phase of
this session) already provided the 8-dimension role taxonomy and per-field
`require`/`reject` rules. Extended in this pass with:
- `commencement_date` / `start_date` (require `dateRole=commencement`, reject
  `signature`/`execution`/`expiration`) and `end_date` (mirrors
  `expiration_date`) — closing the *other* direction of "execution dates
  mapped as commencement dates" (only `expiration_date` had a date-role guard
  before this pass).
- `late_fee_amount` (`requireMonetaryRole: ["penalty"]`) — closes "address
  number cannot populate late fee."
- Fixed a real ordering bug in `inferClauseRole`/`inferResponsibilityRole`
  (plural "options to renew" wasn't matching a singular-only pattern) found
  while writing golden-corpus tests, and a confidence-model bug (below).

### 2.2 Lease Truth Assembly — the one canonical publisher

New file: **`_shared/extraction/lease-truth-assembly.ts`**. `assembleCanonicalFields()`
is the only function that may publish a canonical field result. Deliberately
built on the two existing, already-shared primitives from §1, not a new
retrieval system:

- **Alias resolution**: wires the previously-dormant `resolveCanonicalKey()`
  into production for the first time.
- **Duplicate-concept merging**: `commencement_date`⟷`start_date`,
  `expiration_date`⟷`end_date`, `responsibility_taxes`⟷`tax_responsibility`,
  `responsibility_insurance`⟷`insurance_responsibility` are merged into one
  published identity. (`tenant_contact_name` was investigated and
  deliberately **not** merged with `tenant_name` — they are genuinely
  different facts, day-to-day contact vs. legal tenant entity, confirmed
  against this session's own earlier fix distinguishing them; conflating them
  would recreate the exact kind of bug this task is fixing. `monthly_rent`/
  `annual_rent` and `property_address`/`property_name` are OR-alternates in
  `field-contract.ts` but are also genuinely different facts and are **not**
  merged.)
- **Actor/action/object obligation direction** (`inferObligationActor` +
  `validateObligationDirection`): a generalized regex identifies the
  grammatical *actor* of a pay/reimburse/maintain/repair/insure/perform verb
  and rejects a responsibility-field value that names the *other* party —
  the direct fix for "tenant obligations assigned to landlord because
  landlord appears nearby."
- **Term-date cross-validation**: `expiration_date` must be chronologically
  after `commencement_date`, once both are already selected — flags, never
  fabricates.
- **Rent arithmetic cross-validation**: `monthly_rent × 12` must reconcile
  with `annual_rent` within tolerance; tolerance is purely numeric (currency
  symbols/commas stripped before comparison), so OCR losing a `$` or comma
  doesn't falsely flag a real match.
- **Multi-component, capped confidence**: `extractionConfidence`,
  `sourceAuthorityConfidence` (informational tie-break only, not a cap — see
  the bug fix below), `semanticRoleConfidence`, `crossFieldConfidence`. Final
  confidence is capped by the weakest *critical* (semantic/cross-field)
  component — the direct fix for "95–99% confidence shown for semantically
  invalid mappings."
- **`CanonicalFieldResult`**: `fieldId`, `value`, `status` (`verified` /
  `derived_verified` / `needs_review` / `conflicting` / `not_stated`),
  `selectedCandidateKey`, `rejectedCandidateKeys`, `sourcePage`, `sourceText`,
  `resolver` (`TermResolver`/`RentResolver`/`ResponsibilityResolver`/
  `SemanticCompatibilityResolver`/`PassthroughResolver`), `validationResults`,
  `confidenceComponents` — matches the task's suggested shape.

**A real bug this module's own test suite caught and fixed during
development**: the first confidence-model draft let `sourceAuthorityConfidence`
(a source-priority *tie-break* signal, e.g. rule=0.9/table=0.85/llm=0.75)
independently cap the final confidence — dragging a fully valid,
llm-sourced field down to ~50% for no defect of its own. Fixed so only
*trust/validity* signals (semantic compatibility, cross-field checks) cap
confidence; source authority is reported but never punitive on its own.

### 2.3 Wired into the ACTUAL runtime path (not a side-write)

This was the part of the exercise that mattered most, and where the real risk
of "looks fixed, isn't" lived:

- **`buildMinimalReviewPayload()`** (the transient, fast payload) — value/
  status/confidence for every schema field are overridden by the canonical
  result when one exists.
- **`buildReviewPayload()`** — the function whose output actually **survives**
  past the deferred enrichment pass (confirmed by reading its own docstring:
  `buildMinimalReviewPayload`'s payload is explicitly a placeholder). Same
  override applied here, independently, since this function has its own,
  separate, much larger fallback/recovery value-computation logic.
- **`workflow_output.lease_fields`** — found, mid-implementation, that
  `buildLeaseWorkflowAbstraction()` (called by `buildReviewPayload`) computes
  its own `lease_fields` from the **raw, un-reconciled** row, and that the
  frontend's fallback hierarchy checks `workflow_output.lease_fields` *before*
  `standard_fields`/`fields`. Overriding only `standard_fields` would have
  left this earlier, higher-priority source displaying the wrong value
  whenever it had its own evidence — silently defeating the entire fix. Fixed
  by computing an "effective row" (raw row with each field's value replaced
  by its canonical result) and feeding *that* into
  `buildLeaseWorkflowAbstraction`, so both payload shapes are corrected from
  one Lease Truth Assembly computation, not two.
- **`review-approve`**: a new, additive approval-safety check
  (`findConflictingTruthAssemblyFields`) blocks approval (`422
  TRUTH_ASSEMBLY_CONFLICT`) when any field is `conflicting` — application-layer
  only, no DB migration, additive to the existing `review_readiness` DB gate
  (never replaces it).
- **Frontend**: **no frontend code changes were needed or made.** Because the
  backend now writes the reconciled/canonical value directly into the same
  `standard_fields`/`fields`/`workflow_output.lease_fields` locations the
  frontend already reads, `leaseFieldResolver.js`'s existing single-location
  read automatically serves the canonical value. This was a deliberate choice
  over adding a new `canonical_fields` object the frontend would need new
  code to consult — which would have re-created the exact "parallel,
  optional, easy-to-miss" pattern already sitting unused in
  `document-intelligence-v3`. Additive `truth_assembly_status`/
  `truth_assembly_validation_results`/`truth_assembly_field_id` keys are
  stamped onto every standard field for future UI surfacing (evidence,
  competing candidates, validation warnings) — read-only, backward-compatible,
  not yet consumed by any frontend component in this pass.

---

## 3. Real-document test results

**Constraint stated plainly**: this sandboxed session has no live Azure
Document Intelligence or OpenAI credentials, so no genuine re-extraction of
the two real leases in the repo (`_tests/fixtures/golden-leases/
naren-executed-lease-01162024.pdf`, and the `benchmarks/lease-extraction/`
"Macon Crossing" ground-truth/replay JSON pair) could be run end-to-end in
this pass. Both were located and confirmed to exist (see §1); running the
real pipeline against them requires an environment with those credentials —
noted as the concrete next step in §5, not silently skipped.

In place of that, three new test files exercise the **exact same code path**
(`buildReviewPayload`/`buildMinimalReviewPayload`/`findConflictingTruthAssemblyFields`,
not a parallel harness) against synthetic fixtures spanning the three named
lease archetypes (typed lease with a summary page; scanned lease with
handwritten addenda/tables/formulas; scanned form lease with handwritten
party/premises/rent/term values):

- **`_tests/lease-truth-assembly.test.ts`** (20 tests) — unit-level:
  alias resolution, duplicate-concept merge/conflict, obligation direction,
  term-date/rent-arithmetic cross-validation, confidence capping, guaranty
  vs. renewal-option, address-number vs. late-fee.
- **`_tests/lease-truth-assembly-e2e.test.ts`** (11 tests) — calls
  `buildReviewPayload()` directly (the function whose output survives to
  production), across the three archetypes, plus the specific
  `workflow_output.lease_fields` proof described in §2.3.
- **`_tests/lease-truth-assembly-approval-gate.test.ts`** (3 tests) — the
  review-approve conflict gate.

**All 34 new tests pass.** Specific systemic regressions from the task's own
list, each with a passing test: additional charge ↛ monthly_rent; area
operand ↛ ti_allowance total; execution date ↛ commencement_date; a genuine
commencement/expiration ordering violation is flagged, not silently accepted;
repair clause ↛ utility cost responsibility; guaranty "Initial Term" text ↛
renewal option; landlord-as-payment-recipient ↛ cost bearer; rent arithmetic
tolerates OCR currency-glyph loss; duplicate aliases (start_date/
commencement_date) never disagree in the published payload, and a genuine
disagreement is surfaced as `conflict_detected`, not silently picked.

**Honest caveat**, matching this task's own "no unsupported claim of perfect
accuracy" instruction: these are synthetic fixtures written by the same
author who wrote the classifier they test, so passing them demonstrates
*internal consistency* — the mechanism works the way it's designed to — not
independently-validated accuracy against arbitrary real-world lease prose.
The real, held-out validation is the deferred step in §5.

### Regression safety

- Targeted backend set (existing + new): **199 passed, 1 failed** — the 1
  failure (`field-contract.test.ts`, `tax_responsibility`/
  `responsibility_taxes` independence) is confirmed **pre-existing**, reproduced
  identically on a `git stash` of every change in this entire session.
- Full-suite baseline diff (`node scripts/compare-deno-baseline.mjs`, which
  diffs by failing-test-*name*, not count): zero new non-environment-dependent
  failures. The ~280 "new" names are all `.property.test.ts`/RLS/audit-log/RPC
  tests requiring a live local Supabase Postgres this sandbox does not have.
- Frontend: `npx vitest run src/` — 78 files, 783 tests, all pass (no
  frontend files were touched).

---

## 4. What was NOT built, and why (explicit scope boundary)

Stated directly rather than glossed over:

- **Section A (rebuild a canonical document graph)** — not built. One
  already exists (`document-intelligence-v3/canonical-layout.ts`), dormant.
  Building a second would be the exact anti-pattern this task forbids.
  Actually *activating* the existing one (flipping
  `ENABLE_DOCUMENT_INTELLIGENCE_V3` and wiring its side-write into the live
  payload instead of a separate table) is real, scoped follow-up work, not
  done here — it's a bigger, separate decision (schema/migration surface)
  than this pass's mandate.
- **Sections B–E (deterministic section router, domain evidence packages,
  adaptive per-domain LLM router with request/token budgets)** — not built.
  This is a genuinely separate, large initiative — a new retrieval/routing
  architecture — comparable in scope to the *entire* rest of this task
  combined. Building it without equally-thorough testing would violate this
  task's own standard more than declining to. **No LLM request-count or
  token-usage behavior was changed in this pass** — chunking, retrieval, and
  LLM call volume are exactly what they were before. This is the single
  largest deferred item.
- **Section H (ten named domain resolvers)** — three generalized resolvers
  were built inside Lease Truth Assembly (`TermResolver`, `RentResolver`,
  `ResponsibilityResolver` — the last one covers tax/insurance/electric/
  water-sewer/repairs, since they share one obligation-direction mechanism),
  not ten bespoke classes. `PartyResolver`/`PremisesResolver`/
  `OptionResolver`/`SignatureResolver` are not implemented; their fields
  (`renewal_options`, `broker_name`, `tenant_signatory_name`) already benefit
  from the existing semantic-compatibility layer's per-field rules, just not
  a dedicated resolver class.
- **Component-level repair-obligation structured output** (Section H's
  "preserve component-level split obligations") — not built. `responsibility_repairs`
  still publishes a scalar (tenant/landlord/shared) via the shared
  responsibility resolver, not a structured per-component breakdown.
- **Section N (versioned caching / incremental reprocessing)** — not built.
  Existing generation fencing (confirmed real and unmodified — see §1) still
  prevents a stale job from overwriting a newer generation's result, but
  there is no cache-key-by-component-version system, and no "rerun one domain
  only" capability. This is a real, separate infrastructure investment.
- **Frontend UI surfacing of the new transparency fields** (`truth_assembly_status`,
  `validationResults`, competing candidates) — the *data* is now present on
  every field (see §2.3) but no React component reads it yet. Deliberately
  deferred rather than adding unused frontend plumbing without a consuming
  view.

## 5. Recommended next step (superseded — see §6)

~~Run this exact pipeline... determine whether Sections B–E (the routing/
evidence-package rework) are actually needed next~~ — this was answered
directly: yes, and §6 below implements it as its own coherent change (the
Section-Aware Candidate Router), landing in the same session.

---

# 6. Section-Aware Candidate Router (follow-up implementation)

**Status: implemented, tested, wired into the active runtime path (ON by
default, with an explicit kill switch). Not deployed to production.**

This closes the two gaps §4 explicitly named as deferred: no deterministic
pre-LLM routing existed, and LLM cost/call-count was unchanged. It is
additive to Lease Truth Assembly (§1–5) — it changes what candidates *reach*
`mapFactsToStandardFields`/Lease Truth Assembly, never how that assembly
selects among them.

### 6.1 What was built

Four new modules, each reusing an existing, already-tested system rather than
re-implementing it:

- **`section-router.ts`** — routes Azure Layout `text_blocks` into 17 named
  sections (`parties`, `premises`, `term`, `base_rent`, `rent_schedule`,
  `additional_rent`, `expense_recovery`, `cam`, `taxes`, `insurance`,
  `utilities`, `repairs`, `options`, `defaults`, `signatures`, `guaranty`,
  `amendment`, plus `other`) via heading detection + keyword scoring +
  heading-inheritance for body blocks. Each of the 17 maps to exactly one of
  5 bounded LLM-call domains (`core_terms`, `rent_and_charges`,
  `expenses_and_cam`, `operating_obligations`, `legal_rights_and_dates`).
  Routing limits candidate *competition* (which section's content is
  eligible evidence for which domain call) — it never assigns a final field
  value itself; a repair clause routes to `repairs`/`operating_obligations`
  and can produce a repair fact, but only wins a utility-payment field if
  semantic-compatibility.ts's `responsibilityRole` check (unchanged, already
  built) says the text is actually a payment obligation.
- **`deterministic-candidates.ts`** — bridges rule-extractor.ts's existing,
  already-tested `extractRuleBased()` (label/pattern/table/docling-field
  matching — this already implements everything the task's own "extract
  obvious candidates" examples describe: labelled parties, currency amounts,
  percentages, dates, table rows) into `Fact[]`, tagged with a clause
  category and an `LlmCallDomain`, so deterministic and LLM-produced
  candidates compete on equal footing inside fact-field-mapper.ts's
  existing scoring + semantic-compatibility gate. No new extraction logic;
  a format bridge only.
- **`domain-readiness.ts`** — the `DomainReadiness` evaluator, exactly the
  shape requested (`criticalFactsPresent`, `authoritativeSourcesPresent`,
  `semanticRolesComplete`, `conflictsPresent`, `deterministicValidationPassed`,
  `requiresLlm`, `escalationReasons`). Reuses `mapFactsToStandardFields`
  itself (running it on deterministic-only facts) rather than
  re-implementing candidate resolution — this module only interprets that
  existing output through a per-domain lens. A domain with no routed content
  and no facts is treated as "not applicable" (e.g. no CAM clause in this
  lease), not escalated; a domain WITH routed content but no resolved
  candidate IS escalated.
- **`openai-fact-ledger/adaptive-extractor.ts`** — `extractFactLedgerAdaptive()`
  orchestrates the above: deterministic candidates first, then at most one
  Azure OpenAI call per domain where `requiresLlm=true`, each with a narrow,
  domain-scoped prompt and evidence package (only that domain's routed
  blocks ± 1 neighbor, plus already-resolved deterministic facts so the
  model doesn't re-derive them) — never the whole document, never one call
  per chunk/page/field. Falls back wholesale to the existing, fully-tested
  `extractFactLedger()` (whole-document chunking) whenever adaptive routing
  cannot confidently apply: no text blocks to route, a resume/checkpoint
  state was requested, or file-mode was requested — "do not enforce the call
  count by dropping necessary extraction" is satisfied by this safety net,
  not by a lower bound on how carefully any one domain is checked.

### 6.2 Wired into the actual runtime path

`openai-fact-ledger/orchestrator.ts`'s `runOpenAIFactLedgerPipeline()` — the
one function both `normalize-pdf-output` and every test in this repo actually
call — now calls `extractFactLedgerAdaptive()` instead of `extractFactLedger()`
directly. **On by default**, per this task's own instruction not to add
"another side-write" next to the already-dormant document-intelligence-v3.
`DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION=true` is an explicit, fast operator
kill switch (no code deploy needed) back to the original whole-document
chunking, for situations this sandboxed session cannot itself validate
against (real Azure/OpenAI traffic) — on top of the adaptive extractor's own
per-document fallback safety net.

Facts produced adaptively (deterministic + selective LLM) flow into the
exact same `mapFactsToStandardFields()` → Lease Truth Assembly pipeline
already described in §1–5. No new final publisher was created.

Instrumentation (`extractionDebug.openai_fact_ledger.adaptive_extraction`):
per-domain `called`/`reason`/`inputTokensEstimate`/`promptTokens`/
`outputTokens`/`factsReturned`/`cacheHit`, plus `llmDomains`,
`domainsResolvedDeterministically`, `domainsEscalated`,
`totalInputTokensEstimate`, `totalOutputTokens`. `azureCalls` is always `0`
in this module's own accounting — Azure Document Intelligence already ran
once, upstream, in `parse-document-azure` before this module ever executes;
this module makes no additional Azure calls itself, by construction, and
this is asserted directly in tests (§6.3).

### 6.3 Acceptance criteria — verified by test, not asserted

`_tests/adaptive-extraction-components.test.ts` (8 tests, section
router/deterministic candidates/domain readiness in isolation) and
`_tests/adaptive-extraction-acceptance.test.ts` (10 tests, end-to-end through
`extractFactLedgerAdaptive`) — all 18 pass:

- Labelled parties extracted with a real, asserted **zero** Azure OpenAI
  fetch calls (`countFetchCallsTo` spy wrapping `globalThis.fetch`).
- Labelled premises area extracted with zero calls.
- An explicit monthly/annual rent pair validates (Lease Truth Assembly's
  existing rent-arithmetic check) with zero calls.
- Utilities evidence is routed from the utilities section specifically (a
  repair-domain block and a utilities-domain block in the same document
  route to their own distinct domains, verified directly on the router's
  output).
- Insurance requirements route from the insurance section.
- CAM clauses route to `expenses_and_cam`.
- Additional charges still cannot become base rent under the adaptive path
  (reusing semantic-compatibility.ts, unchanged).
- A skipped (deterministically-resolved) domain records a non-empty,
  specific reason.
- An escalated domain records a non-empty, specific reason (a genuine
  "content present, nothing resolved" case, distinguished by test from the
  "nothing here at all, not applicable" case).
- Adaptive facts are proven to flow through the identical
  `mapFactsToStandardFields`/`assembleCanonicalFields` calls Lease Truth
  Assembly's own tests use — no parallel publisher.
- A canonical-only rebuild (re-deriving the canonical payload from
  already-extracted facts, calling only `mapFactsToStandardFields` +
  `assembleCanonicalFields`) is asserted to make **0** Azure calls and **0**
  OpenAI calls — both functions are pure/offline by construction, verified
  directly rather than assumed.

**Honest gap**: "repair clauses produce component obligations" (a
per-component structured breakdown — e.g. HVAC vs. structural vs. interior
repair responsibility as separate rows, not one scalar) was **not** built.
`responsibility_repairs` still publishes a single normalized
tenant/landlord/shared scalar via the existing `ResponsibilityResolver`
logic in `lease-truth-assembly.ts`. What IS verified: a repair-domain clause
correctly does not leak into a utility-payment field (§6.3's utilities test),
which is the specific systemic bug this task named — but the richer
component-level structure is a real, separate follow-up, not silently
claimed as done.

**Real-document caveat, same as §3**: no live Azure/OpenAI credentials exist
in this sandbox, so these are synthetic fixtures across the three named
archetypes, not the actual Naren/Macon Crossing documents. §6.5 below is the
concrete next step to close that gap.

### 6.4 Bugs found and fixed while proving this (all real, all pre-existing or newly introduced by this pass — none swept under the rug)

- **`fact-field-mapper.ts`'s tenant_name/landlord_name shape guard** did not
  recognize a bare labelled key-value pair (`"Tenant: Justin Cress"` — the
  exact shape Azure Layout key-value pairs and `deterministic-candidates.ts`
  produce) as sufficient party-identification framing; it required a full
  sentence ("referred to as Tenant", "herein called Tenant"). Generalized to
  accept a label immediately followed by *this candidate's own value*
  (tightened after an initial, too-permissive version spuriously matched a
  multi-field signature block that merely *started* with "TENANT:").
- **`lease-truth-assembly.ts`'s confidence model** (from §1–5) had a real
  bug this new work's tests surfaced: `sourceAuthorityConfidence` (a
  source-priority tie-break signal) was capping overall confidence,
  dragging a fully-valid llm-sourced field down to ~50%. Fixed so only
  trust/validity signals (semantic compatibility, cross-field checks) cap
  confidence.
- **`domain-readiness.ts`'s conflict detection** initially used
  `mapped.rejectedCandidates` (a broad audit trail that includes candidates
  correctly filtered out as wrong matches) as its conflict signal, causing
  domains to escalate even when already correctly and unambiguously
  resolved. Fixed to use `fieldProvenance[key].competingCandidates`
  specifically — candidates that passed their own shape/semantic guard and
  remain genuinely competitive by score, the actual definition of an
  unresolved ambiguity.
- **A pre-existing test-hygiene bug**, unrelated to this task's own changes,
  surfaced as test-order-dependent flakiness while proving the "zero Azure
  OpenAI calls" acceptance criteria: `openai-fact-ledger.test.ts`'s
  "`ENABLE_DOCUMENT_INTELLIGENCE_V3` unset" test deleted the flag to test
  the default, but its own `finally` block set it to `"true"` instead of
  restoring the deleted state — leaking that flag for the rest of any
  `deno test` invocation that ran this file before others, silently
  changing `document-index-v3`'s resolution path (and therefore whether
  `docling.fields` key-value pairs survived) for every later test in the
  same process. Fixed (one line: `.delete()` instead of `.set(..., "true")`).

### 6.5 What was deferred, and why (same honesty standard as §4)

- **Per-component repair-obligation structure** — not built (§6.3).
- **A real cross-invocation cache** (by document hash, keyed on section-
  router/deterministic-extractor/prompt-schema versions, as the original
  spec's Section N asked) — not built. `adaptive-extractor.ts` has only an
  in-process `Map` cache (identical domain+evidence-text pairs within the
  same function execution never double-call), which is real but narrow; it
  does not survive across separate Edge Function invocations. This is the
  same gap §4 already named for Lease Truth Assembly's caching story.
- **`document-intelligence-v3` reuse** — per this task's explicit instruction
  ("reuse its useful graph types... or extract the useful components into
  shared modules, keep the dormant orchestrator disabled"), this
  implementation did neither *and* neither, deliberately: it builds directly
  on `AzureDocumentOutput`/`DoclingOutput` (`text_blocks`/`tables`/`fields`),
  the one document representation *already* flowing unconditionally through
  the entire active pipeline, rather than depending on the flag-gated,
  often-absent `canonical_layout_v3`. This avoids a second competing
  document representation without needing to extract or touch
  `document-intelligence-v3`'s code at all. `document-intelligence-v3`
  itself remains exactly as dormant as it was — untouched, not re-enabled,
  not extended.
- **Real per-request token/cost accounting against a live document set** —
  the instrumentation schema is real and wired in (§6.2), but its numbers
  have only been exercised against synthetic fixtures and mocked LLM
  responses; real `promptTokens`/`completionTokens` values from `_shared/llm.ts`
  are threaded through unmodified, but no live run has recorded them yet.

### 6.6 Recommended next step

Same recommendation as the original §5, now genuinely actionable: run this
pipeline (Lease Truth Assembly + Section-Aware Candidate Router, both now
live by default) against the real `naren-executed-lease-01162024.pdf` and
Macon Crossing fixtures in an environment with live Azure Document
Intelligence + OpenAI credentials. Capture the resulting
`extractionDebug.openai_fact_ledger.adaptive_extraction` instrumentation
block directly — it will give the first genuine (not synthetic) read on
real call counts against the target table (0–1 / 1–3 / 2–4 calls by
archetype) and real per-domain escalation reasons, which is the only
remaining piece neither this pass nor §1–5 could produce without live
credentials.

---

# 7. Bounded Per-Domain Enrich Refactor (follow-up implementation)

**Status: implemented, tested, wired into the real runtime path as an
explicit opt-in. Not deployed. Not migrated. `ENRICH_BOUNDED_STAGE_MODE`
defaults `"off"` everywhere, so nothing about this section changes current
production behavior until both a migration is pushed AND the flag is set.**

### 7.1 The problem this closes

A real production incident (Craven Wings lease, documented in full in
`FAILED_EXTRACTION_ROOT_CAUSE.md`) showed `normalize-pdf-output`'s `"enrich"`
mode gets killed by the platform (HTTP 546, compute/memory exhaustion) on
complex, multi-table documents, because `buildReviewPayload()` tries to
rebuild the entire rich review payload — clause records, the 91-field lease
field map, universal document items, expense-rule derivation, and per-field
evidence verification across ~88 schema fields — in one Edge Function
invocation, holding the whole document's state in memory at once. The
narrow incident fix (already committed, see §-prior-work in
`FAILED_EXTRACTION_ROOT_CAUSE.md`) stopped that crash from being silently
masked as a safe "review-ready" result; it did not stop the crash itself.
This section is the actual fix: splitting `"enrich"` into 10 smaller, bounded,
independently-retryable stages so no single invocation holds the whole
document's state.

### 7.2 Exact stage sequence

`_shared/extraction/enrich-bounded-stage/stage-sequence.ts`'s
`ENRICH_STAGE_SEQUENCE` is the single source of truth, consulted by
`completeBoundedEnrichStage()` to decide what runs next (no stage hardcodes
its own successor):

1. `enrich_clauses` — `buildClauseRecords()` only (the in-code-documented
   "dominant cost behind... 546 failures").
2. `enrich_fields` — document-profile detection + `buildLeaseFieldMap()`
   (~91 field specs, 756 lines) — resumes from stage 1's persisted clauses.
3. `enrich_items` — both `buildUniversalDocumentItems()` calls (kept as two
   calls, not merged — the second genuinely depends on an intervening
   profile re-classification) + evidence-clause helpers + lease-type
   classification.
4. `enrich_derivation` — the cross-cutting phase:
   `deriveExpenseRules`/`deriveCamProfile`/`deriveBudgetPreview`/
   `buildBudgetHandoffReadiness`/`buildValidationResults`, run once over the
   pooled output of stages 1–3.
5–9. `enrich_evidence_core_terms`, `enrich_evidence_rent_and_charges`,
   `enrich_evidence_expenses_and_cam`, `enrich_evidence_operating_obligations`,
   `enrich_evidence_legal_rights_and_dates` — each runs
   `buildStandardFieldsForEntries()` (the per-field evidence-verification
   loop, extracted as its own top-level function in
   `normalize-pdf-output/index.ts` this pass) restricted to the schema
   fields whose `FieldGroup` maps to that stage's `LlmCallDomain`, via the
   pre-existing `FIELD_GROUP_TO_LLM_CALL_DOMAIN` table
   (`deterministic-candidates.ts`) — no new taxonomy.
10. `enrich_truth_assembly` — the only canonical publisher. Pools all 9
   prior stages' outputs (workflow derivation + all 5 evidence-domain
   results + a remainder pass for the handful of schema fields whose
   `FieldGroup` maps to no domain, e.g. `notes`, `budget_inputs`), calls
   `buildReviewPayload()` — the SAME function every other caller uses,
   verbatim, via two additive hooks (`precomputedWorkflowOutputs`,
   `precomputedStandardFieldsByRow`) — runs the unchanged
   `assembleCanonicalFields()` (Lease Truth Assembly), persists the rich
   `ui_review_payload`, and is the only stage allowed to overwrite it.

`_tests/enrich-bounded-stages.test.ts` asserts this exact order, that
`nextEnrichBoundedStage()` traverses it correctly, and that
`isFinalEnrichBoundedStage("enrich_truth_assembly")` is the only true case.

### 7.3 Active dispatch path

Two dispatch sites, both gated on `getEnrichBoundedStageMode() === "active"`
(everywhere else, `"off"` preserves the exact pre-existing call):

- **`normalize-pdf-output/index.ts`**'s post-normalize dispatch (~line 3975)
  — enqueues `firstEnrichBoundedStage()` (`"enrich_clauses"`) instead of
  `enqueueEnrichmentJob()` (the old monolithic `"enrich"` job) once the
  minimal payload is durable.
- **`lease-extraction-worker/index.ts`**'s defensive re-dispatch (~line
  2198, the "did the enqueue call survive a mid-process crash" safety net)
  — same conditional swap.

Once a bounded stage is queued, **`lease-extraction-worker/index.ts`**'s new
stage-dispatch branch (`isEnrichBoundedStageName(currentStage)`, ~line 2225,
sitting directly above the existing `"enrich"` branch it does not touch)
runs exactly once per invocation: cancellation check → `callInternalFunction("normalize-pdf-output", {file_id, pipeline_job_id, generation_id, worker_attempt, mode: currentStage}, orgId, BOUNDED_ENRICH_STAGE_TIMEOUT_MS)`
→ on success or failure, `completeBoundedEnrichStage()` (shared, one
implementation, not 9 hand-copied blocks) either enqueues the next stage or
marks the job/payload failed. **This branch never loops through the
sequence itself** — each invocation dispatches one stage and returns; the
chain advances only because each completion enqueues a fresh,
independent `pipeline_jobs` row + worker invocation, exactly the
"new row, new invocation" pattern the old `"enrich"` dispatch already used.
This is what makes the chain resumable across crashes by construction, with
no new resume-tracking logic needed.

On the `normalize-pdf-output` side, `Deno.serve`'s top-level dispatch
(~line 3233) routes any of the 10 stage-name `mode` values to the new
`handleBoundedEnrichStage()` handler, sitting alongside (not replacing) the
existing `if (mode === "enrich")` branch.

### 7.4 Persistence locations

No new table, no new column — both additive to `uploaded_files` columns
already used for cross-stage handoff:

- **`normalized_output.metadata.extractionDebug.bounded_stage_results`**
  (new sub-object) — one entry per stage,
  `{status, generation_id, stage_version, completed_at, data, limits_hit, error_code, error_message}`
  (`stage-persistence.ts`). `isStageAlreadyCompleted()` is the idempotency
  guard every stage handler calls before doing any work: reusable only when
  the stored entry's `generation_id` AND `stage_version` (`STAGE_RESULT_VERSION = "v1"`,
  bumped whenever stage logic changes in a way that invalidates old
  results) both match — never mixes results across generations, never
  silently reuses a result computed by now-different logic.
- **`ui_review_payload`** — untouched by every stage except
  `enrich_truth_assembly`, which is the only stage that overwrites it with
  the rich canonical payload (the minimal payload normalize already
  persisted stays reviewer-visible and diagnostic for every stage in
  between).
- **`extractionDebug.merged_field_sources`** — the pre-existing shape
  `assembleCanonicalFields()` already consumes. `mergeBoundedStageResult()`
  supports merging a stage's own field-level contributions into it
  (`fieldContributions` parameter), but **honestly: no current stage
  actually populates it** — none of the 10 stages discover a NEW raw field
  value beyond what normalize's own LLM/rule extraction already put in the
  row; they only derive workflow-abstraction structures and verify evidence
  for values that already exist. `truthAssemblyCanonicalFields` is instead
  recomputed fresh, cheaply, at the top of every stage invocation from the
  row + normalize's own already-persisted `merged_field_sources` — proven
  cheap (schema-sized, not document-sized) and confirmed correct by the
  byte-equivalence test (§7.6). The `fieldContributions` merge path exists
  and is exercised by unit tests, but is currently dead code in practice —
  flagged here rather than left to look more wired than it is.

### 7.5 Limits and failure behavior

`_shared/extraction/enrich-stage-limits.ts` checks
`{textBlockCount, fullTextChars, pageCount}` against per-stage limits before
any stage does real work (`enrich_clauses`/`enrich_fields`: 2,500 blocks /
150,000 chars / 80 pages; everything else: 4,000 / 250,000 / 120 — initial
estimates, not measured, since Deno exposes no precise per-invocation memory
stats; see `telemetry.ts` for what IS measured). **Per the user's explicit
requirement, exceeding a limit does NOT fall back to whole-document
processing.** Real bounded-slice splitting (process a page/block range,
persist it as `"incomplete"`, re-enqueue the same stage for the next range)
is **deliberately not implemented in this change-set** — an oversized stage
fails explicitly with `BOUNDED_STAGE_LIMIT_EXCEEDED` (HTTP 422), a plain
terminal failure, never silently downgraded.

Generation fencing is checked twice per stage (`checkGenerationStillActive()`,
one shared helper replacing 3 previously-duplicated ad hoc checks): once
before loading any data, once again immediately before persisting — a
newer generation starting mid-computation is caught by the second check and
nothing is written. `completeBoundedEnrichStage()` is the one shared
failure handler (replacing what would otherwise be 9 hand-copied ~100-150
line blocks): any `ok:false` outcome — including `limitExceeded`,
`DOWNSTREAM_FUNCTION_FAILED` (546-shaped), schema failures, and persistence
failures — marks the `pipeline_jobs` row `"failed"` with the **original**
error code/message preserved verbatim, sets `ui_review_payload.enrichment_status = "failed"`
(never `"completed"`/`"completed_with_warnings"`), blocks any further stage
from enqueueing, and re-runs `finalize_lease_extraction_for_review` so
approval-time readiness re-evaluation sees the failure. Per the user's
explicit, repeated instruction, this RPC call still passes
`p_package_mode`/`p_financial_mode` (`completion.ts`'s
`callFinalizeExtractionReadiness()`) even though the live deployed function
doesn't yet accept them (the same pending mismatch `FAILED_EXTRACTION_ROOT_CAUSE.md`
documents) — the mismatch stays visible everywhere this RPC is called
rather than being quietly special-cased away here.

### 7.6 Bugs found and fixed while proving this (all real — the byte-equivalence test earned its keep)

`_tests/enrich-bounded-stages.test.ts` asserts the bounded chain's final
output is byte-equivalent to the monolithic `buildReviewPayload()` call for
an identical fixture. Three real divergences were caught and fixed while
getting that assertion to pass:

- **Workflow-abstraction stages were reading the wrong row.**
  `buildReviewPayload()`'s monolithic path always feeds `buildLeaseWorkflowAbstraction()`
  the row with Lease Truth Assembly's canonical overrides already applied
  (`truthAssemblyEffectiveRows`, per an existing in-code comment: "so the
  frontend's fallback hierarchy doesn't show an un-reconciled value").
  `handleBoundedEnrichStage()` initially passed the raw row to stages 2–4,
  producing subtly wrong output (caught via
  `profile_detection_signals.context_text_chars`/`unmapped_items_count`
  mismatches). Fixed by computing the same "effective row" once, near the
  top of the handler, and using it for stages 2–4 — while correctly leaving
  the evidence-domain/remainder stages on the RAW row, matching
  `buildReviewPayload`'s own evidence loop (whose Lease Truth Assembly
  override happens later, per-field, inside `buildStandardFieldsForEntries`
  itself).
- **Pooling the 5 domain stages + remainder did not restore schema field
  order.** Concatenating `[...evidenceByDomain.flat(), ...remainderFields]`
  in dispatch order produces the right SET of fields but in the wrong
  ORDER — the monolithic single-pass loop always emits fields in the
  schema's declared order. Fixed with a new shared helper,
  `reorderStandardFieldsBySchema()` (`domain-fields.ts`), used identically
  by both `handleBoundedEnrichStage`'s `enrich_truth_assembly` case and the
  test's own pooling helper — keeps the reviewer-facing field order stable
  regardless of which stage produced a given field.
- **A blank `"notes"` field's CAM-sentence fallback was silently dropped.**
  `buildReviewPayload()`'s row loop has a lease-specific fallback,
  independent of `buildStandardFieldsForEntries()`: when `values.notes` is
  blank, `extractCamNoteFromText(doclingRaw)` pulls a CAM sentence directly
  from the document text. This lives in `buildReviewPayload`'s own
  `rows.map()`, so it never ran for the bounded evidence-domain/remainder
  stages, which build their own local `values` independently. The schema's
  `notes` field is deliberately `extractionMode: "human_only"` with no
  labels (by design, to avoid false-positive matches — see its schema
  comment), so this omission wasn't a validation-safety issue, but it was a
  real, silent feature regression for lease documents. Fixed by applying
  the identical `extractCamNoteFromText` fallback at both bounded call
  sites (and the test's own pooling helper) — `extractCamNoteFromText` and
  `isBlank` are now exported via `__test__` so the test reuses the exact
  production logic rather than re-implementing the regex.

A stale doc comment in `enrich-stage-limits.ts` describing a "slice and
re-enqueue" splitting behavior that was never implemented (superseded by
the plain `BOUNDED_STAGE_LIMIT_EXCEEDED` terminal failure, per §7.5) was
also corrected to match actual behavior.

### 7.7 Test results

- **`_tests/lease-workflow-stage-split.test.ts`** (4 tests) — each of the 4
  workflow-abstraction stage functions produces output identical to running
  today's single `buildLeaseWorkflowAbstraction()` call, plus a shape-stability
  regression anchor.
- **`_tests/enrich-evidence-domain-split.test.ts`** (5 tests) — the 5
  `LlmCallDomain` buckets partition the lease schema with no field claimed
  twice and none dropped; pooling all 5 + the remainder reproduces the
  unrestricted evidence loop's output field-for-field.
- **`_tests/enrich-bounded-stages.test.ts`** (17 tests) — all scenarios
  from the required list: exact stage order and traversal; exactly one
  stage advances per invocation; a completed stage is reused idempotently
  and rejects a generation/version mismatch; resuming from an
  already-persisted earlier stage without recomputing it; a terminal
  failure enqueues nothing further; a stale generation (both pre- and
  post-compute) persists nothing; duplicate dispatch returns the existing
  job, not a second row; an oversized stage input fails explicitly with
  `BOUNDED_STAGE_LIMIT_EXCEEDED` with zero partial persistence; the mode
  flag defaults `"off"`; `enrich_truth_assembly`'s completion enqueues
  nothing further; the byte-equivalence gate (§7.6, including truth-assembly
  markers on the pooled output); pooled evidence spans all 5 domains; a
  546-shaped failure is a plain terminal failure with the original error
  preserved and `enrichment_status` never softened to
  `"completed_with_warnings"`; canonical-only reconstruction makes zero
  Azure/zero OpenAI calls.
- **Regression baseline** — the extraction-pipeline-relevant existing suite
  (`lease-truth-assembly*.test.ts`, `adaptive-extraction-*.test.ts`,
  `openai-fact-ledger.test.ts`, `lease-extraction-worker-reconciliation.test.ts`,
  `business-extraction-mock-gate.test.ts`,
  `business-extraction-provider-default-failsafe.test.ts`,
  `lease-assignment-semantic-extraction.test.ts`) run together with all 3
  new files: **134 passed, 0 failed**.
- **`deno check`** on every modified/new file (`normalize-pdf-output/index.ts`,
  `lease-extraction-worker/index.ts`, `lease-workflow.ts`,
  `generation-fence.ts`, `enrich-stage-limits.ts`, every file under
  `enrich-bounded-stage/`, and all 3 new test files): clean, zero errors.
- **Not run**: the repo's full `_tests/` directory as one invocation fails
  ~400 pre-existing tests with `createClient(...)` errors (`SUPABASE_URL`
  and friends are unset in this sandbox — no live Supabase connection
  exists here; see the earlier "Full product audit" finding this repo
  already has on file). Confirmed these are pre-existing and
  environment-only, not caused by this change: none are in files this pass
  touched, and every one fails identically with `git stash` applied to
  every change in this section.

### 7.8 What was deferred, and why (same honesty standard as §4/§6.5)

- **Real bounded-slice splitting for oversized single-stage input** — not
  built (§7.5). An oversized document fails loudly instead, which is safe
  but not yet a complete fix for the very largest documents; real slicing
  is real, separate work.
- **`"shadow"` mode's dual-run comparison** — `ENRICH_BOUNDED_STAGE_MODE`
  defines three values (`feature-mode.ts`), but only `"active"` is actually
  consulted at either dispatch site; `"shadow"` currently behaves exactly
  like `"off"`. The flag value exists and is tested
  (`getEnrichBoundedStageMode()`'s own unit test), but the "run both, log a
  comparison, don't yet trust the new path" behavior the flag's own doc
  comment describes is not wired to anything yet — flagged here rather than
  implied to work.
- **Per-stage `merged_field_sources` contribution** — the merge mechanism
  exists (`mergeBoundedStageResult`'s `fieldContributions` parameter) but no
  current stage populates it (§7.4) — there is currently nothing for it to
  contribute, since no bounded stage discovers a field value normalize
  didn't already extract. Worth revisiting if a future stage ever needs to
  add new field-level facts mid-chain.
- **Telemetry is logged, not aggregated.** `startBoundedStageTelemetry()`
  produces a real per-stage record (byte counts, duration, best-effort
  `Deno.memoryUsage()`) passed to `logger.event()`, but nothing yet reads it
  back into a dashboard or a stored rollup — it exists to make a future
  "which stage actually needs splitting" decision possible, not to answer
  it yet.
- **Real-document validation** — same constraint as §3/§6.3: no live Azure/
  OpenAI credentials in this sandbox, so no genuine 546-prone document has
  been run through the bounded chain end-to-end. The byte-equivalence test
  proves the bounded chain computes the SAME thing the monolithic path
  does for a fixture small enough to run both ways in a test process; it
  cannot itself prove the bounded chain avoids 546 on a real oversized
  document — that requires the live run in §7.9.

### 7.9 Remaining remote prerequisites (nothing in this list has been done)

1. **Push the migration**: `supabase/migrations/20260880000000_enrich_bounded_stage_names.sql`
   widens `pipeline_jobs_stage_check` to allow the 10 new stage names
   (`enrich` itself stays allowed). Required before `ENRICH_BOUNDED_STAGE_MODE`
   can be set to anything other than `"off"` in that environment — without
   it, `enqueue_pipeline_job` will reject every bounded-stage row with a
   constraint violation.
2. **Deploy the 2 modified Edge Functions** (`normalize-pdf-output`,
   `lease-extraction-worker`) plus the new shared modules under
   `_shared/extraction/enrich-bounded-stage/`, `generation-fence.ts`, and
   `enrich-stage-limits.ts`.
3. **Set `ENRICH_BOUNDED_STAGE_MODE=active`** as a runtime secret in the
   target environment once (1) and (2) are done — until set, the deployed
   code behaves identically to today (flag defaults `"off"`), so deploying
   alone is safe and reversible.
4. **Validate against a real 546-prone document** (§7.8's last point) before
   trusting this in production — the concrete next step, same shape as
   §6.6's recommendation for the Section-Aware Candidate Router.
5. Tune `enrich-stage-limits.ts`'s per-stage limits once real telemetry
   (§7.8) exists from that validation run — the current numbers are
   estimates.

No deployment, migration push, or remote action was taken in this pass.
