// @ts-nocheck

export const PORTFOLIO_QUERY_ENTITIES = ["lease", "obligation", "critical_date", "finding", "financial_term"];
export const PORTFOLIO_QUERY_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "between", "exists"];
export const PORTFOLIO_QUERY_FIELDS = {
  lease: ["tenant_name", "property_id", "portfolio_id", "expiration_date", "base_rent_current", "lease_status", "approval_status", "semantic_status", "risk_severity"],
  obligation: ["obligation_type", "responsible_party", "next_due_date", "status", "materiality", "portfolio_id", "property_id"],
  critical_date: ["event_type", "event_date", "window_start", "window_end", "calculation_status", "materiality", "portfolio_id", "property_id"],
  finding: ["rule_key", "risk_domain", "severity", "status", "portfolio_id", "property_id"],
  financial_term: ["term_type", "normalized_amount", "currency", "frequency", "status", "portfolio_id", "property_id"],
};
