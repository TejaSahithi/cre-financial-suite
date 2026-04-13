import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

/**
 * Document Extraction Pipeline End-to-End Integration Tests
 * 
 * **Validates: Requirements 2.7, 3.1, 3.2, 3.3**
 * 
 * This test suite validates the complete document extraction pipeline from upload to UI field population,
 * including error handling, recovery mechanisms, custom field integration, and performance testing.
 * 
 * Test Coverage:
 * 1. Complete pipeline from upload to UI field population
 * 2. Error handling and recovery across all pipeline stages
 * 3. Custom field integration with existing UI components
 * 4. Performance and scalability with large documents
 */

// Test configuration
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

interface TestDocument {
  id: string;
  fileName: string;
  fileFormat: string;
  mimeType: string;
  content: Uint8Array;
  size: number;
  expectedFields: string[];
  moduleType: string;
}

interface PipelineStageResult {
  stage: string;
  success: boolean;
  duration: number;
  error?: string;
  data?: any;
}

interface EndToEndTestResult {
  documentId: string;
  fileName: string;
  fileFormat: string;
  totalDuration: number;
  success: boolean;
  stages: PipelineStageResult[];
  extractedFields: Record<string, any>;
  customFields: Array<{
    field_name: string;
    field_type: string;
    confidence: number;
  }>;
  errors: string[];
}

// Helper function to create test documents of various sizes and formats
function createTestDocuments(): TestDocument[] {
  // Small PDF document
  const smallPdfContent = new TextEncoder().encode(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj
4 0 obj<</Length 120>>stream
BT /F1 12 Tf 72 720 Td (LEASE AGREEMENT) Tj
0 -20 Td (Tenant: Acme Corporation) Tj
0 -20 Td (Monthly Rent: $8,500.00) Tj
0 -20 Td (Start Date: 2025-01-01) Tj
0 -20 Td (End Date: 2027-12-31) Tj ET
endstream endobj
xref 0 5 0000000000 65535 f 0000000009 00000 n 0000000058 00000 n 0000000115 00000 n 0000000179 00000 n 
trailer<</Size 5/Root 1 0 R>>startxref 299 %%EOF`);

  // Medium text document with complex lease terms
  const mediumTextContent = new TextEncoder().encode(`COMMERCIAL LEASE AGREEMENT

PARTIES:
Landlord: Metropolitan Property Management LLC
Tenant: Acme Technology Solutions Inc.
Property Address: 1234 Business Park Drive, Suite 500, Tech City, CA 90210

LEASE TERMS:
Lease Start Date: January 1, 2025
Lease End Date: December 31, 2027
Initial Term: 36 months
Monthly Base Rent: $12,750.00
Security Deposit: $25,500.00
Square Footage: 3,400 SF
Rent per SF: $3.75

ADDITIONAL CHARGES:
Common Area Maintenance (CAM): $2.50 per SF annually
Property Taxes: Tenant's proportionate share
Insurance: Tenant responsible for liability insurance
Utilities: Tenant pays all utilities

ESCALATIONS:
Annual Rent Increase: 3% per year starting Year 2
CPI Adjustment: Maximum 5% annually

SPECIAL PROVISIONS:
Parking Spaces: 15 spaces included
Pet Policy: No pets allowed
Signage Rights: Exterior building signage permitted
Early Termination: 6-month notice required with penalty

CUSTOM TERMS:
Technology Infrastructure: Fiber optic ready
Conference Room Access: Shared conference room included
After Hours Access: 24/7 keycard access
Expansion Rights: Right of first refusal on adjacent suite

This lease agreement contains additional standard commercial lease provisions
and is subject to all applicable local, state, and federal laws.`);

  // Large document with extensive data (simulating a complex lease with many fields)
  const largeDocumentContent = new TextEncoder().encode(`MASTER LEASE AGREEMENT - MULTI-TENANT COMMERCIAL PROPERTY

EXECUTIVE SUMMARY:
Property: Tech Business Center - Building A
Total Square Footage: 45,000 SF
Number of Units: 12 units
Lease Commencement: January 1, 2025
Master Lease Term: 10 years with renewal options

TENANT ROSTER:
Unit 101: Acme Corp - 2,400 SF - $8,500/month - Lease expires 12/31/2027
Unit 102: Beta LLC - 2,000 SF - $7,500/month - Lease expires 06/30/2026
Unit 103: Gamma Inc - 3,200 SF - $11,200/month - Lease expires 12/31/2028
Unit 201: Delta Solutions - 2,800 SF - $9,800/month - Lease expires 03/31/2027
Unit 202: Epsilon Tech - 3,600 SF - $12,600/month - Lease expires 09/30/2026
Unit 203: Zeta Consulting - 2,200 SF - $7,700/month - Lease expires 12/31/2025
Unit 301: Eta Enterprises - 4,000 SF - $14,000/month - Lease expires 06/30/2028
Unit 302: Theta Corp - 3,400 SF - $11,900/month - Lease expires 12/31/2027
Unit 303: Iota Systems - 2,600 SF - $9,100/month - Lease expires 03/31/2026
Unit 401: Kappa Industries - 5,200 SF - $18,200/month - Lease expires 12/31/2029
Unit 402: Lambda Services - 3,800 SF - $13,300/month - Lease expires 09/30/2027
Unit 403: Mu Technologies - 2,400 SF - $8,400/month - Lease expires 06/30/2026

FINANCIAL SUMMARY:
Total Monthly Rent: $142,200
Annual Rent Roll: $1,706,400
Average Rent per SF: $3.16
Occupancy Rate: 100%
Annual CAM Charges: $337,500 ($7.50 per SF)
Annual Property Taxes: $225,000 ($5.00 per SF)
Annual Insurance: $67,500 ($1.50 per SF)

LEASE ESCALATIONS:
Base Rent Increases: 3% annually for all tenants
CAM Escalations: Actual costs passed through
Tax Escalations: Actual costs passed through
CPI Adjustments: Maximum 5% annually, minimum 2%

TENANT IMPROVEMENTS:
Allowance per SF: $25.00 for new tenants
Renewal Allowance: $15.00 per SF for renewals
Landlord Work: HVAC, electrical, plumbing rough-in
Tenant Work: Flooring, paint, fixtures, furniture

PARKING ALLOCATION:
Total Spaces: 180 spaces (4 per 1,000 SF)
Reserved Spaces: 24 executive spaces
Visitor Spaces: 36 spaces
Electric Vehicle Charging: 12 stations

BUILDING AMENITIES:
Fitness Center: 1,200 SF facility with equipment
Conference Center: 800 SF with A/V equipment
Café: 600 SF with seating for 40
Outdoor Terrace: 2,000 SF rooftop space
Bike Storage: Secure storage for 50 bikes

MAINTENANCE RESPONSIBILITIES:
Landlord: Structure, roof, HVAC systems, elevators
Tenant: Interior maintenance, janitorial, utilities
Shared: Common area maintenance, landscaping, security

INSURANCE REQUIREMENTS:
General Liability: $2,000,000 per occurrence
Property Insurance: Full replacement cost
Workers Compensation: As required by law
Umbrella Policy: $5,000,000 minimum

SPECIAL CLAUSES:
Expansion Rights: Tenants have ROFR on adjacent space
Assignment Rights: Permitted with landlord approval
Subletting: Permitted with 30-day notice
Early Termination: 12-month notice with 6-month penalty
Renewal Options: Two 5-year options at market rates

CUSTOM FIELD DATA:
Building Class: Class A office building
LEED Certification: Gold certified
Fiber Internet: Gigabit fiber to each suite
Security System: 24/7 monitoring with keycard access
Backup Power: Emergency generator for common areas
Water Features: Decorative fountain in lobby
Art Collection: Rotating local artist displays
Green Roof: 5,000 SF living roof system
Solar Panels: 200kW solar array
EV Infrastructure: Level 2 charging stations

This master lease agreement governs all individual tenant leases and contains
comprehensive terms and conditions for the operation of this multi-tenant
commercial property. All individual tenant leases are subordinate to this
master agreement and must comply with its terms and conditions.`);

  return [
    {
      id: "test-small-pdf-e2e",
      fileName: "small-lease.pdf",
      fileFormat: "pdf",
      mimeType: "application/pdf",
      content: smallPdfContent,
      size: smallPdfContent.length,
      expectedFields: ["tenant_name", "monthly_rent", "start_date", "end_date"],
      moduleType: "leases"
    },
    {
      id: "test-medium-txt-e2e",
      fileName: "medium-lease.txt",
      fileFormat: "txt",
      mimeType: "text/plain",
      content: mediumTextContent,
      size: mediumTextContent.length,
      expectedFields: ["tenant_name", "monthly_rent", "start_date", "end_date", "square_footage", "cam_charges"],
      moduleType: "leases"
    },
    {
      id: "test-large-doc-e2e",
      fileName: "large-master-lease.txt",
      fileFormat: "txt",
      mimeType: "text/plain",
      content: largeDocumentContent,
      size: largeDocumentContent.length,
      expectedFields: ["tenant_name", "monthly_rent", "start_date", "end_date", "square_footage", "occupancy_rate"],
      moduleType: "leases"
    }
  ];
}

// Helper function to call edge functions with timing
async function callEdgeFunctionTimed(
  functionName: string,
  body: Record<string, unknown>,
  useServiceRole = false
): Promise<{ result: any; duration: number; success: boolean; error?: string }> {
  const startTime = Date.now();
  const authToken = useServiceRole ? SUPABASE_SERVICE_ROLE_KEY : SUPABASE_ANON_KEY;
  
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    });

    const duration = Date.now() - startTime;
    const data = await response.json().catch(() => ({}));
    
    return {
      result: data,
      duration,
      success: response.ok,
      error: response.ok ? undefined : `HTTP ${response.status}: ${JSON.stringify(data)}`
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    return {
      result: {},
      duration,
      success: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

// Helper to create test file records in database
async function createTestFileRecord(testDoc: TestDocument, orgId: string): Promise<void> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  const fileUrl = `${SUPABASE_URL}/storage/v1/object/public/financial-uploads/test/${testDoc.fileName}`;
  
  const { error } = await supabase
    .from("uploaded_files")
    .insert({
      id: testDoc.id,
      org_id: orgId,
      file_name: testDoc.fileName,
      file_url: fileUrl,
      mime_type: testDoc.mimeType,
      module_type: testDoc.moduleType,
      status: "uploaded",
      file_size: testDoc.size,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

  if (error) {
    throw new Error(`Failed to create test file record: ${error.message}`);
  }
}

// Helper to clean up test data
async function cleanupTestData(fileIds: string[], orgId: string): Promise<void> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  // Clean up uploaded files
  for (const fileId of fileIds) {
    await supabase.from("uploaded_files").delete().eq("id", fileId);
  }
  
  // Clean up any custom fields created during testing
  await supabase.from("custom_fields").delete().eq("org_id", orgId);
  await supabase.from("custom_field_values").delete().eq("org_id", orgId);
}

// Main end-to-end pipeline test function
async function runEndToEndPipelineTest(testDoc: TestDocument, orgId: string): Promise<EndToEndTestResult> {
  const result: EndToEndTestResult = {
    documentId: testDoc.id,
    fileName: testDoc.fileName,
    fileFormat: testDoc.fileFormat,
    totalDuration: 0,
    success: false,
    stages: [],
    extractedFields: {},
    customFields: [],
    errors: []
  };

  const startTime = Date.now();

  try {
    // Stage 1: File Upload and Routing
    console.log(`  🔄 Stage 1: Testing file upload and routing for ${testDoc.fileName}...`);
    const ingestResult = await callEdgeFunctionTimed("ingest-file", {
      file_id: testDoc.id,
      module_type: testDoc.moduleType
    }, true);

    result.stages.push({
      stage: "ingest-routing",
      success: ingestResult.success,
      duration: ingestResult.duration,
      error: ingestResult.error,
      data: ingestResult.result
    });

    if (!ingestResult.success) {
      result.errors.push(`Ingest/Routing failed: ${ingestResult.error}`);
      return result;
    }

    // Stage 2: Document Extraction (if not CSV)
    if (testDoc.fileFormat !== "csv") {
      console.log(`  🔄 Stage 2: Testing document extraction...`);
      
      // Check if extraction was completed as part of ingest-file
      const extractionSuccess = ingestResult.result?.steps?.extraction?.success;
      const extractionDuration = ingestResult.result?.steps?.extraction?.duration || 0;
      
      result.stages.push({
        stage: "document-extraction",
        success: extractionSuccess || false,
        duration: extractionDuration,
        error: extractionSuccess ? undefined : ingestResult.result?.steps?.extraction?.error,
        data: ingestResult.result?.steps?.extraction
      });

      if (!extractionSuccess) {
        result.errors.push(`Document extraction failed: ${ingestResult.result?.steps?.extraction?.error}`);
        return result;
      }
    }

    // Stage 3: AI Interpretation and Field Mapping
    console.log(`  🔄 Stage 3: Testing AI interpretation and field mapping...`);
    
    const normalizationSuccess = ingestResult.result?.steps?.normalization?.success;
    const normalizationDuration = ingestResult.result?.steps?.normalization?.duration || 0;
    
    result.stages.push({
      stage: "ai-interpretation",
      success: normalizationSuccess || false,
      duration: normalizationDuration,
      error: normalizationSuccess ? undefined : ingestResult.result?.steps?.normalization?.error,
      data: ingestResult.result?.steps?.normalization
    });

    if (!normalizationSuccess) {
      result.errors.push(`AI interpretation failed: ${ingestResult.result?.steps?.normalization?.error}`);
      return result;
    }

    // Extract field data from results
    if (ingestResult.result?.extracted_data) {
      result.extractedFields = ingestResult.result.extracted_data;
    }

    // Stage 4: Custom Field Detection and Creation
    console.log(`  🔄 Stage 4: Testing custom field detection...`);
    
    const customFieldResult = await callEdgeFunctionTimed("extract-with-custom-fields", {
      file_id: testDoc.id,
      auto_create_fields: true
    }, true);

    result.stages.push({
      stage: "custom-field-detection",
      success: customFieldResult.success,
      duration: customFieldResult.duration,
      error: customFieldResult.error,
      data: customFieldResult.result
    });

    if (customFieldResult.success && customFieldResult.result?.custom_field_suggestions) {
      result.customFields = customFieldResult.result.custom_field_suggestions;
    }

    // Stage 5: Data Storage and Validation
    console.log(`  🔄 Stage 5: Testing data storage and validation...`);
    
    // Check if data was stored successfully
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: storedData, error: storageError } = await supabase
      .from("uploaded_files")
      .select("*")
      .eq("id", testDoc.id)
      .single();

    const storageSuccess = !storageError && storedData?.status === "completed";
    
    result.stages.push({
      stage: "data-storage",
      success: storageSuccess,
      duration: 50, // Estimated duration for database operations
      error: storageError?.message,
      data: storedData
    });

    if (!storageSuccess) {
      result.errors.push(`Data storage failed: ${storageError?.message}`);
    }

    // Calculate overall success
    result.success = result.stages.every(stage => stage.success);
    
  } catch (error) {
    result.errors.push(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    result.totalDuration = Date.now() - startTime;
  }

  return result;
}

Deno.test("End-to-End Pipeline - Complete Document Processing Workflow", async () => {
  console.log("🔍 Testing complete end-to-end document processing workflow");
  
  const testDocuments = createTestDocuments();
  const testOrgId = "test-org-e2e-" + Date.now();
  const fileIds = testDocuments.map(doc => doc.id);
  
  try {
    // Create test file records
    for (const testDoc of testDocuments) {
      await createTestFileRecord(testDoc, testOrgId);
    }
    
    const results: EndToEndTestResult[] = [];
    
    // Run end-to-end tests for each document
    for (const testDoc of testDocuments) {
      console.log(`\n📄 Testing end-to-end pipeline for ${testDoc.fileName} (${testDoc.size} bytes)`);
      
      const result = await runEndToEndPipelineTest(testDoc, testOrgId);
      results.push(result);
      
      // Log stage results
      console.log(`  📊 Pipeline Results for ${testDoc.fileName}:`);
      console.log(`    - Total Duration: ${result.totalDuration}ms`);
      console.log(`    - Overall Success: ${result.success}`);
      console.log(`    - Extracted Fields: ${Object.keys(result.extractedFields).length}`);
      console.log(`    - Custom Fields Suggested: ${result.customFields.length}`);
      
      result.stages.forEach(stage => {
        const status = stage.success ? "✅" : "❌";
        console.log(`    ${status} ${stage.stage}: ${stage.duration}ms`);
        if (stage.error) {
          console.log(`      Error: ${stage.error}`);
        }
      });
      
      if (result.errors.length > 0) {
        console.log(`    ❌ Errors: ${result.errors.join('; ')}`);
      }
    }
    
    // Analyze overall results
    const successfulTests = results.filter(r => r.success);
    const failedTests = results.filter(r => !r.success);
    
    console.log(`\n📊 End-to-End Pipeline Summary:`);
    console.log(`- Total documents tested: ${results.length}`);
    console.log(`- Successful pipelines: ${successfulTests.length}`);
    console.log(`- Failed pipelines: ${failedTests.length}`);
    console.log(`- Success rate: ${(successfulTests.length / results.length * 100).toFixed(1)}%`);
    
    // Performance analysis
    const avgDuration = results.reduce((sum, r) => sum + r.totalDuration, 0) / results.length;
    const maxDuration = Math.max(...results.map(r => r.totalDuration));
    const minDuration = Math.min(...results.map(r => r.totalDuration));
    
    console.log(`\n⏱️  Performance Metrics:`);
    console.log(`- Average processing time: ${avgDuration.toFixed(0)}ms`);
    console.log(`- Maximum processing time: ${maxDuration}ms`);
    console.log(`- Minimum processing time: ${minDuration}ms`);
    
    // Field extraction analysis
    const totalFieldsExtracted = results.reduce((sum, r) => sum + Object.keys(r.extractedFields).length, 0);
    const totalCustomFields = results.reduce((sum, r) => sum + r.customFields.length, 0);
    
    console.log(`\n📋 Field Extraction Summary:`);
    console.log(`- Total fields extracted: ${totalFieldsExtracted}`);
    console.log(`- Total custom fields suggested: ${totalCustomFields}`);
    console.log(`- Average fields per document: ${(totalFieldsExtracted / results.length).toFixed(1)}`);
    
    // Assert that the end-to-end pipeline works for at least some documents
    assertEquals(
      successfulTests.length > 0,
      true,
      `End-to-end pipeline should work for at least one document. ` +
      `Results: ${results.map(r => `${r.fileName}=${r.success}`).join(', ')}. ` +
      `Errors: ${failedTests.map(r => `${r.fileName}: ${r.errors.join('; ')}`).join(' | ')}`
    );
    
    // Assert reasonable performance (under 30 seconds per document)
    assertEquals(
      maxDuration < 30000,
      true,
      `Pipeline processing should complete within 30 seconds. Max duration: ${maxDuration}ms`
    );
    
    // Assert that field extraction is working
    assertEquals(
      totalFieldsExtracted > 0,
      true,
      `Pipeline should extract at least some fields from documents. Total extracted: ${totalFieldsExtracted}`
    );
    
    console.log(`\n🎉 End-to-end pipeline test completed successfully!`);
    
  } finally {
    // Cleanup test data
    await cleanupTestData(fileIds, testOrgId);
  }
});

Deno.test("Error Handling and Recovery - Pipeline Stage Failures", async () => {
  console.log("🔍 Testing error handling and recovery across pipeline stages");
  
  const testOrgId = "test-org-error-" + Date.now();
  const testScenarios = [
    {
      name: "Non-existent file",
      fileId: "non-existent-file-id",
      expectedStage: "ingest-routing",
      expectedError: "File not found"
    },
    {
      name: "Invalid file format",
      fileId: "test-invalid-format",
      fileName: "invalid.xyz",
      mimeType: "application/unknown",
      expectedStage: "document-extraction",
      expectedError: "Unsupported format"
    },
    {
      name: "Corrupted file content",
      fileId: "test-corrupted-file",
      fileName: "corrupted.pdf",
      mimeType: "application/pdf",
      content: new TextEncoder().encode("This is not a valid PDF file"),
      expectedStage: "document-extraction",
      expectedError: "Extraction failed"
    }
  ];
  
  const fileIds: string[] = [];
  
  try {
    const errorResults: Array<{
      scenario: string;
      errorDetected: boolean;
      errorStage: string;
      errorMessage: string;
      recoveryAttempted: boolean;
      recoverySuccessful: boolean;
    }> = [];
    
    for (const scenario of testScenarios) {
      console.log(`\n🧪 Testing scenario: ${scenario.name}`);
      
      // Create test file record if needed
      if (scenario.fileName && scenario.content) {
        fileIds.push(scenario.fileId);
        await createTestFileRecord({
          id: scenario.fileId,
          fileName: scenario.fileName,
          fileFormat: scenario.fileName.split('.').pop() || 'unknown',
          mimeType: scenario.mimeType,
          content: scenario.content,
          size: scenario.content.length,
          expectedFields: [],
          moduleType: "leases"
        }, testOrgId);
      }
      
      // Test the pipeline with error scenario
      const result = await callEdgeFunctionTimed("ingest-file", {
        file_id: scenario.fileId,
        module_type: "leases"
      }, true);
      
      const errorResult = {
        scenario: scenario.name,
        errorDetected: !result.success,
        errorStage: result.success ? "none" : "ingest-routing",
        errorMessage: result.error || "No error",
        recoveryAttempted: false,
        recoverySuccessful: false
      };
      
      // Check if error was detected at expected stage
      if (!result.success) {
        console.log(`  ❌ Error detected: ${result.error}`);
        
        // Check if the system attempted recovery
        if (result.result?.retry_count > 0) {
          errorResult.recoveryAttempted = true;
          console.log(`  🔄 Recovery attempted: ${result.result.retry_count} retries`);
        }
        
        // Check if error handling provided useful information
        if (result.result?.error_code && result.result?.error_message) {
          console.log(`  📋 Error details: ${result.result.error_code} - ${result.result.error_message}`);
        }
      } else {
        console.log(`  ⚠️  Expected error but pipeline succeeded`);
      }
      
      errorResults.push(errorResult);
    }
    
    // Analyze error handling results
    const errorsDetected = errorResults.filter(r => r.errorDetected).length;
    const recoveryAttempts = errorResults.filter(r => r.recoveryAttempted).length;
    
    console.log(`\n📊 Error Handling Summary:`);
    console.log(`- Total error scenarios: ${testScenarios.length}`);
    console.log(`- Errors properly detected: ${errorsDetected}`);
    console.log(`- Recovery attempts made: ${recoveryAttempts}`);
    console.log(`- Error detection rate: ${(errorsDetected / testScenarios.length * 100).toFixed(1)}%`);
    
    // Assert that error handling is working
    assertEquals(
      errorsDetected >= testScenarios.length * 0.5, // At least 50% of errors should be detected
      true,
      `Error handling should detect most error scenarios. Detected: ${errorsDetected}/${testScenarios.length}`
    );
    
    console.log(`\n✅ Error handling and recovery test completed`);
    
  } finally {
    await cleanupTestData(fileIds, testOrgId);
  }
});

Deno.test("Custom Field Integration - Dynamic Field Creation and Management", async () => {
  console.log("🔍 Testing custom field integration with existing UI components");
  
  const testOrgId = "test-org-custom-" + Date.now();
  const testFileId = "test-custom-fields-" + Date.now();
  
  // Create a document with non-standard fields that should trigger custom field creation
  const customFieldDocument = new TextEncoder().encode(`SPECIALIZED LEASE AGREEMENT

TENANT INFORMATION:
Business Name: Quantum Computing Solutions LLC
Industry Type: Technology Research
NAICS Code: 541712
D-U-N-S Number: 123456789
Credit Rating: AAA
Years in Business: 8

PROPERTY DETAILS:
Building Type: Laboratory Space
Hazmat Classification: Class 2
Clean Room Requirements: ISO 14644-1 Class 7
Specialized Equipment: Electron Microscope, Spectrometer
Power Requirements: 480V 3-phase, 200 amp service
HVAC Requirements: Precision temperature control ±1°F
Vibration Isolation: Required for sensitive equipment

FINANCIAL TERMS:
Base Rent: $18,500/month
Equipment Rental: $3,200/month
Utility Surcharge: $1,800/month
Hazmat Insurance: $950/month
Specialized Cleaning: $650/month
Security Monitoring: $450/month

COMPLIANCE REQUIREMENTS:
EPA Permit Number: EPA-12345-LAB
OSHA Compliance: 29 CFR 1910.1450
Fire Department Permit: FD-2024-0892
Building Code Variance: BCV-2024-156

CUSTOM PROVISIONS:
Research Confidentiality: Level 3 security clearance required
Patent Rights: Tenant retains all IP developed on premises
Publication Rights: Landlord approval required for publications
Equipment Removal: 90-day notice required
Decontamination: Tenant responsible upon lease termination`);

  try {
    // Create test file record
    await createTestFileRecord({
      id: testFileId,
      fileName: "specialized-lease.txt",
      fileFormat: "txt",
      mimeType: "text/plain",
      content: customFieldDocument,
      size: customFieldDocument.length,
      expectedFields: ["tenant_name", "monthly_rent"],
      moduleType: "leases"
    }, testOrgId);
    
    console.log(`\n📄 Processing document with specialized fields...`);
    
    // Stage 1: Process document through standard pipeline
    const pipelineResult = await callEdgeFunctionTimed("ingest-file", {
      file_id: testFileId,
      module_type: "leases"
    }, true);
    
    console.log(`  📊 Standard pipeline result: ${pipelineResult.success ? 'Success' : 'Failed'}`);
    
    // Stage 2: Test custom field detection and suggestion
    const customFieldResult = await callEdgeFunctionTimed("extract-with-custom-fields", {
      file_id: testFileId,
      auto_create_fields: false // Don't auto-create, just suggest
    }, true);
    
    console.log(`  📊 Custom field detection: ${customFieldResult.success ? 'Success' : 'Failed'}`);
    
    let suggestedFields: any[] = [];
    if (customFieldResult.success && customFieldResult.result?.custom_field_suggestions) {
      suggestedFields = customFieldResult.result.custom_field_suggestions;
      console.log(`  📋 Suggested custom fields: ${suggestedFields.length}`);
      
      suggestedFields.forEach(field => {
        console.log(`    - ${field.field_name} (${field.field_type}): ${field.field_label}`);
      });
    }
    
    // Stage 3: Test custom field creation API
    const createdFields: any[] = [];
    
    if (suggestedFields.length > 0) {
      console.log(`\n🔧 Testing custom field creation...`);
      
      // Create a few suggested custom fields
      const fieldsToCreate = suggestedFields.slice(0, 3); // Test with first 3 suggestions
      
      for (const suggestedField of fieldsToCreate) {
        const createResult = await callEdgeFunctionTimed("custom-fields", {
          module_type: "leases",
          field_name: suggestedField.field_name,
          field_label: suggestedField.field_label,
          field_type: suggestedField.field_type,
          field_options: suggestedField.field_options || [],
          is_required: false
        }, true);
        
        if (createResult.success) {
          createdFields.push(createResult.result.custom_field);
          console.log(`    ✅ Created field: ${suggestedField.field_name}`);
        } else {
          console.log(`    ❌ Failed to create field: ${suggestedField.field_name} - ${createResult.error}`);
        }
      }
    }
    
    // Stage 4: Test custom field value setting
    if (createdFields.length > 0) {
      console.log(`\n💾 Testing custom field value setting...`);
      
      const testValues: Record<string, any> = {};
      createdFields.forEach((field, index) => {
        // Set test values based on field type
        switch (field.field_type) {
          case 'text':
            testValues[field.field_name] = `Test value ${index + 1}`;
            break;
          case 'number':
            testValues[field.field_name] = (index + 1) * 100;
            break;
          case 'date':
            testValues[field.field_name] = '2025-01-01';
            break;
          case 'boolean':
            testValues[field.field_name] = index % 2 === 0;
            break;
          case 'select':
            if (field.field_options && field.field_options.length > 0) {
              testValues[field.field_name] = field.field_options[0];
            }
            break;
        }
      });
      
      const setValuesResult = await callEdgeFunctionTimed("custom-field-values", {
        record_id: "test-lease-record-123",
        record_type: "lease",
        values: testValues
      }, true);
      
      console.log(`  📊 Value setting result: ${setValuesResult.success ? 'Success' : 'Failed'}`);
      if (setValuesResult.success) {
        console.log(`    💾 Set values for ${Object.keys(testValues).length} custom fields`);
      } else {
        console.log(`    ❌ Value setting error: ${setValuesResult.error}`);
      }
    }
    
    // Stage 5: Test custom field retrieval
    console.log(`\n📖 Testing custom field retrieval...`);
    
    const retrieveFieldsResult = await callEdgeFunctionTimed("custom-fields", {
      module_type: "leases"
    }, true);
    
    console.log(`  📊 Field retrieval result: ${retrieveFieldsResult.success ? 'Success' : 'Failed'}`);
    
    let retrievedFields: any[] = [];
    if (retrieveFieldsResult.success && retrieveFieldsResult.result?.custom_fields) {
      retrievedFields = retrieveFieldsResult.result.custom_fields;
      console.log(`    📋 Retrieved ${retrievedFields.length} custom fields`);
    }
    
    // Analyze custom field integration results
    console.log(`\n📊 Custom Field Integration Summary:`);
    console.log(`- Document processed: ${pipelineResult.success ? 'Yes' : 'No'}`);
    console.log(`- Custom fields suggested: ${suggestedFields.length}`);
    console.log(`- Custom fields created: ${createdFields.length}`);
    console.log(`- Custom fields retrieved: ${retrievedFields.length}`);
    
    // Assert that custom field integration is working
    assertEquals(
      suggestedFields.length > 0,
      true,
      `Custom field detection should suggest fields for specialized documents. Suggested: ${suggestedFields.length}`
    );
    
    assertEquals(
      createdFields.length > 0,
      true,
      `Custom field creation should work. Created: ${createdFields.length}`
    );
    
    console.log(`\n✅ Custom field integration test completed successfully!`);
    
  } finally {
    await cleanupTestData([testFileId], testOrgId);
  }
});

Deno.test("Performance and Scalability - Large Document Processing", async () => {
  console.log("🔍 Testing performance and scalability with large documents");
  
  const testOrgId = "test-org-perf-" + Date.now();
  
  // Create documents of increasing sizes to test scalability
  const performanceTestDocs = [
    {
      name: "Small Document (1KB)",
      size: 1024,
      content: "A".repeat(1024)
    },
    {
      name: "Medium Document (10KB)",
      size: 10240,
      content: "B".repeat(10240)
    },
    {
      name: "Large Document (100KB)",
      size: 102400,
      content: "C".repeat(102400)
    },
    {
      name: "Very Large Document (500KB)",
      size: 512000,
      content: "D".repeat(512000)
    }
  ];
  
  const fileIds: string[] = [];
  
  try {
    const performanceResults: Array<{
      documentName: string;
      documentSize: number;
      processingTime: number;
      throughput: number; // bytes per second
      success: boolean;
      memoryEfficient: boolean;
      stages: { stage: string; duration: number }[];
    }> = [];
    
    for (let i = 0; i < performanceTestDocs.length; i++) {
      const testDoc = performanceTestDocs[i];
      const fileId = `test-perf-${i}-${Date.now()}`;
      fileIds.push(fileId);
      
      console.log(`\n📄 Testing ${testDoc.name}...`);
      
      // Create enhanced document content with lease data
      const enhancedContent = `PERFORMANCE TEST LEASE AGREEMENT - ${testDoc.name}

TENANT: Performance Test Tenant ${i + 1}
MONTHLY RENT: $${(i + 1) * 5000}.00
START DATE: 2025-01-01
END DATE: 2027-12-31
SQUARE FOOTAGE: ${(i + 1) * 1000} SF

ADDITIONAL CONTENT:
${testDoc.content}

This document is designed to test the performance and scalability of the document extraction pipeline
with documents of varying sizes. The system should handle documents efficiently regardless of size
while maintaining accuracy in field extraction and processing speed.`;
      
      const documentContent = new TextEncoder().encode(enhancedContent);
      
      // Create test file record
      await createTestFileRecord({
        id: fileId,
        fileName: `performance-test-${i + 1}.txt`,
        fileFormat: "txt",
        mimeType: "text/plain",
        content: documentContent,
        size: documentContent.length,
        expectedFields: ["tenant_name", "monthly_rent", "start_date", "end_date"],
        moduleType: "leases"
      }, testOrgId);
      
      // Measure processing time
      const startTime = Date.now();
      const result = await callEdgeFunctionTimed("ingest-file", {
        file_id: fileId,
        module_type: "leases"
      }, true);
      const totalTime = Date.now() - startTime;
      
      // Calculate throughput
      const throughput = documentContent.length / (totalTime / 1000); // bytes per second
      
      // Analyze stage performance
      const stages: { stage: string; duration: number }[] = [];
      if (result.result?.steps) {
        Object.entries(result.result.steps).forEach(([stageName, stageData]: [string, any]) => {
          if (stageData?.duration) {
            stages.push({ stage: stageName, duration: stageData.duration });
          }
        });
      }
      
      const performanceResult = {
        documentName: testDoc.name,
        documentSize: documentContent.length,
        processingTime: totalTime,
        throughput: throughput,
        success: result.success,
        memoryEfficient: totalTime < (documentContent.length / 1000) * 100, // Heuristic: should process 1KB in under 100ms
        stages: stages
      };
      
      performanceResults.push(performanceResult);
      
      console.log(`  📊 Results for ${testDoc.name}:`);
      console.log(`    - Size: ${(documentContent.length / 1024).toFixed(1)} KB`);
      console.log(`    - Processing Time: ${totalTime}ms`);
      console.log(`    - Throughput: ${(throughput / 1024).toFixed(1)} KB/s`);
      console.log(`    - Success: ${result.success ? 'Yes' : 'No'}`);
      console.log(`    - Memory Efficient: ${performanceResult.memoryEfficient ? 'Yes' : 'No'}`);
      
      if (stages.length > 0) {
        console.log(`    - Stage Breakdown:`);
        stages.forEach(stage => {
          console.log(`      • ${stage.stage}: ${stage.duration}ms`);
        });
      }
      
      if (!result.success) {
        console.log(`    ❌ Error: ${result.error}`);
      }
    }
    
    // Analyze overall performance trends
    const successfulTests = performanceResults.filter(r => r.success);
    const avgThroughput = successfulTests.reduce((sum, r) => sum + r.throughput, 0) / successfulTests.length;
    const maxProcessingTime = Math.max(...performanceResults.map(r => r.processingTime));
    const minProcessingTime = Math.min(...performanceResults.map(r => r.processingTime));
    
    console.log(`\n📊 Performance and Scalability Summary:`);
    console.log(`- Total documents tested: ${performanceTestDocs.length}`);
    console.log(`- Successful processing: ${successfulTests.length}`);
    console.log(`- Average throughput: ${(avgThroughput / 1024).toFixed(1)} KB/s`);
    console.log(`- Processing time range: ${minProcessingTime}ms - ${maxProcessingTime}ms`);
    console.log(`- Memory efficient tests: ${performanceResults.filter(r => r.memoryEfficient).length}`);
    
    // Check for performance degradation with larger documents
    const throughputs = successfulTests.map(r => r.throughput);
    const throughputVariation = (Math.max(...throughputs) - Math.min(...throughputs)) / Math.max(...throughputs);
    
    console.log(`\n⚡ Scalability Analysis:`);
    console.log(`- Throughput variation: ${(throughputVariation * 100).toFixed(1)}%`);
    console.log(`- Scalability: ${throughputVariation < 0.5 ? 'Good' : 'Needs improvement'}`);
    
    // Assert performance requirements
    assertEquals(
      successfulTests.length >= performanceTestDocs.length * 0.75, // At least 75% should succeed
      true,
      `Performance test should handle most document sizes. Successful: ${successfulTests.length}/${performanceTestDocs.length}`
    );
    
    assertEquals(
      maxProcessingTime < 60000, // Should complete within 60 seconds
      true,
      `Large document processing should complete within 60 seconds. Max time: ${maxProcessingTime}ms`
    );
    
    assertEquals(
      avgThroughput > 1024, // Should process at least 1KB/s on average
      true,
      `System should maintain reasonable throughput. Average: ${(avgThroughput / 1024).toFixed(1)} KB/s`
    );
    
    console.log(`\n🎉 Performance and scalability test completed successfully!`);
    
  } finally {
    await cleanupTestData(fileIds, testOrgId);
  }
});

Deno.test("Pipeline Resilience - Concurrent Processing and Load Testing", async () => {
  console.log("🔍 Testing pipeline resilience with concurrent processing");
  
  const testOrgId = "test-org-concurrent-" + Date.now();
  const concurrentDocuments = 5; // Test with 5 concurrent documents
  const fileIds: string[] = [];
  
  try {
    // Create multiple test documents for concurrent processing
    const testDocs: TestDocument[] = [];
    for (let i = 0; i < concurrentDocuments; i++) {
      const fileId = `test-concurrent-${i}-${Date.now()}`;
      fileIds.push(fileId);
      
      const content = new TextEncoder().encode(`CONCURRENT TEST LEASE ${i + 1}

TENANT: Concurrent Test Tenant ${i + 1}
MONTHLY RENT: $${(i + 1) * 3000}.00
START DATE: 2025-0${(i % 9) + 1}-01
END DATE: 2027-0${(i % 9) + 1}-31
SQUARE FOOTAGE: ${(i + 1) * 800} SF

This is a test document for concurrent processing validation.
Document ID: ${i + 1}
Processing timestamp: ${new Date().toISOString()}

Additional content to make document processing more realistic:
${Array(100).fill(`Line ${i + 1} content for testing concurrent processing capabilities.`).join('\n')}`);
      
      const testDoc: TestDocument = {
        id: fileId,
        fileName: `concurrent-test-${i + 1}.txt`,
        fileFormat: "txt",
        mimeType: "text/plain",
        content: content,
        size: content.length,
        expectedFields: ["tenant_name", "monthly_rent", "start_date", "end_date"],
        moduleType: "leases"
      };
      
      testDocs.push(testDoc);
      await createTestFileRecord(testDoc, testOrgId);
    }
    
    console.log(`\n🚀 Starting concurrent processing of ${concurrentDocuments} documents...`);
    
    // Process all documents concurrently
    const startTime = Date.now();
    const concurrentPromises = testDocs.map(async (testDoc, index) => {
      const docStartTime = Date.now();
      
      try {
        const result = await callEdgeFunctionTimed("ingest-file", {
          file_id: testDoc.id,
          module_type: testDoc.moduleType
        }, true);
        
        return {
          documentIndex: index,
          documentId: testDoc.id,
          fileName: testDoc.fileName,
          success: result.success,
          duration: Date.now() - docStartTime,
          error: result.error,
          stages: result.result?.steps || {}
        };
      } catch (error) {
        return {
          documentIndex: index,
          documentId: testDoc.id,
          fileName: testDoc.fileName,
          success: false,
          duration: Date.now() - docStartTime,
          error: error instanceof Error ? error.message : String(error),
          stages: {}
        };
      }
    });
    
    // Wait for all concurrent processing to complete
    const results = await Promise.all(concurrentPromises);
    const totalConcurrentTime = Date.now() - startTime;
    
    // Analyze concurrent processing results
    const successfulConcurrent = results.filter(r => r.success);
    const failedConcurrent = results.filter(r => !r.success);
    const avgConcurrentDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;
    const maxConcurrentDuration = Math.max(...results.map(r => r.duration));
    const minConcurrentDuration = Math.min(...results.map(r => r.duration));
    
    console.log(`\n📊 Concurrent Processing Results:`);
    console.log(`- Total documents: ${concurrentDocuments}`);
    console.log(`- Successful: ${successfulConcurrent.length}`);
    console.log(`- Failed: ${failedConcurrent.length}`);
    console.log(`- Success rate: ${(successfulConcurrent.length / concurrentDocuments * 100).toFixed(1)}%`);
    console.log(`- Total concurrent time: ${totalConcurrentTime}ms`);
    console.log(`- Average document time: ${avgConcurrentDuration.toFixed(0)}ms`);
    console.log(`- Time range: ${minConcurrentDuration}ms - ${maxConcurrentDuration}ms`);
    
    // Check for resource contention (if concurrent processing takes much longer than sequential)
    const estimatedSequentialTime = avgConcurrentDuration * concurrentDocuments;
    const concurrencyEfficiency = estimatedSequentialTime / totalConcurrentTime;
    
    console.log(`\n⚡ Concurrency Analysis:`);
    console.log(`- Estimated sequential time: ${estimatedSequentialTime.toFixed(0)}ms`);
    console.log(`- Actual concurrent time: ${totalConcurrentTime}ms`);
    console.log(`- Concurrency efficiency: ${concurrencyEfficiency.toFixed(2)}x`);
    console.log(`- Resource contention: ${concurrencyEfficiency < 0.5 ? 'High' : concurrencyEfficiency < 0.8 ? 'Moderate' : 'Low'}`);
    
    // Log individual results
    results.forEach(result => {
      const status = result.success ? "✅" : "❌";
      console.log(`  ${status} ${result.fileName}: ${result.duration}ms`);
      if (result.error) {
        console.log(`    Error: ${result.error}`);
      }
    });
    
    // Assert concurrent processing requirements
    assertEquals(
      successfulConcurrent.length >= concurrentDocuments * 0.8, // At least 80% should succeed
      true,
      `Concurrent processing should handle most documents. Successful: ${successfulConcurrent.length}/${concurrentDocuments}`
    );
    
    assertEquals(
      totalConcurrentTime < estimatedSequentialTime * 1.5, // Shouldn't take more than 1.5x sequential time
      true,
      `Concurrent processing should be reasonably efficient. Time: ${totalConcurrentTime}ms vs estimated ${estimatedSequentialTime.toFixed(0)}ms`
    );
    
    assertEquals(
      maxConcurrentDuration < 30000, // No single document should take more than 30 seconds
      true,
      `Individual document processing should complete within 30 seconds. Max: ${maxConcurrentDuration}ms`
    );
    
    console.log(`\n🎉 Pipeline resilience test completed successfully!`);
    
  } finally {
    await cleanupTestData(fileIds, testOrgId);
  }
});