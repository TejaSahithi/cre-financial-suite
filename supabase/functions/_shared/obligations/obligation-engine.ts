export interface LeaseObligationInput {
  id: string;
  org_id: string;
  lease_id?: string | null;
  property_id?: string | null;
  obligation_type: string;
  cadence?: string | null;
  due_rule?: Record<string, unknown> | null;
  effective_start?: string | null;
  effective_end?: string | null;
  communication_policy?: string | null;
  status?: string | null;
}

export interface ObligationOccurrenceInput {
  obligation_id: string;
  lease_id: string | null;
  property_id: string | null;
  period_start: string | null;
  period_end: string | null;
  due_date: string;
  notification_policy: string;
  idempotency_key: string;
  status: "open" | "overdue" | "pending_review";
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addMonths(value: Date, months: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, value.getUTCDate()));
}

function addDays(value: Date, days: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function cadenceMonths(cadence: string | null | undefined): number | null {
  const value = String(cadence || "once").toLowerCase();
  if (value === "monthly") return 1;
  if (value === "quarterly") return 3;
  if (value === "annual") return 12;
  return null;
}

function occurrenceStatus(dueDate: string, asOfDate: string): "open" | "overdue" {
  return dueDate < asOfDate ? "overdue" : "open";
}


function dateFromParts(year: number, month: number, day: number): Date | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

function yearEnd(year: number): Date {
  return new Date(Date.UTC(year, 11, 31));
}

function yearStart(year: number): Date {
  return new Date(Date.UTC(year, 0, 1));
}

function reviewOccurrence(obligation: LeaseObligationInput, start: Date, end: Date, notificationPolicy: string): ObligationOccurrenceInput {
  const dueDate = formatDate(start);
  return {
    obligation_id: obligation.id,
    lease_id: obligation.lease_id ?? null,
    property_id: obligation.property_id ?? null,
    period_start: formatDate(start),
    period_end: formatDate(end),
    due_date: dueDate,
    notification_policy: notificationPolicy,
    idempotency_key: `${obligation.id}:review_required:${dueDate}`,
    status: "pending_review",
  };
}

function pushOccurrence(occurrences: ObligationOccurrenceInput[], obligation: LeaseObligationInput, input: {
  periodStart: Date;
  periodEnd: Date;
  due: Date;
  start: Date;
  end: Date;
  asOfDate: string;
  notificationPolicy: string;
  keyParts: unknown[];
}) {
  if (input.due < input.start || input.due > input.end) return;
  const dueDate = formatDate(input.due);
  occurrences.push({
    obligation_id: obligation.id,
    lease_id: obligation.lease_id ?? null,
    property_id: obligation.property_id ?? null,
    period_start: formatDate(input.periodStart),
    period_end: formatDate(input.periodEnd),
    due_date: dueDate,
    notification_policy: input.notificationPolicy,
    idempotency_key: [obligation.id, ...input.keyParts, dueDate].join(":"),
    status: occurrenceStatus(dueDate, input.asOfDate),
  });
}
function obligationCanGenerate(status: unknown): boolean {
  return String(status || "active").trim().toLowerCase() === "active";
}

export function generateObligationOccurrences(input: {
  obligation: LeaseObligationInput;
  windowStart: string;
  windowEnd: string;
  asOfDate?: string;
}): ObligationOccurrenceInput[] {
  const obligation = input.obligation;
  if (!obligationCanGenerate(obligation.status)) return [];

  const windowStart = parseDate(input.windowStart);
  const windowEnd = parseDate(input.windowEnd);
  if (!windowStart || !windowEnd || windowEnd < windowStart) return [];

  const effectiveStart = parseDate(obligation.effective_start) ?? windowStart;
  const effectiveEnd = parseDate(obligation.effective_end) ?? windowEnd;
  const start = effectiveStart > windowStart ? effectiveStart : windowStart;
  const end = effectiveEnd < windowEnd ? effectiveEnd : windowEnd;
  if (end < start) return [];

  const rule = obligation.due_rule ?? {};
  const offsetDays = Number(rule.offset_days ?? 0);
  const intervalMonths = cadenceMonths(obligation.cadence);
  const notificationPolicy = String(obligation.communication_policy || "internal_only");
  const asOfDate = input.asOfDate || formatDate(windowStart);
  const occurrences: ObligationOccurrenceInput[] = [];

  const ruleType = String(rule.rule_type || rule.type || "").toLowerCase();
  if (rule.review_required || ruleType === "review_required") {
    return [reviewOccurrence(obligation, start, end, notificationPolicy)];
  }

  if (ruleType === "statement_due_after_year_end" || rule.anchor === "calendar_year_end") {
    const daysAfterYearEnd = Number(rule.days_after_year_end ?? rule.offset_days ?? 0);
    for (let year = start.getUTCFullYear() - 1; year <= end.getUTCFullYear(); year += 1) {
      const anchor = yearEnd(year);
      const due = addDays(anchor, daysAfterYearEnd);
      pushOccurrence(occurrences, obligation, {
        periodStart: yearStart(year),
        periodEnd: anchor,
        due,
        start,
        end,
        asOfDate,
        notificationPolicy,
        keyParts: ["statement_due_after_year_end", year],
      });
    }
    return occurrences;
  }

  if (ruleType === "tenant_liability_cutoff" || rule.anchor === "statement_date" || rule.anchor === "period_end_plus_months") {
    const anchor = parseDate(String(rule.statement_date || rule.anchor_date || rule.period_end || ""));
    const months = Number(rule.months_after_statement ?? rule.offset_months ?? 0);
    if (!anchor || !Number.isFinite(months)) return [reviewOccurrence(obligation, start, end, notificationPolicy)];
    const due = addMonths(anchor, months);
    pushOccurrence(occurrences, obligation, {
      periodStart: parseDate(String(rule.period_start || "")) ?? start,
      periodEnd: parseDate(String(rule.period_end || "")) ?? anchor,
      due,
      start,
      end,
      asOfDate,
      notificationPolicy,
      keyParts: ["tenant_liability_cutoff", formatDate(anchor), months],
    });
    return occurrences;
  }

  if (rule.fixed_month || rule.fixed_day) {
    const month = Number(rule.fixed_month);
    const day = Number(rule.fixed_day);
    for (let year = start.getUTCFullYear(); year <= end.getUTCFullYear(); year += 1) {
      const due = dateFromParts(year, month, day);
      if (!due) return [reviewOccurrence(obligation, start, end, notificationPolicy)];
      pushOccurrence(occurrences, obligation, {
        periodStart: yearStart(year),
        periodEnd: yearEnd(year),
        due: addDays(due, offsetDays),
        start,
        end,
        asOfDate,
        notificationPolicy,
        keyParts: ["fixed_date", year, month, day],
      });
    }
    return occurrences;
  }

  if (!intervalMonths) {
    const due = addDays(parseDate(String(rule.due_date || formatDate(start))) ?? start, offsetDays);
    pushOccurrence(occurrences, obligation, {
      periodStart: start,
      periodEnd: end,
      due,
      start,
      end,
      asOfDate,
      notificationPolicy,
      keyParts: ["once"],
    });
    return occurrences;
  }

  for (let cursor = start; cursor <= end; cursor = addMonths(cursor, intervalMonths)) {
    const periodStart = cursor;
    const nextPeriodStart = addMonths(cursor, intervalMonths);
    const periodEnd = addDays(nextPeriodStart, -1) < end ? addDays(nextPeriodStart, -1) : end;
    const due = addDays(periodEnd, offsetDays);
    const dueDate = formatDate(due);
    occurrences.push({
      obligation_id: obligation.id,
      lease_id: obligation.lease_id ?? null,
      property_id: obligation.property_id ?? null,
      period_start: formatDate(periodStart),
      period_end: formatDate(periodEnd),
      due_date: dueDate,
      notification_policy: notificationPolicy,
      idempotency_key: `${obligation.id}:${formatDate(periodStart)}:${dueDate}`,
      status: occurrenceStatus(dueDate, asOfDate),
    });
  }
  return occurrences;
}