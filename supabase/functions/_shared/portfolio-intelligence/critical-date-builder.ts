// @ts-nocheck

import { PORTFOLIO_INTELLIGENCE_SCHEMA_VERSION, isoDate, stablePortfolioId } from "./types.ts";

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function buildCriticalDates(args: { fact: any; noticeRules?: any[]; includeEstimated?: boolean }) {
  const fact = args.fact;
  const events: any[] = [];
  const addEvent = (eventType: string, fieldKey: string, label: string, materiality = "operational") => {
    const field = fact.fields?.[fieldKey];
    const date = isoDate(field?.normalizedValue ?? field?.value);
    if (!date && field?.sourceLayer === "none") return;
    events.push({
      eventId: stablePortfolioId("critical-date", [fact.documentFamilyId, eventType, date ?? field?.status]),
      leaseId: fact.leaseId ?? null,
      documentFamilyId: fact.documentFamilyId,
      propertyId: fact.propertyId ?? null,
      portfolioId: fact.portfolioId ?? null,
      eventType,
      label,
      eventDate: date,
      windowStart: null,
      windowEnd: null,
      calculationStatus: date ? "resolved" : field?.status === "ambiguous" ? "ambiguous" : "missing_anchor",
      dateSource: field?.sourceLayer ?? "none",
      materiality,
      isBlocking: !date && materiality === "approval_critical",
      isEstimated: false,
      sourceFieldKeys: [fieldKey],
      sourceProjectionIds: [field?.projectionId].filter(Boolean),
      sourceEvidenceIds: field?.evidenceIds ?? [],
      evidenceAvailable: Boolean(field?.evidenceIds?.length),
      schemaVersion: PORTFOLIO_INTELLIGENCE_SCHEMA_VERSION,
    });
  };
  addEvent("commencement", "commencement_date", "Commencement", "approval_critical");
  addEvent("rent_commencement", "rent_commencement_date", "Rent Commencement", "financial");
  addEvent("expiration", "expiration_date", "Expiration", "approval_critical");

  const expiration = isoDate(fact.fields?.expiration_date?.normalizedValue);
  for (const rule of args.noticeRules ?? []) {
    if (!expiration) {
      events.push({
        eventId: stablePortfolioId("critical-date", [fact.documentFamilyId, rule.eventType ?? "renewal_notice_deadline", "missing_anchor"]),
        leaseId: fact.leaseId ?? null,
        documentFamilyId: fact.documentFamilyId,
        propertyId: fact.propertyId ?? null,
        portfolioId: fact.portfolioId ?? null,
        eventType: rule.eventType ?? "renewal_notice_deadline",
        label: rule.label ?? "Renewal notice deadline",
        eventDate: null,
        windowStart: null,
        windowEnd: null,
        calculationStatus: "missing_anchor",
        dateSource: "expiration_date",
        materiality: "operational",
        isBlocking: false,
        isEstimated: false,
        sourceFieldKeys: ["expiration_date"],
        sourceProjectionIds: [],
        sourceEvidenceIds: [],
        evidenceAvailable: false,
        schemaVersion: PORTFOLIO_INTELLIGENCE_SCHEMA_VERSION,
      });
      continue;
    }
    const deadline = addDays(expiration, -Math.abs(Number(rule.daysBefore ?? 0)));
    const open = addDays(deadline, -Math.abs(Number(rule.windowDays ?? 30)));
    events.push({
      eventId: stablePortfolioId("critical-date", [fact.documentFamilyId, rule.eventType ?? "renewal_notice_deadline", deadline]),
      leaseId: fact.leaseId ?? null,
      documentFamilyId: fact.documentFamilyId,
      propertyId: fact.propertyId ?? null,
      portfolioId: fact.portfolioId ?? null,
      eventType: rule.eventType ?? "renewal_notice_deadline",
      label: rule.label ?? "Renewal notice deadline",
      eventDate: deadline,
      windowStart: open,
      windowEnd: deadline,
      calculationStatus: "resolved",
      dateSource: "expiration_date",
      materiality: "operational",
      isBlocking: false,
      isEstimated: Boolean(rule.isEstimated),
      sourceFieldKeys: ["expiration_date", ...(rule.sourceFieldKeys ?? [])],
      sourceProjectionIds: [],
      sourceEvidenceIds: fact.fields?.expiration_date?.evidenceIds ?? [],
      evidenceAvailable: Boolean(fact.fields?.expiration_date?.evidenceIds?.length),
      schemaVersion: PORTFOLIO_INTELLIGENCE_SCHEMA_VERSION,
    });
  }

  const seen = new Set();
  return events.filter((event) => {
    const key = [event.documentFamilyId, event.eventType, event.eventDate, event.windowStart, event.windowEnd].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => `${a.eventDate ?? a.windowEnd ?? "9999-12-31"}:${a.eventType}:${a.documentFamilyId}`.localeCompare(`${b.eventDate ?? b.windowEnd ?? "9999-12-31"}:${b.eventType}:${b.documentFamilyId}`));
}

export function filterCriticalDates(events: any[], request: any) {
  const from = request.dateFrom ?? "0000-01-01";
  const to = request.dateTo ?? "9999-12-31";
  return events.filter((event) => {
    const date = event.eventDate ?? event.windowEnd ?? event.windowStart;
    if (!date) return request.includeEstimated === true || event.calculationStatus !== "resolved";
    if (date < from || date > to) return false;
    if (request.portfolioId && event.portfolioId !== request.portfolioId) return false;
    if (request.propertyId && event.propertyId !== request.propertyId) return false;
    if (Array.isArray(request.leaseIds) && request.leaseIds.length && !request.leaseIds.includes(event.leaseId)) return false;
    if (Array.isArray(request.eventTypes) && request.eventTypes.length && !request.eventTypes.includes(event.eventType)) return false;
    if (Array.isArray(request.statuses) && request.statuses.length && !request.statuses.includes(event.calculationStatus)) return false;
    if (Array.isArray(request.materialities) && request.materialities.length && !request.materialities.includes(event.materiality)) return false;
    if (!request.includeEstimated && event.isEstimated) return false;
    return true;
  }).sort((a, b) => `${a.eventDate ?? "9999-12-31"}:${a.eventType}:${a.documentFamilyId}`.localeCompare(`${b.eventDate ?? "9999-12-31"}:${b.eventType}:${b.documentFamilyId}`));
}
