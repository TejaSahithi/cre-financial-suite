// @ts-nocheck

export type ProjectionMode =
  | "contracted_only"
  | "include_approved_renewals"
  | "include_assumed_renewals";

export interface LeaseScopeSelection {
  scopeLevel: "property" | "building" | "unit";
  scopeId: string | null;
}

export interface NormalizedLeaseDates {
  leaseStart: Date | null;
  rentStart: Date | null;
  leaseEnd: Date | null;
}

export interface RentScheduleRowInput {
  id?: string;
  org_id?: string;
  lease_id?: string;
  property_id?: string | null;
  building_id?: string | null;
  unit_id?: string | null;
  abstract_version?: number | null;
  row_type?: string | null;
  phase?: string | null;
  charge_frequency?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  monthly_amount?: number | string | null;
  annual_amount?: number | string | null;
  rent_per_sf?: number | string | null;
  rsf?: number | string | null;
  proration_method?: string | null;
  is_abatement?: boolean | null;
  abatement_percent?: number | string | null;
  escalation_type?: string | null;
  escalation_rate?: number | string | null;
  escalation_amount?: number | string | null;
  escalation_index?: string | null;
  status?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  source?: string | null;
  assumption_reason?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function normalizeProjectionMode(mode?: string | null): ProjectionMode {
  const normalized = String(mode || "").trim().toLowerCase();
  if (normalized === "include_approved_renewals") return "include_approved_renewals";
  if (normalized === "include_assumed_renewals") return "include_assumed_renewals";
  return "contracted_only";
}

export function normalizeScopeSelection(body: Record<string, unknown>): LeaseScopeSelection {
  const unitId = asText(body?.unit_id);
  const buildingId = asText(body?.building_id);
  const explicitScopeLevel = asText(body?.scope_level);
  const explicitScopeId = asText(body?.scope_id);

  if (explicitScopeLevel === "unit") {
    return { scopeLevel: "unit", scopeId: explicitScopeId ?? unitId ?? null };
  }
  if (explicitScopeLevel === "building") {
    return { scopeLevel: "building", scopeId: explicitScopeId ?? buildingId ?? null };
  }
  if (unitId) return { scopeLevel: "unit", scopeId: unitId };
  if (buildingId) return { scopeLevel: "building", scopeId: buildingId };
  return {
    scopeLevel: "property",
    scopeId: asText(body?.scope_id) ?? asText(body?.property_id) ?? null,
  };
}

export function monthLabel(index: number): string {
  return MONTH_LABELS[index] ?? "";
}

export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthStartUtc(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1));
}

export function monthEndUtc(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex + 1, 0));
}

export function parseDateUtc(value: unknown): Date | null {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : new Date(Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate(),
  ));
}

export function formatDateUtc(value: Date | null): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

export function addMonthsUtc(value: Date, months: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, value.getUTCDate()));
}

export function daysInMonthUtc(value: Date): number {
  return monthEndUtc(value.getUTCFullYear(), value.getUTCMonth()).getUTCDate();
}

export function countOverlapDays(start: Date, end: Date): number {
  const utcStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const utcEnd = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.floor((utcEnd - utcStart) / 86400000) + 1;
}

export function overlapsMonth(
  rowStart: Date | null,
  rowEnd: Date | null,
  monthStart: Date,
  monthEnd: Date,
): boolean {
  if (!rowStart || !rowEnd) return false;
  return rowStart <= monthEnd && rowEnd >= monthStart;
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function snapshotFields(lease: Record<string, any>): Record<string, any> {
  return safeObject(lease?.abstract_snapshot?.fields);
}

function extractionFields(lease: Record<string, any>): Record<string, any> {
  return safeObject(lease?.extraction_data?.fields);
}

function extractedFields(lease: Record<string, any>): Record<string, any> {
  return safeObject(lease?.extracted_fields);
}

export function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function asInteger(value: unknown): number | null {
  const parsed = asNumber(value);
  return parsed == null ? null : Math.round(parsed);
}

export function asText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

export function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function isApprovedLease(lease: Record<string, any>): boolean {
  const abstractStatus = String(lease?.abstract_status || "").toLowerCase();
  if (abstractStatus === "approved") return true;
  return String(lease?.status || "").toLowerCase() === "approved";
}

export function approvedFieldValue(
  lease: Record<string, any>,
  keys: string | string[],
): unknown {
  const candidates = Array.isArray(keys) ? keys : [keys];
  const snapshot = snapshotFields(lease);
  const extraction = extractionFields(lease);
  const extracted = extractedFields(lease);

  for (const key of candidates) {
    const snapshotField = safeObject(snapshot[key]);
    if (snapshotField.value != null && snapshotField.value !== "") {
      return snapshotField.value;
    }
    if (lease?.[key] != null && lease[key] !== "") {
      return lease[key];
    }
    const extractedField = extracted[key];
    if (extractedField && typeof extractedField === "object" && "value" in extractedField) {
      if (extractedField.value != null && extractedField.value !== "") return extractedField.value;
    }
    if (extractedField != null && extractedField !== "") return extractedField;
    const extractionField = extraction[key];
    if (extractionField && typeof extractionField === "object" && "value" in extractionField) {
      if (extractionField.value != null && extractionField.value !== "") return extractionField.value;
    }
    if (extractionField != null && extractionField !== "") return extractionField;
  }
  return null;
}

export function normalizedLeaseDates(lease: Record<string, any>): NormalizedLeaseDates {
  const leaseStart = parseDateUtc(
    approvedFieldValue(lease, ["commencement_date", "start_date"]),
  );
  const rentStart = parseDateUtc(
    approvedFieldValue(lease, ["rent_commencement_date", "commencement_date", "start_date"]),
  );
  const leaseEnd = parseDateUtc(
    approvedFieldValue(lease, ["expiration_date", "end_date"]),
  );
  return {
    leaseStart,
    rentStart: rentStart ?? leaseStart,
    leaseEnd,
  };
}

export function leaseRsf(lease: Record<string, any>): number {
  return (
    asNumber(approvedFieldValue(lease, ["tenant_rsf", "rentable_area_sqft", "square_footage", "total_sf"])) ??
    0
  );
}

export function baseMonthlyRentFromLease(lease: Record<string, any>): number {
  const monthly = asNumber(approvedFieldValue(lease, ["monthly_rent", "base_rent_monthly"]));
  if (monthly != null && monthly > 0) return monthly;

  const annual = asNumber(approvedFieldValue(lease, ["annual_rent"]));
  if (annual != null && annual > 0) return annual / 12;

  const rsf = leaseRsf(lease);
  const rentPerSf = asNumber(approvedFieldValue(lease, ["rent_per_sf"]));
  if (rsf > 0 && rentPerSf != null && rentPerSf > 0) {
    return (rentPerSf * rsf) / 12;
  }

  const groundRent = asNumber(approvedFieldValue(lease, ["ground_rent"]));
  if (groundRent != null && groundRent > 0) return groundRent;

  return 0;
}

function normalizeEscalationType(rawValue: unknown): string {
  return String(rawValue || "none").trim().toLowerCase();
}

function normalizeEscalationTiming(rawValue: unknown): string {
  const value = String(rawValue || "lease_anniversary").trim().toLowerCase();
  if (value === "calendar_year") return value;
  if (value === "fiscal_year") return value;
  return "lease_anniversary";
}

function escalationEventsThroughMonth(
  referenceStart: Date | null,
  targetMonthStart: Date,
  timing: string,
): number {
  if (!referenceStart) return 0;
  if (timing === "calendar_year" || timing === "fiscal_year") {
    return Math.max(0, targetMonthStart.getUTCFullYear() - referenceStart.getUTCFullYear());
  }
  const monthDelta =
    (targetMonthStart.getUTCFullYear() - referenceStart.getUTCFullYear()) * 12 +
    (targetMonthStart.getUTCMonth() - referenceStart.getUTCMonth());
  return Math.max(0, Math.floor(monthDelta / 12));
}

function escalatedMonthlyAmount(
  baseMonthly: number,
  escalationType: string,
  escalationValue: number,
  escalationTiming: string,
  referenceStart: Date | null,
  targetMonthStart: Date,
): number {
  const events = escalationEventsThroughMonth(referenceStart, targetMonthStart, escalationTiming);
  if (events <= 0 || escalationValue === 0) return round2(baseMonthly);

  if (/amount|flat/.test(escalationType)) {
    return round2(baseMonthly + (escalationValue * events));
  }

  if (["fixed_pct", "fixed", "cpi", "manual", "stepped"].includes(escalationType) || escalationType.includes("pct")) {
    return round2(baseMonthly * Math.pow(1 + (escalationValue / 100), events));
  }

  return round2(baseMonthly);
}

function recurringRowTypeForLease(lease: Record<string, any>): string {
  const leaseType = String(approvedFieldValue(lease, ["lease_type"]) || "").toLowerCase();
  if (leaseType.includes("ground")) return "ground_rent";
  return "base_rent";
}

function extraRecurringMonthlyCharges(lease: Record<string, any>): Array<{ rowType: string; monthlyAmount: number }> {
  const rows: Array<{ rowType: string; monthlyAmount: number }> = [];
  const percentageRent = asNumber(approvedFieldValue(lease, ["percentage_rent"]));
  const groundRent = asNumber(approvedFieldValue(lease, ["ground_rent"]));
  if (groundRent != null && groundRent > 0 && recurringRowTypeForLease(lease) !== "ground_rent") {
    rows.push({ rowType: "ground_rent", monthlyAmount: groundRent });
  }
  if (percentageRent != null && percentageRent > 0) {
    rows.push({ rowType: "percentage_rent", monthlyAmount: percentageRent });
  }
  return rows;
}

export function generateApprovedRentScheduleRows(lease: Record<string, any>): RentScheduleRowInput[] {
  const dates = normalizedLeaseDates(lease);
  if (!dates.rentStart || !dates.leaseEnd || dates.rentStart > dates.leaseEnd) return [];

  const orgId = lease?.org_id;
  const abstractVersion = asInteger(lease?.abstract_version) ?? 1;
  const baseMonthly = baseMonthlyRentFromLease(lease);
  const escalationType = normalizeEscalationType(
    approvedFieldValue(lease, ["escalation_type"]),
  );
  const escalationValue = asNumber(approvedFieldValue(lease, ["escalation_rate"])) ?? 0;
  const escalationTiming = normalizeEscalationTiming(
    approvedFieldValue(lease, ["escalation_timing"]),
  );
  const freeRentMonths = Math.max(0, asInteger(approvedFieldValue(lease, ["free_rent_months"])) ?? 0);
  const rowType = recurringRowTypeForLease(lease);
  const rsf = leaseRsf(lease);

  const rows: RentScheduleRowInput[] = [];
  let cursor = monthStartUtc(dates.rentStart.getUTCFullYear(), dates.rentStart.getUTCMonth());
  let monthOffset = 0;

  while (cursor <= dates.leaseEnd) {
    const monthStart = monthStartUtc(cursor.getUTCFullYear(), cursor.getUTCMonth());
    const monthEnd = monthEndUtc(cursor.getUTCFullYear(), cursor.getUTCMonth());
    const activeStart = dates.rentStart > monthStart ? dates.rentStart : monthStart;
    const activeEnd = dates.leaseEnd < monthEnd ? dates.leaseEnd : monthEnd;
    const overlapDays = countOverlapDays(activeStart, activeEnd);
    const monthDays = daysInMonthUtc(monthStart);
    const fullMonthly = escalatedMonthlyAmount(
      baseMonthly,
      escalationType,
      escalationValue,
      escalationTiming,
      dates.rentStart,
      monthStart,
    );
    const isFreeRent = monthOffset < freeRentMonths;

    rows.push({
      org_id: orgId,
      lease_id: lease.id,
      property_id: lease.property_id ?? null,
      building_id: lease.building_id ?? null,
      unit_id: lease.unit_id ?? null,
      abstract_version: abstractVersion,
      row_type: rowType,
      phase: "contracted",
      charge_frequency: "monthly",
      period_start: formatDateUtc(activeStart),
      period_end: formatDateUtc(activeEnd),
      monthly_amount: isFreeRent ? 0 : fullMonthly,
      annual_amount: isFreeRent ? 0 : round2(fullMonthly * 12),
      rent_per_sf: rsf > 0 ? round2((fullMonthly * 12) / rsf) : null,
      rsf: rsf || null,
      proration_method: "actual_days",
      is_abatement: isFreeRent,
      abatement_percent: isFreeRent ? 100 : 0,
      escalation_type: escalationType,
      escalation_rate: escalationType.includes("amount") || escalationType.includes("flat") ? null : escalationValue,
      escalation_amount: escalationType.includes("amount") || escalationType.includes("flat") ? escalationValue : null,
      status: "approved",
      approved_at: lease?.abstract_approved_at ?? null,
      approved_by: lease?.abstract_approved_by ?? null,
      source: "approved_abstract",
      metadata: {
        month_key: monthKey(monthStart),
        full_month_amount: round2(fullMonthly),
        scheduled_amount: isFreeRent ? 0 : round2(fullMonthly * (overlapDays / monthDays)),
        overlap_days: overlapDays,
        days_in_month: monthDays,
        free_rent_applied: isFreeRent,
      },
    });

    for (const extraCharge of extraRecurringMonthlyCharges(lease)) {
      rows.push({
        org_id: orgId,
        lease_id: lease.id,
        property_id: lease.property_id ?? null,
        building_id: lease.building_id ?? null,
        unit_id: lease.unit_id ?? null,
        abstract_version: abstractVersion,
        row_type: extraCharge.rowType,
        phase: "contracted",
        charge_frequency: "monthly",
        period_start: formatDateUtc(activeStart),
        period_end: formatDateUtc(activeEnd),
        monthly_amount: round2(extraCharge.monthlyAmount),
        annual_amount: round2(extraCharge.monthlyAmount * 12),
        rent_per_sf: null,
        rsf: rsf || null,
        proration_method: "actual_days",
        is_abatement: false,
        abatement_percent: 0,
        status: "approved",
        approved_at: lease?.abstract_approved_at ?? null,
        approved_by: lease?.abstract_approved_by ?? null,
        source: "approved_abstract",
        metadata: {
          month_key: monthKey(monthStart),
          scheduled_amount: round2(extraCharge.monthlyAmount * (overlapDays / monthDays)),
          overlap_days: overlapDays,
          days_in_month: monthDays,
        },
      });
    }

    cursor = monthStartUtc(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1);
    monthOffset += 1;
  }

  return rows;
}

function monthlyEquivalent(row: RentScheduleRowInput): number {
  const monthly = asNumber(row?.monthly_amount);
  if (monthly != null) return monthly;
  const annual = asNumber(row?.annual_amount);
  if (annual != null) return annual / 12;
  const rentPerSf = asNumber(row?.rent_per_sf);
  const rsf = asNumber(row?.rsf);
  if (rentPerSf != null && rsf != null) return (rentPerSf * rsf) / 12;
  return 0;
}

export function projectedAmountForMonth(
  row: RentScheduleRowInput,
  monthStart: Date,
  monthEnd: Date,
): number {
  const rowStart = parseDateUtc(row?.period_start);
  const rowEnd = parseDateUtc(row?.period_end);
  if (!overlapsMonth(rowStart, rowEnd, monthStart, monthEnd)) return 0;

  const activeStart = rowStart! > monthStart ? rowStart! : monthStart;
  const activeEnd = rowEnd! < monthEnd ? rowEnd! : monthEnd;
  const overlapDays = countOverlapDays(activeStart, activeEnd);
  const monthDays = daysInMonthUtc(monthStart);
  return round2(monthlyEquivalent(row) * (overlapDays / monthDays));
}

function parseRenewalTermMonths(rawValue: unknown): number {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value || value === "none") return 0;
  if (value === "month_to_month") return 1;

  const compact = value.replace(/\s+/g, "");
  const match = compact.match(/(\d+)x(\d+)/);
  if (match) {
    return Number(match[2]) * 12;
  }

  const yearMatch = value.match(/(\d+)\s*year/);
  if (yearMatch) {
    return Number(yearMatch[1]) * 12;
  }

  const monthMatch = value.match(/(\d+)\s*month/);
  if (monthMatch) {
    return Number(monthMatch[1]);
  }

  return 0;
}

function recurringRunRateForMonth(rows: RentScheduleRowInput[], monthStart: Date): number {
  const monthEnd = monthEndUtc(monthStart.getUTCFullYear(), monthStart.getUTCMonth());
  return round2(
    rows
      .filter((row) => ["base_rent", "ground_rent", "percentage_rent"].includes(String(row?.row_type || "")))
      .reduce((sum, row) => sum + projectedAmountForMonth(row, monthStart, monthEnd), 0),
  );
}

export function buildAssumedRenewalRows(
  lease: Record<string, any>,
  approvedRows: RentScheduleRowInput[],
  projectionEnd: Date,
): RentScheduleRowInput[] {
  const dates = normalizedLeaseDates(lease);
  if (!dates.leaseEnd || projectionEnd <= dates.leaseEnd) return [];

  const renewalMonths = parseRenewalTermMonths(
    approvedFieldValue(lease, ["renewal_options"]),
  );
  const holdoverMultiplier = asNumber(
    approvedFieldValue(lease, ["holdover_rent_multiplier"]),
  ) ?? 0;
  const renewalEscalationPct = asNumber(
    approvedFieldValue(lease, ["renewal_escalation_percent"]),
  ) ?? 0;

  const expiryMonthStart = monthStartUtc(dates.leaseEnd.getUTCFullYear(), dates.leaseEnd.getUTCMonth());
  const lastRunRate = recurringRunRateForMonth(approvedRows, expiryMonthStart);
  if (lastRunRate <= 0) return [];

  const rows: RentScheduleRowInput[] = [];
  const assumedStart = addMonthsUtc(expiryMonthStart, 1);
  let cursor = assumedStart;
  const assumedRenewalEnd =
    renewalMonths > 0
      ? new Date(Date.UTC(assumedStart.getUTCFullYear(), assumedStart.getUTCMonth() + renewalMonths, 0))
      : null;

  while (cursor <= projectionEnd) {
    const monthStart = monthStartUtc(cursor.getUTCFullYear(), cursor.getUTCMonth());
    const monthEnd = monthEndUtc(cursor.getUTCFullYear(), cursor.getUTCMonth());

    if (assumedRenewalEnd && monthStart <= assumedRenewalEnd) {
      const yearsIntoRenewal = Math.floor(
        ((monthStart.getUTCFullYear() - assumedStart.getUTCFullYear()) * 12 +
          (monthStart.getUTCMonth() - assumedStart.getUTCMonth())) / 12,
      );
      const monthlyAmount = round2(
        lastRunRate *
        (1 + (renewalEscalationPct / 100)) *
        Math.pow(1 + (renewalEscalationPct / 100), yearsIntoRenewal),
      );
      rows.push({
        lease_id: lease.id,
        property_id: lease.property_id ?? null,
        building_id: lease.building_id ?? null,
        unit_id: lease.unit_id ?? null,
        row_type: "renewal_base_rent",
        phase: "assumed_renewal",
        charge_frequency: "monthly",
        period_start: formatDateUtc(monthStart),
        period_end: formatDateUtc(monthEnd),
        monthly_amount: monthlyAmount,
        annual_amount: round2(monthlyAmount * 12),
        rsf: leaseRsf(lease) || null,
        status: "approved",
        source: "assumption",
        assumption_reason: "assumed_renewal",
        metadata: {
          month_key: monthKey(monthStart),
          renewal_escalation_percent: renewalEscalationPct,
        },
      });
      cursor = monthStartUtc(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1);
      continue;
    }

    if (holdoverMultiplier > 0) {
      const holdoverAmount = round2(lastRunRate * holdoverMultiplier);
      rows.push({
        lease_id: lease.id,
        property_id: lease.property_id ?? null,
        building_id: lease.building_id ?? null,
        unit_id: lease.unit_id ?? null,
        row_type: "holdover_rent",
        phase: "holdover",
        charge_frequency: "monthly",
        period_start: formatDateUtc(monthStart),
        period_end: formatDateUtc(monthEnd),
        monthly_amount: holdoverAmount,
        annual_amount: round2(holdoverAmount * 12),
        rsf: leaseRsf(lease) || null,
        status: "approved",
        source: "assumption",
        assumption_reason: "holdover",
        metadata: {
          month_key: monthKey(monthStart),
          holdover_multiplier: holdoverMultiplier,
        },
      });
    }

    cursor = monthStartUtc(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1);
  }

  return rows;
}

export function filterRowsForProjectionMode(
  rows: RentScheduleRowInput[],
  mode: ProjectionMode,
): RentScheduleRowInput[] {
  return rows.filter((row) => {
    const phase = String(row?.phase || "contracted").toLowerCase();
    if (phase === "contracted") return true;
    if (phase === "approved_renewal") {
      return mode === "include_approved_renewals" || mode === "include_assumed_renewals";
    }
    if (phase === "assumed_renewal" || phase === "holdover") {
      return mode === "include_assumed_renewals";
    }
    return mode === "include_assumed_renewals";
  });
}

export function nextFiscalYearExplanation(
  lease: Record<string, any>,
  nextFyTotal: number,
  projectionMode: ProjectionMode,
): string | null {
  if (nextFyTotal > 0) return null;
  const leaseEnd = parseDateUtc(
    approvedFieldValue(lease, ["expiration_date", "end_date"]),
  );
  if (!leaseEnd) return "No approved rent schedule rows are available for next fiscal year.";

  const expiryText = formatDateUtc(leaseEnd);
  if (projectionMode === "contracted_only") {
    return `Lease expires on ${expiryText}; contracted rent does not continue into the next fiscal year.`;
  }
  if (projectionMode === "include_approved_renewals") {
    return `Lease expires on ${expiryText}; no approved renewal rent schedule rows were found.`;
  }
  return `Lease expires on ${expiryText}; no approved or assumed renewal/holdover rent is available for the next fiscal year.`;
}
