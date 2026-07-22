// @ts-nocheck
export function calculateErrorBudget({ service, window, objective, totalRequests, successfulRequests }) {
  const observedReliability = totalRequests > 0 ? successfulRequests / totalRequests : 1;
  const allowedFailure = 1 - objective;
  const observedFailure = 1 - observedReliability;
  const budgetConsumed = allowedFailure > 0 ? observedFailure / allowedFailure : 0;
  const remainingBudget = Math.max(0, 1 - budgetConsumed);
  const rolloutAllowed = observedReliability >= objective && remainingBudget > 0;
  return { service, window, objective, observedReliability, budgetConsumed, remainingBudget, rolloutAllowed, reasonCodes: rolloutAllowed ? ["error_budget_healthy"] : ["error_budget_exhausted"] };
}