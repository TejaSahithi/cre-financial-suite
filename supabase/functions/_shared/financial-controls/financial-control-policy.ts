export type FinancialControlPolicyAction = "WARN" | "REQUIRE_ACKNOWLEDGEMENT" | "REQUIRE_APPROVAL" | "BLOCK";
export type MissingPolicyBehavior = "fail_open" | "fail_closed";

export interface FinancialControlPolicy {
  id?: string | null;
  org_id?: string | null;
  property_id?: string | null;
  workflow?: string | null;
  finding_type?: string | null;
  severity?: string | null;
  threshold_min?: number | string | null;
  threshold_max?: number | string | null;
  action?: string | null;
  missing_policy_behavior?: string | null;
  priority?: number | string | null;
  is_active?: boolean | null;
  reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FinancialControlFindingForPolicy {
  org_id?: string | null;
  property_id?: string | null;
  workflow?: string | null;
  code?: string | null;
  category?: string | null;
  severity?: string | null;
  variance_amount?: number | string | null;
  variance_percent?: number | string | null;
  policy_decision_snapshot?: Record<string, unknown> | null;
}

const ACTIONS = new Set(["WARN", "REQUIRE_ACKNOWLEDGEMENT", "REQUIRE_APPROVAL", "BLOCK"]);
const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

function normalizeAction(value: unknown): FinancialControlPolicyAction {
  const action = String(value || "").trim().toUpperCase();
  return (ACTIONS.has(action) ? action : "REQUIRE_ACKNOWLEDGEMENT") as FinancialControlPolicyAction;
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function norm(value: unknown): string | null {
  const text = String(value || "").trim().toLowerCase();
  return text || null;
}

function policyMatches(policy: FinancialControlPolicy, finding: FinancialControlFindingForPolicy, workflow: string) {
  if (policy.is_active === false) return false;
  if (policy.org_id && finding.org_id && policy.org_id !== finding.org_id) return false;
  if (policy.workflow && norm(policy.workflow) !== norm(workflow)) return false;
  if (policy.property_id && policy.property_id !== finding.property_id) return false;
  if (policy.finding_type && ![finding.code, finding.category].map(norm).includes(norm(policy.finding_type))) return false;
  if (policy.severity && norm(policy.severity) !== norm(finding.severity)) return false;

  const basis = asNumber(finding.variance_percent) ?? asNumber(finding.variance_amount) ?? 0;
  const min = asNumber(policy.threshold_min);
  const max = asNumber(policy.threshold_max);
  if (min != null && Math.abs(basis) < min) return false;
  if (max != null && Math.abs(basis) > max) return false;
  return true;
}

function specificity(policy: FinancialControlPolicy) {
  let score = Number(policy.priority ?? 0);
  if (policy.property_id) score += 1000;
  if (policy.finding_type) score += 100;
  if (policy.severity) score += 50 + (SEVERITY_RANK[norm(policy.severity) || ""] || 0);
  if (policy.threshold_min != null || policy.threshold_max != null) score += 25;
  if (policy.workflow) score += 10;
  return score;
}

export function resolveFinancialControlPolicyDecision(input: {
  finding: FinancialControlFindingForPolicy;
  policies?: FinancialControlPolicy[];
  workflow?: string | null;
  missingPolicyBehavior?: MissingPolicyBehavior | null;
  resolvedAt?: string | null;
}) {
  const workflow = String(input.workflow || input.finding.workflow || "budget_approval");
  const matching = (input.policies || [])
    .filter((policy) => policyMatches(policy, input.finding, workflow))
    .sort((a, b) => specificity(b) - specificity(a));
  const selected = matching[0] || null;
  const resolvedAt = input.resolvedAt || new Date().toISOString();

  if (!selected) {
    const explicitBehavior = input.missingPolicyBehavior || null;
    const action = explicitBehavior === "fail_closed" ? "BLOCK" : explicitBehavior === "fail_open" ? "WARN" : null;
    return {
      action,
      blocks: action === "BLOCK",
      requiresAcknowledgement: false,
      requiresApproval: false,
      reason: explicitBehavior === "fail_closed"
        ? "No financial-control policy matched; explicit fail-closed requested."
        : explicitBehavior === "fail_open"
          ? "No financial-control policy matched; explicit fail-open requested."
          : "No financial-control policy matched; no fail-open/fail-closed behavior was configured.",
      missingPolicyBehavior: explicitBehavior,
      policy: null,
      snapshot: {
        action,
        blocks: action === "BLOCK",
        reason: explicitBehavior === "fail_closed" ? "NO_POLICY_FAIL_CLOSED" : explicitBehavior === "fail_open" ? "NO_POLICY_FAIL_OPEN" : "NO_POLICY_CONFIGURED",
        workflow,
        missing_policy_behavior: explicitBehavior,
        matched_policy_id: null,
        resolved_at: resolvedAt,
        finding: {
          code: input.finding.code ?? null,
          category: input.finding.category ?? null,
          severity: input.finding.severity ?? null,
          variance_amount: input.finding.variance_amount ?? null,
          variance_percent: input.finding.variance_percent ?? null,
        },
      },
    };
  }

  const action = normalizeAction(selected.action);
  return {
    action,
    blocks: action === "BLOCK",
    requiresAcknowledgement: action === "REQUIRE_ACKNOWLEDGEMENT",
    requiresApproval: action === "REQUIRE_APPROVAL",
    reason: selected.reason || `Matched ${action} financial-control policy.`,
    missingPolicyBehavior: norm(selected.missing_policy_behavior) === "fail_closed" ? "fail_closed" : "fail_open",
    policy: selected,
    snapshot: {
      action,
      blocks: action === "BLOCK",
      reason: selected.reason || "MATCHED_POLICY",
      workflow,
      missing_policy_behavior: norm(selected.missing_policy_behavior) === "fail_closed" ? "fail_closed" : "fail_open",
      matched_policy_id: selected.id ?? null,
      matched_policy: {
        id: selected.id ?? null,
        property_id: selected.property_id ?? null,
        workflow: selected.workflow ?? null,
        finding_type: selected.finding_type ?? null,
        severity: selected.severity ?? null,
        threshold_min: selected.threshold_min ?? null,
        threshold_max: selected.threshold_max ?? null,
        action,
        priority: selected.priority ?? null,
        updated_at: selected.updated_at ?? null,
      },
      resolved_at: resolvedAt,
      finding: {
        code: input.finding.code ?? null,
        category: input.finding.category ?? null,
        severity: input.finding.severity ?? null,
        variance_amount: input.finding.variance_amount ?? null,
        variance_percent: input.finding.variance_percent ?? null,
      },
    },
  };
}

export function findingBlocksBudgetApproval(finding: FinancialControlFindingForPolicy) {
  const override = (finding.policy_decision_snapshot?.override || {}) as Record<string, unknown>;
  if (override.allowed === true) return false;
  return finding.policy_decision_snapshot?.blocks === true;
}
