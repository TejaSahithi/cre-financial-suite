// @ts-nocheck

function norm(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function classifyRentRollVariance(canonical: any, system: any, config: any = {}) {
  if (!canonical && system) return "missing_in_lease_intelligence";
  if (canonical && !system) return "missing_in_rent_roll";
  if (!canonical && !system) return "ambiguous_match";
  const toleranceAmount = Number(config.amountTolerance ?? 1);
  const tolerancePct = Number(config.percentageTolerance ?? 0.02);
  const canonicalValue = Number(canonical?.value ?? canonical);
  const systemValue = Number(system?.value ?? system);
  if (norm(canonical) === norm(system)) return "exact_match";
  if (Number.isFinite(canonicalValue) && Number.isFinite(systemValue)) {
    const variance = Math.abs(canonicalValue - systemValue);
    const pct = systemValue === 0 ? variance : variance / Math.abs(systemValue);
    if (variance <= toleranceAmount || pct <= tolerancePct) return "normalized_match";
    return "material_variance";
  }
  return norm(canonical).includes(norm(system)) || norm(system).includes(norm(canonical)) ? "normalized_match" : "material_variance";
}
