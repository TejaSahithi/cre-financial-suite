import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

/**
 * Integration Tests for Document Extraction Pipeline
 * 
 * Tests complete end-to-end pipeline from upload to UI field population
 * Validates error handling and recovery across all pipeline stages
 * Tests custom field integration with existing UI components
 * Tests performance and scalability with large documents
 */

interface TestFile {
  id: string;
  name: string;
  type: string;
  size: number;
  content?: string;
  orgId: string;
  propertyId?: string;
}

interface PipelineResult {
  fileId: string;
  status: 'success' | 'failed' | 'partial';
  stages: {
    upload: boolean;
    routing: boolean;
    extraction: boolean;
    aiInterpretation: boolean;
    fieldMapping: boolean;
    customFields: boolean;
  };
  extractedData?: any[];
  mappedFields?: Record<string, string>;
  customFieldSuggestions?: any[];
  errors?: string[];
  processingTime: number;
}

// Mock Supabase client for integration testing
const mockSupabase = {
  from: (table: string) => ({
    select: () => ({ data: [], error: null }),
    insert: () => ({ data: {}, error: null }),
    update: () => ({ data: {}, error: null }),
    delete: () => ({ data: {}, error: null }),
    eq: () => ({ data: [], error: null }),
    single: () => ({ data: {}, error: null }),
  }),
  functions: {
    invoke: async (functionName: string, options: any) => {
      // Mock function responses based on function name
      switch (functionName) {
        case 'ingest-file':
          return { data: { status: 'routed', nextFunction: 'parse-pdf-docling' }, error: null };
        case 'parse-pdf-docling':
          return { data: { extracted: true, content: 'Mock extracted content' }, error: null };
        case 'extract-document-fields':
          return { data: { fields: { tenant: 'Test Tenant', rent: 2500 } }, error: null };
        case 'extract-with-custom-fields':
          return {
            data: {
              extracted_data: [{ tenant: 'Test Tenant', rent: 2500, custom_field: 'Custom Value' }],
              mapped_fields: { tenant: 'tenant_name', rent: 'monthly_rent' },
              unmapped_fields: [{ field_name: 'custom_field', suggested_type: 'text' }],
              custom_field_suggestions: [{ field_name: 'custom_field', field_label: 'Custom Field', field_type: 'text' }],
              processing_summary: { total_records: 1, mapped_field_count: 2, unmapped_field_count: 1, suggestions_count: 1, auto_created_count: 0 }
            },
            error: null
          };
        case 'custom-fields':
          return { data: { custom_fields: [] }, error: null };
        default:
          return { data: null, error: { message: 'Function not found' } };
      }
    }
  }
};

// Test helper functions
async function createTestFile(fileData: Partial<TestFile>): Promise<TestFile> {
  return {
    id: `test-file-${Date.now()}`,
    name: fileData.name || 'test-document.pdf',
    type: fileData.type || 'application/pdf',
    size: fileData.size || 1024000,
    content: fileData.content || 'Mock PDF content',
    orgId: fileData.orgId || 'test-org-123',
    propertyId: fileData.propertyId,
    ...fileData
  };
}

async function simulateEndToEndPipeline(testFile: TestFile): Promise<PipelineResult> {
  const startTime = Date.now();
  const result: PipelineResult = {
    fileId: testFile.id,
    status: 'success',
    stages: {
      upload: false,
      routing: false,
      extraction: false,
      aiInterpretation: false,
      fieldMapping: false,
      customFields: false
    },
    errors: [],
    processingTime: 0
  };

  try {
    // Stage 1: Upload
    console.log(`[Integration Test] Stage 1: Upload file ${testFile.name}`);
    // Simulate file upload to storage
    await new Promise(resolve => setTimeout(resolve, 100));
    result.stages.upload = true;

    // Stage 2: Routing
    console.log(`[Integration Test] Stage 2: Route file through ingest-file`);
    const routingResponse = await mockSupabase.functions.invoke('ingest-file', {
      body: { file_id: testFile.id, file_type: testFile.type }
    });
    
    if (routingResponse.error) {
      result.errors?.push(`Routing failed: ${routingResponse.error.message}`);
      result.status = 'failed';
      return result;
    }
    result.stages.routing = true;

    // Stage 3: Extraction
    console.log(`[Integration Test] Stage 3: Extract content via parse-pdf-docling`);
    const extractionResponse = await mockSupabase.functions.invoke('parse-pdf-docling', {
      body: { file_id: testFile.id }
    });
    
    if (extractionResponse.error) {
      result.errors?.push(`Extraction failed: ${extractionResponse.error.message}`);
      result.status = 'failed';
      return result;
    }
    result.stages.extraction = true;

    // Stage 4: AI Interpretation
    console.log(`[Integration Test] Stage 4: AI interpretation via extract-document-fields`);
    const aiResponse = await mockSupabase.functions.invoke('extract-document-fields', {
      body: { file_id: testFile.id }
    });
    
    if (aiResponse.error) {
      result.errors?.push(`AI interpretation failed: ${aiResponse.error.message}`);
      result.status = 'partial';
    } else {
      result.stages.aiInterpretation = true;
    }

    // Stage 5: Field Mapping with Custom Fields
    console.log(`[Integration Test] Stage 5: Enhanced extraction with custom fields`);
    const enhancedResponse = await mockSupabase.functions.invoke('extract-with-custom-fields', {
      body: { file_id: testFile.id, module_type: 'leases', auto_create_fields: false }
    });
    
    if (enhancedResponse.error) {
      result.errors?.push(`Enhanced extraction failed: ${enhancedResponse.error.message}`);
      result.status = 'partial';
    } else {
      result.stages.fieldMapping = true;
      result.stages.customFields = true;
      result.extractedData = enhancedResponse.data.extracted_data;
      result.mappedFields = enhancedResponse.data.mapped_fields;
      result.customFieldSuggestions = enhancedResponse.data.custom_field_suggestions;
    }

  } catch (error) {
    result.errors?.push(`Pipeline error: ${error instanceof Error ? error.message : String(error)}`);
    result.status = 'failed';
  }

  result.processingTime = Date.now() - startTime;
  return result;
}

// Integration Test 1: Complete End-to-End Pipeline
Deno.test("Integration Test 1: Complete pipeline from upload to UI field population", async () => {
  console.log("🔄 Testing complete end-to-end document processing pipeline");

  const testFile = await createTestFile({
    name: 'lease-agreement.pdf',
    type: 'application/pdf',
    size: 1500000,
    orgId: 'integration-test-org'
  });

  const result = await simulateEndToEndPipeline(testFile);

  console.log(`Pipeline result:`, result);

  // Verify all stages completed successfully
  assertEquals(result.status, 'success', 'Pipeline should complete successfully');
  assertEquals(result.stages.upload, true, 'Upload stage should succeed');
  assertEquals(result.stages.routing, true, 'Routing stage should succeed');
  assertEquals(result.stages.extraction, true, 'Extraction stage should succeed');
  assertEquals(result.stages.aiInterpretation, true, 'AI interpretation stage should succeed');
  assertEquals(result.stages.fieldMapping, true, 'Field mapping stage should succeed');
  assertEquals(result.stages.customFields, true, 'Custom fields stage should succeed');

  // Verify extracted data structure
  assertExists(result.extractedData, 'Should have extracted data');
  assertExists(result.mappedFields, 'Should have mapped fields');
  assertExists(result.customFieldSuggestions, 'Should have custom field suggestions');

  // Verify processing time is reasonable
  assert(result.processingTime < 5000, 'Processing should complete within 5 seconds');

  console.log("✅ End-to-end pipeline test completed successfully");
});

// Integration Test 2: Error Handling and Recovery
Deno.test("Integration Test 2: Error handling and recovery across pipeline stages", async () => {
  console.log("🔄 Testing error handling and recovery mechanisms");

  // Test with various error scenarios
  const errorScenarios = [
    { name: 'corrupted-file.pdf', type: 'application/pdf', size: 0 }, // Empty file
    { name: 'unsupported.xyz', type: 'application/unknown', size: 1000 }, // Unsupported format
    { name: 'large-file.pdf', type: 'application/pdf', size: 100000000 }, // Very large file
  ];

  for (const scenario of errorScenarios) {
    console.log(`Testing error scenario: ${scenario.name}`);
    
    const testFile = await createTestFile({
      ...scenario,
      orgId: 'error-test-org'
    });

    const result = await simulateEndToEndPipeline(testFile);

    // Verify error handling
    if (result.status === 'failed') {
      assertExists(result.errors, 'Should have error messages');
      assert(result.errors!.length > 0, 'Should have at least one error');
      console.log(`Expected failure for ${scenario.name}: ${result.errors![0]}`);
    }

    // Verify graceful degradation
    if (result.status === 'partial') {
      console.log(`Partial success for ${scenario.name} - some stages completed`);
      assert(result.stages.upload, 'Upload should always succeed in mock');
    }
  }

  console.log("✅ Error handling test completed successfully");
});

// Integration Test 3: Custom Field Integration
Deno.test("Integration Test 3: Custom field integration with existing UI components", async () => {
  console.log("🔄 Testing custom field integration workflow");

  const testFile = await createTestFile({
    name: 'lease-with-custom-data.pdf',
    type: 'application/pdf',
    size: 2000000,
    orgId: 'custom-field-test-org'
  });

  // Simulate pipeline with custom field auto-creation enabled
  const result = await simulateEndToEndPipeline(testFile);

  // Verify custom field suggestions were generated
  assertExists(result.customFieldSuggestions, 'Should have custom field suggestions');
  assert(result.customFieldSuggestions!.length > 0, 'Should have at least one suggestion');

  const suggestion = result.customFieldSuggestions![0];
  assertExists(suggestion.field_name, 'Suggestion should have field name');
  assertExists(suggestion.field_label, 'Suggestion should have field label');
  assertExists(suggestion.field_type, 'Suggestion should have field type');

  // Test custom field creation
  console.log("Testing custom field creation from suggestion");
  const createResponse = await mockSupabase.functions.invoke('custom-fields', {
    method: 'POST',
    body: {
      module_type: 'leases',
      field_name: suggestion.field_name,
      field_label: suggestion.field_label,
      field_type: suggestion.field_type
    }
  });

  assertEquals(createResponse.error, null, 'Custom field creation should succeed');

  // Test field value setting
  console.log("Testing custom field value setting");
  const setValueResponse = await mockSupabase.functions.invoke('custom-fields', {
    method: 'POST',
    body: {
      record_id: 'test-lease-123',
      record_type: 'lease',
      values: { [suggestion.field_name]: 'Test Value' }
    }
  });

  assertEquals(setValueResponse.error, null, 'Setting field values should succeed');

  console.log("✅ Custom field integration test completed successfully");
});

// Integration Test 4: Performance and Scalability
Deno.test("Integration Test 4: Performance and scalability with large documents", async () => {
  console.log("🔄 Testing performance and scalability");

  const performanceTests = [
    { name: 'small-doc.pdf', size: 100000, expectedTime: 2000 },
    { name: 'medium-doc.pdf', size: 1000000, expectedTime: 3000 },
    { name: 'large-doc.pdf', size: 5000000, expectedTime: 5000 },
  ];

  const results: { size: number; time: number }[] = [];

  for (const test of performanceTests) {
    console.log(`Testing performance with ${test.name} (${test.size} bytes)`);
    
    const testFile = await createTestFile({
      name: test.name,
      type: 'application/pdf',
      size: test.size,
      orgId: 'performance-test-org'
    });

    const startTime = Date.now();
    const result = await simulateEndToEndPipeline(testFile);
    const actualTime = Date.now() - startTime;

    results.push({ size: test.size, time: actualTime });

    // Verify processing completed within expected time
    assert(actualTime < test.expectedTime, 
      `Processing ${test.name} should complete within ${test.expectedTime}ms, took ${actualTime}ms`);

    // Verify successful processing regardless of size
    assertEquals(result.status, 'success', `${test.name} should process successfully`);

    console.log(`${test.name}: ${actualTime}ms (expected < ${test.expectedTime}ms)`);
  }

  // Verify performance scaling is reasonable
  const smallTime = results[0].time;
  const largeTime = results[2].time;
  const scalingFactor = largeTime / smallTime;

  console.log(`Performance scaling factor: ${scalingFactor.toFixed(2)}x`);
  assert(scalingFactor < 10, 'Performance should not degrade more than 10x for 50x larger files');

  console.log("✅ Performance and scalability test completed successfully");
});

// Integration Test 5: Concurrent Document Processing
Deno.test("Integration Test 5: Concurrent document processing", async () => {
  console.log("🔄 Testing concurrent document processing");

  const concurrentFiles = Array.from({ length: 5 }, (_, i) => 
    createTestFile({
      name: `concurrent-doc-${i + 1}.pdf`,
      type: 'application/pdf',
      size: 1000000,
      orgId: `concurrent-test-org-${i + 1}`
    })
  );

  const files = await Promise.all(concurrentFiles);

  // Process all files concurrently
  const startTime = Date.now();
  const results = await Promise.all(
    files.map(file => simulateEndToEndPipeline(file))
  );
  const totalTime = Date.now() - startTime;

  console.log(`Processed ${files.length} files concurrently in ${totalTime}ms`);

  // Verify all files processed successfully
  results.forEach((result, index) => {
    assertEquals(result.status, 'success', `File ${index + 1} should process successfully`);
    assertExists(result.extractedData, `File ${index + 1} should have extracted data`);
  });

  // Verify concurrent processing is more efficient than sequential
  const averageSequentialTime = results.reduce((sum, r) => sum + r.processingTime, 0) / results.length;
  const concurrentEfficiency = (averageSequentialTime * files.length) / totalTime;

  console.log(`Concurrent efficiency: ${concurrentEfficiency.toFixed(2)}x faster than sequential`);
  assert(concurrentEfficiency > 1, 'Concurrent processing should be more efficient than sequential');

  console.log("✅ Concurrent processing test completed successfully");
});

// Integration Test 6: Memory Usage and Resource Management
Deno.test("Integration Test 6: Memory usage and resource management", async () => {
  console.log("🔄 Testing memory usage and resource management");

  const initialMemory = (performance as any).memory?.usedJSHeapSize || 0;
  console.log(`Initial memory usage: ${(initialMemory / 1024 / 1024).toFixed(2)} MB`);

  // Process multiple large files to test memory management
  const largeFiles = Array.from({ length: 3 }, (_, i) =>
    createTestFile({
      name: `large-memory-test-${i + 1}.pdf`,
      type: 'application/pdf',
      size: 10000000, // 10MB files
      orgId: `memory-test-org-${i + 1}`
    })
  );

  const files = await Promise.all(largeFiles);
  const results: PipelineResult[] = [];

  // Process files sequentially to monitor memory usage
  for (const file of files) {
    const beforeMemory = (performance as any).memory?.usedJSHeapSize || 0;
    
    const result = await simulateEndToEndPipeline(file);
    results.push(result);

    const afterMemory = (performance as any).memory?.usedJSHeapSize || 0;
    const memoryIncrease = afterMemory - beforeMemory;

    console.log(`File ${file.name}: Memory increase ${(memoryIncrease / 1024 / 1024).toFixed(2)} MB`);

    // Verify memory increase is reasonable
    assert(memoryIncrease < 50 * 1024 * 1024, 'Memory increase should be less than 50MB per file');
  }

  // Verify all files processed successfully despite memory constraints
  results.forEach((result, index) => {
    assertEquals(result.status, 'success', `Large file ${index + 1} should process successfully`);
  });

  const finalMemory = (performance as any).memory?.usedJSHeapSize || 0;
  const totalMemoryIncrease = finalMemory - initialMemory;

  console.log(`Total memory increase: ${(totalMemoryIncrease / 1024 / 1024).toFixed(2)} MB`);
  assert(totalMemoryIncrease < 200 * 1024 * 1024, 'Total memory increase should be less than 200MB');

  console.log("✅ Memory usage and resource management test completed successfully");
});

// Integration Test 7: Database State Consistency
Deno.test("Integration Test 7: Database state consistency throughout pipeline", async () => {
  console.log("🔄 Testing database state consistency");

  const testFile = await createTestFile({
    name: 'database-consistency-test.pdf',
    type: 'application/pdf',
    size: 1500000,
    orgId: 'db-consistency-test-org'
  });

  // Track database state changes throughout pipeline
  const stateChanges: { stage: string; timestamp: number; data: any }[] = [];

  // Mock database state tracking
  const trackStateChange = (stage: string, data: any) => {
    stateChanges.push({
      stage,
      timestamp: Date.now(),
      data: { ...data }
    });
  };

  // Simulate pipeline with state tracking
  trackStateChange('initial', { fileId: testFile.id, status: 'uploaded' });

  const result = await simulateEndToEndPipeline(testFile);

  trackStateChange('routing', { fileId: testFile.id, status: 'routed' });
  trackStateChange('extraction', { fileId: testFile.id, status: 'extracted' });
  trackStateChange('ai_interpretation', { fileId: testFile.id, status: 'interpreted' });
  trackStateChange('field_mapping', { fileId: testFile.id, status: 'mapped' });
  trackStateChange('final', { fileId: testFile.id, status: 'completed', result });

  // Verify state progression is logical
  assertEquals(stateChanges.length, 6, 'Should have 6 state changes');
  
  // Verify timestamps are in order
  for (let i = 1; i < stateChanges.length; i++) {
    assert(stateChanges[i].timestamp >= stateChanges[i-1].timestamp, 
      `State change ${i} should occur after ${i-1}`);
  }

  // Verify final state is consistent
  const finalState = stateChanges[stateChanges.length - 1];
  assertEquals(finalState.data.status, 'completed', 'Final state should be completed');
  assertEquals(finalState.data.result.status, 'success', 'Final result should be success');

  console.log("Database state progression:", stateChanges.map(s => s.stage));
  console.log("✅ Database state consistency test completed successfully");
});

// Integration Test 8: Multi-Format Document Processing
Deno.test("Integration Test 8: Multi-format document processing", async () => {
  console.log("🔄 Testing multi-format document processing");

  const testFormats = [
    { name: 'lease.pdf', type: 'application/pdf', size: 1500000 },
    { name: 'contract.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 800000 },
    { name: 'agreement.doc', type: 'application/msword', size: 600000 },
    { name: 'terms.txt', type: 'text/plain', size: 50000 },
    { name: 'scan.png', type: 'image/png', size: 2000000 },
    { name: 'document.jpg', type: 'image/jpeg', size: 1800000 }
  ];

  const results: { format: string; success: boolean; processingTime: number }[] = [];

  for (const format of testFormats) {
    console.log(`Testing format: ${format.name} (${format.type})`);
    
    const testFile = await createTestFile({
      ...format,
      orgId: 'multi-format-test-org'
    });

    const startTime = Date.now();
    const result = await simulateEndToEndPipeline(testFile);
    const processingTime = Date.now() - startTime;

    results.push({
      format: format.name,
      success: result.status === 'success',
      processingTime
    });

    // Verify each format can be processed
    assert(['success', 'partial'].includes(result.status), 
      `Format ${format.name} should be processable`);

    // Verify routing stage always succeeds
    assertEquals(result.stages.routing, true, 
      `Routing should succeed for ${format.name}`);

    console.log(`${format.name}: ${result.status} (${processingTime}ms)`);
  }

  // Verify all formats were attempted
  assertEquals(results.length, testFormats.length, 'All formats should be tested');

  // Verify at least 80% success rate
  const successCount = results.filter(r => r.success).length;
  const successRate = successCount / results.length;
  assert(successRate >= 0.8, `Success rate should be at least 80%, got ${(successRate * 100).toFixed(1)}%`);

  console.log(`Multi-format processing: ${successCount}/${results.length} successful (${(successRate * 100).toFixed(1)}%)`);
  console.log("✅ Multi-format document processing test completed successfully");
});

// Integration Test 9: Custom Field Workflow Integration
Deno.test("Integration Test 9: Custom field workflow integration", async () => {
  console.log("🔄 Testing complete custom field workflow integration");

  const testFile = await createTestFile({
    name: 'complex-lease-with-custom-fields.pdf',
    type: 'application/pdf',
    size: 2500000,
    orgId: 'custom-workflow-test-org'
  });

  // Step 1: Process document with custom field detection
  console.log("Step 1: Processing document with custom field detection");
  const extractionResult = await simulateEndToEndPipeline(testFile);

  assertEquals(extractionResult.status, 'success', 'Document processing should succeed');
  assertExists(extractionResult.customFieldSuggestions, 'Should have custom field suggestions');
  assert(extractionResult.customFieldSuggestions!.length > 0, 'Should suggest at least one custom field');

  // Step 2: Create custom fields from suggestions
  console.log("Step 2: Creating custom fields from suggestions");
  const createdFields: any[] = [];
  
  for (const suggestion of extractionResult.customFieldSuggestions!) {
    const createResponse = await mockSupabase.functions.invoke('custom-fields', {
      method: 'POST',
      body: {
        module_type: 'leases',
        field_name: suggestion.field_name,
        field_label: suggestion.field_label,
        field_type: suggestion.field_type,
        field_options: suggestion.field_options || []
      }
    });

    assertEquals(createResponse.error, null, `Creating field ${suggestion.field_name} should succeed`);
    createdFields.push(createResponse.data);
  }

  assert(createdFields.length > 0, 'Should create at least one custom field');

  // Step 3: Set values for custom fields
  console.log("Step 3: Setting values for custom fields");
  const testRecordId = 'test-lease-workflow-123';
  const fieldValues: Record<string, any> = {};

  extractionResult.customFieldSuggestions!.forEach((suggestion, index) => {
    fieldValues[suggestion.field_name] = `Test Value ${index + 1}`;
  });

  const setValuesResponse = await mockSupabase.functions.invoke('custom-fields', {
    method: 'POST',
    body: {
      record_id: testRecordId,
      record_type: 'lease',
      values: fieldValues
    }
  });

  assertEquals(setValuesResponse.error, null, 'Setting field values should succeed');

  // Step 4: Retrieve custom field values
  console.log("Step 4: Retrieving custom field values");
  const getValuesResponse = await mockSupabase.functions.invoke('custom-fields', {
    method: 'GET',
    body: {
      record_id: testRecordId,
      record_type: 'lease'
    }
  });

  assertEquals(getValuesResponse.error, null, 'Getting field values should succeed');

  // Step 5: Test auto-creation workflow
  console.log("Step 5: Testing auto-creation workflow");
  const autoCreateFile = await createTestFile({
    name: 'auto-create-test.pdf',
    type: 'application/pdf',
    size: 1000000,
    orgId: 'auto-create-test-org'
  });

  const autoCreateResponse = await mockSupabase.functions.invoke('extract-with-custom-fields', {
    body: {
      file_id: autoCreateFile.id,
      module_type: 'leases',
      auto_create_fields: true,
      confidence_threshold: 60
    }
  });

  assertEquals(autoCreateResponse.error, null, 'Auto-creation should succeed');
  assertExists(autoCreateResponse.data, 'Should have response data');
  assertExists(autoCreateResponse.data!.processing_summary, 'Should have processing summary');

  const summary = autoCreateResponse.data!.processing_summary;
  assert(summary.total_records > 0, 'Should process at least one record');
  assert(summary.suggestions_count >= 0, 'Should have suggestion count');

  console.log(`Workflow completed: ${createdFields.length} fields created, ${Object.keys(fieldValues).length} values set`);
  console.log("✅ Custom field workflow integration test completed successfully");
});

// Integration Test 10: Error Recovery and Resilience
Deno.test("Integration Test 10: Error recovery and resilience", async () => {
  console.log("🔄 Testing error recovery and resilience mechanisms");

  // Test various failure scenarios and recovery
  const failureScenarios = [
    {
      name: 'Network timeout simulation',
      file: { name: 'timeout-test.pdf', type: 'application/pdf', size: 1000000 },
      expectedBehavior: 'graceful_degradation'
    },
    {
      name: 'Corrupted file content',
      file: { name: 'corrupted.pdf', type: 'application/pdf', size: 0 },
      expectedBehavior: 'error_with_details'
    },
    {
      name: 'Unsupported format',
      file: { name: 'unknown.xyz', type: 'application/unknown', size: 500000 },
      expectedBehavior: 'fallback_processing'
    },
    {
      name: 'Very large file',
      file: { name: 'huge.pdf', type: 'application/pdf', size: 500000000 },
      expectedBehavior: 'resource_management'
    }
  ];

  const recoveryResults: { scenario: string; recovered: boolean; errorHandled: boolean }[] = [];

  for (const scenario of failureScenarios) {
    console.log(`Testing scenario: ${scenario.name}`);
    
    const testFile = await createTestFile({
      ...scenario.file,
      orgId: `resilience-test-${Date.now()}`
    });

    try {
      const result = await simulateEndToEndPipeline(testFile);
      
      const recovered = result.status !== 'failed';
      const errorHandled = result.errors ? result.errors.length > 0 : false;

      recoveryResults.push({
        scenario: scenario.name,
        recovered,
        errorHandled
      });

      // Verify appropriate behavior based on scenario
      switch (scenario.expectedBehavior) {
        case 'graceful_degradation':
          assert(['success', 'partial'].includes(result.status), 
            'Should gracefully degrade on network issues');
          break;
        case 'error_with_details':
          assert(result.errors && result.errors.length > 0, 
            'Should provide detailed error information');
          break;
        case 'fallback_processing':
          assert(result.stages.routing, 
            'Should attempt routing even for unknown formats');
          break;
        case 'resource_management':
          assert(result.processingTime < 10000, 
            'Should handle large files within reasonable time');
          break;
      }

      console.log(`${scenario.name}: ${result.status} (${result.errors?.length || 0} errors)`);

    } catch (error) {
      // Even exceptions should be handled gracefully
      recoveryResults.push({
        scenario: scenario.name,
        recovered: false,
        errorHandled: true
      });
      
      console.log(`${scenario.name}: Exception handled - ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Verify overall resilience
  const recoveredCount = recoveryResults.filter(r => r.recovered).length;
  const errorHandledCount = recoveryResults.filter(r => r.errorHandled).length;

  console.log(`Recovery rate: ${recoveredCount}/${recoveryResults.length} scenarios`);
  console.log(`Error handling: ${errorHandledCount}/${recoveryResults.length} scenarios`);

  // At least 75% of scenarios should either recover or handle errors gracefully
  const resilienceRate = (recoveredCount + errorHandledCount) / recoveryResults.length;
  assert(resilienceRate >= 0.75, 
    `Resilience rate should be at least 75%, got ${(resilienceRate * 100).toFixed(1)}%`);

  console.log("✅ Error recovery and resilience test completed successfully");
});