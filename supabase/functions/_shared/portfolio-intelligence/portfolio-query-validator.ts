// @ts-nocheck

import { PORTFOLIO_QUERY_ENTITIES, PORTFOLIO_QUERY_FIELDS, PORTFOLIO_QUERY_OPERATORS } from "./portfolio-query-schema.ts";

export function validatePortfolioSearchPlan(plan: any) {
  const errors: string[] = [];
  if (!PORTFOLIO_QUERY_ENTITIES.includes(plan?.entity)) errors.push("unsupported_entity");
  const fields = PORTFOLIO_QUERY_FIELDS[plan?.entity] ?? [];
  for (const filter of plan?.filters ?? []) {
    if (!fields.includes(filter.field)) errors.push(`unsupported_field:${filter.field}`);
    if (!PORTFOLIO_QUERY_OPERATORS.includes(filter.operator)) errors.push(`unsupported_operator:${filter.operator}`);
    if (String(filter.field).toLowerCase().includes("sql") || String(filter.value).includes(";")) errors.push("raw_sql_rejected");
  }
  for (const sort of plan?.sort ?? []) {
    if (!fields.includes(sort.field)) errors.push(`unsupported_sort:${sort.field}`);
    if (!["asc", "desc"].includes(sort.direction)) errors.push(`unsupported_sort_direction:${sort.direction}`);
  }
  if (!Number.isInteger(plan?.limit) || plan.limit < 1 || plan.limit > 100) errors.push("unbounded_result_set");
  return { valid: errors.length === 0, errors };
}
