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
        // Kong's verify_jwt=true gate (compute-lease keeps this enabled)
        // requires a valid Authorization: Bearer JWT before the request ever
        // reaches the function code -- apikey/x-internal-service-key alone
        // satisfy the function's own internal-call check (verifyUser's
        // isInternalServiceRequest) but not the gateway. The service-role key
        // is itself a validly-signed JWT for this project, so sending it as
        // the Bearer token clears Kong's gate; verifyUser() still resolves
        // this as an internal call via x-internal-service-key exactly as
        // before (isInternalServiceRequest is checked first, ahead of any
        // Authorization-based user lookup), so no application-level behavior
        // changes. Matches the header shape already used by
        // lease-extraction-worker/auth.ts's buildInternalFunctionHeaders for
        // its own internal service-to-service calls.
        "Authorization": `Bearer ${serviceKey}`,
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
  return record.value ?? record.normalized_value ?? record.normalizedValue ?? record.raw_value ?? null;
}

const APPROVED_REVIEW_STATUSES = new Set(["accepted", "edited", "approved", "reviewed"]);

function isPresent(value: unknown) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function isApprovedSnapshotEntry(entry: unknown) {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  const status = String(record.review_status ?? record.status ?? "").trim().toLowerCase();
  return APPROVED_REVIEW_STATUSES.has(status);
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

function approvedSnapshotValue(approved: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = valueFromCandidate(approved[key]);
    if (isPresent(value)) return value;
  }
  return null;
}

function addApprovedTermMonthsInclusive(startIso: string, months: number) {
  const start = new Date(`${startIso}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || !Number.isFinite(months) || months <= 0) return null;
  const targetIndex = start.getUTCMonth() + Math.round(months);
  const targetYear = start.getUTCFullYear() + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const targetDay = Math.min(
    start.getUTCDate(),
    new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate(),
  );
  const end = new Date(Date.UTC(targetYear, targetMonth, targetDay));
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

function reconcileApprovedFinalTermDate(
  fields: Record<string, unknown>,
  approved: Record<string, unknown>,
) {
  const commencement = toIsoDate(approvedSnapshotValue(
    approved,
    ["commencement_date", "start_date", "lease_start_date", "term_start_date"],
  ));
  const termMonths = toNumber(approvedSnapshotValue(approved, ["lease_term_months", "term_months"]));
  if (!commencement || !termMonths || termMonths <= 0) return;

  const finalExpiration = addApprovedTermMonthsInclusive(commencement, termMonths);
  if (!finalExpiration) return;
  const minimumExpectedDays = Math.max(45, Math.round(termMonths * 24));

  for (const key of ["expiration_date", "end_date"]) {
    const current = approved[key] && typeof approved[key] === "object"
      ? approved[key] as Record<string, unknown>
      : null;
    if (!current) continue;
    const currentIso = toIsoDate(valueFromCandidate(current));
    const actualDays = currentIso ? daysBetween(commencement, currentIso) : null;
    if (currentIso && actualDays != null && actualDays >= minimumExpectedDays) continue;

    const corrected = {
      ...current,
      value: finalExpiration,
      raw_value: finalExpiration,
      extraction_status: "calculated",
      confidence_score: Math.min(Number(current.confidence_score ?? current.confidence ?? 0.9), 0.9),
      confidence: Math.min(Number(current.confidence_score ?? current.confidence ?? 0.9), 0.9),
      source_field_keys: ["commencement_date", "lease_term_months"],
      derivation_trace: `${key} = commencement_date ${commencement} + lease_term_months ${Math.round(termMonths)} - 1 day`,
      correction_reason: "Annual anniversary replaced with final initial-term expiration.",
    };
    fields[key] = corrected;
    approved[key] = corrected;
  }
}

export function validateApprovedSnapshotIntegrity(snapshot: Record<string, unknown>) {
  const approved = (snapshot?.approved || {}) as Record<string, unknown>;
  const commencement = toIsoDate(approvedSnapshotValue(
    approved,
    ["commencement_date", "start_date", "lease_start_date", "term_start_date"],
  ));
  const expiration = toIsoDate(approvedSnapshotValue(
    approved,
    ["expiration_date", "end_date", "lease_end_date", "term_end_date"],
  ));
  if (commencement && expiration && expiration <= commencement) {
    throw new Error("Approved expiration/end date must be after commencement/start date");
  }

  const termMonths = toNumber(approvedSnapshotValue(approved, ["lease_term_months", "term_months"]));
  if (termMonths != null && (!Number.isInteger(termMonths) || termMonths <= 0)) {
    throw new Error("Approved lease term months must be a positive whole number");
  }

  const monthlyRent = toNumber(approvedSnapshotValue(approved, ["monthly_rent", "base_rent_monthly"]));
  const annualRent = toNumber(approvedSnapshotValue(approved, ["annual_rent", "base_rent_annual"]));
  if (monthlyRent != null && monthlyRent < 0) {
    throw new Error("Approved monthly rent cannot be negative");
  }
  if (annualRent != null && annualRent < 0) {
    throw new Error("Approved annual rent cannot be negative");
  }
  if (
    monthlyRent != null && monthlyRent > 0 &&
    annualRent != null && annualRent > 0 &&
    Math.abs(annualRent - monthlyRent * 12) > 1
  ) {
    throw new Error("Approved monthly and annual rent conflict; resolve the amount/frequency before approval");
  }
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

  reconcileApprovedFinalTermDate(fields, approved);

  const sourceFileId = lease.source_file_id ?? extraction.source_file_id ?? extraction.uploaded_file_id ?? null;
  const sourceDocument = {
    uploaded_file_id: sourceFileId,
    source_file_id: sourceFileId,
    source_file_name: extraction.source_file_name ?? null,
    document_subtype: extraction.document_subtype ?? lease.document_subtype ?? null,
  };

  const snapshot = {
    version,
    approved_at: approvedAt || new Date().toISOString(),
    approved_by: approvedBy,
    source_document: sourceDocument,
    uploaded_file_id: sourceFileId,
    fields,
    approved,
    pending_fields,
    rejected_fields,
    unmapped_terms,
  };
  validateApprovedSnapshotIntegrity(snapshot);
  return snapshot;
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

function getApprovedValue(lease: Record<string, unknown>, key: string, aliases: string[] = []) {
  const snapshot = lease.abstract_snapshot && typeof lease.abstract_snapshot === "object"
    ? lease.abstract_snapshot as Record<string, unknown>
    : null;
  const approvedFields = (snapshot?.approved || {}) as Record<string, unknown>;
  const snapshotFields = (snapshot?.fields || {}) as Record<string, unknown>;
  const candidates = [key, ...aliases];

  for (const k of candidates) {
    const approvedValue = valueFromCandidate(approvedFields[k]);
    if (isPresent(approvedValue)) return approvedValue;
  }

  for (const k of candidates) {
    const entry = snapshotFields[k];
    if (!isApprovedSnapshotEntry(entry)) continue;
    const snapshotValue = valueFromCandidate(entry);
    if (isPresent(snapshotValue)) {
      return snapshotValue;
    }
  }

  // Legacy approved leases may predate abstract_snapshot.approved. For current
  // approvals, never fall through to raw extraction/top-level lease fields.
  if (snapshot) return null;

  for (const k of candidates) {
    if (isPresent(lease[k])) {
      return lease[k];
    }
  }
  return null;
}

export function toNoticeDays(lease: Record<string, unknown>) {
  for (const key of ["renewal_notice_days"]) {
    const value = Number(getApprovedValue(lease, key));
    if (Number.isFinite(value) && value > 0) return value;
  }
  for (const key of ["renewal_notice_months"]) {
    const value = Number(getApprovedValue(lease, key));
    if (Number.isFinite(value) && value > 0) return Math.round(value * 30);
  }
  for (const key of ["renewal_notice_period", "renewal_notice", "notice_period"]) {
    const raw = String(getApprovedValue(lease, key) || "").toLowerCase();
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
  const direct = toNumber(getApprovedValue(lease, "lease_term_months", ["term_months"]));
  if (direct && direct > 0) return Math.round(direct);
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

  // Do not advance a recurring anniversary one year at a time: that can
  // still stop before the final term year. The approved, independently
  // sourced term length determines the exact inclusive final date.
  return deriveExpirationFromTerm(commencement, lease) ?? expiration;
}

function deriveExpirationFromTerm(startIso: string | null, lease: Record<string, unknown>) {
  if (!startIso) return null;
  const termMonths = toTermMonths(lease);
  if (!termMonths || termMonths <= 0) return null;
  const start = new Date(`${startIso}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  const targetIndex = start.getUTCMonth() + Math.round(termMonths);
  const targetYear = start.getUTCFullYear() + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const targetDay = Math.min(
    start.getUTCDate(),
    new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate(),
  );
  const end = new Date(Date.UTC(targetYear, targetMonth, targetDay));
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

export function buildCriticalDateRows(approvedLease: Record<string, unknown>, today = new Date().toISOString().slice(0, 10)) {
  const leaseDate = toIsoDate(
    getApprovedValue(approvedLease, "lease_date", ["lease_execution_date", "signed_date"])
  );
  const commencement = toIsoDate(
    getApprovedValue(approvedLease, "commencement_date", ["start_date", "lease_start_date", "term_start_date"])
  );
  const rawExpiration = toIsoDate(
    getApprovedValue(approvedLease, "expiration_date", ["end_date", "lease_end_date", "term_end_date"])
  );
  const expiration = correctSuspiciousExpiration(
    commencement,
    rawExpiration ?? deriveExpirationFromTerm(commencement, approvedLease),
    approvedLease,
  );
  const optionDeadline = toIsoDate(
    getApprovedValue(approvedLease, "option_exercise_deadline", ["renewal_exercise_deadline", "option_deadline"])
  );
  const rentCommencement = toIsoDate(getApprovedValue(approvedLease, "rent_commencement_date"));
  const renewalNoticeDays = toNoticeDays(approvedLease);
  const baseRow = {
    org_id: approvedLease.org_id,
    lease_id: approvedLease.id,
    property_id: approvedLease.property_id ?? null,
    source: "derived",
  };
  const rows = [];

  if (leaseDate) {
    rows.push({
      ...baseRow,
      date_type: "lease_date",
      due_date: leaseDate,
      status: leaseDate <= today ? "completed" : "open",
    });
  }
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
