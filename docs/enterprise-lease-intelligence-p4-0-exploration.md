# Enterprise Lease Intelligence P4.0 Exploration

Date: 2026-07-19
Branch: feature/lease-intelligence-enterprise-p1-p8
HEAD: 5a047ea
Verdict: P4.0 exploration complete; no schema or runtime implementation started.

## Scope

P4.0 is a grounded exploration pass for the deterministic lease dates, term,
rent, and financial-structure layer above immutable P2/P3 claims. It does not
add migrations, production code, provider calls, parser changes, runtime flags,
deployment, remote database writes, CAM/expense-rule implementation, billing,
budget, reconciliation, or Lease Review redesign.

P4 must preserve the core guarantee: no date, rent amount, or financial
schedule may be fabricated merely because nearby numbers make a plausible
calculation. Every output must be explicitly classified as extracted, derived,
calculated, ambiguous, needs_review, manual_required, requires_related_document,
not_present, not_applicable, unreadable, or extraction_failed. Derived and
calculated outputs must carry source claim IDs, source document/generation,
formula, inputs, calculation version, assumptions, unresolved dependencies, and
validation result.

## Preflight And Baselines

Repository state:

- Branch confirmed: `feature/lease-intelligence-enterprise-p1-p8`.
- Working tree before exploration: clean.
- HEAD confirmed: `5a047ea`.
- Branch state: ahead of `origin/feature/lease-intelligence-enterprise-p1-p8` by 14 commits.
- Migration count: 209.
- Latest commits: P3.8 `5a047ea`, P3.7 `07bc65b`, P3.6 `6cf3605`, P3.5 `558c447`, P3.4 `259ef70`, P3.3 `20411f4`, P3.2 `411691f`, P3.1 `c5b33db`, P2.7 `06ea94c`, P2.6 `535876f`, P2.5 `7c7e217`, P2.4 `dbea26e`, P2.3 `285a96d`, P2.2 `bc08e15`, P2.1 `08feabf`.

Version/hash evidence:

- P2 claims version: `lease-claims-v1`.
- P2 claims hash: `4dd86ea371a473e68bb0930b3716740fffdfd3bbcf4979ba2643d9f8e2480a9a`.
- P3 profile version/hash: `lease-document-profiles-v1` / `82d6bf7b41219cd281f96e9e18f3db544d848766afefdd5f5c8474a29cd20845`.
- P3 relationship version: `lease-document-relationships-v1`.
- P3 package resolution version: `lease-package-resolution-v1`.
- P3 package projection version: `lease-package-projection-v1`.

Feature defaults:

- `LEASE_CLAIMS_LEDGER_MODE` unset resolves to `off`.
- `LEASE_DOCUMENT_PACKAGE_MODE` unset resolves to `off`.

Verification run during P4.0:

- `bash scripts/db-reset-two-lanes.sh remote-parity`: PASS, exit code 0.
- `bash scripts/db-reset-two-lanes.sh full-repository`: PASS, exit code 0.
- P3.8 focused suite: `4 passed | 0 failed`.
- P1 provenance tests: `38 passed | 0 failed`.
- P2 projection tests: `18 passed | 0 failed`.
- Bounded P0-P3 backend regression: 31 files, `258 passed | 0 failed`.
- Frontend Vitest: 62 files / 685 tests PASS.
- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS, with existing Vite dynamic-import/chunk-size warnings only.

Inherited all-files backend blocker:

- Command: `docker run --rm -v "${PWD}:/work" -w /work denoland/deno:2.7.12 test --no-lock --allow-read --allow-write --allow-env --allow-net --allow-run --allow-import supabase/functions/_tests`
- Result: exit code 1 before test execution.
- Classification: inherited pre-execution TypeScript type-check blocker in `supabase/functions/_tests/update-lease-extraction-field.property.test.ts`, where `SUPABASE_URL`, `SERVICE_ROLE_KEY`, and `ANON_KEY` are typed as `string | undefined` at call sites requiring `string`.
- P4.0 assessment: unchanged inherited all-files-suite blocker; no unexplained new baseline failure was observed.

No Azure, Vertex, Gemini, Docling, parser, provider, deployment, production push,
remote database write, or real-document provider regression was performed.

## 1. Existing Date Fields, Tables, Services And Calculations

Current date fields are primarily scalar lease columns and compatibility fields:
`lease_date`, `start_date`, `end_date`, `commencement_date`,
`expiration_date`, `rent_commencement_date`, `lease_term_months`,
`assignment_effective_date`, `option_exercise_deadline`,
`renewal_notice_months`, `termination_notice_months`,
`tenant_signature_date`, and `landlord_signature_date`.

The frontend and backend field contracts both register the main date concepts in
`src/lib/leaseFieldContract.js` and
`supabase/functions/_shared/extraction/field-contract.ts`. The contracts support
fixed scalar values and aliases such as `start_date` versus
`commencement_date`, but they do not model event-based expressions, relative
dates, alternatives, recurring deadlines, formula inputs, or unresolved date
dependencies.

Date normalization exists in:

- `src/components/lease-review/utils/criticalDates.js`.
- `src/components/lease-review/utils/crossFieldValidator.js`.
- `supabase/functions/_shared/lease-approval-workflow.ts`.
- `supabase/functions/_shared/rent-schedule.ts`.
- `src/pages/RentProjection.jsx`.

The current code can parse fixed dates, derive rough notice-day values from
days/months/years text, and compare date spans. Formula/input provenance is not
persisted for those derived dates.

## 2. Existing Critical-Date Lifecycle

`supabase/migrations/20260514130000_lease_critical_dates.sql` creates
`public.lease_critical_dates` with `date_type`, `due_date`, owner/status fields,
`reminder_days_before`, note, source, timestamps, RLS, and uniqueness by
`(lease_id, date_type, due_date)`.

The table supports operational tracking of due dates, but it stores resolved
dates only. It does not preserve:

- expression type;
- anchor event or anchor claim;
- source claim IDs;
- formula;
- inputs;
- calculation version;
- assumptions;
- unresolved dependency state;
- package-effective source identity.

Approval creates derived critical-date rows through
`supabase/functions/_shared/lease-approval-workflow.ts`. Frontend utility
`src/components/lease-review/utils/criticalDates.js` mirrors similar logic for
display. Both paths can flatten expressions into dates.

Lossy behavior found:

- `correctSuspiciousExpiration` can roll an expiration date forward by years
  when the span appears too short relative to a term-month value.
- `toNoticeDays` converts months to `months * 30` and years to `years * 365`.
- Renewal notice deadlines become fixed dates by subtracting day counts from
  expiration.

Those behaviors are useful advisory heuristics today, but P4 should not treat
them as authoritative calculation records without source claims, formulas,
inputs, assumptions, and validation state.

## 3. Existing Rent Fields, Schedules And Calculations

Scalar rent and charge fields exist on `leases` and in the extraction contracts:
`monthly_rent`, `annual_rent`, `rent_per_sf`, `billing_frequency`,
`escalation_rate`, `escalation_type`, `escalation_timing`,
`security_deposit`, fee amount fields, `ti_allowance`, `free_rent_months`,
`assignment_consideration`, `amended_base_rent_for_additional_year`,
`renewal_options`, `renewal_type`, `renewal_notice_months`,
`holdover_rent_multiplier`, `renewal_escalation_percent`,
`base_rent_monthly`, `rent_due_day`, `rent_frequency`, and
`rent_payment_timing`.

`supabase/migrations/20260516153000_rent_schedule_authority_and_permission_fix.sql`
creates `public.rent_schedules`. It has approved period rows with
`row_type`, `phase`, `charge_frequency`, period dates, monthly/annual/PSF
amounts, RSF, proration, abatement, escalation fields, approval fields, source,
assumption reason, notes, and metadata.

This table is the strongest existing schedule surface. It is still not a full
P4 contract because it lacks first-class:

- source claim IDs and package-effective claim IDs;
- source document/generation identity;
- date expression IDs;
- formula/input records;
- calculation version;
- unresolved dependency records;
- conflict records;
- validation status distinct from row approval status;
- schedule run/version table;
- charge-definition versus charge-period separation.

`supabase/functions/_shared/rent-schedule.ts` generates approved rent schedule
rows from approved lease fields. It chooses monthly rent first, then annual/12,
then PSF * RSF / 12, then ground rent. It applies free rent as the first N
months, applies scalar escalation settings, and adds simple monthly ground-rent
or percentage-rent rows when scalar fields are present.

Current risk: a stated monthly rate, annualized run rate, or PSF value can
become a period schedule without preserving the exact legal basis that made
that schedule valid.

## 4. Existing Financial Charge Structures

Existing structures are mixed between scalar lease fields, `rent_schedules`,
`revenues`, `budgets`, CAM tables, and Lease Review compatibility rows.

Current support:

- base rent through scalar fields and `rent_schedules`;
- ground rent and percentage rent as simple extra recurring monthly rows in the
  rent schedule helper;
- security deposit as a scalar rent/charges field;
- fee fields as individual scalar amounts;
- TI allowance as a scalar field;
- free-rent month count as a scalar field;
- escalation type/rate/timing as scalar fields.

Current gaps for P4:

- no general charge-definition table;
- no charge-period table separate from rent periods;
- no one-time versus recurring charge lifecycle;
- no prepaid-rent treatment;
- no amortized improvement/equipment charge model;
- no formula/input provenance for calculated charges;
- no explicit split between deposit, base rent, CAM components, prepaid amounts,
  and recurring additional rent;
- no bounded-period rent addendum/amendment schedule layer.

P5 owns CAM and recoverability logic. P4 should only model non-CAM financial
charges needed to keep rent/date/term truth deterministic and provenance backed.

## 5. Downstream Consumers

Important current consumers:

- `supabase/functions/approve-lease-workflow/index.ts` approves abstract data and
  triggers rent schedule generation through `compute-lease`.
- `supabase/functions/compute-lease/index.ts` ensures approved rent schedules,
  computes lease projections, and saves computation snapshots with source tables
  `leases` and `rent_schedules`.
- `src/pages/RentProjection.jsx` computes live approved-lease statistics from
  approved scalar fields and displays snapshot outputs when available.
- `supabase/functions/compute-revenue/index.ts` calculates base rent from
  `leases.monthly_rent`.
- `supabase/functions/compute-budget/index.ts` consumes revenue snapshots and
  falls back to `leases.monthly_rent` when needed.
- `supabase/functions/generate-budget/index.ts` expects lease annual rent.
- Frontend revenue and charge preview components often use `monthly_rent`,
  `annual_rent`, or derived annual/monthly fallbacks.

P4 active mode would need a compatibility layer so downstream consumers can
migrate from scalar lease fields without silent fallback or double-counting.

## 6. P2 Registered-Concept Coverage And Gaps

Registered and broadly sufficient for scalar fact extraction:

- `lease_date`;
- `start_date`;
- `end_date`;
- `commencement_date`;
- `expiration_date`;
- `rent_commencement_date`;
- `assignment_effective_date`;
- `option_exercise_deadline`;
- `monthly_rent`;
- `annual_rent`;
- `rent_per_sf`;
- `billing_frequency`;
- `security_deposit`;
- individual fee amount fields;
- `ti_allowance`;
- `assignment_consideration`;
- `amended_base_rent_for_additional_year`.

Registered but too coarse for P4:

- `lease_term_months`: term count only, not a term expression or dependency.
- `renewal_options`: string/summary, not option periods, exercise windows, or
  renewal rent formulas.
- `renewal_notice_months` and `termination_notice_months`: notice period values,
  not notice-window expressions.
- `free_rent_months`: count only, not period rows.
- `escalation_rate`, `escalation_type`, `escalation_timing`: scalar fragments,
  not stepped/CPI/formula schedules.
- `monthly_rent`, `annual_rent`, `rent_per_sf`: values, not a rent schedule or
  billed first-year basis.
- `ti_allowance`: allowance value, not amortized-charge formula.
- `security_deposit`: total amount, not components or source allocation.

Registered under another concept or as aliases:

- `base_rent_monthly` maps into `monthly_rent`.
- `rent_frequency` maps into `billing_frequency`.
- `tenant_rsf`/`rentable_area_sqft` participate in premises/RSF fields.

Dynamic-only or absent for P4:

- date expression rows such as `earlier_of`, `later_of`,
  `relative_to_event`, `notice_window`, and `recurring_deadline`;
- schedule period concepts;
- charge definition concepts;
- prepaid rent;
- amortized improvement charge;
- equipment charge;
- percentage rent formula details;
- CPI index details;
- partial-month and proration expression concepts;
- bounded addendum/amendment rent periods.

Derived/calculated and should not be direct extraction concepts:

- tenant pro-rata share where computed from tenant/building RSF;
- annualized run rate derived from monthly rent;
- monthly rent derived from annualized rent unless the basis is validated;
- rent PSF derived from annual rent and RSF unless the basis is validated.

A separately reviewed P2 registry evolution is required before P4 implementation
for expression, schedule, formula, and charge concepts. P4.0 adds none.

## 7. P3 Package-Effective Claim Suitability

P3 is suitable as the authority source for P4 inputs, with boundaries:

- P3 selects package-effective claims from immutable P2 source claims.
- Amendments can override explicit concepts only.
- Extensions and renewals can affect term concepts.
- Commencement certificates can supply final commencement/rent commencement
  and related term-date facts.
- Assignments preserve economics unless the assignment document explicitly
  supplies an allowed economic concept.
- Missing base documents can produce `requires_related_document`.
- Conflicts are available before compatibility projection and runtime finalizer
  write-back.
- Package modes default off and fail closed when dependencies are invalid.

P4 should run after P3 package-effective resolution/projection, not before it.
P4 should not mutate P2 source claims or historical P3 effective-claim rows.
It should persist its own versioned expression/schedule/calculation records
that reference source claim IDs and package-effective claim IDs.

## 8. Current Incorrect Or Lossy Behaviors

Current behavior that must not become P4 authority unchanged:

- Expiration can be corrected heuristically by rolling the year forward.
- Notice months can be flattened to 30-day months.
- Annual rent can be derived from monthly rent in Lease Review display.
- Rent PSF can be derived from annual rent and square footage in display.
- `baseMonthlyRentFromLease` can treat annual rent or PSF as enough to generate
  a monthly schedule.
- `free_rent_months` becomes the first N months of abatement, even if the lease
  text defined different periods.
- Scalar escalation fields can create long-period escalated monthly rows without
  a formula/input record.
- Revenue and budget paths still rely on scalar `monthly_rent`.

These are acceptable compatibility behaviors but not sufficient for P4 active
authority.

## 9. One-Source Versus Package-Aware Implications

Single-document extraction can provide scalar facts but cannot safely determine
current financial truth when amendments, assignments, renewals, extensions,
commencement certificates, or missing base leases are involved.

Package-aware implications:

- upload order is not financial precedence;
- base economics should be inherited only through package-effective claims;
- amendments must affect only explicit concepts or bounded schedule periods;
- assignments should preserve economics unless explicit economic terms are
  supplied under allowed policy;
- missing base lease must block inherited financial calculations with
  `requires_related_document`;
- open package conflicts must block authoritative calculation;
- final schedule rows must carry source document/generation and package
  resolution identity.

## 10. Proposed Date-Expression Contract

Recommended future contract separates date expressions from resolved dates.

Candidate table family:

- `lease_date_expression_runs`;
- `lease_date_expressions`;
- `lease_date_expression_inputs`;
- `lease_date_expression_conflicts`.

Candidate expression fields:

- `expression_type`;
- `explicit_date`;
- `anchor_concept`;
- `anchor_expression_id`;
- `event_name`;
- `offset_value`;
- `offset_unit`;
- `direction`;
- `business_day_rule`;
- `alternatives`;
- `condition`;
- `source_claim_ids`;
- `source_relationship_ids`;
- `package_effective_claim_ids`;
- `source_document_ids`;
- `source_generation_ids`;
- `resolution_status`;
- `resolved_date`;
- `resolution_formula`;
- `calculation_version`;
- `assumptions`;
- `unresolved_dependencies`;
- `validation_status`;
- `review_status`.

The model can represent:

- fixed assignment effective dates;
- commencement as the earlier of a fixed offset from execution or an event;
- expiration dependent on commencement plus term;
- option notice required before expiration;
- recurring reconciliation deadlines after year-end;
- payment due after statement;
- commencement certificate resolving a previously dependent commencement date.

## 11. Proposed Normalized Rent/Charge Schedule Contract

The existing `rent_schedules` table should be treated as compatibility evidence,
not the full final P4 model. A safer future model is:

- `lease_financial_schedule_runs`;
- `lease_rent_schedules`;
- `lease_rent_schedule_periods`;
- `lease_financial_charge_definitions`;
- `lease_financial_charge_periods`;
- `lease_financial_formulas`;
- `lease_financial_calculation_inputs`;
- `lease_financial_calculation_conflicts`.

Exact names should be confirmed during P4.1/P4.3 before migrations are written.

Rent period fields should include:

- start expression/date;
- end expression/date;
- month range;
- amount;
- frequency;
- basis;
- currency;
- PSF amount;
- rentable area;
- annualized amount;
- billed amount;
- abatement amount;
- escalation method;
- source claim IDs;
- package-effective claim IDs;
- source document/generation;
- formula;
- validation status.

Charge types should include:

- `base_rent`;
- `percentage_rent`;
- `additional_rent`;
- `recurring_charge`;
- `one_time_charge`;
- `deposit`;
- `prepaid_rent`;
- `tenant_improvement_allowance`;
- `amortized_improvement_charge`;
- `equipment_charge`;
- `late_fee`;
- `holdover_rent`.

P4 should not include CAM expense-rule computation.

## 12. Proposed Formula/Input Provenance Contract

Every derived or calculated value needs a durable formula/input record:

- formula key and version;
- human-readable formula text;
- machine-readable formula JSON;
- input claim IDs;
- input expression IDs;
- input schedule-period IDs;
- package resolution/projection IDs;
- source document and generation IDs;
- normalized input values;
- units and basis;
- assumptions;
- unresolved dependencies;
- validation checks and results;
- deterministic engine version;
- idempotency key.

Examples:

- `annualized_rent = monthly_rent * 12` can be advisory, but must not equal
  billed first-year rent without schedule-period evidence.
- `option_notice_due = expiration_date - 180 days` is valid only when both the
  expiration date and 180-day notice requirement are resolved or reviewed.
- `expiration = commencement + 86 months` should remain unresolved when
  commencement is event-based and the event is not resolved.

## 13. Proposed Conflict And Reviewer Contract

P4 conflicts should be separate from P2/P3 conflicts but reference them.

Conflict types should include:

- conflicting source schedules;
- incompatible date expressions;
- ambiguous term dependency;
- missing related document;
- missing formula input;
- unsupported formula;
- annualized-versus-billed ambiguity;
- scalar-field-versus-schedule mismatch;
- package conflict inherited from P3;
- reviewer override required.

Reviewer decisions should:

- select or reject candidate expression/schedule rows;
- approve a manual required value with provenance;
- attach explanation and reviewer identity;
- trigger recalculation into a new P4 run;
- never mutate P2 source claims or historical P3 package-effective claims.

## 14. Proposed Feature-Mode Contract

Recommended server-owned mode:

`LEASE_FINANCIAL_SCHEDULE_MODE=off|shadow|active`

Semantics:

- `off`: zero P4 runtime writes; current behavior unchanged.
- `shadow`: build date expressions and financial schedules; compare against
  current lease fields/rent outputs; no Lease Review or downstream output
  change.
- `active`: versioned P4 schedules become authoritative; no silent fallback;
  unresolved required expressions and conflicts block appropriate readiness or
  approval transitions.

Dependencies:

- `shadow` should require `LEASE_CLAIMS_LEDGER_MODE=shadow|active`.
- `active` should require `LEASE_CLAIMS_LEDGER_MODE=active`.
- Package-aware financial authority should require
  `LEASE_DOCUMENT_PACKAGE_MODE=shadow|active` for packages.
- P4 must not silently enable package mode.
- Browser input must not control this mode.

## 15. Safest Schema Names

Names to validate before implementation:

- `lease_date_expression_runs`;
- `lease_date_expressions`;
- `lease_date_expression_inputs`;
- `lease_date_expression_conflicts`;
- `lease_financial_schedule_runs`;
- `lease_rent_schedules`;
- `lease_rent_schedule_periods`;
- `lease_financial_charge_definitions`;
- `lease_financial_charge_periods`;
- `lease_financial_formulas`;
- `lease_financial_calculation_inputs`;
- `lease_financial_calculation_conflicts`;
- `lease_financial_schedule_reviewer_decisions`.

Naming principles:

- keep P4 tables distinct from P2 claims and P3 package-effective tables;
- include run/version identity;
- preserve source and package references;
- avoid overloading existing `rent_schedules` until a migration path is defined;
- keep compatibility projection fields separate from authoritative schedule
  records.

## 16. Safest Integration Points

Safest future integration points:

- after P2/P3 effective claims are available;
- before final Lease Review compatibility projection in shadow mode;
- after reviewer decision save when recalculation is needed;
- at approval freeze/version boundary;
- before `compute-lease` uses active schedule authority;
- before critical-date dashboard receives derived rows;
- through server-owned Edge Function/RPC boundaries only.

Avoid:

- parser/model/prompt changes;
- provider calls;
- direct browser-controlled calculation authority;
- modifying P2 source claims;
- rewriting P3 package precedence;
- replacing Lease Review UI before a compatibility projection exists;
- redirecting revenue/budget consumers before active-mode acceptance.

## 17. Exact Migrations/Modules Likely Required

Likely migrations:

- P4.1 date-expression run/expression/input/conflict tables and RPC contracts.
- P4.2 term dependency graph tables or extension to date expressions.
- P4.3 base-rent schedule run/schedule/period tables.
- P4.4 financial charge definition/period/formula/input/conflict tables.
- P4.6 compatibility projection tables or projection-run extensions.
- P4.7 runtime/finalizer/RPC write-back contracts and RLS/security grants.

Likely modules:

- `supabase/functions/_shared/extraction/financial-schedule/feature-mode.ts`;
- `supabase/functions/_shared/extraction/financial-schedule/date-expression-types.ts`;
- `supabase/functions/_shared/extraction/financial-schedule/date-expression-resolver.ts`;
- `supabase/functions/_shared/extraction/financial-schedule/term-dependency-graph.ts`;
- `supabase/functions/_shared/extraction/financial-schedule/rent-schedule-types.ts`;
- `supabase/functions/_shared/extraction/financial-schedule/rent-schedule-resolver.ts`;
- `supabase/functions/_shared/extraction/financial-schedule/formula-engine.ts`;
- `supabase/functions/_shared/extraction/financial-schedule/validation.ts`;
- `supabase/functions/_shared/extraction/financial-schedule/projection.ts`;
- `supabase/functions/_shared/extraction/financial-schedule/runtime-orchestrator.ts`;
- focused `_tests` modules for each phase.

Names and exact boundaries should be reviewed at P4.1 start.

## 18. P4.1-P4.8 Refined Sequence

Recommended sequence after repository inspection:

- P4.1: registry and date-expression foundation. Add reviewed P2 registry
  evolution for expression/schedule concepts, feature-mode parser tests, and
  date-expression pure types. No runtime authority.
- P4.2: term and dependency graph. Model initial term, dependent
  commencement/expiration, option windows, notice windows, recurring deadlines,
  unresolved dependencies, and validation states.
- P4.3: base-rent schedule structures. Introduce schedule runs and base-rent
  period records without extra charges or CAM.
- P4.4: additional charges, deposits, and amortization. Add non-CAM charge
  definitions/periods, deposit component support, prepaid amounts, and amortized
  improvement/equipment charge formulas.
- P4.5: deterministic calculation and validation engine. Resolve date
  expressions and financial periods only from validated inputs; classify
  ambiguous/manual-required/unresolved cases.
- P4.6: compatibility projections and diffs. Compare P4 shadow outputs against
  scalar lease fields, existing rent schedules, critical dates, and Lease Review
  compatibility rows.
- P4.7: runtime/finalizer/reviewer integration. Wire server-owned P4 modes,
  reviewer decisions, recalculation triggers, approval freeze/versioning, and
  active readiness blockers.
- P4.8: integrated local closure. Run local DB replay, bounded and full
  regression, mode matrices, no-provider assertions, package scenarios, and
  pre-shadow acceptance readiness.

This sequence is adjusted from the initial candidate only by making P4.1 include
the separately reviewed registry evolution needed for P4 concepts before schema
or runtime work begins.

## 19. Test Strategy

P4 tests should include:

- pure date-expression resolver tests;
- term dependency graph tests;
- rent schedule period construction tests;
- formula/input provenance tests;
- conflict classification tests;
- reviewer decision and recalculation tests;
- package-aware amendment/assignment/commencement-certificate tests;
- compatibility projection diff tests;
- feature-mode matrix tests;
- RPC contract and RLS tests;
- DB replay lanes;
- bounded P0-P4 backend regression;
- full backend regression when the inherited all-files blocker is resolved;
- frontend compatibility tests that do not redesign Lease Review;
- no-provider-call assertions.

Known sanitized business examples to use:

- 86-month term, months 1-2 free, months 3-12 monthly base rent of 6004,
  later scheduled escalations through month 86, 24 dollars PSF starting rate,
  annualized 72048 run rate not treated as billed first-year rent, 2021 CAM
  estimate separate from base rent, 15535.36 deposit components, 12350
  grease-trap amount amortized at 5 percent, 174.55 monthly amortized charge
  beginning month 3, two stated five-year options, conflicting third-option
  table text, and 180-day notice requirement.
- Assignment effective date explicit, economics inherited from base, amendment
  affects only explicit concepts, missing base lease produces
  `requires_related_document`.
- Commencement certificate supplies final commencement while expiration may
  remain dependent on commencement plus validated term formula.

## 20. Stop-Condition Assessment

Stop-condition findings:

- Working tree was clean before P4.0 exploration.
- P3 closure commit `5a047ea` is present.
- No unexplained new baseline failure appeared.
- P4 does not need to mutate P2 source claims.
- P4 does not need to change P3 package precedence.
- Current `rent_schedules` is an existing approved schedule surface, but it is
  not a conflicting complete P4 model. It should be treated as compatibility and
  migration context.
- Date/rent calculation does not require provider calls.
- P4 can distinguish extracted, derived, calculated, ambiguous, needs_review,
  manual_required, requires_related_document, not_present, not_applicable,
  unreadable, and extraction_failed through an explicit contract.
- P4 should not implement CAM/expense rules.
- P4 should not require Lease Review redesign before compatibility projection.
- No remote access, deployment, provider call, or production push was necessary.

P4.0 exploration complete; no schema or runtime implementation started.
