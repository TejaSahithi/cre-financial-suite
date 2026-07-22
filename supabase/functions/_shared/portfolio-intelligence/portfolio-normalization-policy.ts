// @ts-nocheck

export function normalizeFinancialValue(value: any, policy: any = {}) {
  const amount = typeof value?.amount === "number" ? value.amount : Number(String(value?.amount ?? "").replace(/[$,]/g, ""));
  const currency = value?.currency ?? null;
  const targetCurrency = policy.targetCurrency ?? currency;
  const warnings: string[] = [];
  if (!Number.isFinite(amount)) return { normalizedAmount: null, currency, warnings: ["amount_missing_or_invalid"] };
  if (currency && targetCurrency && currency !== targetCurrency) {
    const rate = policy.fxRates?.[`${currency}:${targetCurrency}`];
    if (!rate) return { normalizedAmount: null, currency, warnings: ["fx_rate_missing", `native_currency:${currency}`] };
    return { normalizedAmount: amount * rate, currency: targetCurrency, warnings: [`fx_rate_source:${policy.fxSourceDate ?? "unknown"}`] };
  }
  return { normalizedAmount: amount, currency, warnings };
}

export function normalizeArea(value: any, policy: any = {}) {
  const amount = Number(value?.amount ?? value);
  const unit = value?.unit ?? policy.sourceAreaUnit ?? null;
  const target = policy.targetAreaUnit ?? unit;
  if (!Number.isFinite(amount)) return { normalizedArea: null, areaUnit: unit, warnings: ["area_missing_or_invalid"] };
  if (unit && target && unit !== target) {
    const factor = policy.areaConversion?.[`${unit}:${target}`];
    if (!factor) return { normalizedArea: null, areaUnit: unit, warnings: ["area_conversion_missing"] };
    return { normalizedArea: amount * factor, areaUnit: target, warnings: [] };
  }
  return { normalizedArea: amount, areaUnit: unit, warnings: [] };
}

export function annualizeAmount(amount: number | null, frequency: string | null) {
  if (amount === null || amount === undefined) return null;
  if (frequency === "monthly") return amount * 12;
  if (frequency === "weekly") return amount * 52;
  if (frequency === "daily") return amount * 365;
  if (frequency === "annual") return amount;
  return null;
}
