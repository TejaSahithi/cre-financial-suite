// @ts-nocheck

export const INTEGRATION_CONTRACTS = {
  "lease-fact-v1": { fields: ["leaseId", "documentFamilyId", "tenantName", "expirationDate", "status", "lineage"] },
  "portfolio-summary-v1": { fields: ["portfolioId", "leaseCount", "activeLeaseCount", "coverage", "sourceGenerationDigest"] },
  "critical-dates-v1": { fields: ["eventId", "eventType", "eventDate", "windowStart", "windowEnd", "sourceFieldKeys"] },
  "obligations-v1": { fields: ["obligationId", "obligationType", "responsibleParty", "status", "dueRule"] },
  "risk-findings-v1": { fields: ["findingId", "ruleKey", "severity", "scoreContribution", "resolutionGuidance"] },
  "portfolio-export-v1": { fields: ["exportId", "format", "filters", "coverageSummary", "sourceGenerationDigest"] },
};

export function projectContract(contractVersion: string, source: any) {
  const contract = INTEGRATION_CONTRACTS[contractVersion];
  if (!contract) throw new Error(`unsupported_contract:${contractVersion}`);
  return Object.fromEntries(contract.fields.map((field: string) => [field, source[field] ?? source[field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] ?? null]));
}
