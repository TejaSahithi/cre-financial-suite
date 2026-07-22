// @ts-nocheck

import { PORTFOLIO_INTELLIGENCE_SCHEMA_VERSION, isoDate, numericValue, stablePortfolioId } from "./types.ts";

export function normalizeObligations(args: { fact: any; clauses?: any[]; amendmentEffects?: any[]; now?: string }) {
  const obligations: any[] = [];
  const clauses = args.clauses ?? [];
  const insurance = args.fact?.fields?.insurance_requirement;
  if (insurance && insurance.sourceLayer !== "none") {
    obligations.push({
      id: stablePortfolioId("obligation", [args.fact.documentFamilyId, "insurance_certificate"]),
      organizationId: args.fact.organizationId,
      portfolioId: args.fact.portfolioId ?? null,
      propertyId: args.fact.propertyId ?? null,
      documentFamilyId: args.fact.documentFamilyId,
      portfolioLeaseFactId: args.fact.id ?? null,
      obligationType: "insurance_certificate",
      responsibleParty: "tenant",
      counterparty: "landlord",
      frequency: "annual",
      dueRule: { relation: "before", anchor: "insurance_policy_expiration", offsetDays: 30 },
      startDate: isoDate(args.fact.fields?.commencement_date?.normalizedValue),
      endDate: isoDate(args.fact.fields?.expiration_date?.normalizedValue),
      nextDueDate: null,
      amount: null,
      currency: null,
      status: insurance.status === "ambiguous" ? "ambiguous" : "missing_anchor",
      materiality: "operational",
      sourceFieldKeys: ["insurance_requirement"],
      sourceProjectionIds: [insurance.projectionId].filter(Boolean),
      sourceEvidenceIds: insurance.evidenceIds ?? [],
      confidence: insurance.status === "ambiguous" ? 0.45 : 0.7,
      reasonCodes: ["anchor_date_unresolved"],
      schemaVersion: PORTFOLIO_INTELLIGENCE_SCHEMA_VERSION,
    });
  }
  for (const clause of clauses) {
    const text = String(clause.text ?? "").toLowerCase();
    const obligationType = text.includes("cam") ? "cam_reconciliation" : text.includes("sales") ? "sales_report" : text.includes("financial statement") ? "financial_statement_delivery" : text.includes("rent") ? "rent_payment" : null;
    if (!obligationType) continue;
    const explicitDate = isoDate(clause.dueDate ?? clause.date ?? null);
    const relative = text.match(/(\d+)\s+days?\s+(before|after)\s+([a-z_\s]+)/i);
    obligations.push({
      id: stablePortfolioId("obligation", [args.fact.documentFamilyId, obligationType, clause.blockId ?? clause.id ?? obligations.length]),
      organizationId: args.fact.organizationId,
      portfolioId: args.fact.portfolioId ?? null,
      propertyId: args.fact.propertyId ?? null,
      documentFamilyId: args.fact.documentFamilyId,
      portfolioLeaseFactId: args.fact.id ?? null,
      obligationType,
      responsibleParty: text.includes("landlord") ? "landlord" : "tenant",
      counterparty: text.includes("landlord") ? "tenant" : "landlord",
      frequency: text.includes("annual") || text.includes("annually") ? "annual" : text.includes("monthly") ? "monthly" : null,
      dueRule: relative ? { relation: relative[2], anchor: relative[3].trim().replace(/\s+/g, "_"), offsetDays: Number(relative[1]) } : explicitDate ? { relation: "on", anchor: "explicit_date" } : null,
      startDate: isoDate(clause.startDate),
      endDate: isoDate(clause.endDate),
      nextDueDate: explicitDate,
      amount: numericValue(clause.amount),
      currency: clause.currency ?? null,
      status: explicitDate ? "resolved" : relative ? "missing_anchor" : "partially_resolved",
      materiality: obligationType === "rent_payment" ? "financial" : "operational",
      sourceFieldKeys: clause.sourceFieldKeys ?? [obligationType],
      sourceProjectionIds: clause.sourceProjectionIds ?? [],
      sourceEvidenceIds: clause.evidenceIds ?? clause.sourceEvidenceIds ?? [],
      confidence: relative || explicitDate ? 0.78 : 0.52,
      reasonCodes: explicitDate ? [] : relative ? ["relative_anchor_unresolved"] : ["obligation_due_rule_partial"],
      schemaVersion: PORTFOLIO_INTELLIGENCE_SCHEMA_VERSION,
    });
  }
  return obligations.sort((a, b) => `${a.nextDueDate ?? "9999"}:${a.obligationType}`.localeCompare(`${b.nextDueDate ?? "9999"}:${b.obligationType}`));
}
