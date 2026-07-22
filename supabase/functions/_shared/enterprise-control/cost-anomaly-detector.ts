// @ts-nocheck
export function detectCostAnomaly(current, baseline) {
  if (!baseline || baseline.averageCost <= 0) return { anomalous: false, reasonCodes: ["baseline_missing"] };
  const ratio = current.totalCost / baseline.averageCost;
  return ratio >= 3 ? { anomalous: true, ratio, reasonCodes: ["cost_spike_detected"] } : { anomalous: false, ratio, reasonCodes: ["cost_normal"] };
}