// @ts-nocheck
import { getDateExpressionType } from "./date-expression-registry.ts";
import type { DateExpressionType } from "./date-expression-types.ts";

const ALIASES: Record<string, DateExpressionType> = {
  fixed: "fixed_date",
  specific_date: "fixed_date",
  explicit_date: "fixed_date",
  event: "event_date",
  relative_date: "relative_to_date",
  relative_event: "relative_to_event",
  before_after_date: "relative_to_date",
  before_after_event: "relative_to_event",
  sooner_of: "earlier_of",
  later: "later_of",
  min_of: "minimum_of",
  max_of: "maximum_of",
  dependent: "dependent_date",
  recurring: "recurring_deadline",
  notice: "notice_window",
  unknown_expression: "unresolved_expression",
};

function normalizeToken(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function normalizeDateExpressionType(value: unknown): DateExpressionType | null {
  const token = normalizeToken(value);
  if (!token) return null;
  if (getDateExpressionType(token)) return token as DateExpressionType;
  return ALIASES[token] ?? null;
}

export function requireDateExpressionType(value: unknown): DateExpressionType {
  const normalized = normalizeDateExpressionType(value);
  if (!normalized) {
    throw new Error(`DATE_EXPRESSION_TYPE_INVALID: ${String(value ?? "")}`);
  }
  return normalized;
}

export function canonicalizeExpressionComponent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeExpressionComponent);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = canonicalizeExpressionComponent((value as Record<string, unknown>)[key]);
  }
  return result;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalizeExpressionComponent(value));
}
