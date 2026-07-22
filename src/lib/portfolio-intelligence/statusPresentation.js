export function formatPortfolioMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "Not available";
  const amount = Number(value);
  if (Math.abs(amount) >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (Math.abs(amount) >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount.toLocaleString()}`;
}

export function formatCoverageRate(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "0%";
  return `${Math.round(Number(value) * 100)}%`;
}

export function severityClass(severity) {
  if (severity === "critical") return "text-red-700 bg-red-50 border-red-200";
  if (severity === "high") return "text-orange-700 bg-orange-50 border-orange-200";
  if (severity === "medium") return "text-amber-700 bg-amber-50 border-amber-200";
  return "text-slate-700 bg-slate-50 border-slate-200";
}
