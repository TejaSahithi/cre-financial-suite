import {
  isResolvedReview,
  readFieldReview,
  readFieldValue,
  REVIEW_STATUSES,
} from "@/lib/leaseReviewSchema";

function normalizeWorkflow(lease) {
  return lease?.extraction_data?.workflow_output || lease?.extraction_data?.workflowOutput || {};
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== "");
}

export function readReviewedBudgetFieldValue(lease, key) {
  const review = readFieldReview(lease, key);
  if (isResolvedReview(review) && review.status !== REVIEW_STATUSES.N_A) {
    const reviewedValue = firstPresent(review.value, review.normalized_value, review.normalizedValue);
    if (reviewedValue !== undefined) return reviewedValue;
  }
  const extractedValue = readFieldValue(lease, key);
  if (extractedValue !== null && extractedValue !== undefined) return extractedValue;
  return lease?.extraction_data?.fields?.[key]?.value ?? null;
}

export function resolveBudgetPreviewInputs(lease) {
  const workflow = normalizeWorkflow(lease);
  const workflowPreview = workflow?.budget_preview || workflow?.budgetPreview || {};
  const workflowRent = workflowPreview?.rent_revenue_budget?.[0]?.monthly_rent;
  const reviewedMonthly = firstPresent(
    readReviewedBudgetFieldValue(lease, "monthly_rent"),
    readReviewedBudgetFieldValue(lease, "base_rent_monthly"),
  );
  const reviewedAnnualRent = readReviewedBudgetFieldValue(lease, "annual_rent");
  const monthly = firstFiniteNumber(
    reviewedMonthly,
    workflowRent,
    lease?.monthly_rent,
    reviewedAnnualRent != null ? Number(reviewedAnnualRent) / 12 : null,
    lease?.annual_rent ? Number(lease.annual_rent) / 12 : null,
  );
  const startBasis = firstPresent(
    readReviewedBudgetFieldValue(lease, "rent_commencement_date"),
    readReviewedBudgetFieldValue(lease, "commencement_date"),
    workflowPreview?.rent_revenue_budget?.[0]?.start_date,
    lease?.commencement_date,
    lease?.start_date,
  );
  const escalationRate = firstFiniteNumber(
    readReviewedBudgetFieldValue(lease, "escalation_rate"),
    lease?.escalation_rate,
  );
  return { monthly, startBasis, escalationRate };
}
