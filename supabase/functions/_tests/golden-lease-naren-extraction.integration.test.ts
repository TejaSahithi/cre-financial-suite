// @ts-nocheck
// Golden-lease regression test for the scanned 17-page lease fixture at
// supabase/functions/_tests/fixtures/golden-leases/naren-executed-lease-01162024.pdf
// ("NAREN - EXECUTED LEASE...01162024").
//
// This is a live-environment integration test, not a unit test -- it reads
// the ALREADY-PERSISTED extraction result for a real uploaded_files row via
// a real Supabase connection, following the same opt-in convention as
// business-extraction-local-integration.property.test.ts (throws at
// module-load if the required env vars aren't set, rather than silently
// skipping). No Azure/OpenAI credentials are read or embedded here -- only
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY, supplied by whoever runs the test.
//
// Run against the linked remote project (extraction_runs family now pushed,
// ENABLE_EXTRACTION_PROVENANCE=true):
//   SUPABASE_URL=<project-url> SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
//   GOLDEN_LEASE_UPLOADED_FILE_ID=d7316b09-20d7-4c1f-8675-7fade21ce1ab \
//   deno test --allow-env --allow-net --no-lock golden-lease-naren-extraction.integration.test.ts
//
// Run: deno test --allow-env --allow-net --no-lock golden-lease-naren-extraction.integration.test.ts

import { assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const UPLOADED_FILE_ID = Deno.env.get("GOLDEN_LEASE_UPLOADED_FILE_ID");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !UPLOADED_FILE_ID) {
  throw new Error(
    "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and GOLDEN_LEASE_UPLOADED_FILE_ID must all be set " +
    "for the golden-lease integration test -- this test reads a real, already-processed " +
    "uploaded_files row rather than fabricating one.",
  );
}

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

// Explicit page-1 values from the "SUMMARY OF BASIC LEASE INFORMATION" and
// signature block of the source PDF. Every value here was read directly off
// the document, not inferred -- see the plan's Golden lease results table.
const GOLDEN_FIELDS: Record<string, { expected: unknown; check?: (actual: unknown) => boolean }> = {
  lease_date: { expected: "2024-01-09" },
  landlord_name: { expected: "224 Partners, LLC" },
  tenant_name: { expected: "Mindful Tech Solutions Inc" },
  tenant_signatory_name: { expected: "Narendra Pydi" },
  square_footage: { expected: 1110 },
  commencement_date: { expected: "2024-02-01" },
  monthly_rent: { expected: 1400 },
  annual_rent: { expected: 16800 },
  escalation_rate: { expected: 5 },
  security_deposit: { expected: 1400 },
  permitted_use: { expected: "IT work" },
};

function extractFieldValue(records: unknown, key: string): unknown {
  if (!records || typeof records !== "object") return undefined;
  const merged = (records as any).metadata?.extractionDebug?.merged_field_sources
    ?? (records as any).metadata?.extractionDebug?.validated_field_values;
  return merged?.[key]?.value;
}

Deno.test("golden lease: page-1 explicit fields resolve to their documented values", async () => {
  const client = adminClient();
  const { data: file, error } = await client
    .from("uploaded_files")
    .select("id, status, review_readiness, ui_review_payload")
    .eq("id", UPLOADED_FILE_ID)
    .maybeSingle();

  if (error) throw new Error(JSON.stringify(error));
  assertExists(file, `uploaded_files row ${UPLOADED_FILE_ID} not found`);

  const payload = file.ui_review_payload;
  assertExists(payload, "ui_review_payload is empty -- extraction has not completed for this file");

  const results: Array<{ field: string; expected: unknown; actual: unknown; pass: boolean }> = [];
  for (const [field, { expected }] of Object.entries(GOLDEN_FIELDS)) {
    const actual = extractFieldValue(payload, field);
    results.push({ field, expected, actual, pass: actual === expected });
  }

  const failed = results.filter((r) => !r.pass);
  const summary = results
    .map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.field}: expected=${JSON.stringify(r.expected)} actual=${JSON.stringify(r.actual)}`)
    .join("\n");
  console.log(`[golden-lease] field-by-field results:\n${summary}`);

  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${results.length} golden fields did not match:\n` +
      failed.map((r) => `  ${r.field}: expected ${JSON.stringify(r.expected)}, got ${JSON.stringify(r.actual)}`).join("\n"),
    );
  }
});
