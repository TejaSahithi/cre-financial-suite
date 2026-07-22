// @ts-nocheck

export function summarizePortfolioRisk(findings: any[]) {
  const bySeverity = { low: 0, medium: 0, high: 0, critical: 0 };
  const byDomain: Record<string, number> = {};
  let totalScore = 0;
  for (const finding of findings.filter((item) => item.status !== "resolved" && item.status !== "dismissed")) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    byDomain[finding.riskDomain] = (byDomain[finding.riskDomain] ?? 0) + Number(finding.scoreContribution ?? 0);
    totalScore += Number(finding.scoreContribution ?? 0);
  }
  return { totalScore, bySeverity, byDomain, findingCount: findings.length };
}
