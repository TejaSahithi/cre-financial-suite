// @ts-nocheck

export const PORTFOLIO_RISK_RULES = [
  { ruleKey: "expiration_within_180_days", domain: "expiration", severity: "high", scoreContribution: 30 },
  { ruleKey: "renewal_notice_within_60_days", domain: "renewal", severity: "high", scoreContribution: 25 },
  { ruleKey: "critical_rent_missing_evidence", domain: "data_quality", severity: "critical", scoreContribution: 40 },
  { ruleKey: "unresolved_amendment_precedence", domain: "amendment", severity: "critical", scoreContribution: 45 },
  { ruleKey: "rent_roll_material_variance", domain: "financial", severity: "high", scoreContribution: 35 },
  { ruleKey: "insurance_obligation_unresolved", domain: "insurance", severity: "medium", scoreContribution: 15 },
  { ruleKey: "leased_area_mismatch", domain: "operational", severity: "medium", scoreContribution: 15 },
];
