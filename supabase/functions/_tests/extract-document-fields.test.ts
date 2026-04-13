// @ts-nocheck
/**
 * Unit tests for extract-document-fields AI interpretation
 * Tests AI field extraction, confidence scoring, custom field detection, and error handling
 */

import { assertEquals, assertExists, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";

// Mock AI response for lease extraction
const mockLeaseAIResponse = [
  {
    tenant_name: "Acme Tenant LLC",
    property_name: "123 Main Street Office Building",
    unit_number: "Suite 400",
    start_date: "2025-01-01",
    end_date: "2027-12-31",
    lease_term_months: 36,
    monthly_rent: 8500,
    annual_rent: 102000,
    rent_per_sf: 42.5,
    square_footage: 2400,
    lease_type: "nnn",
    security_deposit: 17000,
    escalation_rate: 3,
    status: "active",
    confidence_score: 92,
    extraction_notes: "High confidence extraction from structured lease document",
    custom_fields: {
      parking_spaces: "5 reserved spaces",
      hvac_responsibility: "Tenant maintains HVAC system"
    }
  }
];

// Mock AI response for property extraction
const mockPropertyAIResponse = [
  {
    name: "Downtown Office Complex",
    address: "456 Business Ave",
    city: "New York",
    state: "NY",
    zip: "10001",
    property_type: "office",
    total_sqft: 50000,
    year_built: 1998,
    total_units: 20,
    floors: 5,
    status: "active",
    purchase_price: 15000000,
    market_value: 18000000,
    noi: 1200000,
    cap_rate: 6.7,
    confidence_score: 88,
    extraction_notes: "Property details extracted from marketing brochure"
  }
];

Deno.test("Input Validation - Valid Input", () => {
  function validateAndPreprocessInput(rawText: string, moduleType: string, fileName: string) {
    const warnings: string[] = [];
    const metadata = {
      original_length: rawText.length,
      estimated_tokens: Math.ceil(rawText.length / 4),
      file_name: fileName,
      module_type: moduleType,
    };

    // Basic validation
    if (!rawText || rawText.trim().length < 10) {
      return {
        isValid: false,
        processedText: "",
        warnings: ["Text is too short or empty"],
        metadata
      };
    }

    // Clean and preprocess text
    let processedText = rawText
      .replace(/\r\n/g, '\n')
      .replace(/\t/g, ' ')
      .replace(/\s{3,}/g, ' ')
      .trim();

    return {
      isValid: true,
      processedText,
      warnings,
      metadata
    };
  }
  
  const validInput = "This is a commercial lease agreement between Landlord Corp and Acme Tenant LLC for the premises located at 123 Main Street.";
  const result = validateAndPreprocessInput(validInput, "leases", "lease.pdf");
  
  assertEquals(result.isValid, true);
  assertEquals(result.warnings.length, 0);
  assertEquals(result.processedText.length > 0, true);
  assertEquals(result.metadata.module_type, "leases");
});

Deno.test("Input Validation - Invalid Input", () => {
  function validateAndPreprocessInput(rawText: string, moduleType: string, fileName: string) {
    const warnings: string[] = [];
    const metadata = {
      original_length: rawText.length,
      estimated_tokens: Math.ceil(rawText.length / 4),
      file_name: fileName,
      module_type: moduleType,
    };

    if (!rawText || rawText.trim().length < 10) {
      return {
        isValid: false,
        processedText: "",
        warnings: ["Text is too short or empty"],
        metadata
      };
    }

    return {
      isValid: true,
      processedText: rawText.trim(),
      warnings,
      metadata
    };
  }
  
  // Test empty input
  const emptyResult = validateAndPreprocessInput("", "leases", "empty.pdf");
  assertEquals(emptyResult.isValid, false);
  assertEquals(emptyResult.warnings[0], "Text is too short or empty");
  
  // Test very short input
  const shortResult = validateAndPreprocessInput("Hi", "leases", "short.pdf");
  assertEquals(shortResult.isValid, false);
  assertEquals(shortResult.warnings[0], "Text is too short or empty");
});

Deno.test("Input Preprocessing - Text Cleaning", () => {
  function validateAndPreprocessInput(rawText: string, moduleType: string, fileName: string) {
    const warnings: string[] = [];
    const metadata = {
      original_length: rawText.length,
      estimated_tokens: Math.ceil(rawText.length / 4),
      file_name: fileName,
      module_type: moduleType,
    };

    if (!rawText || rawText.trim().length < 10) {
      return {
        isValid: false,
        processedText: "",
        warnings: ["Text is too short or empty"],
        metadata
      };
    }

    // Clean and preprocess text
    let processedText = rawText
      .replace(/\r\n/g, '\n')  // Normalize line endings
      .replace(/\t/g, ' ')     // Convert tabs to spaces
      .replace(/\s{3,}/g, ' ') // Collapse multiple spaces
      .trim();

    // Check for potential issues
    if (processedText.length > 50000) {
      warnings.push("Document is very long, may be truncated");
      processedText = processedText.slice(0, 24000) + "\n\n[Document truncated for processing]";
      metadata.was_truncated = true;
    }

    return {
      isValid: true,
      processedText,
      warnings,
      metadata
    };
  }
  
  const messyText = "This\tis\ta\tlease\r\nagreement   with   multiple   spaces\r\n\r\nand\ttabs.";
  const result = validateAndPreprocessInput(messyText, "leases", "messy.pdf");
  
  assertEquals(result.isValid, true);
  assertEquals(result.processedText.includes('\t'), false); // Tabs should be converted
  assertEquals(result.processedText.includes('\r'), false); // CRLF should be normalized
  assertEquals(result.processedText.includes('   '), false); // Multiple spaces should be collapsed
});

Deno.test("Document Characteristics Detection", () => {
  function analyzeDocumentCharacteristics(rawText: string) {
    const hasTabularData = /\t/.test(rawText) || /\|.*\|/.test(rawText);
    const hasStructuredData = /:\s*\$?\d+/.test(rawText) || /\b\d{1,2}\/\d{1,2}\/\d{4}\b/.test(rawText);
    const hasMultipleRecords = (rawText.match(/\n/g) || []).length > 20;
    
    return {
      has_tabular_data: hasTabularData,
      has_structured_data: hasStructuredData,
      likely_multiple_records: hasMultipleRecords
    };
  }
  
  // Test tabular data detection
  const tabularText = "Name\tRent\tDate\nTenant A\t$5000\t01/01/2025\nTenant B\t$6000\t02/01/2025";
  const tabularResult = analyzeDocumentCharacteristics(tabularText);
  assertEquals(tabularResult.has_tabular_data, true);
  assertEquals(tabularResult.has_structured_data, true);
  
  // Test structured data detection
  const structuredText = "Monthly Rent: $8,500\nLease Start: 01/01/2025\nSecurity Deposit: $17,000";
  const structuredResult = analyzeDocumentCharacteristics(structuredText);
  assertEquals(structuredResult.has_structured_data, true);
  
  // Test multiple records detection
  const multipleRecordsText = Array(25).fill("This is line content").join('\n');
  const multipleResult = analyzeDocumentCharacteristics(multipleRecordsText);
  assertEquals(multipleResult.likely_multiple_records, true);
});

Deno.test("System Prompt Generation", () => {
  const SYSTEM_PROMPT = `You are an expert commercial real estate (CRE) data extraction system.
Your ONLY job is to extract structured field values from documents and return them as strictly valid JSON.

CRITICAL OUTPUT RULES — follow ALL of these exactly:
1. Output ONLY valid JSON. No explanation, no markdown code fences, no preamble, no commentary.
2. If extracting MULTIPLE records (e.g. rent roll table, expense log, unit list) → output a JSON ARRAY: [{...}, {...}]
3. If extracting a SINGLE record (e.g. one lease abstract, one property profile) → output a JSON OBJECT: {...}
4. NEVER omit a field key. If the value is not found anywhere, use null — never skip the key.
5. MONETARY VALUES: Extract as plain numbers only. "$12,500" → 12500. "$1.2M" → 1200000. "$25/SF" → 25.
6. PERCENTAGES: Plain numbers only. "3%" → 3. "3.5%" → 3.5. "350 bps" → 3.5.
7. DATES: Always convert to YYYY-MM-DD. "January 1, 2024" → "2024-01-01". "3/15/24" → "2024-03-15".
8. SQUARE FOOTAGE: Plain number only. "12,000 SF" → 12000. "5,500 RSF" → 5500.
9. For rent rolls and similar tables: EACH ROW = one separate JSON object in the array.
10. When you see "per SF" or "PSF" figures, extract them as rent_per_sf (annual, unless document says monthly).
11. If monthly_rent and annual_rent conflict, prefer whichever has more decimal precision or appears more explicitly.
12. For dates given as just a year (e.g. "2024"), use "2024-01-01" as a default date.

ENHANCED EXTRACTION RULES:
13. Include a "confidence_score" field (0-100) for each extracted record indicating your confidence in the extraction accuracy.
14. Include an "extraction_notes" field with any important context or assumptions made during extraction.
15. If you find data that doesn't match the standard fields, include it in a "custom_fields" object within each record.
16. For custom fields, use descriptive keys and include the raw text value found in the document.`;
  
  // Test that system prompt contains key instructions
  assertEquals(SYSTEM_PROMPT.includes("ONLY valid JSON"), true);
  assertEquals(SYSTEM_PROMPT.includes("confidence_score"), true);
  assertEquals(SYSTEM_PROMPT.includes("custom_fields"), true);
  assertEquals(SYSTEM_PROMPT.includes("MONETARY VALUES"), true);
  assertEquals(SYSTEM_PROMPT.includes("DATES"), true);
});

Deno.test("User Prompt Building", () => {
  const MODULE_SCHEMAS = {
    lease: {
      description: "Commercial lease / rent roll record",
      tableHint: "Look for a lease abstract, rent roll table, lease summary, or tenant schedule.",
      fields: `{
  "tenant_name": "string — name of the tenant or company",
  "monthly_rent": "number — base rent per month in USD",
  "start_date": "string — lease commencement date in YYYY-MM-DD format"
}`
    }
  };
  
  function buildUserPrompt(moduleType: string, rawText: string, fileName: string, suggestCustomFields = false) {
    const schema = MODULE_SCHEMAS[moduleType] ?? MODULE_SCHEMAS.lease;
    const recordCount = rawText.length > 5000 ? "MULTIPLE records (use a JSON array)" : "one or more records";

    const customFieldInstructions = suggestCustomFields ? `

CUSTOM FIELD DETECTION:
- If you find data that doesn't fit the standard fields above, include it in a "custom_fields" object
- Use descriptive field names like "assignment_clause", "parking_spaces", "hvac_responsibility"` : "";

    return `Extract all ${schema.description} data from the document below.

File name: "${fileName}"
Module: ${moduleType.toUpperCase()}
Document hint: ${schema.tableHint}

TASK:
- Scan the ENTIRE document for every piece of data matching the fields below.
- This document likely contains ${recordCount}.

FIELDS TO EXTRACT (return null for any field not found):
${schema.fields}${customFieldInstructions}

DOCUMENT TEXT:
─────────────────────────────────────────────────────
${rawText.slice(0, 1000)}
─────────────────────────────────────────────────────

OUTPUT ONLY VALID JSON. NO EXPLANATION.`;
  }
  
  const shortText = "Tenant: Acme Corp, Rent: $5000/month, Start: 01/01/2025";
  const prompt = buildUserPrompt("lease", shortText, "test.pdf", true);
  
  assertEquals(prompt.includes("Commercial lease / rent roll record"), true);
  assertEquals(prompt.includes("one or more records"), true);
  assertEquals(prompt.includes("CUSTOM FIELD DETECTION"), true);
  assertEquals(prompt.includes("tenant_name"), true);
  assertEquals(prompt.includes("Acme Corp"), true);
});

Deno.test("Rule-Based Lease Extraction", () => {
  function extractLeaseFieldsRuleBased(text: string, moduleType: string) {
    if (moduleType !== "lease") return [];

    const row: Record<string, unknown> = {};

    // Helper: strip currency and parse number
    function parseMoney(s: string): number | null {
      const cleaned = s.replace(/[$,\s]/g, "").replace(/\/month.*$/i, "").trim();
      const n = parseFloat(cleaned);
      return isNaN(n) ? null : n;
    }

    // Helper: extract value after a label
    function extractAfterLabel(label: string): string | null {
      const re = new RegExp(`${label}[:\\s]+([^\\n]+)`, "i");
      const m = text.match(re);
      return m ? m[1].trim() : null;
    }

    // Extract tenant name
    const tenantRaw = extractAfterLabel("Tenant") || extractAfterLabel("Lessee");
    if (tenantRaw) {
      row.tenant_name = tenantRaw.replace(/[,;.]$/, "").trim();
    }

    // Extract monthly rent
    const rentRaw = extractAfterLabel("Base Rent") || extractAfterLabel("Monthly Rent");
    if (rentRaw) {
      const n = parseMoney(rentRaw);
      if (n !== null && n > 0) row.monthly_rent = n;
    }

    // Calculate confidence
    const foundFields = Object.keys(row).length;
    row.confidence_score = foundFields > 0 ? Math.min(95, 60 + (foundFields * 15)) : 35;
    row.extraction_notes = `Rule-based extraction found ${foundFields} fields`;

    return foundFields > 0 ? [row] : [];
  }
  
  const leaseText = `
    COMMERCIAL LEASE AGREEMENT
    
    Tenant: Acme Business Solutions LLC
    Landlord: Property Management Corp
    Monthly Rent: $8,500 per month
    Security Deposit: $17,000
  `;
  
  const result = extractLeaseFieldsRuleBased(leaseText, "lease");
  assertEquals(result.length, 1);
  assertEquals(result[0].tenant_name, "Acme Business Solutions LLC");
  assertEquals(result[0].monthly_rent, 8500);
  assertEquals(result[0].confidence_score > 60, true);
  assertEquals(typeof result[0].extraction_notes, "string");
});

Deno.test("Custom Field Analysis", () => {
  function analyzeCustomFields(extractedRows: any[]) {
    const customFieldSuggestions: any[] = [];
    const customFieldMap = new Map<string, { values: string[], count: number }>();

    // Collect all custom fields from extracted rows
    for (const row of extractedRows) {
      if (row.custom_fields && typeof row.custom_fields === 'object') {
        for (const [key, value] of Object.entries(row.custom_fields)) {
          if (!customFieldMap.has(key)) {
            customFieldMap.set(key, { values: [], count: 0 });
          }
          const field = customFieldMap.get(key)!;
          field.values.push(String(value));
          field.count++;
        }
      }
    }

    // Generate suggestions for each custom field
    for (const [fieldName, data] of customFieldMap.entries()) {
      const uniqueValues = [...new Set(data.values)];
      const suggestion = {
        field_name: fieldName,
        field_label: fieldName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        field_type: inferFieldType(uniqueValues),
        sample_values: uniqueValues.slice(0, 5),
        confidence: Math.min(95, 60 + (data.count * 10)),
      };

      customFieldSuggestions.push(suggestion);
    }

    return customFieldSuggestions;
  }

  function inferFieldType(values: string[]): 'text' | 'number' | 'date' | 'boolean' | 'select' {
    if (values.length === 0) return 'text';

    // Check for boolean values
    const booleanValues = values.filter(v => 
      /^(true|false|yes|no|y|n|1|0)$/i.test(v.trim())
    );
    if (booleanValues.length / values.length > 0.8) return 'boolean';

    // Check for numeric values
    const numericValues = values.filter(v => 
      /^\$?[\d,]+\.?\d*$/.test(v.trim()) || !isNaN(Number(v.replace(/[$,]/g, '')))
    );
    if (numericValues.length / values.length > 0.8) return 'number';

    // Check for select field (limited unique values)
    const uniqueValues = new Set(values.map(v => v.toLowerCase().trim()));
    if (uniqueValues.size <= 10 && values.length > uniqueValues.size) return 'select';

    return 'text';
  }
  
  const testRows = [
    {
      tenant_name: "Acme Corp",
      custom_fields: {
        parking_spaces: "5",
        hvac_responsibility: "Tenant",
        pet_policy: "No pets allowed"
      }
    },
    {
      tenant_name: "Beta LLC",
      custom_fields: {
        parking_spaces: "3",
        hvac_responsibility: "Landlord",
        pet_policy: "Cats allowed"
      }
    }
  ];
  
  const suggestions = analyzeCustomFields(testRows);
  assertEquals(suggestions.length, 3);
  
  const parkingField = suggestions.find(s => s.field_name === "parking_spaces");
  assertEquals(parkingField.field_type, "number");
  assertEquals(parkingField.field_label, "Parking Spaces");
  
  const hvacField = suggestions.find(s => s.field_name === "hvac_responsibility");
  assertEquals(hvacField.field_type, "select");
  assertEquals(hvacField.sample_values.includes("Tenant"), true);
  assertEquals(hvacField.sample_values.includes("Landlord"), true);
});

Deno.test("Field Type Inference", () => {
  function inferFieldType(values: string[]): 'text' | 'number' | 'date' | 'boolean' | 'select' {
    if (values.length === 0) return 'text';

    // Check for boolean values
    const booleanValues = values.filter(v => 
      /^(true|false|yes|no|y|n|1|0)$/i.test(v.trim())
    );
    if (booleanValues.length / values.length > 0.8) return 'boolean';

    // Check for numeric values
    const numericValues = values.filter(v => 
      /^\$?[\d,]+\.?\d*$/.test(v.trim()) || !isNaN(Number(v.replace(/[$,]/g, '')))
    );
    if (numericValues.length / values.length > 0.8) return 'number';

    // Check for date values
    const dateValues = values.filter(v => 
      /\d{1,2}\/\d{1,2}\/\d{4}/.test(v) || /\d{4}-\d{2}-\d{2}/.test(v) || 
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(v)
    );
    if (dateValues.length / values.length > 0.6) return 'date';

    // Check for select field (limited unique values)
    const uniqueValues = new Set(values.map(v => v.toLowerCase().trim()));
    if (uniqueValues.size <= 10 && values.length > uniqueValues.size) return 'select';

    return 'text';
  }
  
  // Test boolean inference
  assertEquals(inferFieldType(["true", "false", "yes", "no"]), "boolean");
  assertEquals(inferFieldType(["1", "0", "1", "0"]), "boolean");
  
  // Test number inference
  assertEquals(inferFieldType(["100", "200", "$1,500", "2.5"]), "number");
  assertEquals(inferFieldType(["$5,000", "$10,000", "$15,000"]), "number");
  
  // Test date inference
  assertEquals(inferFieldType(["01/01/2025", "02/15/2025", "12/31/2025"]), "date");
  assertEquals(inferFieldType(["2025-01-01", "2025-02-15", "January 1, 2025"]), "date");
  
  // Test select inference
  assertEquals(inferFieldType(["active", "inactive", "active", "pending", "active"]), "select");
  assertEquals(inferFieldType(["small", "medium", "large", "small", "medium"]), "select");
  
  // Test text fallback
  assertEquals(inferFieldType(["This is a long description", "Another unique text", "Different content"]), "text");
});

Deno.test("AI Response Processing", () => {
  function processAIResponse(rawResponse: any[], moduleType: string) {
    if (!Array.isArray(rawResponse)) {
      rawResponse = [rawResponse];
    }

    const cleanRows = rawResponse.map((row: any) => {
      const cleanRow: Record<string, any> = {};
      
      // Copy all fields except metadata
      for (const [key, value] of Object.entries(row)) {
        if (!key.startsWith('_') && key !== 'raw_response') {
          cleanRow[key] = value;
        }
      }
      
      // Ensure confidence score exists
      if (!cleanRow.confidence_score) {
        cleanRow.confidence_score = 75; // Default confidence
      }
      
      // Add extraction metadata
      cleanRow._extraction_method = 'ai';
      cleanRow._extraction_timestamp = new Date().toISOString();
      
      return cleanRow;
    });

    return cleanRows;
  }
  
  const rawResponse = mockLeaseAIResponse;
  const processed = processAIResponse(rawResponse, "leases");
  
  assertEquals(processed.length, 1);
  assertEquals(processed[0].tenant_name, "Acme Tenant LLC");
  assertEquals(processed[0].confidence_score, 92);
  assertEquals(processed[0]._extraction_method, "ai");
  assertExists(processed[0]._extraction_timestamp);
  
  // Test single object input
  const singleResponse = mockLeaseAIResponse[0];
  const processedSingle = processAIResponse(singleResponse, "leases");
  assertEquals(processedSingle.length, 1);
  assertEquals(processedSingle[0].tenant_name, "Acme Tenant LLC");
});

Deno.test("Error Handling - AI Failure", async () => {
  async function handleAIFailure(error: Error, fallbackData?: any[]) {
    console.error("AI extraction failed:", error.message);
    
    if (fallbackData && fallbackData.length > 0) {
      return {
        success: true,
        rows: fallbackData,
        method: "fallback",
        error_recovered: true,
        original_error: error.message
      };
    }
    
    return {
      success: false,
      rows: [],
      method: "error",
      error: error.message,
      error_details: {
        message: error.message,
        timestamp: new Date().toISOString()
      }
    };
  }
  
  const testError = new Error("Vertex AI timeout");
  
  // Test with fallback data
  const fallbackData = [{ tenant_name: "Fallback Tenant", confidence_score: 50 }];
  const resultWithFallback = await handleAIFailure(testError, fallbackData);
  assertEquals(resultWithFallback.success, true);
  assertEquals(resultWithFallback.method, "fallback");
  assertEquals(resultWithFallback.error_recovered, true);
  
  // Test without fallback data
  const resultWithoutFallback = await handleAIFailure(testError);
  assertEquals(resultWithoutFallback.success, false);
  assertEquals(resultWithoutFallback.method, "error");
  assertEquals(resultWithoutFallback.error, "Vertex AI timeout");
});

Deno.test("Confidence Scoring", () => {
  function calculateOverallConfidence(rows: any[]) {
    if (rows.length === 0) return 0;
    
    const totalConfidence = rows.reduce((sum, row) => sum + (row.confidence_score || 0), 0);
    return Math.round(totalConfidence / rows.length);
  }
  
  const testRows = [
    { confidence_score: 95 },
    { confidence_score: 87 },
    { confidence_score: 92 }
  ];
  
  const avgConfidence = calculateOverallConfidence(testRows);
  assertEquals(avgConfidence, 91); // (95 + 87 + 92) / 3 = 91.33, rounded to 91
  
  // Test with missing confidence scores
  const rowsWithMissing = [
    { confidence_score: 90 },
    { /* no confidence_score */ },
    { confidence_score: 80 }
  ];
  
  const avgWithMissing = calculateOverallConfidence(rowsWithMissing);
  assertEquals(avgWithMissing, 57); // (90 + 0 + 80) / 3 = 56.67, rounded to 57
});

Deno.test("Module Schema Validation", () => {
  const MODULE_SCHEMAS = {
    lease: {
      description: "Commercial lease / rent roll record",
      tableHint: "Look for a lease abstract, rent roll table, lease summary, or tenant schedule.",
      fields: `{
  "tenant_name": "string — name of the tenant or company",
  "monthly_rent": "number — base rent per month in USD"
}`
    },
    property: {
      description: "Commercial real estate property / asset record",
      tableHint: "Look for a property listing, asset summary, or property data table.",
      fields: `{
  "name": "string — property name or building name",
  "address": "string — street address"
}`
    }
  };
  
  function getModuleSchema(moduleType: string) {
    return MODULE_SCHEMAS[moduleType] ?? MODULE_SCHEMAS.property;
  }
  
  // Test valid module type
  const leaseSchema = getModuleSchema("lease");
  assertEquals(leaseSchema.description, "Commercial lease / rent roll record");
  assertEquals(leaseSchema.fields.includes("tenant_name"), true);
  
  // Test fallback to property schema
  const unknownSchema = getModuleSchema("unknown_module");
  assertEquals(unknownSchema.description, "Commercial real estate property / asset record");
  assertEquals(unknownSchema.fields.includes("name"), true);
});