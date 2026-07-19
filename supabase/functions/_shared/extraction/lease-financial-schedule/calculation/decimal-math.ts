// @ts-nocheck
export const DECIMAL_INPUT_SCALE = 6;
export const DECIMAL_INTERMEDIATE_SCALE = 6;
export const DECIMAL_CURRENCY_OUTPUT_SCALE = 2;
export const DECIMAL_PERCENTAGE_RATE_SCALE = 6;
export const DECIMAL_ROUNDING_MODE = "half_up";
export const DECIMAL_MAX_ABS_SCALED = 9_999_999_999_999_999_000000n;

const SCALE = BigInt(DECIMAL_INPUT_SCALE);
export const DECIMAL_FACTOR = 1_000_000n;

export interface DecimalValue {
  scaled: bigint;
}

function pow10(exp: number): bigint {
  let out = 1n;
  for (let i = 0; i < exp; i++) out *= 10n;
  return out;
}

export function decimal(value: string | number | bigint | DecimalValue): DecimalValue {
  if (typeof value === "object" && value && "scaled" in value) return bounded({ scaled: BigInt(value.scaled) });
  if (typeof value === "bigint") return bounded({ scaled: value * DECIMAL_FACTOR });
  const raw = String(value).trim().replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error("DECIMAL_INVALID");
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = unsigned.split(".");
  const padded = (fraction + "000000").slice(0, 6);
  const scaled = BigInt(whole || "0") * DECIMAL_FACTOR + BigInt(padded || "0");
  return bounded({ scaled: negative ? -scaled : scaled });
}

export function toDecimalString(value: DecimalValue, scale = 2): string {
  const sign = value.scaled < 0n ? "-" : "";
  const abs = value.scaled < 0n ? -value.scaled : value.scaled;
  const roundFactor = pow10(Number(SCALE) - scale);
  const rounded = (abs + roundFactor / 2n) / roundFactor;
  const whole = rounded / pow10(scale);
  const fraction = String(rounded % pow10(scale)).padStart(scale, "0");
  return scale === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

export function addDecimal(a: string | number | DecimalValue, b: string | number | DecimalValue): DecimalValue {
  return bounded({ scaled: decimal(a).scaled + decimal(b).scaled });
}

export function subtractDecimal(a: string | number | DecimalValue, b: string | number | DecimalValue): DecimalValue {
  return bounded({ scaled: decimal(a).scaled - decimal(b).scaled });
}

export function multiplyDecimal(a: string | number | DecimalValue, b: string | number | DecimalValue): DecimalValue {
  return bounded({ scaled: roundScaled(decimal(a).scaled * decimal(b).scaled, DECIMAL_FACTOR) });
}

export function divideDecimal(a: string | number | DecimalValue, b: string | number | DecimalValue): DecimalValue {
  const divisor = decimal(b).scaled;
  if (divisor === 0n) throw new Error("DECIMAL_DIVIDE_BY_ZERO");
  return bounded({ scaled: roundScaled(decimal(a).scaled * DECIMAL_FACTOR, divisor) });
}

export function percentToRate(value: string | number | DecimalValue): DecimalValue {
  return divideDecimal(decimal(value), 100);
}

export function compareDecimal(a: string | number | DecimalValue, b: string | number | DecimalValue): number {
  const left = decimal(a).scaled;
  const right = decimal(b).scaled;
  return left === right ? 0 : left > right ? 1 : -1;
}

export function sumDecimals(values: Array<string | number | DecimalValue>): DecimalValue {
  return values.reduce((total, value) => addDecimal(total, value), decimal(0));
}

export function roundMoney(value: string | number | DecimalValue): string {
  return toDecimalString(decimal(value), DECIMAL_CURRENCY_OUTPUT_SCALE);
}

export function roundScaled(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("DECIMAL_DIVIDE_BY_ZERO");
  const sign = (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  return sign * ((absNumerator + absDenominator / 2n) / absDenominator);
}

export function bounded(value: DecimalValue): DecimalValue {
  const abs = value.scaled < 0n ? -value.scaled : value.scaled;
  if (abs > DECIMAL_MAX_ABS_SCALED) throw new Error("DECIMAL_OVERFLOW");
  return value;
}