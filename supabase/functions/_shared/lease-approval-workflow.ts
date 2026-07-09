// @ts-nocheck

/**
 * Calls compute-lease synchronously, scoped to the just-approved lease, so
 * rent-schedule generation is part of the same request/response cycle as
 * approval instead of a client-side fire-and-forget trigger. Reuses
 * compute-lease's existing ensureApprovedRentSchedules (delete + regenerate
 * rows when abstract_version changed) via the same internal service-to-service
 * call pattern already used by _shared/compute-orchestrator.ts, rather than
 * duplicating that logic in SQL.
 *
 * Never throws — a rent-schedule failure must not undo an approval that
 * already committed. Callers surface the returned status in the response.
 */
export async function generateApprovedRentSchedule(opts: {
  orgId: string;
  leaseId: string;
  req: Request;
}): Promise<{ status: "ok" | "skipped" | "failed"; error?: string }> {
  const { orgId, leaseId } = opts;
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceKey) {
    console.warn("[approve-lease-workflow] Missing env vars — skipping rent schedule generation");
    return { status: "skipped", error: "Missing Supabase service configuration" };
  }

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/compute-lease`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": serviceKey,
        "x-internal-service-key": serviceKey,
        "x-internal-org-id": orgId,
      },
      body: JSON.stringify({ lease_id: leaseId, fiscal_year: new Date().getUTCFullYear() }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "no response body");
      console.error(`[approve-lease-workflow] compute-lease HTTP ${res.status}: ${text.slice(0, 200)}`);
      return { status: "failed", error: `HTTP ${res.status}` };
    }

    return { status: "ok" };
  } catch (err) {
    console.error("[approve-lease-workflow] compute-lease call failed:", err?.message || err);
    return { status: "failed", error: err?.message || "network error" };
  }
}

export function validateApprovalPayload(body: Record<string, unknown> = {}) {
  const leaseId = String(body.lease_id || "").trim();
  const signedBy = String(body.signed_by || "").trim();
  const signedAt = String(body.signed_at || "").trim();
  const idempotencyKey = String(body.idempotency_key || "").trim();

  if (!leaseId) throw new Error("lease_id is required");
  if (!signedBy) throw new Error("signed_by is required");
  if (!signedAt) throw new Error("signed_at is required");
  if (Number.isNaN(Date.parse(signedAt))) throw new Error("signed_at must be a valid date/time");
  if (!idempotencyKey) throw new Error("idempotency_key is required");

  const fieldReviews = body.field_reviews && typeof body.field_reviews === "object"
    ? body.field_reviews as Record<string, unknown>
    : {};

  return {
    leaseId,
    signedBy,
    signedAt: new Date(signedAt).toISOString(),
    approvalComments: body.approval_comments == null ? null : String(body.approval_comments),
    approvalDocumentUrl: body.approval_document_url == null ? null : String(body.approval_document_url),
    fieldReviews,
    idempotencyKey,
  };
}

function valueFromCandidate(candidate: unknown) {
  if (candidate == null) return null;
  if (typeof candidate !== "object") return candidate;
  const record = candidate as Record<string, unknown>;
  return record.value ?? record.normalized_value ?? record.raw_value ?? null;
}

function readFieldValue(lease: Record<string, unknown>, fieldKey: string, review: Record<string, unknown> | null) {
  if (review && "value" in review) return review.value;
  const extraction = (lease.extraction_data || {}) as Record<string, unknown>;
  const fields = (extraction.fields || {}) as Record<string, unknown>;
  const workflow = (extraction.workflow_output || {}) as Record<string, unknown>;
  const leaseFields = (workflow.lease_fields || {}) as Record<string, unknown>;
  const extractedFields = (lease.extracted_fields || {}) as Record<string, unknown>;

  return valueFromCandidate(fields[fieldKey]) ??
    valueFromCandidate(leaseFields[fieldKey]) ??
    valueFromCandidate(extractedFields[fieldKey]) ??
    lease[fieldKey] ??
    null;
}

function readEvidence(lease: Record<string, unknown>, fieldKey: string, review: Record<string, unknown> | null) {
  const extraction = (lease.extraction_data || {}) as Record<string, unknown>;
  const fields = (extraction.fields || {}) as Record<string, unknown>;
  const candidate = fields[fieldKey] && typeof fields[fieldKey] === "object"
    ? fields[fieldKey] as Record<string, unknown>
    : {};

  return {
    rawValue: review?.raw_value ?? candidate.raw_value ?? candidate.raw ?? null,
    sourcePage: review?.source_page ?? candidate.source_page ?? candidate.page ?? null,
    sourceText: review?.source_text ?? review?.exact_source_text ?? candidate.source_text ?? candidate.exact_source_text ?? null,
    confidence: review?.confidence ?? review?.confidence_score ?? candidate.confidence ?? candidate.confidence_score ?? null,
    extractionStatus: review?.extraction_status ?? candidate.extraction_status ?? null,
  };
}

export function buildAbstractSnapshot({
  lease,
  fieldReviews,
  version,
  approvedBy,
  approvedAt,
}: {
  lease: Record<string, unknown>;
  fieldReviews: Record<string, unknown>;
  version: number;
  approvedBy: string;
  approvedAt?: string;
}) {
  const extraction = (lease.extraction_data || {}) as Record<string, unknown>;
  const workflow = (extraction.workflow_output || {}) as Record<string, unknown>;
  const keys = new Set<string>([
    ...Object.keys(fieldReviews || {}),
    ...Object.keys((extraction.fields || {}) as Record<string, unknown>),
    ...Object.keys((workflow.lease_fields || {}) as Record<string, unknown>),
    ...Object.keys((lease.extracted_fields || {}) as Record<string, unknown>),
  ]);

  const fields: Record<string, unknown> = {};
  const approved: Record<string, unknown> = {};
  const pending_fields: Record<string, unknown> = {};
  const rejected_fields: Record<string, unknown> = {};
  const unmapped_terms: Record<string, unknown> = {};

  for (const key of keys) {
    const review = fieldReviews?.[key] && typeof fieldReviews[key] === "object"
      ? fieldReviews[key] as Record<string, unknown>
      : null;
    const reviewStatus = String(review?.status || "pending");
    const evidence = readEvidence(lease, key, review);
    const entry = {
      value: readFieldValue(lease, key, review),
      raw_value: evidence.rawValue,
      source_page: evidence.sourcePage,
      source_text: evidence.sourceText,
      exact_source_text: evidence.sourceText,
      confidence_score: evidence.confidence,
      confidence: evidence.confidence,
      extraction_status: evidence.extractionStatus,
      review_status: reviewStatus,
      reviewed_at: review?.reviewed_at || null,
      reviewer: review?.reviewer || null,
      field_key: key,
    };

    fields[key] = entry;
    if (["accepted", "edited", "approved", "reviewed"].includes(reviewStatus)) {
      approved[key] = entry;
    } else if (reviewStatus === "rejected") {
      rejected_fields[key] = entry;
    } else if (key.includes("unmapped")) {
      unmapped_terms[key] = entry;
    } else {
      pending_fields[key] = entry;
    }
  }

  return {
    version,
    approved_at: approvedAt || new Date().toISOString(),
    approved_by: approvedBy,
    fields,
    approved,
    pending_fields,
    rejected_fields,
    unmapped_terms,
  };
}

export function toIsoDate(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const usMatch = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (usMatch) {
    const [, m, d, y] = usMatch;
    const yyyy = y.length === 2 ? (Number(y) > 50 ? `19${y}` : `20${y}`) : y;
    return `${yyyy}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()))
    .toISOString()
    .slice(0, 10);
}

export function toNoticeDays(lease: Record<string, unknown>) {
  for (const key of ["renewal_notice_days"]) {
    const value = Number(lease?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  for (const key of ["renewal_notice_months"]) {
    const value = Number(lease?.[key]);
    if (Number.isFinite(value) && value > 0) return Math.round(value * 30);
  }
  for (const key of ["renewal_notice_period", "renewal_notice", "notice_period"]) {
    const raw = String(lease?.[key] || "").toLowerCase();
    if (!raw) continue;
    const match = raw.match(/(\d+(?:\.\d+)?)\s*(day|month|year)/);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (match[2].startsWith("day")) return Math.round(value);
    if (match[2].startsWith("month")) return Math.round(value * 30);
    if (match[2].startsWith("year")) return Math.round(value * 365);
  }
  return null;
}

function toNumber(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function toTermMonths(lease: Record<string, unknown>) {
  const direct = toNumber(lease?.lease_term_months ?? lease?.term_months);
  if (direct && direct > 0) return Math.round(direct);

  for (const key of ["lease_term", "term", "initial_term"]) {
    const raw = String(lease?.[key] || "").toLowerCase();
    if (!raw) continue;
    const years = raw.match(/(\d+(?:\.\d+)?)\s*(year|yr)/);
    if (years) return Math.round(Number(years[1]) * 12);
    const months = raw.match(/(\d+(?:\.\d+)?)\s*(month|mo)/);
    if (months) return Math.round(Number(months[1]));
  }

  return null;
}

function daysBetween(startIso: string, endIso: string) {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  const diff = end.getTime() - start.getTime();
  return Number.isFinite(diff) ? Math.round(diff / 86_400_000) : null;
}

function correctSuspiciousExpiration(commencement: string | null, expiration: string | null, lease: Record<string, unknown>) {
  if (!commencement || !expiration) return expiration;
  const termMonths = toTermMonths(lease);
  const actualDays = daysBetween(commencement, expiration);
  const minimumExpectedDays = termMonths && termMonths >= 6 ? Math.max(45, Math.round(termMonths * 24)) : null;
  if (!minimumExpectedDays || actualDays == null || actualDays >= minimumExpectedDays) return expiration;

  const start = new Date(`${commencement}T00:00:00Z`);
  const corrected = new Date(`${expiration}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(corrected.getTime())) return expiration;

  while (corrected <= start || (daysBetween(commencement, corrected.toISOString().slice(0, 10)) ?? 0) < minimumExpectedDays) {
    corrected.setUTCFullYear(corrected.getUTCFullYear() + 1);
  }
  return corrected.toISOString().slice(0, 10);
}

export function buildCriticalDateRows(approvedLease: Record<string, unknown>, today = new Date().toISOString().slice(0, 10)) {
  const commencement = toIsoDate(
    approvedLease.commencement_date ??
    approvedLease.start_date ??
    approvedLease.lease_start_date ??
    approvedLease.term_start_date,
  );
  const rawExpiration = toIsoDate(
    approvedLease.expiration_date ??
    approvedLease.end_date ??
    approvedLease.lease_end_date ??
    approvedLease.term_end_date,
  );
  const expiration = correctSuspiciousExpiration(commencement, rawExpiration, approvedLease);
  const optionDeadline = toIsoDate(
    approvedLease.option_exercise_deadline ??
    approvedLease.renewal_exercise_deadline ??
    approvedLease.option_deadline,
  );
  const rentCommencement = toIsoDate(approvedLease.rent_commencement_date);
  const renewalNoticeDays = toNoticeDays(approvedLease);
  const baseRow = {
    org_id: approvedLease.org_id,
    lease_id: approvedLease.id,
    property_id: approvedLease.property_id ?? null,
    source: "derived",
  };
  const rows = [];

  if (commencement) {
    rows.push({
      ...baseRow,
      date_type: "commencement",
      due_date: commencement,
      status: commencement <= today ? "completed" : "open",
    });
  }
  if (rentCommencement && rentCommencement !== commencement) {
    rows.push({
      ...baseRow,
      date_type: "rent_commencement",
      due_date: rentCommencement,
      status: rentCommencement <= today ? "completed" : "open",
    });
  }
  if (expiration) {
    rows.push({
      ...baseRow,
      date_type: "expiration",
      due_date: expiration,
      status: expiration < today ? "completed" : "open",
    });
    if (renewalNoticeDays && renewalNoticeDays > 0) {
      const expirationDate = new Date(`${expiration}T00:00:00Z`);
      expirationDate.setUTCDate(expirationDate.getUTCDate() - renewalNoticeDays);
      const noticeIso = expirationDate.toISOString().slice(0, 10);
      rows.push({
        ...baseRow,
        date_type: "renewal_notice",
        due_date: noticeIso,
        status: noticeIso < today ? "completed" : "open",
        reminder_days_before: 30,
      });
    }
  }
  if (optionDeadline) {
    rows.push({
      ...baseRow,
      date_type: "option_exercise",
      due_date: optionDeadline,
      status: optionDeadline < today ? "completed" : "open",
      reminder_days_before: 60,
    });
  }

  return rows;
}
