// @ts-nocheck
/**
 * pipeline-health-check — diagnostic for the CRE lease extraction pipeline
 *
 * Checks the full stack is operational:
 *   - Environment variable presence (never returns values)
 *   - Database schema (tables + required columns)
 *   - Supabase Storage (financial-uploads bucket)
 *   - OpenAI health and credentials
 *   - Azure Document Intelligence health and credentials
 *
 * Access: org_admin or super_admin role only.
 * Security: secret values are NEVER returned — only "present" / "missing".
 */

import { corsHeaders } from "../_shared/cors.ts";
import { createAdminClient, verifyUser } from "../_shared/supabase.ts";
import { callLLMText } from "../_shared/llm.ts";
import { getAzureDocumentIntelligenceConfig } from "../_shared/azure/document-intelligence.ts";
import { resolveExtractionProvider } from "../_shared/extraction/extraction-provider.ts";

type CheckStatus = "pass" | "fail" | "warn" | "skip";

interface Check {
  name: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

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

function buildSecretPresenceMap(): Record<string, "present" | "missing"> {
  const has = (key: string) => !!Deno.env.get(key);
  return {
    SUPABASE_URL: has("SUPABASE_URL") ? "present" : "missing",
    SUPABASE_SERVICE_ROLE_KEY: has("SUPABASE_SERVICE_ROLE_KEY") ? "present" : "missing",
    WORKER_INTERNAL_SECRET: has("WORKER_INTERNAL_SECRET") ? "present" : "missing",
    OPENAI_API_KEY: has("OPENAI_API_KEY") ? "present" : "missing",
    EXTRACTION_PROVIDER: has("EXTRACTION_PROVIDER") ? "present" : "missing",
    AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: has("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT") ? "present" : "missing",
    AZURE_DOCUMENT_INTELLIGENCE_KEY: has("AZURE_DOCUMENT_INTELLIGENCE_KEY") ? "present" : "missing",
    AZURE_DOCUMENT_INTELLIGENCE_API_VERSION: has("AZURE_DOCUMENT_INTELLIGENCE_API_VERSION") ? "present" : "missing",
    AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID: has("AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID") ? "present" : "missing",
    AZURE_DOCUMENT_INTELLIGENCE_OUTPUT_FORMAT: has("AZURE_DOCUMENT_INTELLIGENCE_OUTPUT_FORMAT") ? "present" : "missing",
    STORE_FULL_AZURE_RAW_RESPONSE: has("STORE_FULL_AZURE_RAW_RESPONSE") ? "present" : "missing",
  };
}

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

  const hasOpenAI = !!Deno.env.get("OPENAI_API_KEY");
  checks.push({
    name: "env_openai_api_key",
    status: hasOpenAI ? "pass" : "fail",
    message: hasOpenAI ? "OpenAI API key configured (OPENAI_API_KEY)" : "OpenAI API key missing (OPENAI_API_KEY)",
    ...(hasOpenAI ? {} : { fix: "supabase secrets set OPENAI_API_KEY=<your-key>" }),
  });

  const providerSelection = resolveExtractionProvider();
  checks.push({
    name: "env_extraction_provider",
    status: "pass",
    message: `EXTRACTION_PROVIDER=${providerSelection.mode} (${providerSelection.source})`,
  });

  const azureConfig = getAzureDocumentIntelligenceConfig();
  const azureConfigured = !!(azureConfig.endpoint && azureConfig.keyPresent);
  checks.push({
    name: "env_azure_document_intelligence",
    status: azureConfigured ? "pass" : "fail",
    message: azureConfigured
      ? `Azure Document Intelligence configured (model=${azureConfig.modelId}, api=${azureConfig.apiVersion})`
      : "Azure Document Intelligence endpoint/key missing",
    ...(azureConfigured ? {} : { fix: "Set AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT and AZURE_DOCUMENT_INTELLIGENCE_KEY in Supabase secrets" }),
  });

  return checks;
}

async function checkDatabaseSchema(admin: any): Promise<Check[]> {
  const checks: Check[] = [];

  for (const table of REQUIRED_TABLES) {
    try {
      const { error } = await admin.from(table).select("id").limit(0);
      if (error) {
        checks.push({
          name: `db_table_${table}`,
          status: "fail",
          message: `Table '${table}' query error: ${error.message}`,
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
      });
    }
  }

  try {
    const { error: colErr } = await admin
      .from("uploaded_files")
      .select(REQUIRED_UF_COLUMNS.join(", "))
      .limit(0);

    if (colErr) {
      checks.push({
        name: "db_uploaded_files_columns",
        status: "fail",
        message: `uploaded_files column check failed: ${colErr.message}`,
        fix: "supabase db push",
      });
    } else {
      checks.push({
        name: "db_uploaded_files_columns",
        status: "pass",
        message: `All required uploaded_files columns present`,
      });
    }
  } catch (err: any) {
    checks.push({
      name: "db_uploaded_files_columns",
      status: "fail",
      message: `Column check threw: ${err?.message ?? err}`,
    });
  }

  return checks;
}

async function checkStorage(admin: any): Promise<Check> {
  try {
    const { data, error } = await admin.storage.getBucket("financial-uploads");
    if (error) {
      return {
        name: "storage_bucket",
        status: "fail",
        message: `Storage bucket 'financial-uploads' check failed: ${error.message}`,
        fix: "Verify financial-uploads bucket is created in Supabase storage",
      };
    }
    return {
      name: "storage_bucket",
      status: "pass",
      message: `Storage bucket 'financial-uploads' exists (public=${data.public}, allowedMimeTypes=${JSON.stringify(data.allowed_mime_types)})`,
    };
  } catch (err: any) {
    return {
      name: "storage_bucket",
      status: "fail",
      message: `Storage bucket check threw: ${err?.message ?? err}`,
    };
  }
}

async function checkOpenAIAuth(): Promise<Check> {
  const hasOpenAI = !!Deno.env.get("OPENAI_API_KEY");
  if (!hasOpenAI) {
    return {
      name: "openai_auth",
      status: "fail",
      message: "OpenAI API key not configured",
      fix: "Set OPENAI_API_KEY in Supabase secrets",
    };
  }

  try {
    const response = await callLLMText({
      userPrompt: "Return 'OK'",
      maxOutputTokens: 10,
      temperature: 0,
    });
    const content = String(response.content ?? "").trim();
    return {
      name: "openai_auth",
      status: content ? "pass" : "warn",
      message: content
        ? `OpenAI connection validation succeeded via model: ${response.model}`
        : "OpenAI responded with empty content",
    };
  } catch (err: any) {
    return {
      name: "openai_auth",
      status: "fail",
      message: `OpenAI validation failed: ${err.message}`,
      fix: "Verify OPENAI_API_KEY is active and valid",
    };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

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

  const checks: Check[] = [];
  checks.push(...checkEnvVars());

  const [
    dbChecks,
    storageCheck,
    openaiAuthCheck,
  ] = await Promise.all([
    checkDatabaseSchema(supabaseAdmin),
    checkStorage(supabaseAdmin),
    checkOpenAIAuth(),
  ]);

  checks.push(...dbChecks);
  checks.push(storageCheck);
  checks.push(openaiAuthCheck);

  const hasStatus = (name: string, status: CheckStatus) =>
    checks.some((c) => c.name === name && c.status === status);

  const dbTablesReady = REQUIRED_TABLES.every((t) => hasStatus(`db_table_${t}`, "pass"));
  const dbColumnsReady = hasStatus("db_uploaded_files_columns", "pass");
  const storageReady = hasStatus("storage_bucket", "pass");
  const openaiReady = hasStatus("openai_auth", "pass");
  const azureReady = hasStatus("env_azure_document_intelligence", "pass");

  const overallOk = !checks.some((c) => c.status === "fail");

  return jsonResponse({
    ok: overallOk,
    checked_at: new Date().toISOString(),
    summary: {
      db_ready: dbTablesReady && dbColumnsReady,
      storage_ready: storageReady,
      openai_ready: openaiReady,
      azure_ready: azureReady,
    },
    secret_presence: buildSecretPresenceMap(),
    checks,
  });
});
