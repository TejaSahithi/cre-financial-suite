// Histogram buckets surfaced in the Classification debug panel. Every reason
// returned by the eligibility helpers should have a slot here so diagnostics do
// not silently drop rows.
export const EMPTY_RULE_EXCLUSIONS = Object.freeze({
  superseded: 0,
  not_approved: 0,
  original_lease_required: 0,
  coverage_gap: 0,
  weak_fallback: 0,
  missing_source: 0,
  missing_category: 0,
  included_in_base_rent: 0,
  tenant_direct: 0,
  explicit_exclusion: 0,
  non_recoverable: 0,
  non_cam: 0,
  needs_review: 0,
  wrong_scope: 0,
});

export const EMPTY_ACTUAL_EXCLUSIONS = Object.freeze({
  wrong_scope: 0,
  not_actual_expense: 0,
  original_lease_required: 0,
  coverage_gap: 0,
  superseded: 0,
  rejected: 0,
  draft: 0,
  needs_review: 0,
  not_approved: 0,
  missing_amount: 0,
});

export function bumpExclusion(target, reason) {
  if (!reason) return;
  target[reason] = (target[reason] ?? 0) + 1;
}
