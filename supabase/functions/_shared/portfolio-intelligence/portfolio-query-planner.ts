// @ts-nocheck

import { validatePortfolioSearchPlan } from "./portfolio-query-validator.ts";

function betweenDates(field: string, from: string, to: string) {
  return { field, operator: "between", value: [from, to] };
}

export function planPortfolioQuery(request: any) {
  if (request?.plan) {
    const plan = { ...request.plan, limit: Math.min(Number(request.plan.limit ?? 25), 100) };
    const validation = validatePortfolioSearchPlan(plan);
    if (!validation.valid) return { plan: null, errors: validation.errors };
    return { plan, errors: [] };
  }

  const query = String(request?.query ?? "").toLowerCase();
  const filters: any[] = [];
  let entity = "lease";
  if (query.includes("obligation") || query.includes("insurance")) entity = "obligation";
  if (query.includes("deadline") || query.includes("expiring") || query.includes("expiration") || query.includes("critical date")) entity = "critical_date";
  if (query.includes("risk") || query.includes("missing") || query.includes("unresolved")) entity = "finding";
  if (query.includes("rent") || query.includes("cam") || query.includes("deposit")) entity = query.includes("variance") ? "finding" : "financial_term";

  if (query.includes("next 18 months")) {
    const from = request.today ?? new Date(0).toISOString().slice(0, 10);
    const toDate = new Date(`${from}T00:00:00Z`);
    toDate.setUTCMonth(toDate.getUTCMonth() + 18);
    filters.push(betweenDates(entity === "critical_date" ? "event_date" : "expiration_date", from, toDate.toISOString().slice(0, 10)));
  } else if (query.includes("next 90 days")) {
    const from = request.today ?? new Date(0).toISOString().slice(0, 10);
    const toDate = new Date(`${from}T00:00:00Z`);
    toDate.setUTCDate(toDate.getUTCDate() + 90);
    filters.push(betweenDates(entity === "critical_date" ? "event_date" : "next_due_date", from, toDate.toISOString().slice(0, 10)));
  }
  if (query.includes("unresolved")) filters.push({ field: entity === "finding" ? "status" : "calculation_status", operator: "neq", value: "resolved" });
  if (query.includes("insurance") && entity === "obligation") filters.push({ field: "obligation_type", operator: "eq", value: "insurance_certificate" });
  if (query.includes("cam") && entity === "financial_term") filters.push({ field: "term_type", operator: "eq", value: "cam" });

  const plan = { entity, filters, sort: [{ field: entity === "critical_date" ? "event_date" : entity === "obligation" ? "next_due_date" : "tenant_name", direction: "asc" }], limit: Math.min(Number(request?.limit ?? 25), 100) };
  const validation = validatePortfolioSearchPlan(plan);
  if (!validation.valid) return { plan: null, errors: validation.errors };
  return { plan, errors: [] };
}

export function applySearchPlan(rows: any[], plan: any) {
  const filtered = rows.filter((row) => (plan.filters ?? []).every((filter: any) => {
    const value = row[filter.field] ?? row.fields?.[filter.field]?.normalizedValue ?? row.fields?.[filter.field]?.value;
    if (filter.operator === "eq") return value === filter.value;
    if (filter.operator === "neq") return value !== filter.value;
    if (filter.operator === "contains") return String(value ?? "").toLowerCase().includes(String(filter.value ?? "").toLowerCase());
    if (filter.operator === "exists") return value !== null && value !== undefined;
    if (["gt", "gte", "lt", "lte"].includes(filter.operator)) {
      if (filter.operator === "gt") return value > filter.value;
      if (filter.operator === "gte") return value >= filter.value;
      if (filter.operator === "lt") return value < filter.value;
      return value <= filter.value;
    }
    if (filter.operator === "between") return value >= filter.value[0] && value <= filter.value[1];
    if (filter.operator === "in") return Array.isArray(filter.value) && filter.value.includes(value);
    return false;
  }));
  return filtered.sort((a, b) => (plan.sort ?? []).reduce((result: number, sort: any) => {
    if (result !== 0) return result;
    const av = a[sort.field] ?? a.fields?.[sort.field]?.normalizedValue ?? "";
    const bv = b[sort.field] ?? b.fields?.[sort.field]?.normalizedValue ?? "";
    const cmp = String(av ?? "").localeCompare(String(bv ?? ""));
    return sort.direction === "desc" ? -cmp : cmp;
  }, 0)).slice(0, plan.limit);
}
