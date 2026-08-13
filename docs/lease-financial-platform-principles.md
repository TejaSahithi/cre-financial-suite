

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
