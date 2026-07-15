// @ts-nocheck
/**
 * Manual QA utility for Phase 15 batch advisory audit reports.
 *
 * Usage (no service-role key required):
 *   SUPABASE_FUNCTIONS_URL=https://<project>.supabase.co/functions/v1 \
 *   SUPABASE_ACCESS_TOKEN=<signed-in-user-jwt> \
 *   UPLOADED_FILE_IDS=uf-1,uf-2 \
 *   deno run --allow-env --allow-net supabase/functions/_tests/document-intelligence-v3-advisory-audit-batch-report.ts
 */

function splitEnv(name: string) {
  return (Deno.env.get(name) || "").split(",").map((value) => value.trim()).filter(Boolean);
}

const functionsUrl = Deno.env.get("SUPABASE_FUNCTIONS_URL") || "";
const token = Deno.env.get("SUPABASE_ACCESS_TOKEN") || "";
if (!functionsUrl || !token) {
  console.error("SUPABASE_FUNCTIONS_URL and SUPABASE_ACCESS_TOKEN are required.");
  Deno.exit(1);
}

const body = {
  uploaded_file_ids: splitEnv("UPLOADED_FILE_IDS"),
  run_ids: splitEnv("RUN_IDS"),
  lease_ids: splitEnv("LEASE_IDS"),
  limit: Number(Deno.env.get("LIMIT") || 25),
};

const response = await fetch(`${functionsUrl.replace(/\/$/, "")}/document-intelligence-v3-advisory-audit-batch`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

const payload = await response.json().catch(() => ({}));
console.log(JSON.stringify(payload, null, 2));
if (!response.ok || payload?.error) Deno.exit(1);