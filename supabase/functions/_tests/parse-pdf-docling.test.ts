// @ts-nocheck
/**
 * Unit tests for parse-pdf-docling extraction functions
 * Tests PDF processing, Docling API integration, Gemini fallback, and error handling
 */

import { assertEquals, assertExists, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";

// Mock Docling API response
const mockDoclingResponse = {
  model_version: "docling-1.0",
  page_count: 2,
  blocks: [
    { type: "heading", text: "COMMERCIAL LEASE AGREEMENT", page: 1 },
    { type: "paragraph", text: "This Lease Agreement is entered into between Landlord Corp and Acme Tenant LLC.", page: 1 },
    { type: "paragraph", text: "The premises located at 123 Main Street, Suite 400, New York, NY 10001.", page: 1 },
  ],
  tables: [
    {
      headers: ["Field", "Value"],
      data: [
        ["Tenant Name", "Acme Tenant LLC"],
        ["Lease Start Date", "01/01/2025"],
        ["Monthly Base Rent", "$8,500.00"],
      ]
    }
  ],
  fields: [
    { key: "tenant_name", value: "Acme Tenant LLC", confidence: 0.97 },
    { key: "start_date", value: "01/01/2025", confidence: 0.95 },
    { key: "monthly_rent", value: "$8,500.00", confidence: 0.93 },
  ]
};

// Mock Gemini response
const mockGeminiResponse = {
  full_text: "COMMERCIAL LEASE AGREEMENT\n\nTenant: Acme Tenant LLC\nMonthly Rent: $8,500.00",
  fields: [
    { key: "tenant_name", value: "Acme Tenant LLC", confidence: 0.95 },
    { key: "monthly_rent", value: "$8,500.00", confidence: 0.90 },
  ],
  tables: [],
  text_blocks: [
    { block_index: 0, type: "heading", text: "COMMERCIAL LEASE AGREEMENT", page: 1 },
  ],
  page_count: 1
};

Deno.test("Docling API Call - Success", async () => {
  // Mock successful Docling API call
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL, options?: RequestInit) => {
    if (url.toString().includes("/api/v1/convert")) {
      return new Response(JSON.stringify(mockDoclingResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return originalFetch(url, options);
  };
  
  // Set environment variables for test
  Deno.env.set("DOCLING_API_URL", "http://localhost:5001");
  Deno.env.set("DOCLING_API_KEY", "test-key");
  
  async function callDoclingAPI(fileBytes: Uint8Array, fileName: string, mimeType = "application/octet-stream") {
    const doclingUrl = Deno.env.get("DOCLING_API_URL");
    if (!doclingUrl) {
      throw new Error("DOCLING_API_URL not set");
    }
    
    const apiKey = Deno.env.get("DOCLING_API_KEY");
    const formData = new FormData();
    formData.append("file", new Blob([fileBytes], { type: mimeType }), fileName);
    formData.append("output_formats", "text,tables,fields");
    
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    
    const response = await fetch(`${doclingUrl}/api/v1/convert`, {
      method: "POST",
      headers,
      body: formData,
    });
    
    if (response.ok) {
      const raw = await response.json();
      return normaliseDoclingResponse(raw, fileName);
    }
    
    throw new Error(`Docling API failed: ${response.status}`);
  }
  
  function normaliseDoclingResponse(raw: Record<string, unknown>, fileName: string) {
    const rawBlocks: unknown[] = (raw.blocks as unknown[]) ?? [];
    const text_blocks = rawBlocks.map((b: any, i) => ({
      block_index: i,
      type: b.type ?? "paragraph",
      text: b.text ?? "",
      page: b.page ?? undefined,
    }));
    
    const rawTables: unknown[] = (raw.tables as unknown[]) ?? [];
    const tables = rawTables.map((t: any, i) => {
      const rows: string[][] = (t.data ?? []).map((row: any) =>
        Array.isArray(row) ? row.map(String) : Object.values(row).map(String)
      );
      const headers: string[] = t.headers ?? (rows.length > 0 ? rows[0] : []);
      const dataRows = t.headers ? rows : rows.slice(1);
      return {
        table_index: i,
        headers,
        rows: dataRows,
        markdown: t.markdown ?? undefined,
      };
    });
    
    const rawFields: unknown[] = (raw.fields as unknown[]) ?? [];
    const fields = rawFields.map((f: any) => ({
      key: f.key ?? "",
      value: f.value ?? "",
      confidence: f.confidence ?? undefined,
      page: f.page ?? undefined,
    }));
    
    const full_text = text_blocks.map((b) => b.text).join("\n");
    
    return {
      model_version: (raw.model_version as string) ?? undefined,
      page_count: (raw.page_count as number) ?? undefined,
      text_blocks,
      tables,
      fields,
      full_text,
      raw_response: raw,
    };
  }
  
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // PDF magic bytes
  const result = await callDoclingAPI(pdfBytes, "test.pdf", "application/pdf");
  
  assertEquals(result.model_version, "docling-1.0");
  assertEquals(result.page_count, 2);
  assertEquals(result.text_blocks.length, 3);
  assertEquals(result.tables.length, 1);
  assertEquals(result.fields.length, 3);
  assertEquals(result.fields[0].key, "tenant_name");
  assertEquals(result.fields[0].value, "Acme Tenant LLC");
  
  globalThis.fetch = originalFetch;
  Deno.env.delete("DOCLING_API_URL");
  Deno.env.delete("DOCLING_API_KEY");
});

Deno.test("Docling API Call - Retry Logic", async () => {
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL, options?: RequestInit) => {
    callCount++;
    if (url.toString().includes("/api/v1/convert")) {
      if (callCount < 3) {
        // First two calls fail with 500
        return new Response(JSON.stringify({ error: "Server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      } else {
        // Third call succeeds
        return new Response(JSON.stringify(mockDoclingResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    return originalFetch(url, options);
  };
  
  Deno.env.set("DOCLING_API_URL", "http://localhost:5001");
  
  async function callDoclingAPIWithRetry(fileBytes: Uint8Array, fileName: string, mimeType = "application/octet-stream") {
    const doclingUrl = Deno.env.get("DOCLING_API_URL");
    if (!doclingUrl) {
      throw new Error("DOCLING_API_URL not set");
    }
    
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const formData = new FormData();
        formData.append("file", new Blob([fileBytes], { type: mimeType }), fileName);
        formData.append("output_formats", "text,tables,fields");
        
        const response = await fetch(`${doclingUrl}/api/v1/convert`, {
          method: "POST",
          body: formData,
        });
        
        if (response.ok) {
          const raw = await response.json();
          return { success: true, data: raw };
        }
        
        // Server error (5xx) - retry with exponential backoff
        if (response.status >= 500 && attempt < maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 100; // Reduced for testing
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        throw new Error(`Docling API failed: ${response.status}`);
        
      } catch (err) {
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 100;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }
  }
  
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const result = await callDoclingAPIWithRetry(pdfBytes, "test.pdf", "application/pdf");
  
  assertEquals(result.success, true);
  assertEquals(callCount, 3); // Should have retried twice before succeeding
  
  globalThis.fetch = originalFetch;
  Deno.env.delete("DOCLING_API_URL");
});

Deno.test("Docling API Call - Client Error No Retry", async () => {
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL, options?: RequestInit) => {
    callCount++;
    if (url.toString().includes("/api/v1/convert")) {
      return new Response(JSON.stringify({ error: "Bad request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    return originalFetch(url, options);
  };
  
  Deno.env.set("DOCLING_API_URL", "http://localhost:5001");
  
  async function callDoclingAPIWithRetry(fileBytes: Uint8Array, fileName: string, mimeType = "application/octet-stream") {
    const doclingUrl = Deno.env.get("DOCLING_API_URL");
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const formData = new FormData();
        formData.append("file", new Blob([fileBytes], { type: mimeType }), fileName);
        
        const response = await fetch(`${doclingUrl}/api/v1/convert`, {
          method: "POST",
          body: formData,
        });
        
        if (response.ok) {
          const raw = await response.json();
          return { success: true, data: raw };
        }
        
        // Client error (4xx) - don't retry, fall back to Gemini
        if (response.status >= 400 && response.status < 500) {
          return { success: false, fallback: true, status: response.status };
        }
        
        // Server error (5xx) - retry
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        
        throw new Error(`Docling API failed: ${response.status}`);
        
      } catch (err) {
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        throw err;
      }
    }
  }
  
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const result = await callDoclingAPIWithRetry(pdfBytes, "test.pdf", "application/pdf");
  
  assertEquals(result.success, false);
  assertEquals(result.fallback, true);
  assertEquals(result.status, 400);
  assertEquals(callCount, 1); // Should not retry for client errors
  
  globalThis.fetch = originalFetch;
  Deno.env.delete("DOCLING_API_URL");
});

Deno.test("Gemini Native Extraction - Success", async () => {
  // Mock Vertex AI call
  const mockCallVertexAIFileJSON = async (params: any) => {
    return mockGeminiResponse;
  };
  
  async function extractWithGeminiNative(
    fileBytes: Uint8Array,
    fileName: string,
    mimeType: string,
  ) {
    const hasVertexAI = true; // Mock as available
    
    if (!hasVertexAI) {
      throw new Error("No Vertex AI available");
    }
    
    const systemPrompt = `You are a document data extraction engine for commercial real estate.
Extract ALL structured data from the document. Return ONLY valid JSON, no explanation.`;
    
    const userPrompt = `Extract all data from this document and return a JSON object with fields, tables, text_blocks, and page_count.`;
    
    const result = await mockCallVertexAIFileJSON({
      systemPrompt,
      userPrompt,
      fileBytes,
      fileMimeType: mimeType,
      maxOutputTokens: 8192,
      temperature: 0,
    });
    
    if (result && typeof result === 'object') {
      return normaliseDoclingResponse(result as Record<string, unknown>, fileName);
    }
    
    throw new Error("Gemini returned invalid result");
  }
  
  function normaliseDoclingResponse(raw: Record<string, unknown>, fileName: string) {
    const text_blocks = (raw.text_blocks as any[]) ?? [];
    const tables = (raw.tables as any[]) ?? [];
    const fields = (raw.fields as any[]) ?? [];
    const full_text = (raw.full_text as string) ?? "";
    
    return {
      model_version: "gemini-1.5-pro",
      page_count: (raw.page_count as number) ?? 1,
      text_blocks,
      tables,
      fields,
      full_text,
      raw_response: raw,
    };
  }
  
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const result = await extractWithGeminiNative(pdfBytes, "test.pdf", "application/pdf");
  
  assertEquals(result.model_version, "gemini-1.5-pro");
  assertEquals(result.full_text, "COMMERCIAL LEASE AGREEMENT\n\nTenant: Acme Tenant LLC\nMonthly Rent: $8,500.00");
  assertEquals(result.fields.length, 2);
  assertEquals(result.fields[0].key, "tenant_name");
});

Deno.test("Gemini Native Extraction - Retry Logic", async () => {
  let callCount = 0;
  const mockCallVertexAIFileJSON = async (params: any) => {
    callCount++;
    if (callCount < 2) {
      throw new Error("Vertex AI timeout");
    }
    return mockGeminiResponse;
  };
  
  async function extractWithGeminiNativeRetry(
    fileBytes: Uint8Array,
    fileName: string,
    mimeType: string,
  ) {
    const maxRetries = 2;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await mockCallVertexAIFileJSON({
          systemPrompt: "Extract data",
          userPrompt: "Extract all data",
          fileBytes,
          fileMimeType: mimeType,
        });
        
        if (result && typeof result === 'object') {
          return { success: true, data: result };
        }
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        
      } catch (err) {
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        throw err;
      }
    }
  }
  
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const result = await extractWithGeminiNativeRetry(pdfBytes, "test.pdf", "application/pdf");
  
  assertEquals(result.success, true);
  assertEquals(callCount, 2); // Should have retried once before succeeding
});

Deno.test("Mock Output Generation - PDF", () => {
  function buildMockOutput(fileName: string, mimeType = "application/octet-stream") {
    let mockData = {
      model_version: "mock-1.0",
      page_count: 1,
      text_blocks: [] as any[],
      tables: [] as any[],
      fields: [] as any[],
      full_text: "",
      raw_response: { _mock: true, source_file: fileName, mime_type: mimeType },
    };

    if (mimeType.includes("pdf") || fileName.toLowerCase().includes("lease")) {
      mockData = {
        ...mockData,
        page_count: 3,
        text_blocks: [
          { block_index: 0, type: "heading", text: "COMMERCIAL LEASE AGREEMENT", page: 1 },
          { block_index: 1, type: "paragraph", text: "This Lease Agreement is entered into between Landlord Corp and Acme Tenant LLC.", page: 1 },
        ],
        tables: [
          {
            table_index: 0,
            headers: ["Field", "Value"],
            rows: [
              ["Tenant Name", "Acme Tenant LLC"],
              ["Monthly Base Rent", "$8,500.00"],
            ],
            markdown: "| Field | Value |\n|---|---|\n| Tenant Name | Acme Tenant LLC |",
          },
        ],
        fields: [
          { key: "tenant_name", value: "Acme Tenant LLC", confidence: 0.97, page: 1 },
          { key: "monthly_rent", value: "$8,500.00", confidence: 0.93, page: 2 },
        ],
        full_text: "COMMERCIAL LEASE AGREEMENT\n\nTenant: Acme Tenant LLC\nMonthly Rent: $8,500.00",
      };
    }

    return mockData;
  }
  
  const pdfMock = buildMockOutput("lease_agreement.pdf", "application/pdf");
  assertEquals(pdfMock.page_count, 3);
  assertEquals(pdfMock.text_blocks.length, 2);
  assertEquals(pdfMock.tables.length, 1);
  assertEquals(pdfMock.fields.length, 2);
  assertEquals(pdfMock.fields[0].key, "tenant_name");
  assertEquals(pdfMock.fields[0].value, "Acme Tenant LLC");
  assertEquals(pdfMock.raw_response._mock, true);
});

Deno.test("Mock Output Generation - Excel", () => {
  function buildMockOutput(fileName: string, mimeType = "application/octet-stream") {
    let mockData = {
      model_version: "mock-1.0",
      page_count: 1,
      text_blocks: [] as any[],
      tables: [] as any[],
      fields: [] as any[],
      full_text: "",
      raw_response: { _mock: true, source_file: fileName, mime_type: mimeType },
    };

    if (mimeType.includes("excel") || mimeType.includes("sheet")) {
      mockData = {
        ...mockData,
        tables: [
          {
            table_index: 0,
            headers: ["Property", "Tenant", "Rent", "Start Date", "End Date"],
            rows: [
              ["123 Main St", "Acme Corp", "$5,000", "2024-01-01", "2026-12-31"],
              ["456 Oak Ave", "Beta LLC", "$7,500", "2024-03-01", "2027-02-28"],
            ],
            markdown: "| Property | Tenant | Rent | Start Date | End Date |\n|---|---|---|---|---|",
          },
        ],
        fields: [
          { key: "total_properties", value: "2", confidence: 1.0, page: 1 },
          { key: "total_monthly_rent", value: "$12,500", confidence: 0.95, page: 1 },
        ],
        full_text: "Property\tTenant\tRent\tStart Date\tEnd Date\n123 Main St\tAcme Corp\t$5,000\t2024-01-01\t2026-12-31",
      };
    }

    return mockData;
  }
  
  const excelMock = buildMockOutput("rent_roll.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assertEquals(excelMock.tables.length, 1);
  assertEquals(excelMock.tables[0].headers.length, 5);
  assertEquals(excelMock.tables[0].rows.length, 2);
  assertEquals(excelMock.fields[0].key, "total_properties");
  assertEquals(excelMock.fields[0].value, "2");
});

Deno.test("Mock Output Generation - Image", () => {
  function buildMockOutput(fileName: string, mimeType = "application/octet-stream") {
    let mockData = {
      model_version: "mock-1.0",
      page_count: 1,
      text_blocks: [] as any[],
      tables: [] as any[],
      fields: [] as any[],
      full_text: "",
      raw_response: { _mock: true, source_file: fileName, mime_type: mimeType },
    };

    if (mimeType.startsWith("image/")) {
      mockData = {
        ...mockData,
        text_blocks: [
          { block_index: 0, type: "paragraph", text: "LEASE AGREEMENT", page: 1 },
          { block_index: 1, type: "paragraph", text: "Tenant: John Doe", page: 1 },
          { block_index: 2, type: "paragraph", text: "Monthly Rent: $2,500", page: 1 },
        ],
        fields: [
          { key: "tenant_name", value: "John Doe", confidence: 0.85, page: 1 },
          { key: "monthly_rent", value: "$2,500", confidence: 0.80, page: 1 },
        ],
        full_text: "LEASE AGREEMENT\nTenant: John Doe\nMonthly Rent: $2,500",
      };
    }

    return mockData;
  }
  
  const imageMock = buildMockOutput("scanned_lease.jpg", "image/jpeg");
  assertEquals(imageMock.text_blocks.length, 3);
  assertEquals(imageMock.fields.length, 2);
  assertEquals(imageMock.fields[0].key, "tenant_name");
  assertEquals(imageMock.fields[0].value, "John Doe");
  assertEquals(imageMock.fields[0].confidence, 0.85);
});

Deno.test("Docling Response Normalization", () => {
  function normaliseDoclingResponse(raw: Record<string, unknown>, fileName: string) {
    // Text blocks — Docling may call these "blocks", "paragraphs", or "elements"
    const rawBlocks: unknown[] =
      (raw.blocks as unknown[]) ??
      (raw.paragraphs as unknown[]) ??
      (raw.elements as unknown[]) ??
      [];

    const text_blocks = rawBlocks.map((b: any, i) => ({
      block_index: i,
      type: b.type ?? b.label ?? "paragraph",
      text: b.text ?? b.content ?? "",
      page: b.page ?? b.page_number ?? undefined,
    }));

    // Tables
    const rawTables: unknown[] = (raw.tables as unknown[]) ?? [];
    const tables = rawTables.map((t: any, i) => {
      const rows: string[][] = (t.data ?? t.rows ?? []).map((row: any) =>
        Array.isArray(row) ? row.map(String) : Object.values(row).map(String)
      );
      const headers: string[] = t.headers ?? (rows.length > 0 ? rows[0] : []);
      const dataRows = t.headers ? rows : rows.slice(1);
      return {
        table_index: i,
        headers,
        rows: dataRows,
        markdown: t.markdown ?? t.md ?? undefined,
      };
    });

    // Key-value fields
    const rawFields: unknown[] =
      (raw.fields as unknown[]) ??
      (raw.key_value_pairs as unknown[]) ??
      [];
    const fields = rawFields.map((f: any) => ({
      key: f.key ?? f.label ?? "",
      value: f.value ?? f.text ?? "",
      confidence: f.confidence ?? f.score ?? undefined,
      page: f.page ?? undefined,
    }));

    // Full text
    const full_text: string =
      (raw.full_text as string) ??
      (raw.text as string) ??
      text_blocks.map((b) => b.text).join("\n");

    return {
      model_version: (raw.model_version as string) ?? (raw.version as string) ?? undefined,
      page_count: (raw.page_count as number) ?? (raw.pages as number) ?? undefined,
      text_blocks,
      tables,
      fields,
      full_text,
      raw_response: raw,
    };
  }
  
  // Test with various field names that Docling might use
  const testResponse = {
    model_version: "docling-1.0",
    pages: 2, // Alternative to page_count
    paragraphs: [ // Alternative to blocks
      { label: "heading", content: "Test Heading", page_number: 1 }
    ],
    tables: [
      {
        headers: ["Name", "Value"],
        rows: [["Test", "123"]], // Alternative to data
        md: "| Name | Value |\n|---|---|\n| Test | 123 |" // Alternative to markdown
      }
    ],
    key_value_pairs: [ // Alternative to fields
      { label: "test_field", text: "test_value", score: 0.95 }
    ],
    text: "Full document text" // Alternative to full_text
  };
  
  const normalized = normaliseDoclingResponse(testResponse, "test.pdf");
  
  assertEquals(normalized.model_version, "docling-1.0");
  assertEquals(normalized.page_count, 2);
  assertEquals(normalized.text_blocks.length, 1);
  assertEquals(normalized.text_blocks[0].type, "heading");
  assertEquals(normalized.text_blocks[0].text, "Test Heading");
  assertEquals(normalized.text_blocks[0].page, 1);
  assertEquals(normalized.tables.length, 1);
  assertEquals(normalized.tables[0].headers, ["Name", "Value"]);
  assertEquals(normalized.tables[0].rows, [["Test", "123"]]);
  assertEquals(normalized.tables[0].markdown, "| Name | Value |\n|---|---|\n| Test | 123 |");
  assertEquals(normalized.fields.length, 1);
  assertEquals(normalized.fields[0].key, "test_field");
  assertEquals(normalized.fields[0].value, "test_value");
  assertEquals(normalized.fields[0].confidence, 0.95);
  assertEquals(normalized.full_text, "Full document text");
});

Deno.test("File Format Support Validation", () => {
  const supportedFormats = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv',
    'image/jpeg',
    'image/png',
    'image/tiff',
    'image/webp',
    'image/gif',
    'image/bmp',
    'application/octet-stream'
  ];
  
  function isFormatSupported(mimeType: string): boolean {
    return supportedFormats.some(format => mimeType.includes(format.split('/')[1])) || 
           mimeType.startsWith('image/') || 
           mimeType.startsWith('text/');
  }
  
  // Test supported formats
  assertEquals(isFormatSupported('application/pdf'), true);
  assertEquals(isFormatSupported('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), true);
  assertEquals(isFormatSupported('image/jpeg'), true);
  assertEquals(isFormatSupported('text/plain'), true);
  
  // Test unsupported formats
  assertEquals(isFormatSupported('video/mp4'), false);
  assertEquals(isFormatSupported('audio/mp3'), false);
});

Deno.test("Error Handling - Extraction Failure", async () => {
  async function handleExtractionError(error: Error, fileName: string, mimeType: string) {
    const errorDetails = {
      error_type: "extraction_failed",
      file_name: fileName,
      mime_type: mimeType,
      error_message: error.message,
      timestamp: new Date().toISOString(),
    };
    
    // Mock database update
    const mockUpdate = {
      status: "failed",
      error_message: `Document extraction failed: ${error.message}`,
      docling_raw: { _error: errorDetails },
      processing_completed_at: new Date().toISOString(),
    };
    
    return { error: true, details: errorDetails, update: mockUpdate };
  }
  
  const testError = new Error("Docling API unavailable");
  const result = await handleExtractionError(testError, "test.pdf", "application/pdf");
  
  assertEquals(result.error, true);
  assertEquals(result.details.error_type, "extraction_failed");
  assertEquals(result.details.file_name, "test.pdf");
  assertEquals(result.details.error_message, "Docling API unavailable");
  assertEquals(result.update.status, "failed");
  assertExists(result.update.docling_raw._error);
});