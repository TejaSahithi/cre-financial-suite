// @ts-nocheck
/**
 * pipeline-health-check — admin-only diagnostic for the CRE lease extraction pipeline
 *
 * Checks the full stack is operational:
 *   - Environment variable presence (never returns values)
 *   - Database schema (tables + required columns)
 *   - Supabase Storage (financial-uploads bucket)
 *   - parse-pdf-docling internal auth (dry_run)
 *   - normalize-pdf-output internal auth (dry_run)
 *   - Docling health (if DOCLING_API_URL present)
 *
 * Access: org_admin or super_admin role only.
 * Security: secret values are NEVER returned — only "present" / "missing".
 */

import { corsHeaders } from "../_shared/cors.ts";
import { createAdminClient, verifyUser } from "../_shared/supabase.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CheckStatus = "pass" | "fail" | "warn" | "skip";

interface Check {
  name: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUIRED_TABLES = ["uploaded_files", "pipeline_jobs", "pipeline_logs", "leases"] as const;

const REQUIRED_UF_COLUMNS = [
  "status",
  "processing_status",
  "failed_step",
  "ui_review_payload",
  "normalized_output",
  "docling_raw",
  "review_status",
] as const;

const FUNCTION_CALL_TIMEOUT_MS = 20_000;

const NORMALIZE_SAMPLE_TEXT =
  "Tenant shall pay monthly rent of $2,100. " +
  "Lease commencement date is March 1, 2019. " +
  "Premises: Suite 200, 123 Main Street, Los Angeles, CA 90001. " +
  "Landlord: ABC Properties LLC. Lease term: 36 months.";

// ---------------------------------------------------------------------------
// Secret presence map — NEVER return actual values
// ---------------------------------------------------------------------------

function buildSecretPresenceMap(): Record<string, "present" | "missing"> {
  const has = (key: string) => !!Deno.env.get(key);
  return {
    SUPABASE_URL: has("SUPABASE_URL") ? "present" : "missing",
    SUPABASE_SERVICE_ROLE_KEY: has("SUPABASE_SERVICE_ROLE_KEY") ? "present" : "missing",
    WORKER_INTERNAL_SECRET: has("WORKER_INTERNAL_SECRET") ? "present" : "missing",
    VERTEX_PROJECT_ID: (has("VERTEX_PROJECT_ID") || has("GOOGLE_PROJECT_ID")) ? "present" : "missing",
    GOOGLE_SERVICE_ACCOUNT_KEY: (has("GOOGLE_SERVICE_ACCOUNT_KEY") || has("GOOGLE_PRIVATE_KEY")) ? "present" : "missing",
    DOCLING_API_URL: has("DOCLING_API_URL") ? "present" : "missing",
  };
}

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------

function checkEnvVars(): Check[] {
  const checks: Check[] = [];

  const required = [
    { key: "SUPABASE_URL", label: "SUPABASE_URL" },
    { key: "SUPABASE_SERVICE_ROLE_KEY", label: "SUPABASE_SERVICE_ROLE_KEY" },
    { key: "WORKER_INTERNAL_SECRET", label: "WORKER_INTERNAL_SECRET" },
  ];

  for (const { key, label } of required) {
    const present = !!Deno.env.get(key);
    checks.push({
      name: `env_${key.toLowerCase()}`,
      status: present ? "pass" : "fail",
      message: present ? `${label} is set` : `${label} is missing`,
      ...(present ? {} : { fix: `supabase secrets set ${label}=<value>` }),
    });
  }

  const hasVertexProject = !!(Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID"));
  const hasVertexCreds = !!(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || Deno.env.get("GOOGLE_PRIVATE_KEY"));
  const vertexFull = hasVertexProject && hasVertexCreds;
  const vertexPartial = hasVertexProject || hasVertexCreds;
  checks.push({
    name: "env_vertex_ai",
    status: vertexFull ? "pass" : vertexPartial ? "warn" : "skip",
    message: vertexFull
      ? "Vertex AI fully configured (VERTEX_PROJECT_ID + GOOGLE_SERVICE_ACCOUNT_KEY)"
      : vertexPartial
        ? "Vertex AI partially configured — both VERTEX_PROJECT_ID and GOOGLE_SERVICE_ACCOUNT_KEY are required"
        : "Vertex AI not configured (optional — required for LLM field extraction)",
    ...(vertexPartial && !vertexFull
      ? { fix: "Set both VERTEX_PROJECT_ID and GOOGLE_SERVICE_ACCOUNT_KEY in Supabase secrets" }
      : {}),
  });

  const hasDocling = !!Deno.env.get("DOCLING_API_URL");
  checks.push({
    name: "env_docling_api_url",
    status: hasDocling ? "pass" : "skip",
    message: hasDocling
      ? "DOCLING_API_URL is set"
      : "DOCLING_API_URL not configured (optional — enables structured table extraction)",
    ...(hasDocling ? {} : { fix: "supabase secrets set DOCLING_API_URL=http://your-docling-service:5001" }),
  });

  return checks;
}

async function checkDatabaseSchema(admin: any): Promise<Check[]> {
  const checks: Check[] = [];

  for (const table of REQUIRED_TABLES) {
    try {
      const { error } = await admin.from(table).select("id").limit(0);
      if (error) {
        const missing = /does not exist/i.test(error.message) || error.code === "42P01";
        checks.push({
          name: `db_table_${table}`,
          status: "fail",
          message: missing
            ? `Table '${table}' does not exist`
            : `Table '${table}' query error: ${error.message}`,
          fix: "supabase db push — applies all pending migrations",
        });
      } else {
        checks.push({
          name: `db_table_${table}`,
          status: "pass",
          message: `Table '${table}' exists`,
        });
      }
    } catch (err: any) {
      checks.push({
        name: `db_table_${table}`,
        status: "fail",
        message: `Table '${table}' check threw: ${err?.message ?? err}`,
        fix: "supabase db push",
      });
    }
  }

  // Check all required uploaded_files columns in one query
  try {
    const { error: colErr } = await admin
      .from("uploaded_files")
      .select(REQUIRED_UF_COLUMNS.join(", "))
      .limit(0);

    if (colErr) {
      // Extract the missing column name from the PostgREST error if possible
      const match = colErr.message.match(
        /column (?:uploaded_files\.)?["']?([a-z_]+)["']? does not exist/i,
      );
      const missing = match?.[1] ?? null;
      checks.push({
        name: "db_uploaded_files_columns",
        status: "fail",
        message: missing
          ? `uploaded_files column '${missing}' is missing`
          : `uploaded_files column check failed: ${colErr.message}`,
        fix: "supabase db push — migration 20260610123000_uploaded_files_processing_status.sql adds these columns",
      });
    } else {
      checks.push({
        name: "db_uploaded_files_columns",
        status: "pass",
        message: `All required uploaded_files columns present (${REQUIRED_UF_COLUMNS.join(", ")})`,
      });
    }
  } catch (err: any) {
    checks.push({
      name: "db_uploaded_files_columns",
      status: "fail",
      message: `Column check threw: ${err?.message ?? err}`,
      fix: "supabase db push",
    });
  }

  return checks;
}

async function checkStorage(admin: any): Promise<Check> {
  try {
    const { data: buckets, error } = await admin.storage.listBuckets();

    if (error) {
      return {
        name: "storage_bucket",
        status: "fail",
        message: `Storage listBuckets failed: ${error.message}`,
        fix: "Verify SUPABASE_SERVICE_ROLE_KEY is correct and Storage API is reachable",
      };
    }

    const list: any[] = Array.isArray(buckets) ? buckets : [];
    const found = list.find((b: any) =>
      b?.name === "financial-uploads" || b?.id === "financial-uploads",
    );

    if (!found) {
      const names = list.map((b: any) => b?.name ?? "?").join(", ") || "(none)";
      return {
        name: "storage_bucket",
        status: "fail",
        message: `Bucket 'financial-uploads' not found. Existing buckets: ${names}`,
        fix: "supabase db push — migration 20260403_create_financial_uploads_bucket.sql creates the bucket",
      };
    }

    return {
      name: "storage_bucket",
      status: "pass",
      message: `Bucket 'financial-uploads' exists (public: ${found.public ?? "unknown"})`,
    };
  } catch (err: any) {
    return {
      name: "storage_bucket",
      status: "fail",
      message: `Storage check threw: ${err?.message ?? err}`,
      fix: "Verify SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL are correct",
    };
  }
}

async function checkParseFunctionAuth(): Promise<Check> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const workerSecret = Deno.env.get("WORKER_INTERNAL_SECRET");

  if (!supabaseUrl || !serviceKey) {
    return {
      name: "parse_function_auth",
      status: "fail",
      message: "Cannot call parse-pdf-docling: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set",
      fix: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Edge Function secrets",
    };
  }

  const url = `${supabaseUrl}/functions/v1/parse-pdf-docling`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${serviceKey}`,
    "apikey": serviceKey,
  };
  if (workerSecret) headers["x-worker-secret"] = workerSecret;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ dry_run: true }),
      signal: AbortSignal.timeout(FUNCTION_CALL_TIMEOUT_MS),
    });

    const text = await resp.text().catch(() => "");
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }

    if (resp.status === 401) {
      return {
        name: "parse_function_auth",
        status: "fail",
        message: `parse-pdf-docling returned 401 — worker auth rejected (${json?.error_code ?? "no code"})`,
        fix: "Verify SUPABASE_SERVICE_ROLE_KEY and WORKER_INTERNAL_SECRET match what is set in Supabase Edge Function secrets",
      };
    }

    // Explicit dry_run response from updated function
    if (json?.dry_run === true && json?.authenticated === true) {
      return {
        name: "parse_function_auth",
        status: "pass",
        message: "parse-pdf-docling authenticated ok (dry_run response)",
      };
    }

    // Auth passed and reached body-validation stage (MISSING_FILE_ID = auth passed)
    if (
      resp.status === 400 &&
      (json?.error_code === "MISSING_FILE_ID" || /file_id/i.test(json?.message ?? ""))
    ) {
      return {
        name: "parse_function_auth",
        status: "pass",
        message: "parse-pdf-docling auth passed (function reached body-validation stage)",
      };
    }

    if (resp.ok) {
      return {
        name: "parse_function_auth",
        status: "pass",
        message: `parse-pdf-docling responded ${resp.status} ok`,
      };
    }

    return {
      name: "parse_function_auth",
      status: "fail",
      message: `parse-pdf-docling returned ${resp.status}: ${text.slice(0, 300)}`,
      fix: "Check Supabase Edge Function logs for parse-pdf-docling",
    };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const isTimeout = /timeout|abort/i.test(msg);
    return {
      name: "parse_function_auth",
      status: "fail",
      message: isTimeout
        ? `parse-pdf-docling timed out (>${FUNCTION_CALL_TIMEOUT_MS / 1000}s)`
        : `parse-pdf-docling call failed: ${msg}`,
      fix: "Verify SUPABASE_URL is correct and the function is deployed (supabase functions deploy parse-pdf-docling)",
    };
  }
}

async function checkNormalizeFunctionAuth(): Promise<Check> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceKey) {
    return {
      name: "normalize_function_auth",
      status: "fail",
      message: "Cannot call normalize-pdf-output: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set",
      fix: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Edge Function secrets",
    };
  }

  const url = `${supabaseUrl}/functions/v1/normalize-pdf-output`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
        "apikey": serviceKey,
        "x-internal-service-key": serviceKey,
      },
      body: JSON.stringify({ dry_run: true, sample_text: NORMALIZE_SAMPLE_TEXT }),
      signal: AbortSignal.timeout(FUNCTION_CALL_TIMEOUT_MS),
    });

    const text = await resp.text().catch(() => "");
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }

    if (resp.status === 401) {
      return {
        name: "normalize_function_auth",
        status: "fail",
        message: `normalize-pdf-output returned 401 — auth rejected (${json?.error_code ?? "no code"})`,
        fix: "Verify SUPABASE_SERVICE_ROLE_KEY is correctly set in Supabase Edge Function secrets",
      };
    }

    // Explicit dry_run response
    if (json?.dry_run === true && json?.ok === true) {
      const rows = json?.extraction?.rows ?? 0;
      return {
        name: "normalize_function_auth",
        status: "pass",
        message: `normalize-pdf-output dry_run ok${rows > 0 ? ` (${rows} row(s) extracted from sample)` : ""}`,
      };
    }

    // Auth passed, reached body-validation
    if (
      resp.status === 400 &&
      (json?.error_code === "MISSING_FILE_ID" || /file_id/i.test(json?.message ?? ""))
    ) {
      return {
        name: "normalize_function_auth",
        status: "pass",
        message: "normalize-pdf-output auth passed (function reached body-validation stage)",
      };
    }

    if (resp.ok) {
      return {
        name: "normalize_function_auth",
        status: "pass",
        message: `normalize-pdf-output responded ${resp.status} ok`,
      };
    }

    return {
      name: "normalize_function_auth",
      status: "fail",
      message: `normalize-pdf-output returned ${resp.status}: ${text.slice(0, 300)}`,
      fix: "Check Supabase Edge Function logs for normalize-pdf-output",
    };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const isTimeout = /timeout|abort/i.test(msg);
    return {
      name: "normalize_function_auth",
      status: "fail",
      message: isTimeout
        ? `normalize-pdf-output timed out (>${FUNCTION_CALL_TIMEOUT_MS / 1000}s)`
        : `normalize-pdf-output call failed: ${msg}`,
      fix: "Verify SUPABASE_URL and deploy: supabase functions deploy normalize-pdf-output",
    };
  }
}

async function checkDocling(): Promise<Check> {
  const doclingUrl = Deno.env.get("DOCLING_API_URL");

  if (!doclingUrl) {
    return {
      name: "docling",
      status: "skip",
      message: "DOCLING_API_URL not configured — Docling check skipped (optional)",
      fix: "supabase secrets set DOCLING_API_URL=http://your-docling-service:5001",
    };
  }

  const base = doclingUrl.replace(/\/$/, "");
  const healthUrl = `${base}/health`;

  try {
    const resp = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });

    if (resp.ok) {
      return {
        name: "docling",
        status: "pass",
        message: `Docling health endpoint responded ${resp.status} at ${healthUrl}`,
      };
    }

    if (resp.status === 404) {
      // /health not implemented — probe root
      const rootResp = await fetch(base, {
        method: "GET",
        signal: AbortSignal.timeout(8_000),
      }).catch(() => null);

      if (rootResp?.ok) {
        return {
          name: "docling",
          status: "pass",
          message: `Docling root reachable at ${base} (/health returned 404 — service may not expose a health endpoint)`,
        };
      }
    }

    return {
      name: "docling",
      status: "fail",
      message: `Docling health endpoint returned ${resp.status} at ${healthUrl}`,
      fix: "Verify the Docling service is running and DOCLING_API_URL is reachable from Supabase Edge Functions",
    };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const isTimeout = /timeout|abort/i.test(msg);
    return {
      name: "docling",
      status: "fail",
      message: isTimeout
        ? `Docling health check timed out at ${healthUrl}`
        : `Docling health check failed: ${msg}`,
      fix: `Verify DOCLING_API_URL (${base}) is correct and accessible from Supabase Edge Functions`,
    };
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  // ── Auth guard ────────────────────────────────────────────────────────────
  const hasAuth = Boolean(
    req.headers.get("Authorization") ||
    req.headers.get("x-user-jwt") ||
    req.headers.get("x-supabase-auth"),
  );

  if (!hasAuth) {
    return jsonResponse({ ok: false, error: "Unauthorized", message: "Missing Authorization header" }, 401);
  }

  let user: any;
  let supabaseAdmin: any;

  try {
    const result = await verifyUser(req);
    user = result.user;
    supabaseAdmin = result.supabaseAdmin;
  } catch (err: any) {
    return jsonResponse({
      ok: false,
      error: "Unauthorized",
      message: err?.message ?? "Token verification failed",
    }, 401);
  }

  // ── Admin role gate ───────────────────────────────────────────────────────
  const { data: memberships, error: membershipError } = await supabaseAdmin
    .from("memberships")
    .select("role, org_id, status")
    .eq("user_id", user.id);

  if (membershipError) {
    return jsonResponse({
      ok: false,
      error: "Internal error",
      message: `Failed to verify admin role: ${membershipError.message}`,
    }, 500);
  }

  const memberList: any[] = Array.isArray(memberships) ? memberships : [];
  const isAdmin = memberList.some((m: any) => {
    const roleOk = ["org_admin", "super_admin"].includes(m?.role ?? "");
    const statusOk = !m?.status || ["active", "owner"].includes(m.status);
    return roleOk && statusOk;
  });

  if (!isAdmin) {
    return jsonResponse({
      ok: false,
      error: "Forbidden",
      message: "Pipeline health check requires org_admin or super_admin role",
    }, 403);
  }

  // ── Run all checks ────────────────────────────────────────────────────────
  const checks: Check[] = [];

  // Env var checks are synchronous
  checks.push(...checkEnvVars());

  // All IO-bound checks run in parallel
  const [
    dbChecks,
    storageCheck,
    parseAuthCheck,
    normalizeAuthCheck,
    doclingCheck,
  ] = await Promise.all([
    checkDatabaseSchema(supabaseAdmin),
    checkStorage(supabaseAdmin),
    checkParseFunctionAuth(),
    checkNormalizeFunctionAuth(),
    checkDocling(),
  ]);

  checks.push(...dbChecks);
  checks.push(storageCheck);
  checks.push(parseAuthCheck);
  checks.push(normalizeAuthCheck);
  checks.push(doclingCheck);

  // ── Build summary ─────────────────────────────────────────────────────────
  const hasStatus = (name: string, status: CheckStatus) =>
    checks.some((c) => c.name === name && c.status === status);

  const dbTablesReady = REQUIRED_TABLES.every((t) => hasStatus(`db_table_${t}`, "pass"));
  const dbColumnsReady = hasStatus("db_uploaded_files_columns", "pass");
  const storageReady = hasStatus("storage_bucket", "pass");
  const parseReady = hasStatus("parse_function_auth", "pass");
  const vertexReady = hasStatus("env_vertex_ai", "pass");
  const doclingReady = hasStatus("docling", "pass");

  const ready_for_digital_pdf = dbTablesReady && dbColumnsReady && storageReady && parseReady;
  const ready_for_scanned_pdf = ready_for_digital_pdf && doclingReady;
  const ready_for_llm_extraction = ready_for_digital_pdf && vertexReady;
  const ready_for_docling_tables = dbTablesReady && dbColumnsReady && storageReady && doclingReady;

  const overallOk = !checks.some((c) => c.status === "fail");

  return jsonResponse({
    ok: overallOk,
    checked_at: new Date().toISOString(),
    summary: {
      ready_for_digital_pdf,
      ready_for_scanned_pdf,
      ready_for_llm_extraction,
      ready_for_docling_tables,
    },
    secret_presence: buildSecretPresenceMap(),
    checks,
  });
});
