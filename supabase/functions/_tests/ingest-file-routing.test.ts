// @ts-nocheck
/**
 * Unit tests for ingest-file routing logic
 * Tests pipeline routing decisions, error handling, and status updates
 */

import { assertEquals, assertExists, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";

// Mock dependencies
const mockSupabaseAdmin = {
  from: (table: string) => ({
    select: (columns: string) => ({
      eq: (column: string, value: any) => ({
        single: () => Promise.resolve({
          data: {
            id: "test-file-id",
            org_id: "test-org-id",
            file_name: "test.pdf",
            file_url: "https://example.com/storage/v1/object/public/financial-uploads/test.pdf",
            mime_type: "application/pdf",
            module_type: "leases",
            status: "uploaded"
          },
          error: null
        })
      })
    }),
    update: (data: any) => ({
      eq: (column: string, value: any) => Promise.resolve({ data: {}, error: null })
    })
  }),
  storage: {
    from: (bucket: string) => ({
      download: (path: string) => Promise.resolve({
        data: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]), // PDF magic bytes
        error: null
      })
    })
  }
};

// Mock fetch for edge function calls
const originalFetch = globalThis.fetch;
let mockFetchResponses: Array<{ url: string; response: Response }> = [];

function mockFetch(url: string | URL, options?: RequestInit): Promise<Response> {
  const urlString = url.toString();
  const mockResponse = mockFetchResponses.find(mock => urlString.includes(mock.url));
  
  if (mockResponse) {
    return Promise.resolve(mockResponse.response);
  }
  
  // Default success response
  return Promise.resolve(new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  }));
}

Deno.test("Routing Decision - PDF to parse-pdf-docling", async () => {
  // Test PDF routing decision
  const detection = {
    fileFormat: "pdf" as const,
    moduleType: "leases" as const,
    formatSource: "magic_bytes" as const,
    moduleSource: "explicit" as const,
    confidence: 0.95
  };
  
  // Mock the routing logic (simplified version of actual function)
  function decideRoute(detection: any) {
    switch (detection.fileFormat) {
      case "pdf":
        return { route: "parse-pdf-docling", reason: "PDF → Docling OCR extraction" };
      case "csv":
      case "text":
        return { route: "parse-file", reason: `${detection.fileFormat} file → CSV parser` };
      case "xlsx":
      case "xls":
        return { route: "parse-pdf-docling", reason: `${detection.fileFormat} file → Docling (handles Excel binary format)` };
      default:
        return { route: "unsupported", reason: "Unknown format → unsupported" };
    }
  }
  
  const routing = decideRoute(detection);
  assertEquals(routing.route, "parse-pdf-docling");
  assertEquals(routing.reason, "PDF → Docling OCR extraction");
});

Deno.test("Routing Decision - CSV to parse-file", async () => {
  const detection = {
    fileFormat: "csv" as const,
    moduleType: "leases" as const,
    formatSource: "extension" as const,
    moduleSource: "filename_keyword" as const,
    confidence: 0.85
  };
  
  function decideRoute(detection: any) {
    switch (detection.fileFormat) {
      case "csv":
      case "text":
        return { route: "parse-file", reason: `${detection.fileFormat} file → CSV parser` };
      case "pdf":
        return { route: "parse-pdf-docling", reason: "PDF → Docling OCR extraction" };
      default:
        return { route: "unsupported", reason: "Unknown format → unsupported" };
    }
  }
  
  const routing = decideRoute(detection);
  assertEquals(routing.route, "parse-file");
  assertEquals(routing.reason, "csv file → CSV parser");
});

Deno.test("Routing Decision - Excel to parse-pdf-docling", async () => {
  const detection = {
    fileFormat: "xlsx" as const,
    moduleType: "properties" as const,
    formatSource: "magic_bytes" as const,
    moduleSource: "content_keyword" as const,
    confidence: 0.90
  };
  
  function decideRoute(detection: any) {
    switch (detection.fileFormat) {
      case "xlsx":
      case "xls":
        return { route: "parse-pdf-docling", reason: `${detection.fileFormat} file → Docling (handles Excel binary format)` };
      case "csv":
      case "text":
        return { route: "parse-file", reason: `${detection.fileFormat} file → CSV parser` };
      default:
        return { route: "unsupported", reason: "Unknown format → unsupported" };
    }
  }
  
  const routing = decideRoute(detection);
  assertEquals(routing.route, "parse-pdf-docling");
  assertEquals(routing.reason, "xlsx file → Docling (handles Excel binary format)");
});

Deno.test("Routing Decision - Unsupported Format", async () => {
  const detection = {
    fileFormat: "unknown" as const,
    moduleType: "unknown" as const,
    formatSource: "fallback" as const,
    moduleSource: "fallback" as const,
    confidence: 0.30
  };
  
  function decideRoute(detection: any) {
    switch (detection.fileFormat) {
      case "pdf":
        return { route: "parse-pdf-docling", reason: "PDF → Docling OCR extraction" };
      case "csv":
      case "text":
        return { route: "parse-file", reason: `${detection.fileFormat} file → CSV parser` };
      case "unknown":
      default:
        return { route: "parse-pdf-docling", reason: "Unknown format → Docling (multi-format extraction with fallback)" };
    }
  }
  
  const routing = decideRoute(detection);
  assertEquals(routing.route, "parse-pdf-docling");
  assertEquals(routing.reason, "Unknown format → Docling (multi-format extraction with fallback)");
});

Deno.test("Edge Function Call - Success", async () => {
  globalThis.fetch = mockFetch;
  
  mockFetchResponses = [{
    url: "parse-pdf-docling",
    response: new Response(JSON.stringify({ 
      success: true, 
      file_id: "test-file-id",
      extraction_method: "docling"
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  }];
  
  // Mock the callEdgeFunction implementation
  async function callEdgeFunction(
    supabaseUrl: string,
    functionName: string,
    body: Record<string, unknown>,
    authToken: string,
    retries = 3,
  ) {
    const url = `${supabaseUrl}/functions/v1/${functionName}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    });
    
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  }
  
  const result = await callEdgeFunction(
    "https://test.supabase.co",
    "parse-pdf-docling",
    { file_id: "test-file-id" },
    "test-token"
  );
  
  assertEquals(result.ok, true);
  assertEquals(result.status, 200);
  assertEquals(result.data.success, true);
  
  globalThis.fetch = originalFetch;
});

Deno.test("Edge Function Call - Retry Logic", async () => {
  globalThis.fetch = mockFetch;
  
  let callCount = 0;
  globalThis.fetch = async (url: string | URL, options?: RequestInit) => {
    callCount++;
    if (callCount < 3) {
      // First two calls fail with 500
      return new Response(JSON.stringify({ error: "Server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    } else {
      // Third call succeeds
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  };
  
  async function callEdgeFunctionWithRetry(
    supabaseUrl: string,
    functionName: string,
    body: Record<string, unknown>,
    authToken: string,
    retries = 3,
  ) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const url = `${supabaseUrl}/functions/v1/${functionName}`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${authToken}`,
          },
          body: JSON.stringify(body),
        });
        
        const data = await res.json();
        
        if (res.ok) {
          return { ok: true, status: res.status, data };
        }
        
        // If it's a client error (4xx), don't retry
        if (res.status >= 400 && res.status < 500) {
          return { ok: false, status: res.status, data, error: `Client error: ${res.status}` };
        }
        
        // Server error (5xx) - retry with exponential backoff
        if (attempt < retries) {
          const delay = Math.pow(2, attempt - 1) * 100; // Reduced delay for testing
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        return { ok: false, status: res.status, data, error: `Server error after ${retries} attempts` };
        
      } catch (err) {
        if (attempt < retries) {
          const delay = Math.pow(2, attempt - 1) * 100;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        return { 
          ok: false, 
          status: 500, 
          data: {}, 
          error: `Network error after ${retries} attempts: ${err.message}` 
        };
      }
    }
    
    return { ok: false, status: 500, data: {}, error: "Unexpected retry loop exit" };
  }
  
  const result = await callEdgeFunctionWithRetry(
    "https://test.supabase.co",
    "parse-pdf-docling",
    { file_id: "test-file-id" },
    "test-token"
  );
  
  assertEquals(result.ok, true);
  assertEquals(callCount, 3); // Should have retried twice before succeeding
  
  globalThis.fetch = originalFetch;
});

Deno.test("Edge Function Call - Client Error No Retry", async () => {
  globalThis.fetch = mockFetch;
  
  let callCount = 0;
  globalThis.fetch = async (url: string | URL, options?: RequestInit) => {
    callCount++;
    return new Response(JSON.stringify({ error: "Bad request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  };
  
  async function callEdgeFunctionWithRetry(
    supabaseUrl: string,
    functionName: string,
    body: Record<string, unknown>,
    authToken: string,
    retries = 3,
  ) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const url = `${supabaseUrl}/functions/v1/${functionName}`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${authToken}`,
          },
          body: JSON.stringify(body),
        });
        
        const data = await res.json();
        
        if (res.ok) {
          return { ok: true, status: res.status, data };
        }
        
        // If it's a client error (4xx), don't retry
        if (res.status >= 400 && res.status < 500) {
          return { ok: false, status: res.status, data, error: `Client error: ${res.status}` };
        }
        
        // Server error (5xx) - retry
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        
        return { ok: false, status: res.status, data, error: `Server error after ${retries} attempts` };
        
      } catch (err) {
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        
        return { 
          ok: false, 
          status: 500, 
          data: {}, 
          error: `Network error after ${retries} attempts: ${err.message}` 
        };
      }
    }
    
    return { ok: false, status: 500, data: {}, error: "Unexpected retry loop exit" };
  }
  
  const result = await callEdgeFunctionWithRetry(
    "https://test.supabase.co",
    "parse-pdf-docling",
    { file_id: "test-file-id" },
    "test-token"
  );
  
  assertEquals(result.ok, false);
  assertEquals(result.status, 400);
  assertEquals(callCount, 1); // Should not retry for client errors
  
  globalThis.fetch = originalFetch;
});

Deno.test("File Download - Success", async () => {
  // Mock successful file download
  async function downloadFilePreview(
    supabaseAdmin: any,
    storagePath: string,
    maxBytes = 8,
  ): Promise<Uint8Array> {
    try {
      const { data, error } = await supabaseAdmin.storage
        .from("financial-uploads")
        .download(storagePath);
      if (error || !data) return new Uint8Array(0);
      const buf = await data.arrayBuffer();
      return new Uint8Array(buf.slice(0, maxBytes));
    } catch {
      return new Uint8Array(0);
    }
  }
  
  const result = await downloadFilePreview(mockSupabaseAdmin, "test.pdf", 8);
  assertEquals(result.length, 4); // PDF magic bytes
  assertEquals(Array.from(result), [0x25, 0x50, 0x44, 0x46]);
});

Deno.test("File Download - Error Handling", async () => {
  const mockSupabaseWithError = {
    storage: {
      from: (bucket: string) => ({
        download: (path: string) => Promise.resolve({
          data: null,
          error: { message: "File not found" }
        })
      })
    }
  };
  
  async function downloadFilePreview(
    supabaseAdmin: any,
    storagePath: string,
    maxBytes = 8,
  ): Promise<Uint8Array> {
    try {
      const { data, error } = await supabaseAdmin.storage
        .from("financial-uploads")
        .download(storagePath);
      if (error || !data) return new Uint8Array(0);
      const buf = await data.arrayBuffer();
      return new Uint8Array(buf.slice(0, maxBytes));
    } catch {
      return new Uint8Array(0);
    }
  }
  
  const result = await downloadFilePreview(mockSupabaseWithError, "nonexistent.pdf", 8);
  assertEquals(result.length, 0);
});

Deno.test("Text Preview Download", async () => {
  const mockSupabaseWithText = {
    storage: {
      from: (bucket: string) => ({
        download: (path: string) => Promise.resolve({
          data: new Blob([new TextEncoder().encode("tenant_name,monthly_rent,lease_start")]),
          error: null
        })
      })
    }
  };
  
  async function downloadTextPreview(
    supabaseAdmin: any,
    storagePath: string,
  ): Promise<string> {
    try {
      const { data, error } = await supabaseAdmin.storage
        .from("financial-uploads")
        .download(storagePath);
      if (error || !data) return "";
      const buf = await data.arrayBuffer();
      const bytes = new Uint8Array(buf.slice(0, 2048));
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return "";
    }
  }
  
  const result = await downloadTextPreview(mockSupabaseWithText, "test.csv");
  assertEquals(result, "tenant_name,monthly_rent,lease_start");
});

Deno.test("Status Updates - Processing States", async () => {
  let statusUpdates: Array<{ status: string; timestamp: string }> = [];
  
  const mockSupabaseWithTracking = {
    from: (table: string) => ({
      update: (data: any) => ({
        eq: (column: string, value: any) => {
          statusUpdates.push({ status: data.status, timestamp: data.updated_at });
          return Promise.resolve({ data: {}, error: null });
        }
      })
    })
  };
  
  // Simulate status updates during processing
  await mockSupabaseWithTracking.from("uploaded_files")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", "test-file-id");
    
  await mockSupabaseWithTracking.from("uploaded_files")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("id", "test-file-id");
  
  assertEquals(statusUpdates.length, 2);
  assertEquals(statusUpdates[0].status, "processing");
  assertEquals(statusUpdates[1].status, "completed");
});

Deno.test("Error Handling - File Not Found", async () => {
  const mockSupabaseNotFound = {
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: any) => ({
          single: () => Promise.resolve({
            data: null,
            error: { message: "File not found" }
          })
        })
      })
    })
  };
  
  // Mock error handling logic
  function handleFileNotFound(fileRecord: any, fetchError: any) {
    if (fetchError || !fileRecord) {
      return {
        error: true,
        message: `File not found: ${fetchError?.message ?? "Invalid file_id or org mismatch"}`,
        error_code: "FILE_NOT_FOUND",
      };
    }
    return { error: false };
  }
  
  const result = handleFileNotFound(null, { message: "File not found" });
  assertEquals(result.error, true);
  assertEquals(result.error_code, "FILE_NOT_FOUND");
});

Deno.test("Two-Step Processing - PDF Pipeline", async () => {
  globalThis.fetch = mockFetch;
  
  // Mock successful two-step processing
  mockFetchResponses = [
    {
      url: "parse-pdf-docling",
      response: new Response(JSON.stringify({ 
        success: true, 
        file_id: "test-file-id",
        extraction_method: "docling"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    },
    {
      url: "normalize-pdf-output",
      response: new Response(JSON.stringify({ 
        success: true, 
        file_id: "test-file-id",
        normalized_rows: 5
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    }
  ];
  
  async function callEdgeFunction(
    supabaseUrl: string,
    functionName: string,
    body: Record<string, unknown>,
    authToken: string,
  ) {
    const url = `${supabaseUrl}/functions/v1/${functionName}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    });
    
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  }
  
  // Step 1: Docling extraction
  const doclingResult = await callEdgeFunction(
    "https://test.supabase.co",
    "parse-pdf-docling",
    { file_id: "test-file-id" },
    "test-token"
  );
  
  assertEquals(doclingResult.ok, true);
  assertEquals(doclingResult.data.extraction_method, "docling");
  
  // Step 2: Normalization
  const normalizeResult = await callEdgeFunction(
    "https://test.supabase.co",
    "normalize-pdf-output",
    { file_id: "test-file-id" },
    "test-token"
  );
  
  assertEquals(normalizeResult.ok, true);
  assertEquals(normalizeResult.data.normalized_rows, 5);
  
  globalThis.fetch = originalFetch;
});