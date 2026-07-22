// @ts-nocheck

export const EVENT_REGISTRY = {
  "lease.approved": { domain: "lease", aggregateType: "lease", contractVersion: "lease-fact-v1", externalName: "LeaseApproved" },
  "lease.rejected": { domain: "lease", aggregateType: "lease", contractVersion: "lease-fact-v1", externalName: "LeaseRejected" },
  "lease.reviewed": { domain: "lease", aggregateType: "lease", contractVersion: "lease-fact-v1", externalName: "LeaseReviewed" },
  "lease-family.updated": { domain: "lease", aggregateType: "document_family", contractVersion: "lease-fact-v1", externalName: "LeaseFamilyUpdated" },
  "lease-fact.published": { domain: "lease", aggregateType: "portfolio_lease_fact", contractVersion: "lease-fact-v1", externalName: "LeaseFactPublished" },
  "portfolio-fact.updated": { domain: "portfolio", aggregateType: "portfolio_lease_fact", contractVersion: "portfolio-summary-v1", externalName: "PortfolioFactUpdated" },
  "critical-date.created": { domain: "portfolio", aggregateType: "critical_date", contractVersion: "critical-dates-v1", externalName: "CriticalDateCreated" },
  "critical-date.changed": { domain: "portfolio", aggregateType: "critical_date", contractVersion: "critical-dates-v1", externalName: "CriticalDateChanged" },
  "obligation.created": { domain: "portfolio", aggregateType: "obligation", contractVersion: "obligations-v1", externalName: "ObligationCreated" },
  "obligation.completed": { domain: "portfolio", aggregateType: "obligation", contractVersion: "obligations-v1", externalName: "ObligationCompleted" },
  "risk.created": { domain: "portfolio", aggregateType: "risk_finding", contractVersion: "risk-findings-v1", externalName: "RiskFindingCreated" },
  "risk.resolved": { domain: "portfolio", aggregateType: "risk_finding", contractVersion: "risk-findings-v1", externalName: "RiskFindingResolved" },
  "rent-roll-variance.detected": { domain: "portfolio", aggregateType: "rent_roll_variance", contractVersion: "risk-findings-v1", externalName: "RentRollVarianceDetected" },
  "portfolio-snapshot.published": { domain: "portfolio", aggregateType: "portfolio_snapshot", contractVersion: "portfolio-summary-v1", externalName: "PortfolioSnapshotPublished" },
};

export function getEventDefinition(eventKey: string) {
  return EVENT_REGISTRY[eventKey] ?? null;
}

export function assertSupportedEvent(eventKey: string) {
  const definition = getEventDefinition(eventKey);
  if (!definition) throw new Error(`unsupported_event:${eventKey}`);
  return definition;
}
