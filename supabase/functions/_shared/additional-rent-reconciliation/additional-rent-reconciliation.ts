// @ts-nocheck

export const ADDITIONAL_RENT_RECONCILIATION_VERSION = "additional-rent-reconciliation-v1";

const AUTHORITATIVE_STATUSES = new Set(["approved", "active", "posted"]);
const ACTUAL_ROLE = "actual";
const BILLED_ROLE = "billed";
const ADJUSTMENT_ROLE = "adjustment";
const CREDIT_ROLE = "credit";
const CAM_TYPES = new Set(["cam", "cam_recovery", "common_area_maintenance", "operating_expense_recovery"]);
const CAM_COMPONENT_TYPES = new Set([
  "tax",
  "taxes",
  "real_estate_tax",
  "real_estate_taxes",
  "property_tax",
  "property_taxes",
  "insurance",
  "property_insurance",
]);

function round2(value) {
  const amount = Number(value || 0);
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function normalizeDate(value) {
  return value ? String(value).slice(0, 10) : "unknown";
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeChargeType(value) {
  return String(value || "unknown").trim().toLowerCase();
}

export function deterministicChargeKey(line) {
  const role = String(line?.role || line?.line_role || ACTUAL_ROLE).trim().toLowerCase();
  const chargeType = normalizeChargeType(line?.charge_type);
  const authoritativeTable = String(line?.authoritative_table || "unknown").trim().toLowerCase();
  const sourceRecordId = String(line?.source_record_id || "unknown").trim();
  const sourcePeriod = String(line?.source_period || `${normalizeDate(line?.period_start)}:${normalizeDate(line?.period_end)}`).trim();
  return `${role}:${chargeType}:${authoritativeTable}:${sourceRecordId}:${sourcePeriod}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function normalizeLine(line, index) {
  const role = String(line?.role || line?.line_role || ACTUAL_ROLE).trim().toLowerCase();
  const chargeType = normalizeChargeType(line?.charge_type);
  const authoritativeTable = String(line?.authoritative_table || "").trim();
  const sourceRecordId = String(line?.source_record_id || "").trim();
  const sourcePeriod = String(line?.source_period || `${normalizeDate(line?.period_start)}:${normalizeDate(line?.period_end)}`).trim();
  const amount = round2(line?.amount);
  const status = normalizeStatus(line?.status || "approved");
  const chargeKey = String(line?.charge_key || deterministicChargeKey({ ...line, role, charge_type: chargeType, authoritative_table: authoritativeTable, source_record_id: sourceRecordId, source_period: sourcePeriod })).trim();
  return {
    index,
    role,
    charge_type: chargeType,
    authoritative_table: authoritativeTable,
    source_record_id: sourceRecordId,
    source_period: sourcePeriod,
    period_start: line?.period_start ?? null,
    period_end: line?.period_end ?? null,
    amount,
    currency: line?.currency || "USD",
    status,
    charge_key: chargeKey,
    explanation: line?.explanation || null,
    evidence: clone(line?.evidence || {}),
    source_snapshot: clone(line?.source_snapshot || {}),
  };
}

function sum(lines) {
  return round2(lines.reduce((total, line) => total + Number(line.amount || 0), 0));
}

function disposition(finalBalance) {
  if (finalBalance > 0) return "tenant_due";
  if (finalBalance < 0) return "tenant_credit";
  return "settled";
}

function pushReason(reasons, code) {
  if (!reasons.includes(code)) reasons.push(code);
}

export function calculateAdditionalRentReconciliation(input = {}) {
  const normalizedLines = (input.lines || []).map(normalizeLine);
  const reasonCodes = [];
  const identitySeen = new Map();
  const actualChargeKeys = new Set();
  const billedChargeTypes = new Set();
  const actualChargeTypes = new Set();
  const camActualPresent = normalizedLines.some((line) => line.role === ACTUAL_ROLE && CAM_TYPES.has(line.charge_type));

  for (const line of normalizedLines) {
    if (!line.charge_type || line.charge_type === "unknown") pushReason(reasonCodes, `CHARGE_TYPE_MISSING:${line.index}`);
    if (!line.authoritative_table) pushReason(reasonCodes, `AUTHORITATIVE_TABLE_MISSING:${line.index}`);
    if (!line.source_record_id) pushReason(reasonCodes, `SOURCE_RECORD_ID_MISSING:${line.index}`);
    if (!line.source_period || line.source_period === "unknown:unknown") pushReason(reasonCodes, `SOURCE_PERIOD_MISSING:${line.index}`);

    const identityKey = `${line.role}:${line.authoritative_table}:${line.source_record_id}`;
    if (identitySeen.has(identityKey)) pushReason(reasonCodes, `DUPLICATE_SOURCE:${line.authoritative_table}:${line.source_record_id}:${line.role}`);
    identitySeen.set(identityKey, line.index);

    if ([ACTUAL_ROLE, BILLED_ROLE, ADJUSTMENT_ROLE, CREDIT_ROLE].includes(line.role) && !AUTHORITATIVE_STATUSES.has(line.status)) {
      pushReason(reasonCodes, `UNAPPROVED_CHARGE:${line.charge_type}`);
    }

    if (line.role === ACTUAL_ROLE) {
      if (actualChargeKeys.has(line.charge_key)) pushReason(reasonCodes, `DUPLICATE_CHARGE_KEY:${line.charge_key}`);
      actualChargeKeys.add(line.charge_key);
      actualChargeTypes.add(line.charge_type);
      if (camActualPresent && CAM_COMPONENT_TYPES.has(line.charge_type)) {
        pushReason(reasonCodes, `DOUBLE_COUNT_CAM_COMPONENT:${line.charge_type}`);
      }
    }
    if (line.role === BILLED_ROLE) billedChargeTypes.add(line.charge_type);
  }

  for (const chargeType of actualChargeTypes) {
    if (!billedChargeTypes.has(chargeType)) pushReason(reasonCodes, `BILLED_AMOUNT_MISSING:${chargeType}`);
  }

  const blocked = reasonCodes.length > 0;
  const countable = (line) => AUTHORITATIVE_STATUSES.has(line.status) && !(camActualPresent && CAM_COMPONENT_TYPES.has(line.charge_type));
  const actualLines = normalizedLines.filter((line) => line.role === ACTUAL_ROLE && countable(line));
  const billedLines = normalizedLines.filter((line) => line.role === BILLED_ROLE && countable(line));
  const adjustmentLines = normalizedLines.filter((line) => line.role === ADJUSTMENT_ROLE && countable(line));
  const creditLines = normalizedLines.filter((line) => line.role === CREDIT_ROLE && countable(line));

  const totals = {
    actual_responsibility: sum(actualLines),
    billed_amount: sum(billedLines),
    adjustments_amount: sum(adjustmentLines),
    credits_amount: sum(creditLines),
  };
  const finalBalance = round2(totals.actual_responsibility - totals.billed_amount + totals.adjustments_amount - totals.credits_amount);

  const calculationLines = [
    ...actualLines.map((line) => ({ ...line, calculation_role: "actual_responsibility", signed_amount: round2(line.amount) })),
    ...billedLines.map((line) => ({ ...line, calculation_role: "billed_or_estimated", signed_amount: round2(-line.amount) })),
    ...adjustmentLines.map((line) => ({ ...line, calculation_role: "approved_adjustment", signed_amount: round2(line.amount) })),
    ...creditLines.map((line) => ({ ...line, calculation_role: "approved_credit", signed_amount: round2(-line.amount) })),
    {
      calculation_role: "final_balance",
      formula: "actual_responsibility - billed_amount + adjustments_amount - credits_amount",
      actual_responsibility: totals.actual_responsibility,
      billed_amount: totals.billed_amount,
      adjustments_amount: totals.adjustments_amount,
      credits_amount: totals.credits_amount,
      output_amount: finalBalance,
    },
  ];

  return {
    engine_version: ADDITIONAL_RENT_RECONCILIATION_VERSION,
    status: blocked ? "blocked" : "calculated",
    reason_codes: reasonCodes,
    totals,
    final_balance: finalBalance,
    balance_disposition: blocked ? "review_required" : disposition(finalBalance),
    calculation_lines: calculationLines,
    input_snapshot: {
      period_start: input.period_start ?? null,
      period_end: input.period_end ?? null,
      calculated_at: input.calculated_at ?? new Date().toISOString(),
      lines: clone(normalizedLines),
    },
  };
}
