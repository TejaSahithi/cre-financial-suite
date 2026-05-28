/**
 * Normalized status helpers — single source of truth for reading
 * approval_status / approved_status / review_status off any row.
 *
 * Why this exists:
 *   The codebase has three fields that all describe approval state:
 *     - approval_status  (canonical)
 *     - approved_status  (legacy alias used by some tables / migrations)
 *     - review_status    (workflow state; "reviewed" maps to "approved")
 *   Before this helper, ~30 call sites read these fields with slightly
 *   different precedence and "reviewed" → "approved" promotion rules,
 *   producing subtle disagreements (a row could be "approved" to one
 *   consumer and "draft" to another).
 *
 * Semantics — keep IDENTICAL to the original ad-hoc patterns so this is a
 * logic-preserving refactor:
 *   - `getEffectiveApprovalStatus(row)` = approval_status || approved_status
 *     (the pattern that appears at leaseExpenseRuleService.js:98, :119, :149,
 *     :164, and several other sites). Returns a normalized lower-case token
 *     or "" if neither field is set.
 *   - `getEffectiveReviewStatus(row)` = normalized review_status with the
 *     "reviewed" → "approved" promotion that appears at lines 97, 163, etc.
 *   - `getRawReviewStatus(row)` = normalized review_status WITHOUT the
 *     promotion — needed at lines 118, 148 where the original code did the
 *     bare read to compare against "rejected" or "needs_review".
 *   - `isEffectivelyApproved(row)` = both effective approval AND effective
 *     review are "approved" (matches isRuleApproved at line 99 and the
 *     isApprovedRuleWorkflow helper in expenseEligibility.js).
 *   - `isEffectivelyRejected(row)` = any of approval / raw review / row_status
 *     equals "rejected" (matches isRuleRejected at lines 117-121).
 *   - `isEffectivelyDraft(row)` = none of the canonical "decided" tokens
 *     (approved, rejected, finalized, not_applicable) is set on any field.
 *
 * What this helper does NOT do:
 *   - It does NOT mutate or normalize the stored values. Callers that write
 *     to these fields continue to write strings like "approved" / "draft"
 *     directly — the helper is only for READS.
 *   - It does NOT replace fine-grained eligibility helpers
 *     (isRuleClassificationEligible, isRuleCamEligible). Those check
 *     additional fields and live in expenseEligibility.js.
 */

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return "";
}

/**
 * Returns the effective approval status as a lowercase token, reading
 * `approval_status` first, then `approved_status` as a fallback.
 * Returns "" if neither field is set.
 */
function getEffectiveApprovalStatus(row) {
  return firstNonEmpty(row?.approval_status, row?.approved_status);
}

/**
 * Returns the effective review status as a lowercase token. The
 * historical "reviewed" value is promoted to "approved" because several
 * tables wrote that token before the canonical state was settled.
 * Returns "" if review_status is not set.
 */
function getEffectiveReviewStatus(row) {
  const raw = normalizeText(row?.review_status);
  if (raw === "reviewed") return "approved";
  return raw;
}

/**
 * Returns review_status as a lowercase token WITHOUT the "reviewed" →
 * "approved" promotion. Use this where the original code compared the
 * bare value against "rejected" / "needs_review" / "draft" tokens.
 */
function getRawReviewStatus(row) {
  return normalizeText(row?.review_status);
}

/**
 * Returns row_status with fallbacks to `status` and `extraction_status`.
 * Mirrors the pattern at leaseExpenseRuleService.js:120, :125, :135, :150.
 */
function getEffectiveRowStatus(row) {
  return firstNonEmpty(row?.row_status, row?.status, row?.extraction_status);
}

function isEffectivelyApproved(row) {
  return getEffectiveApprovalStatus(row) === "approved"
    && getEffectiveReviewStatus(row) === "approved";
}

function isEffectivelyRejected(row) {
  return getEffectiveApprovalStatus(row) === "rejected"
    || getRawReviewStatus(row) === "rejected"
    || normalizeText(row?.row_status) === "rejected"
    || normalizeText(row?.status) === "rejected";
}

function isEffectivelyDraft(row) {
  const decisive = new Set(["approved", "rejected", "finalized", "not_applicable"]);
  return !decisive.has(getEffectiveApprovalStatus(row))
    && !decisive.has(getEffectiveReviewStatus(row))
    && !decisive.has(getEffectiveRowStatus(row));
}

export {
  getEffectiveApprovalStatus,
  getEffectiveReviewStatus,
  getRawReviewStatus,
  getEffectiveRowStatus,
  isEffectivelyApproved,
  isEffectivelyRejected,
  isEffectivelyDraft,
};
