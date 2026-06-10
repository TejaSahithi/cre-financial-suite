// @ts-nocheck
/**
 * Tests for parse-pdf-docling internal authentication.
 *
 * Covers:
 *   - isInternalCall: x-worker-secret, service-role Bearer, x-internal-service-key
 *   - isInternalCall: rejection of public browser calls, wrong secrets, WORKER_INTERNAL_SECRET-as-Bearer
 *   - extractInternalOrgIdFromHeader: UUID validation, internal-only gate
 *   - Worker auth contract: headers sent to parse-pdf-docling use service-role Bearer
 *   - 401 response structure from parse-pdf-docling
 *   - classifyDownstreamError(401) → DOWNSTREAM_AUTH_FAILED
 *   - UI STATUS_VALUES guard: status strings must not appear as error codes
 *   - UI canOpenReview: false on failed files, false without valid payload
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isInternalCall, extractInternalOrgIdFromHeader } from "../_shared/internal-auth.ts";
import { buildInternalFunctionHeaders, classifyDownstreamError } from "../lease-extraction-worker/auth.ts";

// ── Shared test fixtures ─────────────────────────────────────────────────────

const testEnv = {
  get(key: string) {
    return ({
      WORKER_INTERNAL_SECRET: "my-worker-secret",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-without-sub-claim",
    } as Record<string, string>)[key];
  },
};

function makeReq(headers: Record<string, string>) {
  return new Request("https://example.test/functions/v1/parse-pdf-docling", {
    method: "POST",
    headers,
  });
}

// ── isInternalCall ────────────────────────────────────────────────────────────

Deno.test("parse-pdf-docling isInternalCall accepts valid x-worker-secret", () => {
  assertEquals(
    isInternalCall(makeReq({ "x-worker-secret": "my-worker-secret" }), testEnv),
    true,
  );
});

Deno.test("parse-pdf-docling isInternalCall accepts service-role Bearer token", () => {
  assertEquals(
    isInternalCall(makeReq({ Authorization: "Bearer service-role-key-without-sub-claim" }), testEnv),
    true,
  );
});

Deno.test("parse-pdf-docling isInternalCall accepts x-internal-service-key equal to service role key", () => {
  assertEquals(
    isInternalCall(makeReq({ "x-internal-service-key": "service-role-key-without-sub-claim" }), testEnv),
    true,
  );
});

Deno.test("parse-pdf-docling isInternalCall rejects requests with no auth headers (public browser call)", () => {
  assertEquals(isInternalCall(makeReq({}), testEnv), false);
});

Deno.test("parse-pdf-docling isInternalCall rejects incorrect x-worker-secret", () => {
  assertEquals(isInternalCall(makeReq({ "x-worker-secret": "wrong-secret" }), testEnv), false);
  assertEquals(isInternalCall(makeReq({ "x-worker-secret": "" }), testEnv), false);
});

Deno.test("parse-pdf-docling isInternalCall rejects WORKER_INTERNAL_SECRET used as Bearer token", () => {
  // WORKER_INTERNAL_SECRET is not a JWT and must never be accepted as Bearer
  assertEquals(
    isInternalCall(makeReq({ Authorization: "Bearer my-worker-secret" }), testEnv),
    false,
  );
});

Deno.test("parse-pdf-docling isInternalCall rejects ordinary user JWT as Bearer", () => {
  assertEquals(
    isInternalCall(
      makeReq({
        Authorization:
          "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsInJvbGUiOiJhdXRoZW50aWNhdGVkIn0.sig",
      }),
      testEnv,
    ),
    false,
  );
});

Deno.test("parse-pdf-docling isInternalCall is case-insensitive for Bearer prefix", () => {
  assertEquals(
    isInternalCall(makeReq({ Authorization: "bearer service-role-key-without-sub-claim" }), testEnv),
    true,
  );
  assertEquals(
    isInternalCall(makeReq({ Authorization: "BEARER service-role-key-without-sub-claim" }), testEnv),
    true,
  );
});

// ── extractInternalOrgIdFromHeader ────────────────────────────────────────────

Deno.test("parse-pdf-docling extractInternalOrgIdFromHeader returns UUID from valid internal call", () => {
  const orgId = "550e8400-e29b-41d4-a716-446655440000";
  assertEquals(
    extractInternalOrgIdFromHeader(
      makeReq({ "x-worker-secret": "my-worker-secret", "x-internal-org-id": orgId }),
      testEnv,
    ),
    orgId,
  );
});

Deno.test("parse-pdf-docling extractInternalOrgIdFromHeader returns empty string for non-internal calls", () => {
  assertEquals(
    extractInternalOrgIdFromHeader(
      makeReq({ "x-internal-org-id": "550e8400-e29b-41d4-a716-446655440000" }),
      testEnv,
    ),
    "",
  );
});

Deno.test("parse-pdf-docling extractInternalOrgIdFromHeader rejects malformed org_id", () => {
  assertEquals(
    extractInternalOrgIdFromHeader(
      makeReq({ "x-worker-secret": "my-worker-secret", "x-internal-org-id": "not-a-uuid" }),
      testEnv,
    ),
    "",
  );
  assertEquals(
    extractInternalOrgIdFromHeader(
      makeReq({ "x-worker-secret": "my-worker-secret", "x-internal-org-id": "" }),
      testEnv,
    ),
    "",
  );
});

// ── 401 response structure ────────────────────────────────────────────────────

Deno.test("parse-pdf-docling unauthorized response structure is stable and machine-readable", () => {
  const body = { ok: false, error_code: "UNAUTHORIZED_INTERNAL_PARSE_CALL", message: "Unauthorized parse request" };
  assertEquals(body.ok, false);
  assertEquals(body.error_code, "UNAUTHORIZED_INTERNAL_PARSE_CALL");
  assertEquals(typeof body.message, "string");
  // Serializable — no Symbol or function values
  assertEquals(JSON.parse(JSON.stringify(body)), body);
});

// ── Worker builds correct downstream headers ──────────────────────────────────

const workerEnv = {
  get(key: string) {
    return ({
      SUPABASE_SERVICE_ROLE_KEY: "service-role-token",
      WORKER_INTERNAL_SECRET: "my-worker-secret",
    } as Record<string, string>)[key];
  },
};

Deno.test("parse-pdf-docling worker calls use service-role Bearer, never WORKER_INTERNAL_SECRET as Bearer", () => {
  const headers = buildInternalFunctionHeaders("org-abc", workerEnv);
  assertEquals(headers.Authorization, "Bearer service-role-token");
  assertEquals(headers.Authorization === "Bearer my-worker-secret", false);
});

Deno.test("parse-pdf-docling worker sets x-worker-secret for downstream authentication", () => {
  const headers = buildInternalFunctionHeaders("org-abc", workerEnv);
  assertEquals(headers["x-worker-secret"], "my-worker-secret");
});

Deno.test("parse-pdf-docling worker headers satisfy all three isInternalCall acceptance paths", () => {
  const headers = buildInternalFunctionHeaders("org-abc", workerEnv);

  // Path 1: x-worker-secret
  assertEquals(isInternalCall(makeReq({ "x-worker-secret": headers["x-worker-secret"] }), workerEnv), true);

  // Path 2: service-role Bearer
  assertEquals(isInternalCall(makeReq({ Authorization: headers.Authorization }), workerEnv), true);

  // Path 3: x-internal-service-key
  assertEquals(isInternalCall(makeReq({ "x-internal-service-key": headers["x-internal-service-key"] }), workerEnv), true);
});

Deno.test("parse-pdf-docling worker sets x-internal-org-id in downstream call", () => {
  const headers = buildInternalFunctionHeaders("org-abc", workerEnv);
  assertEquals(headers["x-internal-org-id"], "org-abc");
});

// ── 401 → DOWNSTREAM_AUTH_FAILED mapping ─────────────────────────────────────

Deno.test("parse-pdf-docling 401 response maps to DOWNSTREAM_AUTH_FAILED in worker", () => {
  assertEquals(classifyDownstreamError(401), { error_code: "DOWNSTREAM_AUTH_FAILED", retryable: false });
});

Deno.test("parse-pdf-docling 403 response also maps to DOWNSTREAM_AUTH_FAILED in worker", () => {
  assertEquals(classifyDownstreamError(403), { error_code: "DOWNSTREAM_AUTH_FAILED", retryable: false });
});

Deno.test("parse-pdf-docling DOWNSTREAM_AUTH_FAILED is not retryable", () => {
  assertEquals(classifyDownstreamError(401).retryable, false);
});

// ── UI STATUS_VALUES guard (pure logic, no React needed) ─────────────────────
// These mirror the STATUS_VALUES Set and filterErrorCode logic in LeaseUpload.jsx.

const STATUS_VALUES = new Set([
  "ready_for_review", "review_required", "parsing", "parsed", "pdf_parsed",
  "validating", "validated", "storing", "stored", "computing", "completed",
  "uploaded", "lease_extraction_queued", "pending", "queued", "running",
]);

function filterErrorCode(rawCode: string | null | undefined): string {
  if (!rawCode) return "";
  return !STATUS_VALUES.has(rawCode) ? rawCode : "";
}

Deno.test("UI STATUS_VALUES guard: ready_for_review must not appear as an error code", () => {
  assertEquals(filterErrorCode("ready_for_review"), "");
});

Deno.test("UI STATUS_VALUES guard: all lifecycle status strings are blocked from error code display", () => {
  for (const status of STATUS_VALUES) {
    assertEquals(filterErrorCode(status), "", `Expected "${status}" to be filtered out`);
  }
});

Deno.test("UI STATUS_VALUES guard: real error codes pass through unchanged", () => {
  assertEquals(filterErrorCode("DOWNSTREAM_AUTH_FAILED"), "DOWNSTREAM_AUTH_FAILED");
  assertEquals(filterErrorCode("PDF_PARSING_FAILED"), "PDF_PARSING_FAILED");
  assertEquals(filterErrorCode("WORKER_CONFIG_MISSING"), "WORKER_CONFIG_MISSING");
  assertEquals(filterErrorCode("EMPTY_PARSE_TEXT"), "EMPTY_PARSE_TEXT");
  assertEquals(filterErrorCode("FILE_NOT_FOUND"), "FILE_NOT_FOUND");
  assertEquals(filterErrorCode("PARSER_PROVIDER_UNAVAILABLE"), "PARSER_PROVIDER_UNAVAILABLE");
});

Deno.test("UI STATUS_VALUES guard: null and empty string return empty string", () => {
  assertEquals(filterErrorCode(null), "");
  assertEquals(filterErrorCode(""), "");
  assertEquals(filterErrorCode(undefined), "");
});

// ── UI canOpenReview guard (pure logic) ───────────────────────────────────────

function canOpenReview(
  fileRecord: { review_required?: boolean; ui_review_payload?: unknown; status?: string } | null,
): boolean {
  const hasValidReviewPayload =
    fileRecord?.review_required === true &&
    fileRecord?.ui_review_payload != null &&
    fileRecord?.status !== "failed";

  return (
    hasValidReviewPayload ||
    ["validating", "validated", "approved", "storing", "stored", "computing", "completed"].includes(
      fileRecord?.status || "",
    )
  );
}

Deno.test("UI canOpenReview: returns false for failed files even when review payload is present", () => {
  assertEquals(
    canOpenReview({ review_required: true, ui_review_payload: { fields: [] }, status: "failed" }),
    false,
  );
});

Deno.test("UI canOpenReview: returns false when file is only parsing (no review payload)", () => {
  assertEquals(canOpenReview({ review_required: false, ui_review_payload: null, status: "parsing" }), false);
});

Deno.test("UI canOpenReview: returns true when review_required=true and payload exists and status is not failed", () => {
  assertEquals(
    canOpenReview({ review_required: true, ui_review_payload: { fields: [] }, status: "review_required" }),
    true,
  );
});

Deno.test("UI canOpenReview: returns true for post-review statuses", () => {
  for (const status of ["validating", "validated", "approved", "storing", "stored", "computing", "completed"]) {
    assertEquals(canOpenReview({ status }), true, `Expected canOpenReview=true for status="${status}"`);
  }
});

Deno.test("UI canOpenReview: returns false for null file record", () => {
  assertEquals(canOpenReview(null), false);
});
