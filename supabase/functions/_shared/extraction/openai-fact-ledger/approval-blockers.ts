// @ts-nocheck
/**
 * OpenAI Fact Ledger — Profile-Specific Approval Blockers
 *
 * Backend-only, advisory in this pass: computes and stores approval_blockers
 * in ui_review_payload, but LeaseReview.jsx does not consume or display them
 * yet (per guardrail — do not claim this UI story is solved until it does),
 * and this pass does not touch the approve_lease_workflow RPC.
 */

import type { ExtractedRecord } from "../types.ts";
import type { ApprovalBlocker, DocumentProfile, ProfileApprovalBlockersResult } from "./types.ts";

interface BlockerRule {
  /** Any one of these field keys being present (non-null) satisfies the rule. */
  anyOf: string[];
  label: string;
}

const FULL_LEASE_RULES: BlockerRule[] = [
  { anyOf: ["tenant_name"], label: "Tenant Name" },
  { anyOf: ["landlord_name"], label: "Landlord Name" },
  { anyOf: ["property_address", "property_name"], label: "Property Address / Name" },
  { anyOf: ["start_date", "commencement_date"], label: "Commencement Date" },
  { anyOf: ["end_date"], label: "Expiration Date" },
  { anyOf: ["monthly_rent", "annual_rent", "base_rent_monthly"], label: "Base Rent" },
];

const ASSIGNMENT_RULES: BlockerRule[] = [
  { anyOf: ["assignor_name"], label: "Assignor Name" },
  { anyOf: ["assignee_name"], label: "Assignee Name" },
  { anyOf: ["assignment_effective_date"], label: "Assignment Effective Date" },
  { anyOf: ["landlord_consent"], label: "Landlord Consent" },
];

const AMENDMENT_RULES: BlockerRule[] = [
  { anyOf: ["tenant_name"], label: "Tenant Name" },
  { anyOf: ["property_address", "property_name"], label: "Property Address / Name" },
  { anyOf: ["all_other_terms_remain_same"], label: "Scope of Amendment" },
];

const MINIMAL_FLOOR_RULES: BlockerRule[] = [
  { anyOf: ["tenant_name"], label: "Tenant Name" },
  { anyOf: ["property_address", "property_name"], label: "Property Address / Name" },
  { anyOf: ["commencement_date", "start_date"], label: "Commencement Date" },
];

function dedupeRules(rules: BlockerRule[]): BlockerRule[] {
  const seen = new Set<string>();
  const result: BlockerRule[] = [];
  for (const rule of rules) {
    const key = rule.anyOf.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(rule);
  }
  return result;
}

const PROFILE_BLOCKER_RULES: Record<DocumentProfile, BlockerRule[]> = {
  full_lease: FULL_LEASE_RULES,
  assignment: ASSIGNMENT_RULES,
  amendment: AMENDMENT_RULES,
  assignment_amendment: dedupeRules([...ASSIGNMENT_RULES, ...AMENDMENT_RULES]),
  abstract: MINIMAL_FLOOR_RULES,
  addendum: MINIMAL_FLOOR_RULES,
  exhibit: MINIMAL_FLOOR_RULES,
};

function hasRealValue(fields: Record<string, unknown>, key: string): boolean {
  const field = (fields as any)?.[key];
  const value = field && typeof field === "object" && "value" in field ? field.value : field;
  return value !== null && value !== undefined && value !== "";
}

/**
 * Compute advisory approval blockers for a document profile against the
 * mapped standard-field record. Never throws — an unrecognized profile
 * falls back to the minimal 3-field floor.
 */
export function computeProfileApprovalBlockers(args: {
  profile: DocumentProfile;
  standardFields: ExtractedRecord | Record<string, unknown> | null | undefined;
}): ProfileApprovalBlockersResult {
  const { profile } = args;
  const fields = (args.standardFields as ExtractedRecord)?.fields ?? (args.standardFields as Record<string, unknown>) ?? {};
  const rules = PROFILE_BLOCKER_RULES[profile] ?? MINIMAL_FLOOR_RULES;

  const blockers: ApprovalBlocker[] = [];
  for (const rule of rules) {
    const satisfied = rule.anyOf.some((key) => hasRealValue(fields, key));
    if (!satisfied) {
      blockers.push({ fieldKey: rule.anyOf[0], label: rule.label, reason: "missing" });
    }
  }

  return { documentProfile: profile, blockers };
}
