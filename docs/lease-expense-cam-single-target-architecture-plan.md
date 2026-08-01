# Lease, Expense, and CAM Single Target Architecture Plan

Date: 2026-08-01

## Executive decision

The product should have exactly two lease extraction modes:

1. `llm_primary`
   - The normal production path.
   - Uses document parser output plus whole-document LLM extraction.
   - Produces the canonical lease review schema, review payload, expense rules, CAM obligations, provenance, and evidence.

2. `typescript_schema_fallback`
   - The only fallback path.
   - Disabled by default in production.
   - Runs only after `llm_primary` fails in an explicitly fallback-eligible way.
   - Must produce the same canonical schema shape as `llm_primary`.
   - Must mark every run and every derived field/rule as fallback.

Everything else should be treated as legacy compatibility, migration support, debug tooling, or dead code until proven otherwise.

## Target lease extraction architecture

The production path should be:

```text
File upload
  -> upload-handler / confirm-upload
  -> ingest-file
  -> parser/OCR stage
  -> normalize-pdf-output
  -> runLeaseBusinessExtraction
  -> llm_primary
  -> canonical lease review payload
  -> Lease Review UI
  -> approve-lease-workflow
  -> approved lease abstract snapshot
  -> approved lease expense/CAM rule set
```

The fallback path should be:

```text
llm_primary failure
  -> acceptance classifier says fallback_eligible
  -> LEASE_ENABLE_TYPESCRIPT_SCHEMA_FALLBACK=true
  -> typescript_schema_fallback
  -> same canonical lease review payload
  -> UI shows fallback state clearly
  -> approval requires reviewer confirmation
```

There should be no direct UI fallback path, no hidden regex extraction path, no legacy hybrid provider as a normal provider, and no CAM/expense rule projection that looks authoritative without provenance.

## Step 1 - Rename and centralize provider policy

Problem:

- The current live provider name still uses compatibility language such as `openai_primary_legacy_fallback`.
- This makes the architecture hard to reason about and keeps old paths mentally alive.
- `leaseLegacyFallbackEnabled()` currently returns `true`, which contradicts the architecture docs and test intent.

Implementation:

1. Add a central policy file, for example:

```text
supabase/functions/_shared/extraction/lease-extraction-policy.ts
```

2. Define only these public modes:

```ts
export const LEASE_EXTRACTION_MODE_LLM_PRIMARY = "llm_primary";
export const LEASE_EXTRACTION_MODE_TYPESCRIPT_SCHEMA_FALLBACK = "typescript_schema_fallback";
```

3. Replace direct environment checks with:

```ts
export function leaseTypescriptSchemaFallbackEnabled(): boolean {
  return Deno.env.get("LEASE_ENABLE_TYPESCRIPT_SCHEMA_FALLBACK") === "true";
}
```

4. Keep old env var support for one release only:

```ts
const legacyFlag = Deno.env.get("LEASE_ENABLE_TYPESCRIPT_LEGACY_FALLBACK") === "true";
```

5. Log a warning when the old flag is used.

6. Update `business-extraction-orchestrator.ts` so fallback is not unconditional.

Acceptance criteria:

- With no env var set, a failed LLM extraction cannot run the TypeScript fallback.
- With `LEASE_ENABLE_TYPESCRIPT_SCHEMA_FALLBACK=true`, fallback can run only after an accepted fallback-eligible LLM failure.
- Tests explicitly cover both states.

Primary files:

- `supabase/functions/_shared/extraction/business-extraction-orchestrator.ts`
- `supabase/functions/_shared/extraction/lease-extraction-strategy.ts`
- `supabase/functions/_tests/business-extraction-orchestrator.test.ts`

## Step 2 - Create one lease extraction entry point

Problem:

- Multiple modules can still look like extraction authorities.
- The UI and downstream workflows have to understand too many historical shapes.

Implementation:

1. Introduce one public lease extraction function:

```ts
runLeaseBusinessExtraction(request): Promise<LeaseExtractionResult>
```

2. Make it the only function allowed to publish business extraction results for leases.

3. The result must always include:

```ts
{
  extraction_mode: "llm_primary" | "typescript_schema_fallback",
  schema_version: "lease_review_v1",
  provider_run_id: string,
  fallback_used: boolean,
  fallback_reason: string | null,
  fields: LeaseReviewField[],
  expense_rules: LeaseExpenseRule[],
  cam_profile: LeaseCamProfile,
  evidence: EvidenceReference[],
  warnings: string[]
}
```

4. Keep compatibility adapters internal. Do not allow UI or approval code to branch on old raw provider names.

Acceptance criteria:

- `normalize-pdf-output` calls the single lease extraction entry point.
- No frontend file calls or reconstructs raw extraction provider output.
- Approval reads canonical review payload only.

Primary files:

- `supabase/functions/normalize-pdf-output/index.ts`
- `supabase/functions/_shared/extraction/business-extraction-orchestrator.ts`
- `supabase/functions/_shared/extraction/lease-module.ts`
- `src/services/leaseAbstractService.js`
- `src/pages/LeaseReview.jsx`

## Step 3 - Make TypeScript fallback schema-based, not hybrid-shaped

Problem:

- The fallback path still behaves like a legacy hybrid of rules, tables, regex, and older LLM assumptions.
- That is useful for recovery, but dangerous if it publishes values that look normal.

Implementation:

1. Move fallback code behind a named adapter:

```text
supabase/functions/_shared/extraction/typescript-schema-fallback/
```

2. Its only output should be the same `LeaseExtractionResult` shape used by the LLM path.

3. Remove or quarantine any fallback function that returns raw legacy shape directly to the UI.

4. Field-level fallback rules:

- Every field must have page/evidence where possible.
- Fields without evidence must be `needs_review`, not resolved.
- No fallback field can be approval-clean unless reviewed.
- Fallback expense/CAM rules must carry `is_fallback=true`.

5. Add a fallback summary to provenance:

```ts
fallback_summary: {
  enabled_by_env: boolean,
  source: "typescript_schema_fallback",
  resolved_field_count: number,
  unresolved_field_count: number,
  fallback_rule_count: number
}
```

Acceptance criteria:

- Fallback cannot emit a different schema from LLM.
- Fallback cannot hide behind `legacy_hybrid`.
- UI can show a clear fallback banner and per-row fallback badges.

Primary files:

- `supabase/functions/_shared/extraction/pipeline.ts`
- `supabase/functions/_shared/extraction/business-extraction-orchestrator.ts`
- `supabase/functions/_shared/extraction/business-extraction-acceptance.ts`

## Step 4 - Remove UI-side extraction fallbacks

Problem:

- Core field no-provider fallbacks are mostly disabled, but expense/CAM rows can still be synthesized in the frontend.
- This causes the UI to show inaccurate extracted data even when canonical extraction did not prove it.

Implementation:

1. Remove automatic use of `normalizeExpenseRuleFallback()` for production review data.

2. Keep it only as a diagnostic helper behind an explicit debug flag, for example:

```ts
allowDiagnosticFallbackRows: false
```

3. Update CAM/expense review panels to distinguish:

- `llm_primary`
- `typescript_schema_fallback`
- `manual`
- `missing`

4. If no approved or extracted rules exist, show an empty review state instead of guessed rows.

5. Add a visible provenance badge for every CAM/expense rule row.

Acceptance criteria:

- UI never creates business facts from parsed text by default.
- If a row appears, the row has a source: LLM, TypeScript fallback, approved, or manual.
- CAM rules panel does not silently populate from fallback rows when DB-backed rules are absent.

Primary files:

- `src/lib/leaseReviewFieldNormalizer.js`
- `src/components/lease-review/CamExpenseRulesPanel.jsx`
- `src/components/lease-review/SpecializedTables.jsx`
- `src/lib/leaseFieldResolver.js`
- `src/pages/LeaseReview.jsx`

## Step 5 - Make approval the authority boundary

Problem:

- Approval currently materializes approved abstracts and expense rules, but it can still project fallback rules from workflow evidence.
- That makes approval look cleaner than the extraction confidence may justify.

Implementation:

1. Approval should publish only:

- LLM primary rules approved by reviewer.
- TypeScript fallback rules explicitly approved by reviewer.
- Manual reviewer-created rules.

2. Remove automatic publisher fallback from source-backed clauses unless it creates `needs_review` draft rows only.

3. Store rule source:

```ts
rule_source: "llm_primary" | "typescript_schema_fallback" | "manual"
```

4. Store rule approval state:

```ts
approval_state: "draft" | "approved" | "rejected" | "needs_review"
```

5. Do not send draft/fallback rules to CAM until approved.

Acceptance criteria:

- `approve-lease-workflow` cannot publish fallback-generated rules as clean approved rules without reviewer action.
- CAM receives only approved rules.
- Tests prove fallback rules remain review-required.

Primary files:

- `supabase/functions/approve-lease-workflow/index.ts`
- `supabase/functions/_shared/approved-lease-expense-rules.ts`
- `src/services/leaseExpenseRuleService.js`

## Step 6 - Move expense classification authority server-side

Problem:

- Expense matching/scoring still lives in client-side `expenseService.js`.
- Persistence is server-owned, but the classification decision is not fully server-owned.

Target architecture:

```text
Approved expenses
  -> server-side classify-expenses function
  -> expense_classifications
  -> reviewer finalization
  -> send-expense-classification-to-cam
```

Implementation:

1. Create or promote a server function:

```text
supabase/functions/classify-expenses/index.ts
```

2. Move matching/scoring logic from `src/services/expenseService.js` into the function.

3. The frontend should call the function and display results; it should not decide recoverability.

4. Server should read:

- approved actual expenses
- approved lease expense rule sets
- CAM config
- tenant/property context

5. Server should write:

- `expense_classifications`
- audit record
- classification provenance

Acceptance criteria:

- Client no longer computes final classification score/category.
- Server revalidates rule/category/lease relationships.
- Manual overrides are audited.

Primary files:

- `src/services/expenseService.js`
- `supabase/functions/persist-expense-classification/index.ts`
- `supabase/functions/_shared/send-expense-classification-to-cam-workflow.ts`

## Step 7 - Retire legacy `compute-expense` from the active path

Problem:

- `compute-expense` still groups by legacy `expenses.classification` and `lease_config`.
- `CreateBudget.jsx` still invokes it before compute-budget.
- This is a separate path from the newer expense classification workflow.

Implementation:

1. Replace active budget orchestration with:

```text
finalized expense classifications
  -> CAM-ready expense rows
  -> compute-cam
  -> budget computation
```

2. Keep `compute-expense` only as migration/debug code until replacement is complete.

3. Add a deprecation guard:

```ts
COMPUTE_EXPENSE_LEGACY_ENABLED=true
```

4. Default the guard off in production.

5. Remove `compute-expense` after no active UI or compute orchestration calls it.

Acceptance criteria:

- `CreateBudget.jsx` does not call `compute-expense`.
- Budget inputs come from finalized classifications or CAM snapshots.
- `rg "compute-expense"` shows only migration/tests/docs before deletion.

Primary files:

- `supabase/functions/compute-expense/index.ts`
- `src/pages/CreateBudget.jsx`
- `supabase/functions/_shared/compute-orchestrator.ts`

## Step 8 - Make CAM consume only approved inputs

Problem:

- CAM is closer to the right target, but it has multiple authorities: approved lease rules, manual CAM config, CAM-ready classifications, and UI evidence fallbacks.

Target architecture:

```text
Approved lease expense/CAM rules
  + finalized CAM-ready expense classifications
  + explicit manual CAM inputs/config
  -> compute-cam
  -> CAM snapshot
  -> CAM UI
```

Implementation:

1. Define precedence:

```text
manual override
  > approved lease rule
  > finalized expense classification
  > missing / needs review
```

2. `compute-cam` should reject or flag unapproved fallback rules.

3. CAM UI should display source per amount/rule:

- approved lease rule
- manual override
- finalized classification
- missing

4. UI should not recompute authoritative CAM amounts client-side.

Acceptance criteria:

- CAM snapshot explains source and confidence for each recoverable line.
- Unapproved fallback rows cannot enter tenant billing/recovery.
- Manual overrides are visible and audited.

Primary files:

- `supabase/functions/compute-cam/index.ts`
- `src/components/cam/CAMReviewTab.jsx`
- `src/services/camConfig.js`

## Step 9 - Reduce frontend resolver complexity

Problem:

- `leaseFieldResolver.js` and `leaseReviewFieldNormalizer.js` support many historical payload shapes.
- This makes stale or old data hard to distinguish from current canonical data.

Implementation:

1. Move old-shape compatibility into one backend migration/adapter layer.

2. Frontend resolver should read in this order only:

```text
approved snapshot
  -> current canonical review payload
  -> manual edit
  -> missing
```

3. Remove old uploaded normalized/parsed output fallbacks from default display and canonical modes.

4. Add a dev-only diagnostic tab if old payload inspection is still needed.

Acceptance criteria:

- Frontend resolver has fewer source branches.
- No old raw parser payload can become a displayed business value by default.
- Tests document resolver precedence.

Primary files:

- `src/lib/leaseFieldResolver.js`
- `src/lib/leaseReviewFieldNormalizer.js`
- `src/lib/leaseReviewSchema.js`

## Step 10 - Add architecture enforcement tests

Required tests:

1. LLM primary success:

- Does not call TypeScript fallback.
- Emits `extraction_mode=llm_primary`.
- UI receives canonical schema.

2. LLM fallback-eligible failure with fallback disabled:

- Does not call TypeScript fallback.
- Emits manual review or failed extraction state.
- UI does not show guessed fields.

3. LLM fallback-eligible failure with fallback enabled:

- Calls TypeScript fallback once.
- Emits `extraction_mode=typescript_schema_fallback`.
- Marks every fallback field/rule clearly.

4. Expense/CAM rule fallback:

- Fallback rules remain `needs_review`.
- Fallback rules cannot be sent to CAM until approved.

5. UI fallback prevention:

- Empty canonical expense rules means empty UI state, not regex-generated rows.

6. Legacy compute prevention:

- Budget flow does not invoke `compute-expense`.

Primary test areas:

- `supabase/functions/_tests/`
- `src/services/__tests__/`
- `src/lib/__tests__/`

## Step 11 - Cleanup and deletion sequence

Do not delete files first. Delete only after routing and tests prove they are no longer active.

Cleanup order:

1. Stop new writes from old paths.
2. Add deprecation warnings to old paths.
3. Confirm no active imports or function invocations.
4. Run schema, build, and tests.
5. Delete or archive old code.
6. Remove old docs that describe retired behavior.

Likely cleanup candidates after refactor:

| Candidate | Current risk | Delete condition |
| --- | --- | --- |
| `supabase/functions/compute-expense/index.ts` | Legacy expense aggregation path | No UI/orchestrator calls remain; budget uses finalized classifications/CAM snapshots |
| Legacy portions of `supabase/functions/_shared/extraction/pipeline.ts` | Hybrid extraction path can confuse authority | TypeScript fallback adapter produces canonical schema directly |
| Old compatibility provider names in extraction docs/code | Keeps multiple-path mental model alive | New mode names are fully adopted |
| UI fallback branches in `leaseReviewFieldNormalizer.js` | Can synthesize expense/CAM rows | Diagnostic-only path exists and defaults off |
| Old release rollout docs describing hybrid/canonical transition | Docs conflict with target architecture | Replaced by this plan and current runbooks |

Files that should not be deleted until refactored:

| File/folder | Reason |
| --- | --- |
| `supabase/functions/_shared/extraction/openai-fact-ledger/` | Still imported by active orchestration/readiness code |
| `supabase/functions/_shared/extraction/document-intelligence-v3/` | Contains shared review/readiness/persistence logic |
| `src/lib/leaseFieldResolver.js` | Still central to UI display behavior |

## Step 12 - Production rollout plan

1. Release fallback gate fix first.
2. Add telemetry for extraction mode and fallback usage.
3. Disable UI-generated expense/CAM fallback rows.
4. Migrate approval publisher to source-aware rule states.
5. Move expense classification server-side.
6. Remove `compute-expense` from budget flow.
7. Lock CAM to approved inputs only.
8. Delete retired code after two clean releases.

## Required telemetry

Track these counters per org/property/upload:

- `lease_extraction.llm_primary.success`
- `lease_extraction.llm_primary.failure`
- `lease_extraction.typescript_schema_fallback.blocked`
- `lease_extraction.typescript_schema_fallback.used`
- `lease_review.ui_fallback_row.blocked`
- `lease_approval.fallback_rule.approved`
- `lease_approval.fallback_rule.rejected`
- `expense_classification.server_classified`
- `expense_classification.manual_override`
- `cam.unapproved_input_rejected`

## Definition of done

The remediation is complete when:

1. There is one normal lease extraction architecture: LLM primary.
2. There is one fallback architecture: TypeScript schema fallback.
3. Fallback is disabled by default.
4. UI never invents extracted fields or CAM/expense rows.
5. Approval is the authority boundary.
6. Expense classification decisions are server-owned.
7. CAM consumes only approved/finalized/manual-audited inputs.
8. Legacy compute/extraction files are either deleted or isolated behind explicit migration/debug flags.
9. Tests prove the above behavior.

