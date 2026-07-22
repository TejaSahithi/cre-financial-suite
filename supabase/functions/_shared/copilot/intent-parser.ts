// @ts-nocheck
import { CopilotIntent } from "./copilot-contracts.ts";

const INTENT_PATTERNS: Array<[CopilotIntent, RegExp]> = [
  ["lease_expiration_search", /\b(expire|expires|expiration|renewal date)\b/i],
  ["cam_cap_search", /\b(cam|operating expense).*(cap|above|greater|percent|%)\b/i],
  ["rent_change_explanation", /\b(amendment|changed|modified|why).*(rent|base rent)\b/i],
  ["current_field_value", /\b(current|what is|show).*(rent|term|tenant|landlord|commencement|expiration|renewal)\b/i],
  ["amendment_explanation", /\b(amendment|modified|changed).*(renewal|option|term|rent|clause)\b/i],
  ["executive_summary", /\b(summary|summarize|abstract|executive)\b/i],
  ["blocked_review_explanation", /\b(blocked|missing evidence|cannot approve|review blocker)\b/i],
];

export function parseCopilotIntent(question: string, scope = "lease") {
  const normalized = String(question || "").trim();
  if (!normalized) return { intent: "unsupported", scope, normalizedQuestion: "", reasonCodes: ["empty_question"] };
  const match = INTENT_PATTERNS.find(([, pattern]) => pattern.test(normalized));
  return { intent: match?.[0] || "unsupported", scope, normalizedQuestion: normalized, reasonCodes: match ? ["intent_detected"] : ["unsupported_question"] };
}