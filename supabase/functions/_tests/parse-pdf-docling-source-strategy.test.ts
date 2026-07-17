// @ts-nocheck
import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  categorizeSourceUrl,
  shouldUseLocalAzureByteSource,
} from "../parse-pdf-docling/source-strategy.ts";
import { normalizeAzureLayoutToDoclingOutput } from "../_shared/extraction/azure-layout-adapter.ts";

Deno.test("strict Azure + local runtime + localhost URL loads bytes and suppresses URL", () => {
  const strategy = shouldUseLocalAzureByteSource({
    strictAzureMode: true,
    localSupabaseRuntime: true,
    sourceUrl: "http://localhost:54321/storage/v1/object/sign/financial-uploads/org/file.pdf?token=redacted",
    fileSizeBytes: 1024,
  });

  assertEquals(strategy.category, "localhost");
  assertEquals(strategy.loadBytesFromStorage, true);
  assertEquals(strategy.sendUrlToAzure, false);
});

Deno.test("strict Azure + local runtime + kong URL loads bytes and suppresses URL", () => {
  const strategy = shouldUseLocalAzureByteSource({
    strictAzureMode: true,
    localSupabaseRuntime: true,
    sourceUrl: "http://kong:8000/storage/v1/object/sign/financial-uploads/org/file.pdf?token=redacted",
    fileSizeBytes: 2048,
  });

  assertEquals(strategy.category, "kong");
  assertEquals(strategy.loadBytesFromStorage, true);
  assertEquals(strategy.sendUrlToAzure, false);
});

Deno.test("strict Azure + public HTTPS URL preserves URL-first behavior", () => {
  const strategy = shouldUseLocalAzureByteSource({
    strictAzureMode: true,
    localSupabaseRuntime: true,
    sourceUrl: "https://storage.example.com/document.pdf?token=redacted",
    fileSizeBytes: 2048,
  });

  assertEquals(strategy.category, "public_https");
  assertEquals(strategy.loadBytesFromStorage, false);
  assertEquals(strategy.sendUrlToAzure, true);
});

Deno.test("local URL without LOCAL_SUPABASE_RUNTIME does not enable local byte path", () => {
  const strategy = shouldUseLocalAzureByteSource({
    strictAzureMode: true,
    localSupabaseRuntime: false,
    sourceUrl: "http://127.0.0.1:54321/storage/v1/object/sign/financial-uploads/org/file.pdf?token=redacted",
    fileSizeBytes: 2048,
  });

  assertEquals(strategy.category, "127.0.0.1");
  assertEquals(strategy.loadBytesFromStorage, false);
  assertEquals(strategy.sendUrlToAzure, true);
});

Deno.test("base64 byte fallback has a size guard", () => {
  assertThrows(
    () =>
      shouldUseLocalAzureByteSource({
        strictAzureMode: true,
        localSupabaseRuntime: true,
        sourceUrl: "http://kong:8000/storage/v1/object/sign/financial-uploads/org/file.pdf?token=redacted",
        fileSizeBytes: 11 * 1024 * 1024,
        maxLocalAzureBytes: 10 * 1024 * 1024,
      }),
    Error,
    "size guard",
  );
});

Deno.test("STORE_FULL_AZURE_RAW_RESPONSE=false remains honored", () => {
  const previous = Deno.env.get("STORE_FULL_AZURE_RAW_RESPONSE");
  Deno.env.set("STORE_FULL_AZURE_RAW_RESPONSE", "false");
  try {
    const output = normalizeAzureLayoutToDoclingOutput({
      content: "Synthetic sample text",
      pages: [{ pageNumber: 1, lines: [{ content: "Synthetic sample text" }] }],
      paragraphs: [],
      tables: [],
    });

    assertEquals(output.raw_response, null);
    assertEquals(output.raw_response_summary?.raw_response_stored, false);
    assertEquals(output._metadata?.raw_response_stored, false);
  } finally {
    if (previous == null) Deno.env.delete("STORE_FULL_AZURE_RAW_RESPONSE");
    else Deno.env.set("STORE_FULL_AZURE_RAW_RESPONSE", previous);
  }
});

Deno.test("legacy and shadow modes do not activate the strict local byte branch", () => {
  const legacy = shouldUseLocalAzureByteSource({
    strictAzureMode: false,
    localSupabaseRuntime: true,
    sourceUrl: "http://kong:8000/storage/v1/object/sign/financial-uploads/org/file.pdf?token=redacted",
    fileSizeBytes: 2048,
  });

  assertEquals(legacy.loadBytesFromStorage, false);
  assertEquals(legacy.sendUrlToAzure, true);
  assertEquals(legacy.reason, "not_strict_azure_mode");

  // shadow_compare uses Azure, but it is not strict Azure-only mode; it still
  // needs legacy bytes, so this helper must not switch off URL forwarding.
  const shadow = shouldUseLocalAzureByteSource({
    strictAzureMode: false,
    localSupabaseRuntime: true,
    sourceUrl: "http://localhost:54321/storage/v1/object/sign/financial-uploads/org/file.pdf?token=redacted",
    fileSizeBytes: 2048,
  });

  assertEquals(shadow.loadBytesFromStorage, false);
  assertEquals(shadow.sendUrlToAzure, true);
});

Deno.test("source URL categorizer treats invalid or missing values as non-local", () => {
  assertEquals(categorizeSourceUrl(null), "missing");
  assertEquals(categorizeSourceUrl("not a url"), "invalid");
});
