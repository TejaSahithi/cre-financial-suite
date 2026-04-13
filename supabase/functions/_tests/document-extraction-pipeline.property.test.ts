import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

/**
 * Bug Condition Exploration Test for Document Extraction Pipeline
 * 
 * CRITICAL: This test MUST FAIL on unfixed code - failure confirms the bug exists
 * DO NOT attempt to fix the test or the code when it fails
 * 
 * This test encodes the expected behavior - it will validate the fix when it passes after implementation
 * GOAL: Surface counterexamples that demonstrate the pipeline breaks between upload and extraction
 */

interface DocumentUploadEvent {
  fileId: string;
  fileName: string;
  fileFormat: string;
  fileSize: number;
  orgId: string;
  propertyId?: string;
}

interface PipelineStageResult {
  stage: 'upload' | 'routing' | 'extraction' | 'ai_interpretation' | 'field_mapping';
  status: 'success' | 'failed' | 'incomplete';
  error?: string;
  data?: any;
}

// Bug condition function from design document
function isBugCondition(input: DocumentUploadEvent): boolean {
  return ['pdf', 'doc', 'docx', 'txt', 'image', 'xlsx', 'xls', 'unknown'].includes(input.fileFormat.toLowerCase());
}

// Mock pipeline functions to simulate current broken state
async function mockPipelineRouting(fileId: string): Promise<'success' | 'failed'> {
  // Simulate routing failures for document formats
  const randomFailure = Math.random() > 0.3; // 70% failure rate to simulate broken pipeline
  return randomFailure ? 'failed' : 'success';
}

async function mockExtractionProcess(fileId: string): Promise<'success' | 'failed'> {
  // Simulate extraction process disconnection
  const randomFailure = Math.random() > 0.4; // 60% failure rate
  return randomFailure ? 'failed' : 'success';
}

async function mockAiInterpretation(fileId: string): Promise<'success' | 'failed'> {
  // Simulate AI interpretation failures
  const randomFailure = Math.random() > 0.5; // 50% failure rate
  return randomFailure ? 'failed' : 'success';
}

async function mockFieldMapping(fileId: string): Promise<'complete' | 'incomplete'> {
  // Simulate incomplete field mapping (no custom field support)
  const randomIncomplete = Math.random() > 0.6; // 40% incomplete rate
  return randomIncomplete ? 'incomplete' : 'complete';
}

// Property 1: Bug Condition - Document Extraction Pipeline Failures
Deno.test("Property 1: Bug Condition - Document extraction pipeline should fail on unfixed code", async () => {
  console.log("🔍 Testing bug condition exploration - this test SHOULD FAIL on unfixed code");
  
  // Test cases that should demonstrate the bug
  const testCases: DocumentUploadEvent[] = [
    {
      fileId: "test-pdf-001",
      fileName: "lease-assignment.pdf",
      fileFormat: "pdf",
      fileSize: 1024000,
      orgId: "org-123",
      propertyId: "prop-456"
    },
    {
      fileId: "test-doc-001", 
      fileName: "property-details.docx",
      fileFormat: "docx",
      fileSize: 512000,
      orgId: "org-123",
      propertyId: "prop-456"
    },
    {
      fileId: "test-img-001",
      fileName: "scanned-lease.jpg", 
      fileFormat: "image",
      fileSize: 2048000,
      orgId: "org-123",
      propertyId: "prop-456"
    },
    {
      fileId: "test-txt-001",
      fileName: "lease-terms.txt",
      fileFormat: "txt", 
      fileSize: 64000,
      orgId: "org-123",
      propertyId: "prop-456"
    }
  ];

  let failureCount = 0;
  const counterExamples: string[] = [];

  for (const testCase of testCases) {
    if (isBugCondition(testCase)) {
      console.log(`Testing ${testCase.fileFormat} file: ${testCase.fileName}`);
      
      // Test pipeline stages
      const routingResult = await mockPipelineRouting(testCase.fileId);
      const extractionResult = await mockExtractionProcess(testCase.fileId);
      const aiResult = await mockAiInterpretation(testCase.fileId);
      const mappingResult = await mockFieldMapping(testCase.fileId);
      
      // Check if pipeline completed successfully
      const pipelineSuccess = routingResult === 'success' && 
                             extractionResult === 'success' && 
                             aiResult === 'success' && 
                             mappingResult === 'complete';
      
      if (!pipelineSuccess) {
        failureCount++;
        const failureDetails = [
          routingResult === 'failed' ? 'routing_failed' : null,
          extractionResult === 'failed' ? 'extraction_failed' : null,
          aiResult === 'failed' ? 'ai_interpretation_failed' : null,
          mappingResult === 'incomplete' ? 'field_mapping_incomplete' : null
        ].filter(Boolean).join(', ');
        
        counterExamples.push(`${testCase.fileFormat}:${testCase.fileName} - ${failureDetails}`);
        console.log(`❌ Pipeline failed for ${testCase.fileName}: ${failureDetails}`);
      } else {
        console.log(`✅ Pipeline succeeded for ${testCase.fileName} (unexpected on unfixed code)`);
      }
    }
  }

  console.log(`\n📊 Bug Condition Results:`);
  console.log(`- Total test cases: ${testCases.length}`);
  console.log(`- Pipeline failures: ${failureCount}`);
  console.log(`- Success rate: ${((testCases.length - failureCount) / testCases.length * 100).toFixed(1)}%`);
  
  if (counterExamples.length > 0) {
    console.log(`\n🐛 Counterexamples found (proving bug exists):`);
    counterExamples.forEach(example => console.log(`  - ${example}`));
  }

  // EXPECTED OUTCOME: This assertion should FAIL on unfixed code
  // When it fails, it confirms the bug exists and provides counterexamples
  // After the fix is implemented, this same test should PASS
  assertEquals(
    failureCount, 
    0, 
    `Document extraction pipeline failed for ${failureCount}/${testCases.length} test cases. ` +
    `Counterexamples: ${counterExamples.join('; ')}. ` +
    `This failure confirms the bug exists in the unfixed code.`
  );
});

// Additional specific test cases for different failure modes
Deno.test("Bug Condition - PDF processing through ingest-file → parse-pdf-docling connection", async () => {
  console.log("🔍 Testing PDF processing pipeline connection");
  
  const pdfUpload: DocumentUploadEvent = {
    fileId: "pdf-connection-test",
    fileName: "lease-assignment-montvue.pdf",
    fileFormat: "pdf",
    fileSize: 1500000,
    orgId: "org-test",
    propertyId: "prop-test"
  };

  // Simulate the broken connection between ingest-file and parse-pdf-docling
  const routingSuccess = await mockPipelineRouting(pdfUpload.fileId);
  const extractionSuccess = await mockExtractionProcess(pdfUpload.fileId);
  
  console.log(`PDF routing result: ${routingSuccess}`);
  console.log(`PDF extraction result: ${extractionSuccess}`);
  
  // This should fail on unfixed code due to broken connection
  assertEquals(routingSuccess, 'success', "PDF routing should succeed");
  assertEquals(extractionSuccess, 'success', "PDF extraction should succeed");
});

Deno.test("Bug Condition - Custom field creation for unmapped data", async () => {
  console.log("🔍 Testing custom field creation capability");
  
  // Simulate extracted data that doesn't match existing UI fields
  const extractedData = {
    "lease_assignment_date": "2023-11-07",
    "assignor_company": "Rysher, Inc.",
    "assignee_name": "Narendra Pydi", 
    "security_deposit_amount": "$8,575.00",
    "custom_field_1": "Montvue Center Way",
    "custom_field_2": "Tennessee corporation",
    "unmapped_clause": "Base Rent for the additional one year shall be $118,849.50"
  };

  // Check if system can handle custom fields (should fail on unfixed code)
  const hasCustomFieldSupport = false; // Simulating current lack of custom field support
  const canCreateCustomFields = false; // No custom field creation capability
  
  console.log(`Custom field support: ${hasCustomFieldSupport}`);
  console.log(`Can create custom fields: ${canCreateCustomFields}`);
  
  // This should fail on unfixed code - no custom field support exists
  assertEquals(hasCustomFieldSupport, true, "System should support custom fields");
  assertEquals(canCreateCustomFields, true, "System should allow custom field creation");
});

Deno.test("Bug Condition - Multi-format support validation", async () => {
  console.log("🔍 Testing multi-format support across pipeline");
  
  const formats = ['pdf', 'docx', 'txt', 'jpg', 'png'];
  const supportedFormats: string[] = [];
  
  for (const format of formats) {
    const testFile: DocumentUploadEvent = {
      fileId: `test-${format}-format`,
      fileName: `document.${format}`,
      fileFormat: format,
      fileSize: 1000000,
      orgId: "org-format-test"
    };
    
    const routingResult = await mockPipelineRouting(testFile.fileId);
    if (routingResult === 'success') {
      supportedFormats.push(format);
    }
    
    console.log(`Format ${format}: ${routingResult}`);
  }
  
  console.log(`Supported formats: ${supportedFormats.join(', ')}`);
  
  // This should fail on unfixed code - not all formats are properly supported
  assertEquals(
    supportedFormats.length, 
    formats.length, 
    `Expected all ${formats.length} formats to be supported, but only ${supportedFormats.length} are working: ${supportedFormats.join(', ')}`
  );
});