// @ts-nocheck
// Tests for the "Fix Lease Review extraction readiness, evidence, confidence,
// and clause quality" plan's P0 guarantees and §5/§7 fixes.
// Run: deno test --allow-env --allow-read --no-lock lease-review-readiness-and-evidence-guarantees.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  isMeaningfulFieldValue,
  fieldListHasMeaningfulValues,
  uiReviewPayloadHasMeaningfulValues,
  parsedDataHasMeaningfulValues,
  normalizedOutputHasMeaningfulValues,
  uploadedFileRowHasMeaningfulValues,
  computeCoreReady,
} from "../_shared/extraction/payload-guard.ts";
import { validateRecords } from "../_shared/extraction/validator.ts";
import { parseEnum } from "../_shared/extraction/rule-extractor.ts";

const realServe = Deno.serve;
(Deno as any).serve = (..._args: unknown[]) => ({ finished: Promise.resolve(), shutdown: () => {} });
const { __test__: normalizeTest } = await import("../normalize-pdf-output/index.ts");
(Deno as any).serve = realServe;

// ── payload-guard.ts: meaningful-value detection (guarantees 1-3 primitive) ──

Deno.test("isMeaningfulFieldValue: rejects null/empty/sentinel values", () => {
  assertEquals(isMeaningfulFieldValue(null), false);
  assertEquals(isMeaningfulFieldValue(undefined), false);
  assertEquals(isMeaningfulFieldValue(""), false);
  assertEquals(isMeaningfulFieldValue("   "), false);
  assertEquals(isMeaningfulFieldValue("n/a"), false);
  assertEquals(isMeaningfulFieldValue("N/A"), false);
  assertEquals(isMeaningfulFieldValue("null"), false);
  assertEquals(isMeaningfulFieldValue("unknown"), false);
  assertEquals(isMeaningfulFieldValue([]), false);
});

Deno.test("isMeaningfulFieldValue: accepts real values", () => {
  assertEquals(isMeaningfulFieldValue("Mindful Tech Solutions Inc"), true);
  assertEquals(isMeaningfulFieldValue(1400), true);
  assertEquals(isMeaningfulFieldValue(0), true); // 0 is a real extracted number, not a sentinel
  assertEquals(isMeaningfulFieldValue(["a"]), true);
});

Deno.test("guarantee 1: uiReviewPayloadHasMeaningfulValues detects real standard_fields values", () => {
  const withValues = {
    records: [{ standard_fields: [{ field_key: "tenant_name", value: "Acme Inc" }] }],
  };
  const empty = {
    records: [{ standard_fields: [{ field_key: "tenant_name", value: null }] }],
  };
  assertEquals(uiReviewPayloadHasMeaningfulValues(withValues), true);
  assertEquals(uiReviewPayloadHasMeaningfulValues(empty), false);
  assertEquals(uiReviewPayloadHasMeaningfulValues(null), false);
  assertEquals(uiReviewPayloadHasMeaningfulValues({}), false);
});

Deno.test("guarantee 2: parsedDataHasMeaningfulValues distinguishes [{}] fallback shape from real rows", () => {
  assertEquals(parsedDataHasMeaningfulValues([{}]), false, "the literal manual_review_fallback shape must read as empty");
  assertEquals(parsedDataHasMeaningfulValues([{ tenant_name: "Acme Inc" }]), true);
  assertEquals(parsedDataHasMeaningfulValues([]), false);
  assertEquals(parsedDataHasMeaningfulValues(null), false);
});

Deno.test("guarantee 3: normalizedOutputHasMeaningfulValues distinguishes rows:[{}] fallback shape from real rows", () => {
  assertEquals(normalizedOutputHasMeaningfulValues({ rows: [{}] }), false);
  assertEquals(normalizedOutputHasMeaningfulValues({ rows: [{ monthly_rent: 1400 }] }), true);
  assertEquals(normalizedOutputHasMeaningfulValues(null), false);
});

Deno.test("guarantees 1-3 combined: uploadedFileRowHasMeaningfulValues is true if ANY of the three columns has real data", () => {
  assertEquals(
    uploadedFileRowHasMeaningfulValues({ ui_review_payload: null, parsed_data: [{}], normalized_output: { rows: [{}] } }),
    false,
  );
  assertEquals(
    uploadedFileRowHasMeaningfulValues({ ui_review_payload: null, parsed_data: [{ tenant_name: "Acme" }], normalized_output: null }),
    true,
  );
  assertEquals(
    uploadedFileRowHasMeaningfulValues({
      ui_review_payload: { records: [{ standard_fields: [{ field_key: "tenant_name", value: "Acme" }] }] },
      parsed_data: [{}],
      normalized_output: { rows: [{}] },
    }),
    true,
  );
});

// ── guarantee 4: computeCoreReady ────────────────────────────────────────────

function stdField(field_key: string, value: unknown) {
  return { field_key, value };
}

Deno.test("guarantee 4: computeCoreReady is false with no tenant_name even if other core fields exist", () => {
  const fields = [
    stdField("tenant_name", null),
    stdField("property_address", "123 Main St"),
    stdField("commencement_date", "2024-01-01"),
    stdField("expiration_date", "2025-01-01"),
    stdField("monthly_rent", 1400),
    stdField("square_footage", 1000),
  ];
  assertEquals(computeCoreReady(fields), false);
});

Deno.test("guarantee 4: computeCoreReady is true once tenant_name plus a majority of remaining core categories are present", () => {
  const fields = [
    stdField("tenant_name", "Acme Inc"),
    stdField("property_address", "123 Main St"),
    stdField("commencement_date", "2024-01-01"),
    stdField("expiration_date", "2025-01-01"),
    stdField("monthly_rent", 1400),
    stdField("square_footage", 1000),
  ];
  assertEquals(computeCoreReady(fields), true);
});

Deno.test("guarantee 4: computeCoreReady is false when only tenant_name is present (not a majority of core categories)", () => {
  const fields = [stdField("tenant_name", "Acme Inc")];
  assertEquals(computeCoreReady(fields), false);
});

Deno.test("guarantee 4: computeCoreReady does not require every optional field — a majority of the non-tenant core categories still qualifies", () => {
  // tenant_name plus 3 of the 5 remaining categories (property_address,
  // commencement_date, monthly_rent) meets the ceil(5/2)=3 majority bar
  // without square_footage or an end date ever being filled in.
  const fields = [
    stdField("tenant_name", "Acme Inc"),
    stdField("property_address", "123 Main St"),
    stdField("commencement_date", "2024-01-01"),
    stdField("monthly_rent", 1400),
  ];
  assertEquals(computeCoreReady(fields), true);
});

// ── guarantees 4/5/6: buildMinimalReviewPayload hydration ───────────────────

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    rows: [{
      tenant_name: "Mindful Tech Solutions Inc",
      property_address: "224 S Peters Road",
      commencement_date: "2024-02-01",
      expiration_date: "2025-01-31",
      monthly_rent: 1400,
      square_footage: 1110,
    }],
    method: "hybrid",
    warnings: [],
    validationErrors: [],
    metadata: {
      avgConfidence: 91,
      extractionDebug: {
        merged_field_sources: {
          tenant_name: { value: "Mindful Tech Solutions Inc", source_text: "Tenant: Mindful Tech Solutions Inc", source_page: 1, confidence: 0.95 },
          monthly_rent: { value: 1400, source_text: "Monthly Rent: $1,400", source_page: 3, confidence: 0.92 },
        },
        llm_returned_field_details: {},
      },
    },
    ...overrides,
  };
}

Deno.test("guarantee 5: buildMinimalReviewPayload stamps metadata.extraction_contract_version directly (not only nested)", () => {
  const payload = normalizeTest.buildMinimalReviewPayload({
    fileId: "f1", fileName: "lease.pdf", moduleType: "leases", documentSubtype: "base_lease",
    extractionMethod: "azure_layout", reviewRequired: true, result: makeResult(),
  });
  assertEquals(payload.metadata.extraction_contract_version, "lease-review-evidence-v3");
});

Deno.test("guarantee 4: buildMinimalReviewPayload stamps a real core_ready boolean, not undefined", () => {
  const payload = normalizeTest.buildMinimalReviewPayload({
    fileId: "f1", fileName: "lease.pdf", moduleType: "leases", documentSubtype: "base_lease",
    extractionMethod: "azure_layout", reviewRequired: true, result: makeResult(),
  });
  assertEquals(typeof payload.core_ready, "boolean");
  assertEquals(payload.core_ready, true);
});

Deno.test("guarantee 6: a field with value + source + confidence>=90 becomes auto_populated but accepted stays false", () => {
  const payload = normalizeTest.buildMinimalReviewPayload({
    fileId: "f1", fileName: "lease.pdf", moduleType: "leases", documentSubtype: "base_lease",
    extractionMethod: "azure_layout", reviewRequired: true, result: makeResult(),
  });
  const tenantField = payload.records[0].standard_fields.find((f: any) => f.field_key === "tenant_name");
  assertEquals(tenantField.status, "auto_populated");
  assertEquals(tenantField.accepted, false, "auto_populated must never imply reviewer acceptance");
  assert(tenantField.evidence?.source_text, "auto_populated field should carry its source_text");
});

Deno.test("field with a value but no source evidence becomes needs_review, not auto_populated", () => {
  const result = makeResult();
  // square_footage has a value in rows but no entry in merged_field_sources/llm_returned_field_details
  const payload = normalizeTest.buildMinimalReviewPayload({
    fileId: "f1", fileName: "lease.pdf", moduleType: "leases", documentSubtype: "base_lease",
    extractionMethod: "azure_layout", reviewRequired: true, result,
  });
  const sqftField = payload.records[0].standard_fields.find((f: any) => f.field_key === "square_footage");
  assertEquals(sqftField.status, "needs_review");
  assertEquals(sqftField.accepted, false);
});

// ── §5: validator fixes ──────────────────────────────────────────────────────

Deno.test("§5: landlord_consent='required' survives validation as boolean true", () => {
  const record = {
    rowIndex: 0,
    fields: {
      landlord_consent: { value: "required", confidence: 0.8, source: "llm" },
    },
  } as any;
  const { records } = validateRecords([record], "lease");
  assertEquals(records[0].fields.landlord_consent.value, true);
});

Deno.test("§5: lease_type='full_service' maps to the schema's canonical 'gross' value", () => {
  const record = {
    rowIndex: 0,
    fields: {
      lease_type: { value: "full_service", confidence: 0.8, source: "llm" },
    },
  } as any;
  const { records } = validateRecords([record], "lease");
  assertEquals(records[0].fields.lease_type.value, "gross");
});

// ── §5: parseEnum alias fixes ─────────────────────────────────────────────────

const LEASE_TYPE_ALLOWED = ["nnn", "gross", "modified_gross", "nn", "net"];

Deno.test("parseEnum: 'full_service' (underscore form) resolves to 'gross', not a self-referential 'full_service'", () => {
  assertEquals(parseEnum("full_service", LEASE_TYPE_ALLOWED), "gross");
  assertEquals(parseEnum("full service", LEASE_TYPE_ALLOWED), "gross");
  assertEquals(parseEnum("Full-Service", LEASE_TYPE_ALLOWED), "gross");
});

Deno.test("parseEnum: 'triple net'/'nnn' resolves to the schema's actual 'nnn' value, not an out-of-schema 'triple_net'", () => {
  assertEquals(parseEnum("triple net", LEASE_TYPE_ALLOWED), "nnn");
  assertEquals(parseEnum("NNN", LEASE_TYPE_ALLOWED), "nnn");
});

Deno.test("parseEnum: an alias whose target isn't in the field's allowed list returns null instead of an out-of-schema value", () => {
  // "office" is a valid alias target for property_type-style fields, but not
  // a legal lease_type value — must not leak through for this field.
  assertEquals(parseEnum("commercial office", LEASE_TYPE_ALLOWED), null);
});

// ── guarantee 7: enrich failure never touches uploaded_files.status ─────────
// (handleEnrichMode is not exported — this is a structural/code-shape check
// that the enrich-mode error path only patches ui_review_payload.enrichment_status,
// verified directly against the source rather than via a live Supabase stub.)

Deno.test("guarantee 7: normalize-pdf-output source never calls setFailed()/status update inside the enrich-mode catch block", async () => {
  const src = await Deno.readTextFile(
    new URL("../normalize-pdf-output/index.ts", import.meta.url),
  );
  const enrichBlockStart = src.indexOf("async function handleEnrichMode");
  assert(enrichBlockStart !== -1, "handleEnrichMode must exist");
  const enrichBlockEnd = src.indexOf("\nDeno.serve(", enrichBlockStart);
  assert(enrichBlockEnd !== -1, "could not find the end of handleEnrichMode (Deno.serve marker)");
  const enrichBlock = src.slice(enrichBlockStart, enrichBlockEnd);
  // Match actual call sites (setFailed(supabaseAdmin, ...)), not this test's
  // or the source's own explanatory comments mentioning "setFailed()".
  assert(!enrichBlock.includes("setFailed(supabaseAdmin"), "enrich mode must never call setFailed() on uploaded_files.status");
});

Deno.test("guarantee 8: handleEnrichMode never calls runExtractionPipeline — only buildReviewPayload against already-persisted normalized_output", async () => {
  const src = await Deno.readTextFile(
    new URL("../normalize-pdf-output/index.ts", import.meta.url),
  );
  const enrichBlockStart = src.indexOf("async function handleEnrichMode");
  const enrichBlockEnd = src.indexOf("\nDeno.serve(", enrichBlockStart);
  const enrichBlock = src.slice(enrichBlockStart, enrichBlockEnd);
  assert(!enrichBlock.includes("runExtractionPipeline("), "enrich mode must not re-run extraction");
  assert(enrichBlock.includes("buildReviewPayload("), "enrich mode must run the evidence/clause pass");
});
