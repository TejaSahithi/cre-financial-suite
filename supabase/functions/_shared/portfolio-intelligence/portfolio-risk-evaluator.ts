// @ts-nocheck

import { PORTFOLIO_RISK_RULES } from "./portfolio-risk-rules.ts";
import { stablePortfolioId } from "./types.ts";

function daysBetween(today: string, date: string | null) {
  if (!date) return null;
  return Math.floor((new Date(`${date}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86400000);
}

function rule(key: string) {
  return PORTFOLIO_RISK_RULES.find((item) => item.ruleKey === key)!;
}

function finding(ruleKey: string, fact: any, fieldKeys: string[], reasonCodes: string[], explanation: string) {
  const selected = rule(ruleKey);
  return {
    id: stablePortfolioId("portfolio-risk", [fact.documentFamilyId, ruleKey, fieldKeys.join("+")]),
    ruleKey,
    riskDomain: selected.domain,
    severity: selected.severity,
    scoreContribution: selected.scoreContribution,
    affectedLeaseIds: [fact.leaseId].filter(Boolean),
    affectedFieldKeys: fieldKeys,
    reasonCodes,
    explanation,
    evidenceIds: [...new Set(fieldKeys.flatMap((key) => fact.fields?.[key]?.evidenceIds ?? []))].sort(),
    resolutionGuidance: "Review source evidence and resolve the portfolio finding before publication.",
  };
}

export function evaluatePortfolioRisks(args: { facts: any[]; criticalDates?: any[]; obligations?: any[]; rentRollFindings?: any[]; today?: string }) {
  const today = args.today ?? new Date(0).toISOString().slice(0, 10);
  const findings: any[] = [];
  for (const fact of args.facts) {
    const expiration = fact.fields?.expiration_date?.normalizedValue ?? fact.expiration_date ?? null;
    const expirationDays = daysBetween(today, expiration);
    if (expirationDays !== null && expirationDays >= 0 && expirationDays <= 180) findings.push(finding("expiration_within_180_days", fact, ["expiration_date"], ["expiration_180_day_window"], "Lease expires within 180 days."));
    const rent = fact.fields?.base_rent_current;
    if (rent && rent.sourceLayer !== "none" && !rent.evidenceIds?.length) findings.push(finding("critical_rent_missing_evidence", fact, ["base_rent_current"], ["missing_source_evidence"], "Current base rent lacks source evidence."));
    if (fact.findings?.some((item: any) => item.reasonCodes?.includes("unresolved_amendment_precedence"))) findings.push(finding("unresolved_amendment_precedence", fact, fact.findings.flatMap((item: any) => item.fieldKeys ?? []), ["unresolved_amendment_precedence"], "Amendment precedence remains unresolved."));
  }
  for (const obligation of args.obligations ?? []) {
    if (obligation.obligationType === "insurance_certificate" && obligation.status !== "resolved") {
      findings.push(finding("insurance_obligation_unresolved", { ...obligation, fields: {}, leaseId: null }, ["insurance_requirement"], [obligation.status], "Insurance obligation is not fully resolved."));
    }
  }
  for (const variance of args.rentRollFindings ?? []) {
    if (variance.class === "material_variance") findings.push(finding("rent_roll_material_variance", { ...variance, documentFamilyId: variance.factId, fields: {}, leaseId: null }, [variance.fieldKey].filter(Boolean), ["rent_roll_variance"], "Rent roll value materially differs from canonical lease intelligence."));
  }
  return findings.sort((a, b) => `${b.scoreContribution}:${a.ruleKey}`.localeCompare(`${a.scoreContribution}:${b.ruleKey}`));
}
