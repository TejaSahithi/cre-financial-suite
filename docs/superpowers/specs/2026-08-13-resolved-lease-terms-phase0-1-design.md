# Resolved Lease Terms Facade — Phase 0 + Phase 1 Design

Status: approved for implementation planning
Scope: Phase 0 (architectural guardrails doc) and Phase 1 (`resolveLeaseTerms` facade) only, from the larger 13-phase CRE financial-platform expansion. Phases 2–13 are out of scope for this spec and must not be started until this phase is implemented, tested, and merged.

## Why

The platform needs a single authoritative way to answer "what lease terms applied on date X, using only approved data" so future financial evaluators (management fee, percentage rent, reconciliation) can consume one trustworthy input instead of each re-deriving lease state from raw extraction data. No such facade exists today. Two things already do related-but-different jobs and must not be duplicated or bypassed:

- **Document-package resolution** (`supabase/functions/_shared/extraction/document-package/`, tables `lease_package_resolution_runs` / `lease_package_projection_runs`) resolves *which document/claim wins* at extraction-review time, before human approval. It's upstream of this facade, not a substitute for it.
- **`src/lib/approvedLeaseSnapshot.js`** (`approvedLeaseFieldValue`) resolves the *current* approved value for a lease field, with no date parameter and no gap/overlap detection.

Neither does date-parameterized resolution over approved data. That's the gap this facade fills.

## Existing architecture this reuses

- **CAM V2 structural pattern** (`supabase/functions/_shared/cam-engine-v2/`): pure calculation functions with no I/O, a separate data-loading/snapshot-building step, a `contracts/` folder for input/output types, `CalculationLine[]` / `CalcException[]` as the audit-trail shape, golden fixture tests with exact `assertEquals`. Confirmed shapes (`contracts/cam-output.ts`):
  ```ts
  export type CalcExceptionSeverity = "blocking" | "review_required" | "warning" | "info";
  export interface CalcException { severity, code, entity_type, entity_id, message }
  export interface CalculationLine { lease_id, pool_id, sequence, line_type, category, formula_code,
    input_amount, output_amount, adjustment, policy_step_id, explanation, segment_start, segment_end, ... }
  ```
- **`rent_schedules`** table (`20260516153000_rent_schedule_authority_and_permission_fix.sql`) — already effective-dated and versioned:
  ```sql
  rent_schedules(id, org_id, lease_id, property_id, building_id, unit_id, abstract_version,
    row_type,        -- base_rent | ground_rent | percentage_rent | abatement | renewal_base_rent | holdover_rent | manual
    phase,            -- contracted | approved_renewal | assumed_renewal | holdover
    charge_frequency, period_start, period_end, monthly_amount, annual_amount, rent_per_sf, rsf,
    is_abatement, abatement_percent, escalation_type/rate/amount/index,
    status,           -- draft | approved | superseded | archived
    source, metadata, ...)
  ```
- **`leases.abstract_snapshot`** — built by `buildAbstractSnapshot()` in `supabase/functions/_shared/lease-approval-workflow.ts`, confirmed shape:
  ```ts
  { version, approved_at, approved_by, source_document: { uploaded_file_id, source_file_name, document_subtype },
    fields: { [key]: entry }, approved: { [key]: entry }, pending_fields, rejected_fields, unmapped_terms }
  // entry = { value, raw_value, source_page, source_text, exact_source_text, confidence_score,
  //           review_status, reviewed_at, reviewer, field_key }
  ```
  This is the exact source-evidence shape the facade reuses for `sourceEvidence[]` — no new evidence model needed.
- **Edge function auth/org boilerplate** (`supabase/functions/_shared/supabase.ts`): `verifyUser(req)`, `getUserOrgId(userId, supabaseAdmin, req)`, `assertPageAccess(req, orgId, pageNames, access)` — same three calls open every write- or read-gated function (confirmed in `compute-budget/index.ts`).
- **Feature-flag convention** (`supabase/functions/_shared/extraction/document-intelligence-v3/feature-flag.ts` and sibling `feature-mode.ts` files): `Deno.env.get`, default-off, tri-state `off|shadow|active` for staged rollouts. Documented for later phases; not instantiated in Phase 0/1 since nothing yet needs gating.
- **Deno test conventions** (`supabase/functions/_tests/cam-engine-v2-golden.test.ts`): fixture builders with sane defaults + spread-overrides, `assertEquals` against exact expected output.

## Phase 0 — Guardrails

Deliverable: `docs/lease-financial-platform-principles.md`, following the existing doc convention (`docs/cam-release-status.md`, `docs/lease-expense-cam-single-target-architecture-plan.md`). Content:

1. Deterministic financial calculations — same approved inputs, same output, always.
2. Frozen inputs — calculations read a snapshot built once by a loader, never re-query mid-calculation. Cites CAM's ADR-CAM-005/006 as prior art.
3. Immutable approved state — approved/posted results change only via new version, recalculation, or explicit approved adjustment.
4. AI-is-not-an-authority boundary — cites `approve-lease-workflow/index.ts` as the existing, working boundary: `llm_primary`/`typescript_schema_fallback` extraction never reaches CAM/budget/this facade until a human approval step writes an `approved` record.
5. External-data provenance (for future BLS/reference-data phases) — provider, series id, observation period, retrieved-at, payload hash, approver.
6. Fail-closed — never substitute zero/false/empty/assumed for missing financial input; raise a named exception instead.
7. Effective dating — every rule that can change over time resolves against the period it applies to, not "latest."
8. RLS / idempotency — restated pointers to the existing conventions (§14/§16 of the architecture map), not new rules.

No feature flag is introduced in this phase — nothing conditionally depends on Phase 1's behavior yet (new, additive, called by nobody in production). The doc states the tri-state convention exists and when to start using it (once an evaluator's output starts affecting a real financial document — starting around Phase 2). No migrations.

## Phase 1 — `resolveLeaseTerms` facade

### Placement

Mirrors CAM's split, because Phase 2's management-fee evaluator needs to import this **in-process**, not over HTTP:

- `supabase/functions/_shared/lease-terms/contracts/resolved-lease-terms.ts` — types (below).
- `supabase/functions/_shared/lease-terms/load-lease-terms-snapshot.ts` — **all I/O lives here**. `loadLeaseTermsSnapshot(supabaseAdmin, { orgId, leaseId }): Promise<LeaseTermsSnapshot>` loads:
  - `leases` row (must match `orgId`; 404 semantics if not — never trust a client-supplied org_id, derive from the authenticated session per `getUserOrgId`), including `abstract_snapshot`, `abstract_version`.
  - **All** `rent_schedules` rows for the lease (not just ones overlapping `asOfDate` — the full history is needed to distinguish "no row ever existed for this date" from "date is outside the lease term" and to build evidence).
  - Existence/status of the lease's expense rule set (`lease_expense_rule_sets` — presence + status only, no CAM recompute).
  - This function does not take `asOfDate` — it loads everything needed to resolve *any* date, so the pure `resolve()` step can be called repeatedly against one loaded snapshot without re-querying (mirrors CAM's "load once, calculate many" pattern, and directly enables tests that hand-build a snapshot fixture and assert against multiple `asOfDate`s).
- `supabase/functions/_shared/lease-terms/resolve.ts` — **pure function**, no I/O:
  `resolveLeaseTerms(snapshot: LeaseTermsSnapshot, asOfDate: string): ResolvedLeaseTerms`
- `supabase/functions/resolve-lease-terms/index.ts` — thin HTTP wrapper: `verifyUser` → `getUserOrgId` → `assertPageAccess(req, orgId, ["Leases", "LeaseReview"], "read")` → `loadLeaseTermsSnapshot` → `resolveLeaseTerms` → JSON response. Exists for future frontend/API use; **no UI page is added in this phase**.

### Contract

```ts
export interface SourceEvidenceRef {
  kind: "abstract_field" | "rent_schedule_row";
  field_key?: string;           // for abstract_field
  rent_schedule_id?: string;    // for rent_schedule_row
  document_id: string | null;   // leases.abstract_snapshot.source_document.uploaded_file_id
  source_page: number | null;
  source_text: string | null;
  abstract_version: number;
  approved_by: string | null;
  approved_at: string | null;
}

export interface UnresolvedTerm {
  term: string;                 // e.g. "rent", "managementFee"
  code: string;                 // e.g. RENT_SCHEDULE_GAP
  message: string;
}

export interface ResolvedLeaseTerms {
  leaseId: string;
  asOfDate: string;
  premises: { propertyId, buildingId, unitId, rsf } | null;
  rent: {
    monthlyAmount: number | null;
    annualAmount: number | null;
    rowType: string;              // base_rent | ground_rent | renewal_base_rent | holdover_rent | manual
    phase: string;
    periodStart: string;
    periodEnd: string;
    abatementApplied: { percent: number | null; monthlyAmount: number | null } | null;
    effectiveDatingSupported: true;
  } | null;
  expenseRecovery: { ruleSetId: string | null; status: string | null; effectiveDatingSupported: false } | null;
  cam: { ruleSetId: string | null; status: string | null; effectiveDatingSupported: false } | null;
  managementFee: Record<string, unknown> | null;      // pass-through from abstract_snapshot.approved, effectiveDatingSupported: false
  percentageRent: Record<string, unknown> | null;      // + a flag noting percentage_rent rows exist in rent_schedules, if any
  taxes: Record<string, unknown> | null;
  insurance: Record<string, unknown> | null;
  utilities: Record<string, unknown> | null;
  hvac: Record<string, unknown> | null;
  renewalOptions: Record<string, unknown> | null;
  reportingRequirements: Record<string, unknown> | null;
  unresolvedTerms: UnresolvedTerm[];
  sourceEvidence: SourceEvidenceRef[];
}
```

### Field-resolution depth (the deliberate v1 boundary)

Only `rent`/`premises` get true as-of-date resolution, because `rent_schedules` is the only source that's actually per-row effective-dated. Every other field group is a pass-through of the current `abstract_snapshot.approved` values, explicitly tagged `effectiveDatingSupported: false` — never presented with false precision. This is a known, stated limitation, not a bug: building real effective-dating for management fee / percentage rent / taxes / insurance / etc. is later-phase work (Phase 2 introduces `lease_percentage_rent_terms`, Phase 7 introduces COI tables, etc.) and must not be pre-built here per the "don't force generic abstractions too early" instruction.

### Rent resolution logic (the one non-trivial algorithm)

`rent_schedules.row_type` multiplexes several concerns onto one table, so naive "any two rows covering the same date = overlap" is wrong — `abatement` and `percentage_rent` rows are *expected* to coexist with a base row on the same dates by design. The resolver partitions by row_type:

- **Base set** (candidates for `rent`): `status = 'approved' AND row_type IN ('base_rent','ground_rent','renewal_base_rent','holdover_rent','manual')`.
  - **Gap**: no row in the base set has `period_start <= asOfDate <= period_end` → `RENT_SCHEDULE_GAP`, `rent: null`.
  - **Overlap**: more than one base-set row covers `asOfDate` → `RENT_SCHEDULE_OVERLAP`, `rent: null` (fail closed — never guess which one wins).
  - Exactly one match → that row is `rent`.
- **Abatement overlay**: if an approved `row_type='abatement'` (or `is_abatement=true`) row also covers `asOfDate`, it's applied as `rent.abatementApplied`, not treated as a competing/overlapping row.
- **Percentage rent**: rows with `row_type='percentage_rent'` are never used to populate `rent`. Their existence is surfaced as informational evidence under `percentageRent` (this facade does not calculate percentage rent — Phase 5 does).
- **Pre-approval dates**: if `asOfDate` predates the lease's earliest `abstract_version`'s `approved_at`, the whole term set is unresolved with `LEASE_NOT_YET_APPROVED_AS_OF_DATE` rather than guessing at draft/extraction data.

### Files

**Create:**
- `supabase/functions/_shared/lease-terms/contracts/resolved-lease-terms.ts`
- `supabase/functions/_shared/lease-terms/load-lease-terms-snapshot.ts`
- `supabase/functions/_shared/lease-terms/resolve.ts`
- `supabase/functions/resolve-lease-terms/index.ts`
- `supabase/functions/_tests/lease-terms-resolve-golden.test.ts`
- `docs/lease-financial-platform-principles.md`

**Modify:** none.

**Untouched:** CAM V2, budget engine, extraction pipeline, document-package resolver, `lease_critical_dates`, notifications, audit, RLS helpers, all frontend routing/pages.

### Migrations

None. Pure read facade over existing tables; no new schema.

### Tests (`supabase/functions/_tests/lease-terms-resolve-golden.test.ts`, Deno, fixture-builder + exact `assertEquals` style matching CAM)

- Happy path: single approved base_rent row covering `asOfDate`.
- Mid-year rent change: two approved base_rent rows, `asOfDate` in each — both resolve correctly.
- Gap: `asOfDate` outside all base-set rows → `RENT_SCHEDULE_GAP`, `rent: null`.
- Overlap: two approved base_rent rows both covering `asOfDate` → `RENT_SCHEDULE_OVERLAP`, `rent: null`.
- Abatement overlay: base_rent + abatement row both covering `asOfDate` → `rent.abatementApplied` populated, no false overlap.
- Percentage rent coexistence: base_rent + percentage_rent row both covering `asOfDate` → no false overlap; `percentageRent` carries the pointer.
- Draft/superseded rows excluded: a `status='draft'` or `'superseded'` row covering `asOfDate` must not be selected.
- Pre-approval date: `asOfDate` before `abstract_snapshot.approved_at` → `LEASE_NOT_YET_APPROVED_AS_OF_DATE`.
- Missing abstract_snapshot fields (e.g. no `managementFee`-related fields ever extracted) → that section is `null`, appears in `unresolvedTerms`, not a thrown error.
- Cross-org isolation (edge function level): org A's JWT requesting org B's `leaseId` → denied, matching the existing convention (verify by reading `approve-lease-workflow.test.ts` or similar for the exact expected status/shape before writing this test).
- Unauthorized page access (edge function level): user without read access to `Leases`/`LeaseReview` → denied via `assertPageAccess`.

### Deployment / config / secrets

- No new secrets (no external calls in Phase 1).
- No RLS policy changes (edge function follows the existing `supabaseAdmin` + application-level org check pattern used by `compute-budget`/`approve-lease-workflow` — confirm the exact mechanism those two functions use for the org check while implementing, and match it exactly rather than inventing a new one).
- One new edge function to deploy after merge: `supabase functions deploy resolve-lease-terms`.

## Known limitations (stated up front, not discovered later)

- `managementFee`, `percentageRent`, `taxes`, `insurance`, `utilities`, `hvac`, `renewalOptions`, `reportingRequirements` are not effective-dated in v1 — they reflect the current approved snapshot regardless of `asOfDate`. Historical reconciliation against a stale value in one of these fields is out of scope until the relevant later phase introduces real modeling for that domain.
- `expenseRecovery`/`cam` return existence pointers only; CAM V2 remains the sole source of the actual calculated recovery amount.
- No UI in this phase.
