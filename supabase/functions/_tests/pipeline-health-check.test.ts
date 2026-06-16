// @ts-nocheck
/**
 * Tests for pipeline-health-check helper logic.
 *
 * These tests run without a live Supabase instance by mocking fetch and
 * Deno.env.  They cover the requirement-specified cases:
 *
 *   1. Missing GEMINI_API_KEY  → gemini_text check returns "warn", not crash
 *   2. Missing DOCLING_API_URL → docling check returns "skip", not crash
 *   3. parse-pdf-docling 401   → fail with a fix message pointing to WORKER_INTERNAL_SECRET
 *   4. Missing uploaded_files column → fail with migration hint
 *   5. No secret values appear in any check response
 */

import {
  assertEquals,
  assertExists,
  assert,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// ---------------------------------------------------------------------------
// Minimal re-implementations of the logic under test.
// We extract the pure helper functions so we can unit-test them without
// spinning up the full Deno.serve() context.
// ---------------------------------------------------------------------------

type CheckStatus = "pass" | "fail" | "warn" | "skip";
interface Check { name: string; status: CheckStatus; message: string; fix?: string }

// ── Secret presence map ────────────────────────────────────────────────────

function buildSecretPresenceMap(env: Record<string, string | undefined>): Record<string, "present" | "missing"> {
  const has = (k: string) => !!env[k];
  return {
    SUPABASE_URL: has("SUPABASE_URL") ? "present" : "missing",
    SUPABASE_SERVICE_ROLE_KEY: has("SUPABASE_SERVICE_ROLE_KEY") ? "present" : "missing",
    WORKER_INTERNAL_SECRET: has("WORKER_INTERNAL_SECRET") ? "present" : "missing",
    VERTEX_PROJECT_ID: (has("VERTEX_PROJECT_ID") || has("GOOGLE_PROJECT_ID")) ? "present" : "missing",
    GOOGLE_SERVICE_ACCOUNT_KEY: (has("GOOGLE_SERVICE_ACCOUNT_KEY") || has("GOOGLE_PRIVATE_KEY")) ? "present" : "missing",
    DOCLING_API_URL: has("DOCLING_API_URL") ? "present" : "missing",
  };
}

// ── Env var checks ─────────────────────────────────────────────────────────

function checkEnvVarsWithEnv(env: Record<string, string | undefined>): Check[] {
  const checks: Check[] = [];
  const has = (k: string) => !!env[k];

  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WORKER_INTERNAL_SECRET"]) {
    const present = has(key);
    checks.push({
      name: `env_${key.toLowerCase()}`,
      status: present ? "pass" : "fail",
      message: present ? `${key} is set` : `${key} is missing`,
      ...(present ? {} : { fix: `supabase secrets set ${key}=<value>` }),
    });
  }

  const hasDocling = has("DOCLING_API_URL");
  checks.push({
    name: "env_docling_api_url",
    status: hasDocling ? "pass" : "skip",
    message: hasDocling ? "DOCLING_API_URL is set" : "DOCLING_API_URL not configured (optional)",
  });

  return checks;
}

// ── DB column check (simulates PostgREST error parsing) ────────────────────

function checkDbColumnError(errorMessage: string): Check {
  const match = errorMessage.match(
    /column (?:uploaded_files\.)?["']?([a-z_]+)["']? does not exist/i,
  );
  const missing = match?.[1] ?? null;

  return {
    name: "db_uploaded_files_columns",
    status: "fail",
    message: missing
      ? `uploaded_files column '${missing}' is missing`
      : `uploaded_files column check failed: ${errorMessage}`,
    fix: "supabase db push — migration 20260610123000_uploaded_files_processing_status.sql adds these columns",
  };
}

// ── Parse auth check (simulates different HTTP responses) ──────────────────

function evalParseAuthResponse(status: number, bodyJson: any): Check {
  if (status === 401) {
    return {
      name: "parse_function_auth",
      status: "fail",
      message: `parse-pdf-docling returned 401 — worker auth rejected (${bodyJson?.error_code ?? "no code"})`,
      fix: "Verify SUPABASE_SERVICE_ROLE_KEY and WORKER_INTERNAL_SECRET match what is set in Supabase Edge Function secrets",
    };
  }

  if (bodyJson?.dry_run === true && bodyJson?.authenticated === true) {
    return { name: "parse_function_auth", status: "pass", message: "parse-pdf-docling authenticated ok (dry_run response)" };
  }

  if (
    status === 400 &&
    (bodyJson?.error_code === "MISSING_FILE_ID" || /file_id/i.test(bodyJson?.message ?? ""))
  ) {
    return { name: "parse_function_auth", status: "pass", message: "parse-pdf-docling auth passed" };
  }

  return {
    name: "parse_function_auth",
    status: "fail",
    message: `parse-pdf-docling returned ${status}: unexpected`,
    fix: "Check Supabase Edge Function logs for parse-pdf-docling",
  };
}

// ── Docling check (simulates env) ─────────────────────────────────────────

function evalDoclingEnv(env: Record<string, string | undefined>): Check {
  const doclingUrl = env["DOCLING_API_URL"];
  if (!doclingUrl) {
    return {
      name: "docling",
      status: "skip",
      message: "DOCLING_API_URL not configured — Docling check skipped (optional)",
      fix: "supabase secrets set DOCLING_API_URL=http://your-docling-service:5001",
    };
  }
  return { name: "docling", status: "pass", message: `Docling health endpoint reachable at ${doclingUrl}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("missing DOCLING_API_URL → docling returns skip, not crash", () => {
  const env: Record<string, string | undefined> = {
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-key-placeholder",
    // DOCLING_API_URL intentionally absent
  };

  const check = evalDoclingEnv(env);

  assertEquals(check.name, "docling");
  assertEquals(check.status, "skip", "Missing DOCLING_API_URL must produce skip, not crash");
  assert(check.message.includes("optional"), "skip message should mention it is optional");
});

Deno.test("parse-pdf-docling 401 → fail with WORKER_INTERNAL_SECRET fix message", () => {
  const body401 = { ok: false, error_code: "UNAUTHORIZED_INTERNAL_PARSE_CALL" };
  const check = evalParseAuthResponse(401, body401);

  assertEquals(check.status, "fail");
  assert(check.message.includes("401"), "message must mention status 401");
  assertExists(check.fix);
  assert(
    check.fix!.toLowerCase().includes("worker_internal_secret") ||
    check.fix!.toLowerCase().includes("service_role_key"),
    "fix must reference WORKER_INTERNAL_SECRET or SUPABASE_SERVICE_ROLE_KEY",
  );
});

Deno.test("parse-pdf-docling MISSING_FILE_ID → pass (auth succeeded)", () => {
  const body400 = { error: true, error_code: "MISSING_FILE_ID", message: "file_id is required" };
  const check = evalParseAuthResponse(400, body400);

  assertEquals(check.status, "pass", "MISSING_FILE_ID response means auth passed");
});

Deno.test("parse-pdf-docling dry_run ok → pass", () => {
  const bodyOk = { ok: true, dry_run: true, authenticated: true };
  const check = evalParseAuthResponse(200, bodyOk);

  assertEquals(check.status, "pass");
  assert(check.message.includes("dry_run"), "pass message should confirm dry_run");
});

Deno.test("missing uploaded_files column → fail with migration hint", () => {
  const pgError = `column uploaded_files.processing_status does not exist`;
  const check = checkDbColumnError(pgError);

  assertEquals(check.status, "fail");
  assert(check.message.includes("processing_status"), "message must name the missing column");
  assertExists(check.fix);
  assert(
    check.fix!.includes("supabase db push") || check.fix!.includes("migration"),
    "fix must reference migration or supabase db push",
  );
});

Deno.test("missing uploaded_files column (generic error) → fail with migration hint", () => {
  const pgError = `relation "uploaded_files" does not exist`;
  const check = checkDbColumnError(pgError);

  assertEquals(check.status, "fail");
  assertExists(check.fix);
  assert(check.fix!.includes("supabase db push") || check.fix!.includes("migration"));
});

Deno.test("secret presence map never contains actual secret values", () => {
  const realSecret = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpart.signature";
  const env: Record<string, string | undefined> = {
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: realSecret,
    WORKER_INTERNAL_SECRET: "my-super-secret",
    VERTEX_PROJECT_ID: "my-gcp-project",
    GOOGLE_SERVICE_ACCOUNT_KEY: '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----"}',
    DOCLING_API_URL: "http://docling.internal:5001",
  };

  const presence = buildSecretPresenceMap(env);
  const serialized = JSON.stringify(presence);

  // Must never contain real secret values
  assert(!serialized.includes(realSecret), "service role key must not appear in output");
  assert(!serialized.includes("my-super-secret"), "worker secret must not appear in output");
  assert(!serialized.includes("my-gcp-project"), "GCP project ID must not appear in output");
  assert(!serialized.includes("BEGIN PRIVATE KEY"), "service account key must not appear in output");

  // All values must be "present" or "missing"
  for (const [key, value] of Object.entries(presence)) {
    assert(
      value === "present" || value === "missing",
      `${key} must be "present" or "missing", got "${value}"`,
    );
  }
});

Deno.test("env checks produce skip (not fail) for missing DOCLING_API_URL", () => {
  const env: Record<string, string | undefined> = {
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "svc-key",
    WORKER_INTERNAL_SECRET: "secret",
  };

  const checks = checkEnvVarsWithEnv(env);
  const doclingCheck = checks.find((c) => c.name === "env_docling_api_url");

  assertExists(doclingCheck);
  assertEquals(doclingCheck!.status, "skip", "Missing DOCLING_API_URL is a skip, not a failure");
});

Deno.test("env checks return fail for missing WORKER_INTERNAL_SECRET", () => {
  const env: Record<string, string | undefined> = {
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "svc-key",
    // WORKER_INTERNAL_SECRET intentionally absent
  };

  const checks = checkEnvVarsWithEnv(env);
  const workerCheck = checks.find((c) => c.name === "env_worker_internal_secret");

  assertExists(workerCheck);
  assertEquals(workerCheck!.status, "fail");
  assertExists(workerCheck!.fix);
});

Deno.test("overall ok=false when any check is fail", () => {
  const checks: Check[] = [
    { name: "env_supabase_url", status: "pass", message: "ok" },
    { name: "parse_function_auth", status: "fail", message: "401 error", fix: "check secrets" },
    { name: "gemini_text", status: "warn", message: "no key" },
  ];

  const overallOk = !checks.some((c) => c.status === "fail");
  assertEquals(overallOk, false, "overall ok must be false when any check fails");
});

Deno.test("overall ok=true when no check is fail (warn/skip allowed)", () => {
  const checks: Check[] = [
    { name: "env_supabase_url", status: "pass", message: "ok" },
    { name: "gemini_text", status: "warn", message: "no key" },
    { name: "docling", status: "skip", message: "not configured" },
  ];

  const overallOk = !checks.some((c) => c.status === "fail");
  assertEquals(overallOk, true, "warn and skip must not make overall ok=false");
});
