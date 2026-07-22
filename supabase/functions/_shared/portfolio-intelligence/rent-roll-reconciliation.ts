// @ts-nocheck

import { classifyRentRollVariance } from "./rent-roll-variance-classifier.ts";

const COMPARED_FIELDS = ["tenant_name", "premises_identifier", "leased_area", "commencement_date", "expiration_date", "base_rent_current", "security_deposit"];

export function reconcileRentRoll(args: { facts: any[]; rentRoll: any[]; config?: any }) {
  const findings: any[] = [];
  const matchedSystemIds = new Set();
  for (const fact of args.facts) {
    const tenant = fact.fields?.tenant_name?.normalizedValue ?? fact.fields?.tenant_name?.value ?? fact.tenant_name;
    const system = args.rentRoll.find((row) => row.leaseId === fact.leaseId || String(row.tenantName ?? "").toLowerCase() === String(tenant ?? "").toLowerCase());
    if (!system) {
      findings.push({ factId: fact.id ?? fact.documentFamilyId, class: "missing_in_rent_roll", fieldKey: null, canonicalValue: tenant, systemValue: null, materiality: "high", suggestedReviewerAction: "confirm_rent_roll_variance", sourceLineage: fact.lineage });
      continue;
    }
    matchedSystemIds.add(system.id ?? system.leaseId);
    for (const fieldKey of COMPARED_FIELDS) {
      const canonicalValue = fact.fields?.[fieldKey]?.normalizedValue ?? fact.fields?.[fieldKey]?.value ?? fact[fieldKey];
      const systemValue = system[fieldKey] ?? system[fieldKey.replace("_current", "")] ?? system[fieldKey.replace("_identifier", "")];
      const cls = classifyRentRollVariance(canonicalValue, systemValue, args.config);
      if (["exact_match", "normalized_match"].includes(cls)) continue;
      const cNum = Number(canonicalValue);
      const sNum = Number(systemValue);
      findings.push({
        factId: fact.id ?? fact.documentFamilyId,
        class: cls,
        fieldKey,
        canonicalValue,
        systemValue,
        normalizedComparison: { canonical: canonicalValue, system: systemValue },
        varianceAmount: Number.isFinite(cNum) && Number.isFinite(sNum) ? cNum - sNum : null,
        variancePercentage: Number.isFinite(cNum) && Number.isFinite(sNum) && sNum !== 0 ? (cNum - sNum) / Math.abs(sNum) : null,
        materiality: fieldKey === "base_rent_current" ? "financial" : "operational",
        sourceLineage: fact.lineage,
        suggestedReviewerAction: "confirm_rent_roll_variance",
      });
    }
  }
  for (const row of args.rentRoll) {
    if (!matchedSystemIds.has(row.id ?? row.leaseId)) findings.push({ factId: null, class: "missing_in_lease_intelligence", fieldKey: null, canonicalValue: null, systemValue: row.tenantName ?? row.tenant_name, materiality: "medium", suggestedReviewerAction: "request_lease_review", sourceLineage: null });
  }
  return findings.sort((a, b) => `${a.class}:${a.fieldKey ?? ""}:${a.factId ?? ""}`.localeCompare(`${b.class}:${b.fieldKey ?? ""}:${b.factId ?? ""}`));
}
