# Resolved Lease Terms Facade (Phase 0 + Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an architecture-guardrails doc plus a pure, date-parameterized `resolveLeaseTerms` facade that reads only *approved* lease data (rent schedules, abstract snapshot, expense rule sets) — the first shared building block later financial evaluators (management fee, percentage rent) will import in-process.

**Architecture:** Mirrors CAM V2's structural split exactly: a `contracts/` types file, a pure `resolve()` function with zero I/O (fixture-testable), a separate `load*Snapshot()` function that does all the I/O once per lease, and a thin edge-function HTTP wrapper that just wires auth → load → resolve. No new tables — `rent_schedules` and `leases.abstract_snapshot` already carry everything Phase 1 needs.

**Tech Stack:** Deno edge functions (TypeScript), Supabase Postgres (read-only queries against existing tables), Deno's built-in test runner (`deno test`), `https://deno.land/std@0.224.0/assert/mod.ts` for assertions — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-13-resolved-lease-terms-phase0-1-design.md`

## Global Constraints

- No new database tables or migrations — read-only facade over `leases`, `rent_schedules`, `lease_expense_rule_sets`.
- Fail closed: every gap/ambiguity becomes a named `UnresolvedTerm` entry, never a silently substituted default.
- Only `rent`/`premises` get true as-of-date effective dating in v1; every other term group is a current-snapshot pass-through explicitly marked `effectiveDatingSupported: false`.
- Pass-through field keys must be real canonical keys from `supabase/functions/_shared/extraction/field-contract.ts` — never invented field names.
- `resolve.ts` and `contracts/resolved-lease-terms.ts` are strict TypeScript (no `@ts-nocheck`), matching `cam-engine-v2`'s pure-core convention. `load-lease-terms-snapshot.ts` and `resolve-lease-terms/index.ts` use `// @ts-nocheck`, matching every other I/O-facing file in `supabase/functions/`.
- No UI, no new routes, no feature flag — nothing in this phase is called by production code yet.
- Edge function auth/org-check must byte-for-byte mirror the existing pattern in `supabase/functions/approve-lease-workflow/index.ts` (verifyUser → getUserOrgId → assertPageAccess → org-scoped lookup → 404 on miss), just with `"read"` instead of `"write"` access, **including** its status-code mapping in the outer catch block (401 for unauthorized/missing-auth messages, 403 for access-denied/permission messages, 500 otherwise) — never a flat 500 for every failure.
- `rent_schedules.metadata` only ever carries derivation math (`month_key`, `overlap_days`, etc. — see `supabase/functions/_shared/rent-schedule.ts`), never a document/page/text citation. A row's real document evidence, when it has any, lives one level up on the lease's approved `monthly_rent`/`annual_rent` abstract-snapshot field — use that as the row's source evidence when `row.source === "approved_abstract"`; a `"manual"` row has no document to cite and must stay null, not fall back to guessing.
- `premises.buildingId`/`premises.rsf` are only ever populated in lockstep with `rent` resolving (both come from the same matched `rent_schedules` row) — `premises.effectiveDatingSupported` must reflect exactly that, never inferred from a different row when the asOfDate match itself was a gap or overlap.

**Known deviation from the spec's test list (stated here, not silently dropped):** the spec listed "unauthorized page access" as an edge-function-level test. `assertPageAccess` is pre-existing, shared, and enforced identically to every other edge function in this repo — re-testing it here would duplicate coverage for code this plan doesn't write. Task 5 instead does a `deno check` typecheck of the wiring and a manual diff-against-`approve-lease-workflow` review. Cross-org isolation *is* still fully covered, at the loader layer (Task 4), which is the code this plan actually owns.

---

### Task 1: Phase 0 — architectural guardrails doc

**Files:**
- Create: `docs/lease-financial-platform-principles.md`

**Interfaces:** none (documentation only, no code dependencies).

- [ ] **Step 1: Write the guardrails doc**

Create `docs/lease-financial-platform-principles.md`:

```markdown
# Lease Financial Platform — Architectural Principles

These are the standing rules for every financial evaluator added to this
platform (resolved lease terms, management fee, percentage rent, CPI
reference data, and beyond). They codify patterns CAM Engine V2 already
proved out; new work follows them rather than re-deriving its own.

## 1. Deterministic calculations

Same approved inputs → same output, every time. No calculation may read
wall-clock time, random values, or any other non-reproducible input as part
of its core logic. `asOfDate` is always an explicit parameter, never
implied by "now."

## 2. Frozen inputs

A calculation function receives one snapshot, built once, and never
re-queries mid-calculation. See `supabase/functions/_shared/cam-engine-v2/contracts/cam-input.ts`
(ADR-CAM-005/006: "the single frozen snapshot shape ... never a set of live
queries re-run mid-calculation"). The lease-terms facade follows the same
split: `load-lease-terms-snapshot.ts` does all I/O once; `resolve.ts` is a
pure function over the resulting snapshot.

## 3. Immutable approved state

Approved or posted results change only via a new version, a full
recalculation, or an explicit approved adjustment — never an in-place
mutation. `rent_schedules` rows are versioned via `abstract_version` and
`status` (draft → approved → superseded); `leases.abstract_snapshot` is
versioned and only ever appended to via `buildAbstractSnapshot()`.

## 4. AI is not an accounting authority

Extraction candidates (`llm_primary` / `typescript_schema_fallback`) never
reach a financial calculation directly. `supabase/functions/approve-lease-workflow/index.ts`
is the existing, working authority boundary: a human, RBAC-checked action
that writes `abstract_snapshot.approved`, `rent_schedules` (status=approved),
and `lease_critical_dates`. Every new evaluator reads only from that
approved side — never from `extraction_data` or `pending_fields` directly.

## 5. External-data provenance (for later reference-data phases)

When a calculation depends on external data (e.g. a future BLS/CPI
provider), the stored observation must carry: provider, series id,
observation period, value, retrieved-at timestamp, and (once introduced) a
payload hash. The calculation consumes the stored, approved observation —
never a live re-fetch — so a historical calculation stays reproducible even
if the provider later revises the series.

## 6. Fail closed

Never substitute zero, false, empty string, or an assumed value for missing
financial input. Raise a named, structured exception instead. The
lease-terms facade's `unresolvedTerms[]` entries (`RENT_SCHEDULE_GAP`,
`RENT_SCHEDULE_OVERLAP`, `LEASE_NOT_YET_APPROVED_AS_OF_DATE`, and one
`<TERM>_NOT_FOUND` per unmatched term group) are the model for this: every
gap is a named code with a human-readable message, never a silent `null`
that looks the same as "nothing was expected here."

## 7. Effective dating

Every rule that can change over time resolves against the period it
actually applies to, not "whatever's current." `rent_schedules` already
does this per-row (`period_start`/`period_end`). Where a domain has no
per-field effective dating yet (management fee, taxes, insurance,
utilities, HVAC, renewal options — everything currently living inside the
single versioned `abstract_snapshot` blob rather than its own table), say
so explicitly (`effectiveDatingSupported: false`) rather than presenting
false historical precision. Build real effective dating for a domain only
when a phase introduces real per-period modeling for it.

## 8. Multi-tenancy, RLS, and idempotency

Every organization-owned table carries `org_id` and standard RLS
(`is_member_of_org` / `can_write_org_data` — see
`supabase/functions/_shared/supabase.ts`). Every write-capable edge
function calls `verifyUser` → `getUserOrgId` → `assertPageAccess` before
touching data, and derives `org_id` from the authenticated session, never
from a client-supplied value. Schedulers and notification producers reuse
the existing idempotency pattern in `dispatch-critical-date-notifications`
(query-before-send keyed on `org_id + event_type + entity_id` within the
current day) rather than inventing a new dedup mechanism.
```

- [ ] **Step 2: Commit**

```bash
git add docs/lease-financial-platform-principles.md
git commit -m "docs: add lease financial platform architectural principles"
```

---

### Task 2: Resolved lease terms contracts (types)

**Files:**
- Create: `supabase/functions/_shared/lease-terms/contracts/resolved-lease-terms.ts`

**Interfaces:**
- Consumes: nothing (pure type declarations).
- Produces (imported by Tasks 3, 4, 5): `LeaseTermsSnapshot`, `RentScheduleRow`, `AbstractSnapshotFieldEntry`, `ExpenseRuleSetPointer`, `ResolvedLeaseTerms`, `ResolvedRent`, `ResolvedPremises`, `ResolvedRecoveryPointer`, `ResolvedPercentageRent`, `UnresolvedTerm`, `SourceEvidenceRef`.

- [ ] **Step 1: Write the contracts file**

Create `supabase/functions/_shared/lease-terms/contracts/resolved-lease-terms.ts`:

```ts
// Resolved Lease Terms — Phase 1 contracts. Mirrors the cam-engine-v2
// contracts/ split: LeaseTermsSnapshot is the frozen input the pure
// resolve() function consumes (built once by load-lease-terms-snapshot.ts);
// ResolvedLeaseTerms is its deterministic output.
//
// See docs/superpowers/specs/2026-08-13-resolved-lease-terms-phase0-1-design.md
// for the full design rationale, including why only rent/premises get true
// effective dating in v1.

export interface RentScheduleRow {
  id: string;
  row_type: string; // base_rent | ground_rent | percentage_rent | abatement | renewal_base_rent | holdover_rent | manual
  phase: string; // contracted | approved_renewal | assumed_renewal | holdover
  period_start: string; // ISO date
  period_end: string; // ISO date
  monthly_amount: number | null;
  annual_amount: number | null;
  rsf: number | null;
  status: string; // draft | approved | superseded | archived
  is_abatement: boolean;
  abatement_percent: number | null;
  building_id: string | null;
  unit_id: string | null;
  approved_at: string | null;
  approved_by: string | null;
  source: string; // approved_abstract | manual — row's own provenance; approved_abstract rows chain to the lease's approved rent field for document evidence, manual rows have none
}

export interface AbstractSnapshotFieldEntry {
  value: unknown;
  source_page: number | null;
  source_text: string | null;
  reviewer: string | null;
  reviewed_at: string | null;
}

export interface ExpenseRuleSetPointer {
  id: string;
  status: string; // draft | review_required | reviewed | approved | archived
  approvedAt: string | null;
}

export interface LeaseTermsSnapshot {
  leaseId: string;
  orgId: string;
  propertyId: string | null;
  unitId: string | null;
  abstractVersion: number;
  approvedAt: string | null;
  approvedFields: Record<string, AbstractSnapshotFieldEntry>;
  sourceDocumentId: string | null;
  rentScheduleRows: RentScheduleRow[];
  expenseRuleSet: ExpenseRuleSetPointer | null;
}

export interface SourceEvidenceRef {
  kind: "abstract_field" | "rent_schedule_row";
  fieldKey?: string;
  rentScheduleId?: string;
  scheduleSource?: string; // rent_schedules.source ("approved_abstract" | "manual") — only set for kind "rent_schedule_row"
  documentId: string | null;
  sourcePage: number | null;
  sourceText: string | null;
  abstractVersion: number;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface UnresolvedTerm {
  term: string;
  code: string;
  message: string;
}

export interface ResolvedRent {
  monthlyAmount: number | null;
  annualAmount: number | null;
  rowType: string;
  phase: string;
  periodStart: string;
  periodEnd: string;
  abatementApplied: { percent: number | null; monthlyAmount: number | null } | null;
  effectiveDatingSupported: true;
}

export interface ResolvedPremises {
  propertyId: string | null;
  buildingId: string | null;
  unitId: string | null;
  rsf: number | null;
  // true only when buildingId/rsf came from the asOfDate-matched rent
  // schedule row; false when rent itself was unresolved (gap/overlap) —
  // propertyId/unitId (lease-level, not date-dependent) stay populated
  // either way.
  effectiveDatingSupported: boolean;
}

export interface ResolvedRecoveryPointer {
  ruleSetId: string | null;
  status: string | null;
  effectiveDatingSupported: false;
}

export interface ResolvedPercentageRent {
  hasScheduledPercentageRentRows: boolean;
  rowCount: number;
  effectiveDatingSupported: false;
}

export interface ResolvedLeaseTerms {
  leaseId: string;
  asOfDate: string;
  premises: ResolvedPremises | null;
  rent: ResolvedRent | null;
  expenseRecovery: ResolvedRecoveryPointer | null;
  cam: ResolvedRecoveryPointer | null;
  managementFee: Record<string, unknown> | null;
  percentageRent: ResolvedPercentageRent | null;
  taxes: Record<string, unknown> | null;
  insurance: Record<string, unknown> | null;
  utilities: Record<string, unknown> | null;
  hvac: Record<string, unknown> | null;
  renewalOptions: Record<string, unknown> | null;
  reportingRequirements: null;
  unresolvedTerms: UnresolvedTerm[];
  sourceEvidence: SourceEvidenceRef[];
}
```

- [ ] **Step 2: Typecheck**

Run: `deno check supabase/functions/_shared/lease-terms/contracts/resolved-lease-terms.ts`
Expected: no errors (pure type declarations, nothing to fail).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/lease-terms/contracts/resolved-lease-terms.ts
git commit -m "feat: add resolved lease terms contracts"
```

---

### Task 3: Pure `resolveLeaseTerms()` function + golden tests

**Files:**
- Create: `supabase/functions/_shared/lease-terms/resolve.ts`
- Test: `supabase/functions/_tests/lease-terms-resolve-golden.test.ts`

**Interfaces:**
- Consumes: all types from Task 2 (`./contracts/resolved-lease-terms.ts`).
- Produces (imported by Task 5): `resolveLeaseTerms(snapshot: LeaseTermsSnapshot, asOfDate: string): ResolvedLeaseTerms` from `./resolve.ts`.

- [ ] **Step 1: Write the failing golden tests**

Create `supabase/functions/_tests/lease-terms-resolve-golden.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveLeaseTerms } from "../_shared/lease-terms/resolve.ts";
import type { LeaseTermsSnapshot, RentScheduleRow } from "../_shared/lease-terms/contracts/resolved-lease-terms.ts";

let seq = 0;
const uid = (prefix: string) => `${prefix}-${++seq}`;

function rentRow(overrides: Partial<RentScheduleRow> = {}): RentScheduleRow {
  return {
    id: uid("rent"),
    row_type: "base_rent",
    phase: "contracted",
    period_start: "2026-01-01",
    period_end: "2026-12-31",
    monthly_amount: 10000,
    annual_amount: 120000,
    rsf: 5000,
    status: "approved",
    is_abatement: false,
    abatement_percent: null,
    building_id: "building-1",
    unit_id: "unit-1",
    approved_at: "2026-01-05T00:00:00Z",
    approved_by: "reviewer@example.test",
    source: "approved_abstract",
    ...overrides,
  };
}

function snapshot(overrides: Partial<LeaseTermsSnapshot> = {}): LeaseTermsSnapshot {
  return {
    leaseId: "lease-1",
    orgId: "org-1",
    propertyId: "property-1",
    unitId: "unit-1",
    abstractVersion: 1,
    approvedAt: "2026-01-05T00:00:00Z",
    approvedFields: {},
    sourceDocumentId: "doc-1",
    rentScheduleRows: [rentRow()],
    expenseRuleSet: { id: "rule-set-1", status: "approved", approvedAt: "2026-01-05T00:00:00Z" },
    ...overrides,
  };
}

Deno.test("resolveLeaseTerms: happy path resolves a single approved rent row", () => {
  const result = resolveLeaseTerms(snapshot(), "2026-06-15");
  assertEquals(result.rent?.monthlyAmount, 10000);
  assertEquals(result.rent?.periodStart, "2026-01-01");
  assertEquals(result.rent?.effectiveDatingSupported, true);
  assertEquals(result.premises?.buildingId, "building-1");
  assertEquals(result.premises?.rsf, 5000);
  assertEquals(result.premises?.effectiveDatingSupported, true);
  assertEquals(result.unresolvedTerms.some((u) => u.code === "RENT_SCHEDULE_GAP"), false);
});

Deno.test("resolveLeaseTerms: rent evidence cites the lease-level rent field's document for an approved_abstract row", () => {
  const result = resolveLeaseTerms(
    snapshot({
      sourceDocumentId: "doc-42",
      approvedFields: {
        monthly_rent: {
          value: "10000",
          source_page: 3,
          source_text: "Base Rent: $10,000/month",
          reviewer: "reviewer@example.test",
          reviewed_at: "2026-01-05T00:00:00Z",
        },
      },
    }),
    "2026-06-15",
  );
  const rentEvidenceEntry = result.sourceEvidence.find((e) => e.kind === "rent_schedule_row");
  assertEquals(rentEvidenceEntry?.scheduleSource, "approved_abstract");
  assertEquals(rentEvidenceEntry?.documentId, "doc-42");
  assertEquals(rentEvidenceEntry?.sourcePage, 3);
  assertEquals(rentEvidenceEntry?.sourceText, "Base Rent: $10,000/month");
});

Deno.test("resolveLeaseTerms: manual rent schedule rows carry no document evidence, even if a rent field exists", () => {
  const rows = [rentRow({ source: "manual" })];
  const result = resolveLeaseTerms(
    snapshot({
      rentScheduleRows: rows,
      approvedFields: {
        monthly_rent: { value: "10000", source_page: 3, source_text: "irrelevant", reviewer: null, reviewed_at: null },
      },
    }),
    "2026-06-15",
  );
  const rentEvidenceEntry = result.sourceEvidence.find((e) => e.kind === "rent_schedule_row");
  assertEquals(rentEvidenceEntry?.scheduleSource, "manual");
  assertEquals(rentEvidenceEntry?.documentId, null);
  assertEquals(rentEvidenceEntry?.sourcePage, null);
  assertEquals(rentEvidenceEntry?.sourceText, null);
});

Deno.test("resolveLeaseTerms: premises effectiveDatingSupported is true only when the rent schedule itself resolved", () => {
  const resolved = resolveLeaseTerms(snapshot(), "2026-06-15");
  assertEquals(resolved.premises?.effectiveDatingSupported, true);

  const gapped = resolveLeaseTerms(snapshot(), "2027-06-15");
  assertEquals(gapped.premises?.effectiveDatingSupported, false);
  assertEquals(gapped.premises?.propertyId, "property-1");
  assertEquals(gapped.premises?.buildingId, null);
});

Deno.test("resolveLeaseTerms: mid-year rent change resolves each period correctly", () => {
  const rows = [
    rentRow({ period_start: "2026-01-01", period_end: "2026-06-30", monthly_amount: 10000, annual_amount: 60000 }),
    rentRow({ period_start: "2026-07-01", period_end: "2026-12-31", monthly_amount: 11000, annual_amount: 66000 }),
  ];
  const snap = snapshot({ rentScheduleRows: rows });

  const first = resolveLeaseTerms(snap, "2026-03-01");
  assertEquals(first.rent?.monthlyAmount, 10000);

  const second = resolveLeaseTerms(snap, "2026-09-01");
  assertEquals(second.rent?.monthlyAmount, 11000);
});

Deno.test("resolveLeaseTerms: gap in rent schedule is reported, never guessed", () => {
  const result = resolveLeaseTerms(snapshot(), "2027-06-15");
  assertEquals(result.rent, null);
  assertEquals(result.unresolvedTerms.some((u) => u.term === "rent" && u.code === "RENT_SCHEDULE_GAP"), true);
});

Deno.test("resolveLeaseTerms: overlapping approved base rows are flagged, not silently picked", () => {
  const rows = [
    rentRow({ id: "rent-a", period_start: "2026-01-01", period_end: "2026-12-31" }),
    rentRow({ id: "rent-b", period_start: "2026-01-01", period_end: "2026-12-31" }),
  ];
  const result = resolveLeaseTerms(snapshot({ rentScheduleRows: rows }), "2026-06-15");
  assertEquals(result.rent, null);
  assertEquals(result.unresolvedTerms.some((u) => u.term === "rent" && u.code === "RENT_SCHEDULE_OVERLAP"), true);
});

Deno.test("resolveLeaseTerms: abatement row overlays base rent instead of causing a false overlap", () => {
  const rows = [
    rentRow({ id: "rent-base", period_start: "2026-01-01", period_end: "2026-12-31", monthly_amount: 10000 }),
    rentRow({
      id: "rent-abate",
      row_type: "abatement",
      is_abatement: true,
      period_start: "2026-01-01",
      period_end: "2026-02-28",
      abatement_percent: 100,
      monthly_amount: 0,
    }),
  ];
  const result = resolveLeaseTerms(snapshot({ rentScheduleRows: rows }), "2026-01-15");
  assertEquals(result.rent?.monthlyAmount, 10000);
  assertEquals(result.rent?.abatementApplied, { percent: 100, monthlyAmount: 0 });
  assertEquals(result.unresolvedTerms.some((u) => u.code === "RENT_SCHEDULE_OVERLAP"), false);
});

Deno.test("resolveLeaseTerms: percentage rent row coexists without causing a false overlap", () => {
  const rows = [
    rentRow({ id: "rent-base" }),
    rentRow({ id: "rent-pct", row_type: "percentage_rent", monthly_amount: null, annual_amount: null }),
  ];
  const result = resolveLeaseTerms(snapshot({ rentScheduleRows: rows }), "2026-06-15");
  assertEquals(result.rent?.rowType, "base_rent");
  assertEquals(result.unresolvedTerms.some((u) => u.code === "RENT_SCHEDULE_OVERLAP"), false);
  assertEquals(result.percentageRent, { hasScheduledPercentageRentRows: true, rowCount: 1, effectiveDatingSupported: false });
});

Deno.test("resolveLeaseTerms: draft and superseded rows are never selected", () => {
  const rows = [
    rentRow({ id: "rent-draft", status: "draft" }),
    rentRow({ id: "rent-superseded", status: "superseded" }),
  ];
  const result = resolveLeaseTerms(snapshot({ rentScheduleRows: rows }), "2026-06-15");
  assertEquals(result.rent, null);
  assertEquals(result.unresolvedTerms.some((u) => u.code === "RENT_SCHEDULE_GAP"), true);
});

Deno.test("resolveLeaseTerms: asOfDate before lease approval is wholly unresolved", () => {
  const result = resolveLeaseTerms(snapshot(), "2025-12-01");
  assertEquals(result.rent, null);
  assertEquals(result.premises, null);
  assertEquals(result.unresolvedTerms.some((u) => u.code === "LEASE_NOT_YET_APPROVED_AS_OF_DATE"), true);
});

Deno.test("resolveLeaseTerms: missing abstract fields surface as unresolved, not thrown errors", () => {
  const result = resolveLeaseTerms(snapshot({ approvedFields: {} }), "2026-06-15");
  assertEquals(result.managementFee, null);
  assertEquals(result.taxes, null);
  assertEquals(result.insurance, null);
  assertEquals(result.unresolvedTerms.some((u) => u.term === "managementFee" && u.code === "MANAGEMENT_FEE_NOT_FOUND"), true);
});

Deno.test("resolveLeaseTerms: approved abstract fields pass through with effectiveDatingSupported false", () => {
  const result = resolveLeaseTerms(
    snapshot({
      approvedFields: {
        management_fee_basis: {
          value: "annualized_tenant_rent",
          source_page: 4,
          source_text: "4% of Annual Rent",
          reviewer: "reviewer@example.test",
          reviewed_at: "2026-01-05T00:00:00Z",
        },
      },
    }),
    "2026-06-15",
  );
  assertEquals(result.managementFee, { management_fee_basis: "annualized_tenant_rent", effectiveDatingSupported: false });
  assertEquals(result.sourceEvidence.some((e) => e.kind === "abstract_field" && e.fieldKey === "management_fee_basis"), true);
});

Deno.test("resolveLeaseTerms: reporting requirements are always unresolved (not modeled in schema yet)", () => {
  const result = resolveLeaseTerms(snapshot(), "2026-06-15");
  assertEquals(result.reportingRequirements, null);
  assertEquals(
    result.unresolvedTerms.some((u) => u.term === "reportingRequirements" && u.code === "REPORTING_REQUIREMENTS_NOT_MODELED"),
    true,
  );
});

Deno.test("resolveLeaseTerms: missing expense rule set is a named exception, not a silent null", () => {
  const result = resolveLeaseTerms(snapshot({ expenseRuleSet: null }), "2026-06-15");
  assertEquals(result.expenseRecovery, null);
  assertEquals(result.cam, null);
  assertEquals(result.unresolvedTerms.some((u) => u.term === "expenseRecovery" && u.code === "EXPENSE_RECOVERY_NOT_FOUND"), true);
});

Deno.test("resolveLeaseTerms: draft expense rule set is surfaced but flagged not approved", () => {
  const result = resolveLeaseTerms(
    snapshot({ expenseRuleSet: { id: "rule-set-2", status: "draft", approvedAt: null } }),
    "2026-06-15",
  );
  assertEquals(result.expenseRecovery?.ruleSetId, "rule-set-2");
  assertEquals(result.expenseRecovery?.status, "draft");
  assertEquals(result.unresolvedTerms.some((u) => u.term === "expenseRecovery" && u.code === "EXPENSE_RECOVERY_NOT_APPROVED"), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --no-check supabase/functions/_tests/lease-terms-resolve-golden.test.ts`
Expected: FAIL — `resolve.ts` does not exist yet (module not found).

- [ ] **Step 3: Implement `resolve.ts`**

Create `supabase/functions/_shared/lease-terms/resolve.ts`:

```ts
// Pure function: no I/O, deterministic. All data comes from the frozen
// LeaseTermsSnapshot built by load-lease-terms-snapshot.ts. Mirrors
// cam-engine-v2's orchestrator "load once, calculate many" split — see
// docs/superpowers/specs/2026-08-13-resolved-lease-terms-phase0-1-design.md.
import type {
  LeaseTermsSnapshot,
  RentScheduleRow,
  ResolvedLeaseTerms,
  ResolvedPercentageRent,
  ResolvedPremises,
  ResolvedRecoveryPointer,
  ResolvedRent,
  SourceEvidenceRef,
  UnresolvedTerm,
} from "./contracts/resolved-lease-terms.ts";

const BASE_RENT_ROW_TYPES = new Set(["base_rent", "ground_rent", "renewal_base_rent", "holdover_rent", "manual"]);

// Curated subsets of supabase/functions/_shared/extraction/field-contract.ts
// canonical keys — NOT a 1:1 group export. field-contract.ts's cam_rules
// group mixes CAM config with management_fee_basis, repairs_maintenance
// mixes general repairs with HVAC, and legal_options mixes renewal terms
// with assignment/termination terms, so each list below hand-picks only
// the keys that actually mean this term. There is deliberately no
// percentageRent or reportingRequirements entry: no canonical lease-schema
// field models either concept yet (confirmed against field-contract.ts).
const TERM_FIELD_KEYS: Record<string, string[]> = {
  managementFee: ["management_fee_basis"],
  taxes: ["tax_responsibility", "responsibility_taxes"],
  insurance: [
    "insurance_responsibility",
    "responsibility_insurance",
    "property_insurance_responsibility",
    "tenant_insurance_required",
    "general_liability_min",
    "waiver_of_subrogation",
    "additional_insureds_required",
  ],
  utilities: [
    "responsibility_utilities",
    "electric_responsibility",
    "water_sewer_responsibility",
    "utility_reimbursement_amount",
    "water_sewer_reimbursement_amount",
  ],
  hvac: ["hvac_responsibility"],
  renewalOptions: ["renewal_options", "renewal_type", "right_of_first_refusal", "renewal_notice_months"],
};

function screamingSnakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function coversDate(row: RentScheduleRow, asOfDate: string): boolean {
  return row.period_start <= asOfDate && asOfDate <= row.period_end;
}

function rentEvidence(row: RentScheduleRow, snapshot: LeaseTermsSnapshot): SourceEvidenceRef {
  // rent_schedules rows are generated from the lease's approved rent value
  // (rent-schedule.ts's metadata only ever carries derivation math — never
  // a document/page/text citation). The real document evidence for an
  // approved_abstract-sourced row lives one level up, on the lease's
  // approved monthly_rent/annual_rent field entry; a manual row has no
  // document to cite and correctly stays null.
  const rentField = row.source === "approved_abstract"
    ? snapshot.approvedFields["monthly_rent"] ?? snapshot.approvedFields["annual_rent"] ?? null
    : null;
  return {
    kind: "rent_schedule_row",
    rentScheduleId: row.id,
    scheduleSource: row.source,
    documentId: rentField ? snapshot.sourceDocumentId : null,
    sourcePage: rentField ? rentField.source_page : null,
    sourceText: rentField ? rentField.source_text : null,
    abstractVersion: snapshot.abstractVersion,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}

function fieldEvidence(fieldKey: string, snapshot: LeaseTermsSnapshot): SourceEvidenceRef | null {
  const entry = snapshot.approvedFields[fieldKey];
  if (!entry) return null;
  return {
    kind: "abstract_field",
    fieldKey,
    documentId: snapshot.sourceDocumentId,
    sourcePage: entry.source_page,
    sourceText: entry.source_text,
    abstractVersion: snapshot.abstractVersion,
    approvedBy: entry.reviewer,
    approvedAt: entry.reviewed_at,
  };
}

function passThroughSection(
  termName: string,
  snapshot: LeaseTermsSnapshot,
  unresolvedTerms: UnresolvedTerm[],
  sourceEvidence: SourceEvidenceRef[],
): Record<string, unknown> | null {
  const keys = TERM_FIELD_KEYS[termName];
  const values: Record<string, unknown> = {};
  let any = false;
  for (const key of keys) {
    const entry = snapshot.approvedFields[key];
    if (!entry) continue;
    values[key] = entry.value;
    any = true;
    const evidence = fieldEvidence(key, snapshot);
    if (evidence) sourceEvidence.push(evidence);
  }
  if (!any) {
    unresolvedTerms.push({
      term: termName,
      code: `${screamingSnakeCase(termName)}_NOT_FOUND`,
      message: `No approved lease fields found for ${termName}.`,
    });
    return null;
  }
  values.effectiveDatingSupported = false;
  return values;
}

function emptyResolvedLeaseTerms(leaseId: string, asOfDate: string): ResolvedLeaseTerms {
  return {
    leaseId,
    asOfDate,
    premises: null,
    rent: null,
    expenseRecovery: null,
    cam: null,
    managementFee: null,
    percentageRent: null,
    taxes: null,
    insurance: null,
    utilities: null,
    hvac: null,
    renewalOptions: null,
    reportingRequirements: null,
    unresolvedTerms: [],
    sourceEvidence: [],
  };
}

export function resolveLeaseTerms(snapshot: LeaseTermsSnapshot, asOfDate: string): ResolvedLeaseTerms {
  if (!snapshot.approvedAt || asOfDate < snapshot.approvedAt.slice(0, 10)) {
    const result = emptyResolvedLeaseTerms(snapshot.leaseId, asOfDate);
    result.unresolvedTerms.push({
      term: "*",
      code: "LEASE_NOT_YET_APPROVED_AS_OF_DATE",
      message: `Lease has no approved terms as of ${asOfDate}; earliest approval is ${snapshot.approvedAt ?? "none"}.`,
    });
    return result;
  }

  const unresolvedTerms: UnresolvedTerm[] = [];
  const sourceEvidence: SourceEvidenceRef[] = [];

  // --- rent: the only field group with true effective dating in v1 ---
  const baseRows = snapshot.rentScheduleRows.filter(
    (r) => r.status === "approved" && BASE_RENT_ROW_TYPES.has(r.row_type) && coversDate(r, asOfDate),
  );
  const abatementRows = snapshot.rentScheduleRows.filter(
    (r) => r.status === "approved" && (r.row_type === "abatement" || r.is_abatement) && coversDate(r, asOfDate),
  );
  const percentageRows = snapshot.rentScheduleRows.filter(
    (r) => r.status === "approved" && r.row_type === "percentage_rent" && coversDate(r, asOfDate),
  );

  let rent: ResolvedRent | null = null;
  let matchedRow: RentScheduleRow | null = null;
  if (baseRows.length === 0) {
    unresolvedTerms.push({ term: "rent", code: "RENT_SCHEDULE_GAP", message: `No approved rent schedule row covers ${asOfDate}.` });
  } else if (baseRows.length > 1) {
    unresolvedTerms.push({
      term: "rent",
      code: "RENT_SCHEDULE_OVERLAP",
      message: `${baseRows.length} approved rent schedule rows cover ${asOfDate}; cannot determine which applies.`,
    });
  } else {
    matchedRow = baseRows[0];
    rent = {
      monthlyAmount: matchedRow.monthly_amount,
      annualAmount: matchedRow.annual_amount,
      rowType: matchedRow.row_type,
      phase: matchedRow.phase,
      periodStart: matchedRow.period_start,
      periodEnd: matchedRow.period_end,
      abatementApplied: abatementRows.length > 0
        ? { percent: abatementRows[0].abatement_percent, monthlyAmount: abatementRows[0].monthly_amount }
        : null,
      effectiveDatingSupported: true,
    };
    sourceEvidence.push(rentEvidence(matchedRow, snapshot));
    for (const row of abatementRows) sourceEvidence.push(rentEvidence(row, snapshot));
  }

  // --- premises: sourced from the matched rent row (real numeric rsf/building_id) ---
  const premises: ResolvedPremises = {
    propertyId: snapshot.propertyId,
    buildingId: matchedRow?.building_id ?? null,
    unitId: matchedRow?.unit_id ?? snapshot.unitId,
    rsf: matchedRow?.rsf ?? null,
    effectiveDatingSupported: matchedRow !== null,
  };

  // --- percentage rent: pointer only; Phase 5 owns the actual calculation ---
  const percentageRent: ResolvedPercentageRent | null = percentageRows.length > 0
    ? { hasScheduledPercentageRentRows: true, rowCount: percentageRows.length, effectiveDatingSupported: false }
    : null;
  if (!percentageRent) {
    unresolvedTerms.push({
      term: "percentageRent",
      code: "PERCENTAGE_RENT_NOT_FOUND",
      message: "No percentage rent schedule rows found for this period.",
    });
  }

  // --- expenseRecovery / cam: pointer only; CAM V2 owns the actual calculation ---
  let expenseRecovery: ResolvedRecoveryPointer | null = null;
  if (!snapshot.expenseRuleSet) {
    unresolvedTerms.push({ term: "expenseRecovery", code: "EXPENSE_RECOVERY_NOT_FOUND", message: "No expense rule set found for this lease." });
  } else {
    expenseRecovery = { ruleSetId: snapshot.expenseRuleSet.id, status: snapshot.expenseRuleSet.status, effectiveDatingSupported: false };
    if (snapshot.expenseRuleSet.status !== "approved") {
      unresolvedTerms.push({
        term: "expenseRecovery",
        code: "EXPENSE_RECOVERY_NOT_APPROVED",
        message: `Expense rule set ${snapshot.expenseRuleSet.id} has status "${snapshot.expenseRuleSet.status}", not "approved".`,
      });
    }
  }
  const cam = expenseRecovery ? { ...expenseRecovery } : null;

  // --- reporting requirements: no canonical lease-schema field models this
  // yet (confirmed against field-contract.ts) — always unresolved in v1,
  // never a fabricated pass-through of a nonexistent field.
  unresolvedTerms.push({
    term: "reportingRequirements",
    code: "REPORTING_REQUIREMENTS_NOT_MODELED",
    message: "No lease schema fields model reporting requirements yet; see Phase 5 (percentage rent / sales reporting).",
  });

  return {
    leaseId: snapshot.leaseId,
    asOfDate,
    premises,
    rent,
    expenseRecovery,
    cam,
    managementFee: passThroughSection("managementFee", snapshot, unresolvedTerms, sourceEvidence),
    percentageRent,
    taxes: passThroughSection("taxes", snapshot, unresolvedTerms, sourceEvidence),
    insurance: passThroughSection("insurance", snapshot, unresolvedTerms, sourceEvidence),
    utilities: passThroughSection("utilities", snapshot, unresolvedTerms, sourceEvidence),
    hvac: passThroughSection("hvac", snapshot, unresolvedTerms, sourceEvidence),
    renewalOptions: passThroughSection("renewalOptions", snapshot, unresolvedTerms, sourceEvidence),
    reportingRequirements: null,
    unresolvedTerms,
    sourceEvidence,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --no-check supabase/functions/_tests/lease-terms-resolve-golden.test.ts`
Expected: PASS — all 16 tests green.

- [ ] **Step 5: Strict typecheck**

Run: `deno check supabase/functions/_shared/lease-terms/resolve.ts`
Expected: no errors (this file has no `@ts-nocheck`, per the Global Constraints).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/lease-terms/resolve.ts supabase/functions/_tests/lease-terms-resolve-golden.test.ts
git commit -m "feat: add pure resolveLeaseTerms function with golden tests"
```

---

### Task 4: `loadLeaseTermsSnapshot()` loader

**Files:**
- Create: `supabase/functions/_shared/lease-terms/load-lease-terms-snapshot.ts`
- Test: `supabase/functions/_tests/lease-terms-load-snapshot.test.ts`

**Interfaces:**
- Consumes: types from Task 2 (`LeaseTermsSnapshot`, `RentScheduleRow`, `AbstractSnapshotFieldEntry`).
- Produces (imported by Task 5): `loadLeaseTermsSnapshot(supabaseAdmin: any, params: { orgId: string; leaseId: string }): Promise<LeaseTermsSnapshot | null>` from `./load-lease-terms-snapshot.ts`.

- [ ] **Step 1: Write the failing loader tests**

Create `supabase/functions/_tests/lease-terms-load-snapshot.test.ts`:

```ts
// Mock-client style matches supabase/functions/_tests/approved-lease-expense-rules.test.ts:
// a chainable builder that ignores filter args and resolves to canned
// per-table data — no real DB required for this pure data-shape test.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadLeaseTermsSnapshot } from "../_shared/lease-terms/load-lease-terms-snapshot.ts";

function chain(result: any) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function mockClient(tables: Record<string, any>) {
  return {
    from: (table: string) => {
      if (!(table in tables)) throw new Error(`Unexpected table in test: ${table}`);
      return chain(tables[table]);
    },
  };
}

Deno.test("loadLeaseTermsSnapshot: assembles a snapshot from leases + rent_schedules + rule sets", async () => {
  const client = mockClient({
    leases: {
      data: {
        id: "lease-1",
        org_id: "org-1",
        property_id: "property-1",
        unit_id: "unit-1",
        abstract_version: 2,
        abstract_snapshot: {
          approved_at: "2026-01-05T00:00:00Z",
          approved: { management_fee_basis: { value: "annualized_tenant_rent", source_page: 4 } },
          source_document: { uploaded_file_id: "doc-1" },
        },
      },
      error: null,
    },
    rent_schedules: {
      data: [{
        id: "rent-1", row_type: "base_rent", phase: "contracted",
        period_start: "2026-01-01", period_end: "2026-12-31",
        monthly_amount: 10000, annual_amount: 120000, rsf: 5000,
        status: "approved", is_abatement: false, abatement_percent: null,
        building_id: "building-1", unit_id: "unit-1",
        approved_at: "2026-01-05T00:00:00Z", approved_by: "reviewer@example.test",
        source: "approved_abstract",
      }],
      error: null,
    },
    lease_expense_rule_sets: {
      data: [{ id: "rule-set-1", status: "approved", approved_at: "2026-01-05T00:00:00Z" }],
      error: null,
    },
  });

  const snapshot = await loadLeaseTermsSnapshot(client, { orgId: "org-1", leaseId: "lease-1" });

  assertEquals(snapshot?.leaseId, "lease-1");
  assertEquals(snapshot?.abstractVersion, 2);
  assertEquals(snapshot?.approvedAt, "2026-01-05T00:00:00Z");
  assertEquals(snapshot?.rentScheduleRows.length, 1);
  assertEquals(snapshot?.rentScheduleRows[0].monthly_amount, 10000);
  assertEquals(snapshot?.rentScheduleRows[0].source, "approved_abstract");
  assertEquals(snapshot?.expenseRuleSet, { id: "rule-set-1", status: "approved", approvedAt: "2026-01-05T00:00:00Z" });
  assertEquals(snapshot?.approvedFields.management_fee_basis.value, "annualized_tenant_rent");
  assertEquals(snapshot?.sourceDocumentId, "doc-1");
});

Deno.test("loadLeaseTermsSnapshot: returns null for a lease outside the caller's org (cross-org isolation)", async () => {
  const client = mockClient({ leases: { data: null, error: null } });
  const snapshot = await loadLeaseTermsSnapshot(client, { orgId: "org-2", leaseId: "lease-1" });
  assertEquals(snapshot, null);
});

Deno.test("loadLeaseTermsSnapshot: no expense rule set yields a null pointer, not a thrown error", async () => {
  const client = mockClient({
    leases: {
      data: {
        id: "lease-1", org_id: "org-1", property_id: "property-1", unit_id: "unit-1",
        abstract_version: 1,
        abstract_snapshot: { approved_at: "2026-01-05T00:00:00Z", approved: {} },
      },
      error: null,
    },
    rent_schedules: { data: [], error: null },
    lease_expense_rule_sets: { data: [], error: null },
  });

  const snapshot = await loadLeaseTermsSnapshot(client, { orgId: "org-1", leaseId: "lease-1" });
  assertEquals(snapshot?.expenseRuleSet, null);
  assertEquals(snapshot?.rentScheduleRows, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --no-check supabase/functions/_tests/lease-terms-load-snapshot.test.ts`
Expected: FAIL — `load-lease-terms-snapshot.ts` does not exist yet.

- [ ] **Step 3: Implement the loader**

Create `supabase/functions/_shared/lease-terms/load-lease-terms-snapshot.ts`:

```ts
// @ts-nocheck
// I/O only: loads everything resolve.ts needs for ANY asOfDate on one
// lease, so the pure resolver can be called repeatedly against one loaded
// snapshot without re-querying (mirrors cam-engine-v2's snapshot builder).
// org_id is always taken from the caller's resolved session org — never
// trust a client-supplied org_id.
import type { AbstractSnapshotFieldEntry, LeaseTermsSnapshot, RentScheduleRow } from "./contracts/resolved-lease-terms.ts";

function toRentScheduleRow(row: any): RentScheduleRow {
  return {
    id: row.id,
    row_type: row.row_type,
    phase: row.phase,
    period_start: row.period_start,
    period_end: row.period_end,
    monthly_amount: row.monthly_amount,
    annual_amount: row.annual_amount,
    rsf: row.rsf,
    status: row.status,
    is_abatement: !!row.is_abatement,
    abatement_percent: row.abatement_percent,
    building_id: row.building_id,
    unit_id: row.unit_id,
    approved_at: row.approved_at,
    approved_by: row.approved_by,
    source: row.source,
  };
}

function toApprovedFields(approved: Record<string, any> | undefined): Record<string, AbstractSnapshotFieldEntry> {
  const out: Record<string, AbstractSnapshotFieldEntry> = {};
  for (const [key, entry] of Object.entries(approved || {})) {
    out[key] = {
      value: entry?.value ?? null,
      source_page: entry?.source_page ?? null,
      source_text: entry?.source_text ?? entry?.exact_source_text ?? null,
      reviewer: entry?.reviewer ?? null,
      reviewed_at: entry?.reviewed_at ?? null,
    };
  }
  return out;
}

export async function loadLeaseTermsSnapshot(
  supabaseAdmin: any,
  { orgId, leaseId }: { orgId: string; leaseId: string },
): Promise<LeaseTermsSnapshot | null> {
  const { data: lease, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select("id, org_id, property_id, unit_id, abstract_version, abstract_snapshot")
    .eq("id", leaseId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (leaseError || !lease) return null;

  const { data: rentRows, error: rentError } = await supabaseAdmin
    .from("rent_schedules")
    .select(
      "id, row_type, phase, period_start, period_end, monthly_amount, annual_amount, rsf, status, is_abatement, abatement_percent, building_id, unit_id, approved_at, approved_by, source",
    )
    .eq("org_id", orgId)
    .eq("lease_id", leaseId);
  if (rentError) throw new Error(`Failed to load rent_schedules for lease ${leaseId}: ${rentError.message}`);

  const { data: ruleSets, error: ruleSetError } = await supabaseAdmin
    .from("lease_expense_rule_sets")
    .select("id, status, approved_at")
    .eq("org_id", orgId)
    .eq("lease_id", leaseId)
    .order("version", { ascending: false })
    .limit(1);
  if (ruleSetError) throw new Error(`Failed to load lease_expense_rule_sets for lease ${leaseId}: ${ruleSetError.message}`);

  const snapshot = (lease.abstract_snapshot || {}) as Record<string, any>;

  return {
    leaseId: lease.id,
    orgId: lease.org_id,
    propertyId: lease.property_id ?? null,
    unitId: lease.unit_id ?? null,
    abstractVersion: Number(lease.abstract_version || 0),
    approvedAt: snapshot.approved_at ?? null,
    approvedFields: toApprovedFields(snapshot.approved),
    sourceDocumentId: snapshot.source_document?.uploaded_file_id ?? snapshot.uploaded_file_id ?? null,
    rentScheduleRows: (rentRows || []).map(toRentScheduleRow),
    expenseRuleSet: ruleSets && ruleSets[0]
      ? { id: ruleSets[0].id, status: ruleSets[0].status, approvedAt: ruleSets[0].approved_at ?? null }
      : null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --no-check supabase/functions/_tests/lease-terms-load-snapshot.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/lease-terms/load-lease-terms-snapshot.ts supabase/functions/_tests/lease-terms-load-snapshot.test.ts
git commit -m "feat: add lease terms snapshot loader"
```

---

### Task 5: `resolve-lease-terms` edge function

**Files:**
- Create: `supabase/functions/resolve-lease-terms/index.ts`

**Interfaces:**
- Consumes: `resolveLeaseTerms` (Task 3), `loadLeaseTermsSnapshot` (Task 4), pre-existing `verifyUser`/`getUserOrgId`/`assertPageAccess` from `supabase/functions/_shared/supabase.ts`, pre-existing `corsHeaders` from `supabase/functions/_shared/cors.ts`.
- Produces: an HTTP endpoint at function name `resolve-lease-terms` (no other code depends on this in Phase 1 — it exists for future frontend/API use).

- [ ] **Step 1: Write the edge function**

Create `supabase/functions/resolve-lease-terms/index.ts`:

```ts
// @ts-nocheck
// Thin HTTP wrapper around the pure lease-terms facade. Auth/org-check
// pattern is a byte-for-byte match of approve-lease-workflow/index.ts,
// with "read" access instead of "write" since this never mutates data.
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { loadLeaseTermsSnapshot } from "../_shared/lease-terms/load-lease-terms-snapshot.ts";
import { resolveLeaseTerms } from "../_shared/lease-terms/resolve.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["LeaseReview", "Leases"], "read");

    const body = await req.json().catch(() => ({}));
    const leaseId = body.leaseId || body.lease_id;
    const asOfDate = body.asOfDate || body.as_of_date || new Date().toISOString().slice(0, 10);

    if (!leaseId) {
      return jsonResponse({ error: true, message: "leaseId is required", error_code: "LEASE_ID_REQUIRED" }, 400);
    }

    const snapshot = await loadLeaseTermsSnapshot(supabaseAdmin, { orgId, leaseId });
    if (!snapshot) {
      return jsonResponse({ error: true, message: "Lease not found for this organization", error_code: "LEASE_NOT_FOUND" }, 404);
    }

    const resolved = resolveLeaseTerms(snapshot, asOfDate);
    return jsonResponse(resolved);
  } catch (error) {
    // Same status-code mapping as approve-lease-workflow/index.ts's outer
    // catch: transport/auth failures (verifyUser/getUserOrgId/assertPageAccess
    // all just `throw new Error(...)` with no status of their own) get the
    // right HTTP status instead of a flat 500. Domain-level gaps
    // (RENT_SCHEDULE_GAP, etc.) never reach this catch — resolveLeaseTerms
    // returns them in a 200 response's unresolvedTerms[], it never throws
    // for them.
    const message = error instanceof Error ? error.message : String(error);
    const status = /unauthorized|missing authorization/i.test(message)
      ? 401
      : /access denied|permission/i.test(message)
        ? 403
        : 500;
    return jsonResponse({ error: true, message, error_code: "RESOLVE_LEASE_TERMS_FAILED" }, status);
  }
});
```

- [ ] **Step 2: Typecheck the wiring**

Run: `deno check supabase/functions/resolve-lease-terms/index.ts`
Expected: no errors — confirms the imports and call signatures from Tasks 3/4 line up.

- [ ] **Step 3: Run the full lease-terms test suite**

Run: `deno test --no-check supabase/functions/_tests/lease-terms-resolve-golden.test.ts supabase/functions/_tests/lease-terms-load-snapshot.test.ts`
Expected: PASS — all 19 tests green, confirming Tasks 3 and 4 still work together after this task's changes.

- [ ] **Step 4: Manual parity review**

Diff `resolve-lease-terms/index.ts`'s auth block against `approve-lease-workflow/index.ts` lines 23-26 (verifyUser → getUserOrgId → assertPageAccess → org-scoped lookup). Confirm the only intentional differences are: `"read"` instead of `"write"` access, and the org-scoped lookup happening inside `loadLeaseTermsSnapshot` instead of inline. Also diff the outer catch block against `approve-lease-workflow/index.ts` lines 170-187: confirm the 401/403/500 message-pattern mapping is present (not a flat 500), and confirm the 404 branch's message is identical regardless of whether `leaseId` doesn't exist at all or belongs to another org — both must read "Lease not found for this organization" with no distinguishing detail, so a caller cannot probe for another org's lease IDs.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/resolve-lease-terms/index.ts
git commit -m "feat: add resolve-lease-terms edge function"
```

---

## Post-plan checklist (do once, after Task 5)

- [ ] Run the full Deno test suite for the new files together: `deno test --no-check supabase/functions/_tests/lease-terms-resolve-golden.test.ts supabase/functions/_tests/lease-terms-load-snapshot.test.ts`
- [ ] Run `npm run test` (Vitest) to confirm nothing in the frontend broke — this phase touches no frontend files, so this is a fast sanity check, not an expected-changes run.
- [ ] Confirm `git status` shows exactly 5 new files beyond this plan/spec (contracts, resolve.ts + test, loader + test, edge function) plus the two docs files — nothing else.
- [ ] Deploy note (not part of this plan's automated steps): `supabase functions deploy resolve-lease-terms` once merged. No new secrets, no migrations, no RLS changes.
