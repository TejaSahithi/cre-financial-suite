// @ts-nocheck
/**
 * Unit tests for file-detector.ts
 * Tests file format detection, module type detection, and confidence scoring
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { detectFileType, type DetectionResult, type FileFormat, type ModuleType } from "../_shared/file-detector.ts";

Deno.test("File Format Detection - MIME Type Priority", () => {
  // Test MIME type detection (highest priority)
  const pdfResult = detectFileType({
    mimeType: "application/pdf",
    fileName: "document.pdf",
    fileBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF magic bytes
  });
  
  assertEquals(pdfResult.fileFormat, "pdf");
  assertEquals(pdfResult.formatSource, "mime");
  assertEquals(pdfResult.confidence > 0.8, true);
});

Deno.test("File Format Detection - Magic Bytes Override", () => {
  // Test magic bytes override generic MIME type
  const xlsxResult = detectFileType({
    mimeType: "application/octet-stream", // Generic MIME
    fileName: "spreadsheet.xlsx",
    fileBytes: new Uint8Array([0x50, 0x4B, 0x03, 0x04]), // ZIP magic bytes (XLSX)
  });
  
  assertEquals(xlsxResult.fileFormat, "xlsx");
  assertEquals(xlsxResult.formatSource, "magic_bytes");
});

Deno.test("File Format Detection - Extension Fallback", () => {
  // Test extension fallback when no MIME or magic bytes
  const csvResult = detectFileType({
    fileName: "data.csv",
  });
  
  assertEquals(csvResult.fileFormat, "csv");
  assertEquals(csvResult.formatSource, "extension");
});

Deno.test("File Format Detection - Magic Bytes Comprehensive", () => {
  const testCases = [
    { bytes: [0x25, 0x50, 0x44, 0x46], expected: "pdf" }, // %PDF
    { bytes: [0x50, 0x4B, 0x03, 0x04], expected: "xlsx" }, // ZIP (XLSX/DOCX)
    { bytes: [0xD0, 0xCF, 0x11, 0xE0], expected: "xls" }, // Compound doc (XLS/DOC)
    { bytes: [0xFF, 0xD8, 0xFF], expected: "image" }, // JPEG
    { bytes: [0x89, 0x50, 0x4E, 0x47], expected: "image" }, // PNG
    { bytes: [0x47, 0x49, 0x46, 0x38], expected: "image" }, // GIF
    { bytes: [0x49, 0x49, 0x2A, 0x00], expected: "image" }, // TIFF LE
    { bytes: [0x4D, 0x4D, 0x00, 0x2A], expected: "image" }, // TIFF BE
    { bytes: [0x42, 0x4D], expected: "image" }, // BMP
    { bytes: [0xEF, 0xBB, 0xBF], expected: "csv" }, // UTF-8 BOM
  ];

  testCases.forEach(({ bytes, expected }) => {
    const result = detectFileType({
      fileBytes: new Uint8Array(bytes),
    });
    assertEquals(result.fileFormat, expected, `Failed for bytes: ${bytes.map(b => b.toString(16)).join(' ')}`);
    assertEquals(result.formatSource, "magic_bytes");
  });
});

Deno.test("File Format Detection - Format Refinement", () => {
  // Test XLSX vs DOCX refinement based on extension
  const docxResult = detectFileType({
    fileName: "document.docx",
    fileBytes: new Uint8Array([0x50, 0x4B, 0x03, 0x04]), // ZIP magic bytes
  });
  
  assertEquals(docxResult.fileFormat, "docx");
  
  // Test XLS vs DOC refinement
  const docResult = detectFileType({
    fileName: "document.doc",
    fileBytes: new Uint8Array([0xD0, 0xCF, 0x11, 0xE0]), // Compound doc magic bytes
  });
  
  assertEquals(docResult.fileFormat, "doc");
});

Deno.test("File Format Detection - Content-Based Fallback", () => {
  // Test CSV detection from content
  const csvContent = 'name,email,phone\n"John Doe","john@example.com","555-1234"\n"Jane Smith","jane@example.com","555-5678"';
  const csvResult = detectFileType({
    fileName: "unknown",
    contentPreview: csvContent,
  });
  
  assertEquals(csvResult.fileFormat, "csv");
  assertEquals(csvResult.formatSource, "fallback");
  
  // Test tab-separated content
  const tsvContent = "name\temail\tphone\nJohn Doe\tjohn@example.com\t555-1234";
  const tsvResult = detectFileType({
    fileName: "unknown",
    contentPreview: tsvContent,
  });
  
  assertEquals(tsvResult.fileFormat, "text");
  assertEquals(tsvResult.formatSource, "fallback");
});

Deno.test("Module Type Detection - Explicit Priority", () => {
  const result = detectFileType({
    fileName: "property_data.csv",
    explicitModuleType: "leases", // Should override filename keywords
  });
  
  assertEquals(result.moduleType, "leases");
  assertEquals(result.moduleSource, "explicit");
  assertEquals(result.confidence, 1.0); // Explicit should have max confidence
});

Deno.test("Module Type Detection - Filename Keywords", () => {
  const testCases = [
    { fileName: "lease_agreement.pdf", expected: "leases" },
    { fileName: "tenant_list.xlsx", expected: "leases" },
    { fileName: "property_portfolio.csv", expected: "properties" },
    { fileName: "building_data.txt", expected: "properties" },
    { fileName: "expense_report.pdf", expected: "expenses" },
    { fileName: "vendor_invoices.xlsx", expected: "expenses" },
    { fileName: "revenue_summary.csv", expected: "revenue" },
    { fileName: "income_statement.pdf", expected: "revenue" },
    { fileName: "cam_reconciliation.xlsx", expected: "cam" },
    { fileName: "budget_forecast.csv", expected: "budgets" },
  ];

  testCases.forEach(({ fileName, expected }) => {
    const result = detectFileType({ fileName });
    assertEquals(result.moduleType, expected, `Failed for filename: ${fileName}`);
    assertEquals(result.moduleSource, "filename_keyword");
  });
});

Deno.test("Module Type Detection - Content Keywords", () => {
  const testCases = [
    {
      content: "tenant_name,monthly_rent,lease_start,commencement_date",
      expected: "leases"
    },
    {
      content: "property_name,address,square_footage,property_type",
      expected: "properties"
    },
    {
      content: "expense_category,vendor,gl_code,classification,recoverable",
      expected: "expenses"
    },
    {
      content: "revenue_type,income_type,cam_recovery,base_rent",
      expected: "revenue"
    },
    {
      content: "cam_calculation,cam_per_sf,admin_fee,gross_up",
      expected: "cam"
    },
    {
      content: "budget_year,fiscal_year,total_revenue,total_expenses",
      expected: "budgets"
    },
  ];

  testCases.forEach(({ content, expected }) => {
    const result = detectFileType({
      fileName: "unknown.csv",
      contentPreview: content,
    });
    assertEquals(result.moduleType, expected, `Failed for content keywords: ${content}`);
    assertEquals(result.moduleSource, "content_keyword");
  });
});

Deno.test("Confidence Scoring - Various Scenarios", () => {
  // High confidence: magic bytes + matching extension
  const highConfidence = detectFileType({
    fileName: "document.pdf",
    fileBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    explicitModuleType: "leases",
  });
  assertEquals(highConfidence.confidence > 0.95, true);
  
  // Medium confidence: MIME + extension match
  const mediumConfidence = detectFileType({
    mimeType: "application/pdf",
    fileName: "document.pdf",
    contentPreview: "tenant_name,monthly_rent",
  });
  assertEquals(mediumConfidence.confidence > 0.8, true);
  assertEquals(mediumConfidence.confidence < 0.95, true);
  
  // Low confidence: fallback detection
  const lowConfidence = detectFileType({
    fileName: "unknown",
  });
  assertEquals(lowConfidence.confidence < 0.5, true);
});

Deno.test("Edge Cases - Empty and Invalid Inputs", () => {
  // Empty inputs
  const emptyResult = detectFileType({});
  assertEquals(emptyResult.fileFormat, "unknown");
  assertEquals(emptyResult.moduleType, "unknown");
  assertEquals(emptyResult.formatSource, "fallback");
  assertEquals(emptyResult.moduleSource, "fallback");
  
  // Invalid explicit module type
  const invalidModule = detectFileType({
    fileName: "test.pdf",
    explicitModuleType: "invalid_module",
  });
  assertEquals(invalidModule.moduleType, "unknown");
  assertEquals(invalidModule.moduleSource, "fallback");
  
  // Very short file bytes
  const shortBytes = detectFileType({
    fileBytes: new Uint8Array([0x25]),
  });
  assertEquals(shortBytes.fileFormat, "unknown");
});

Deno.test("WebP Magic Bytes Detection", () => {
  // WebP: RIFF....WEBP (12 bytes minimum)
  const webpBytes = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x00, 0x00, 0x00, 0x00, // File size (placeholder)
    0x57, 0x45, 0x42, 0x50  // WEBP
  ]);
  
  const result = detectFileType({
    fileBytes: webpBytes,
  });
  
  assertEquals(result.fileFormat, "image");
  assertEquals(result.formatSource, "magic_bytes");
});

Deno.test("Text Heuristic Detection", () => {
  // Test printable text detection
  const printableText = new TextEncoder().encode("This is a normal text document with standard ASCII characters.");
  const result = detectFileType({
    fileBytes: printableText,
  });
  
  assertEquals(result.fileFormat, "text");
  assertEquals(result.formatSource, "magic_bytes");
  
  // Test binary data (should not be detected as text)
  const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0xFD]);
  const binaryResult = detectFileType({
    fileBytes: binaryData,
  });
  
  assertEquals(binaryResult.fileFormat, "unknown");
});

Deno.test("UTF BOM Detection", () => {
  // UTF-16 LE BOM
  const utf16LEResult = detectFileType({
    fileBytes: new Uint8Array([0xFF, 0xFE, 0x48, 0x00]), // BOM + 'H' in UTF-16 LE
  });
  assertEquals(utf16LEResult.fileFormat, "text");
  
  // UTF-16 BE BOM
  const utf16BEResult = detectFileType({
    fileBytes: new Uint8Array([0xFE, 0xFF, 0x00, 0x48]), // BOM + 'H' in UTF-16 BE
  });
  assertEquals(utf16BEResult.fileFormat, "text");
});

Deno.test("Confidence Boost for Agreement", () => {
  // Test confidence boost when magic bytes and extension agree
  const agreeResult = detectFileType({
    fileName: "document.pdf",
    fileBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // PDF magic bytes
  });
  
  // Test without agreement
  const disagreeResult = detectFileType({
    fileName: "document.txt",
    fileBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // PDF magic bytes but .txt extension
  });
  
  // Agreement should have higher confidence
  assertEquals(agreeResult.confidence > disagreeResult.confidence, true);
});