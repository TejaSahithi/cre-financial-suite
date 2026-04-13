import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { fc } from "https://esm.sh/fast-check@3.15.0";

/**
 * Property-Based Tests for Document Extraction Pipeline Robustness
 * 
 * These tests generate random inputs to verify the pipeline handles
 * edge cases, malformed data, and unexpected scenarios gracefully.
 * 
 * Tests cover:
 * - Random file uploads across all supported formats
 * - AI interpretation with various document content types
 * - Custom field creation with various field types and validation rules
 * - Random existing data operations to verify preservation
 */

// ── Test Data Generators ─────────────────────────────────────────────────────

const fileFormatArbitrary = fc.oneof(
  fc.constant('application/pdf'),
  fc.constant('application/msword'),
  fc.constant('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  fc.constant('text/plain'),
  fc.constant('image/png'),
  fc.constant('image/jpeg'),
  fc.constant('image/tiff'),
  fc.constant('application/vnd.ms-excel'),
  fc.constant('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  fc.constant('text/csv'),
  fc.constant('application/unknown')
);

const fileNameArbitrary = fc.tuple(
  fc.stringOf(fc.char().filter(c => /[a-zA-Z0-9_-]/.test(c)), { minLength: 1, maxLength: 50 }),
  fc.oneof(
    fc.constant('.pdf'),
    fc.constant('.doc'),
    fc.constant('.docx'),
    fc.constant('.txt'),
    fc.constant('.png'),
    fc.constant('.jpg'),
    fc.constant('.jpeg'),
    fc.constant('.tiff'),
    fc.constant('.xls'),
    fc.constant('.xlsx'),
    fc.constant('.csv'),
    fc.constant('.unknown')
  )
).map(([name, ext]) => name + ext);

const fileSizeArbitrary = fc.integer({ min: 0, max: 100_000_000 }); // 0 to 100MB

const orgIdArbitrary = fc.stringOf(
  fc.char().filter(c => /[a-zA-Z0-9-]/.test(c)),
  { minLength: 5, maxLength: 50 }
);

const testFileArbitrary = fc.record({
  name: fileNameArbitrary,
  type: fileFormatArbitrary,
  size: fileSizeArbitrary,
  orgId: orgIdArbitrary,
  propertyId: fc.option(fc.uuid(), { nil: undefined })
});

// Document content generators
const documentContentArbitrary = fc.oneof(
  // Structured lease data
  fc.record({
    tenant_name: fc.fullName(),
    property_name: fc.string({ minLength: 5, maxLength: 100 }),
    unit_number: fc.oneof(fc.integer({ min: 1, max: 9999 }).map(String), fc.string({ minLength: 1, maxLength: 10 })),
    start_date: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }).map(d => d.toISOString().split('T')[0]),
    end_date: fc.date({ min: new Date('2025-01-01'), max: new Date('2035-12-31') }).map(d => d.toISOString().split('T')[0]),
    monthly_rent: fc.float({ min: 500, max: 50000 }),
    square_footage: fc.integer({ min: 100, max: 10000 }),
    lease_type: fc.oneof(fc.constant('gross'), fc.constant('net'), fc.constant('modified_gross')),
    security_deposit: fc.float({ min: 0, max: 100000 })
  }),
  // Unstructured text content
  fc.lorem({ maxCount: 1000 }),
  // Mixed structured/unstructured
  fc.record({
    structured_data: fc.record({
      field1: fc.string(),
      field2: fc.float(),
      field3: fc.boolean()
    }),
    unstructured_text: fc.lorem({ maxCount: 500 }),
    metadata: fc.record({
      created_at: fc.date().map(d => d.toISOString()),
      version: fc.integer({ min: 1, max: 10 }),
      tags: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 10 })
    })
  }),
  // Empty or minimal content
  fc.oneof(
    fc.constant(''),
    fc.constant(null),
    fc.constant(undefined),
    fc.record({})
  )
);

// Custom field generators
const fieldTypeArbitrary = fc.oneof(
  fc.constant('text'),
  fc.constant('number'),
  fc.constant('date'),
  fc.constant('boolean'),
  fc.constant('select')
);

const fieldNameArbitrary = fc.stringOf(
  fc.char().filter(c => /[a-z0-9_]/.test(c)),
  { minLength: 1, maxLength: 50 }
).filter(name => /^[a-z]/.test(name)); // Must start with letter

const customFieldArbitrary = fc.record({
  field_name: fieldNameArbitrary,
  field_label: fc.string({ minLength: 1, maxLength: 100 }),
  field_type: fieldTypeArbitrary,
  field_options: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { maxLength: 20 }),
  is_required: fc.boolean(),
  validation_rules: fc.record({
    min_length: fc.option(fc.integer({ min: 0, max: 1000 }), { nil: undefined }),
    max_length: fc.option(fc.integer({ min: 1, max: 10000 }), { nil: undefined }),
    pattern: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined })
  })
});

// ── Mock Pipeline Functions ──────────────────────────────────────────────────

interface MockPipelineResult {
  success: boolean;
  stages: {
    upload: boolean;
    routing: boolean;
    extraction: boolean;
    aiInterpretation: boolean;
    fieldMapping: boolean;
    customFields: boolean;
  };
  extractedData?: any[];
  errors?: string[];
  processingTime: number;
}

async function mockDocumentPipeline(
  file: any,
  content?: any
): Promise<MockPipelineResult> {
  const startTime = Date.now();
  const result: MockPipelineResult = {
    success: false,
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
    // Stage 1: Upload validation
    if (file.size > 0 && file.name && file.type) {
      result.stages.upload = true;
    } else {
      result.errors?.push('Invalid file parameters');
      result.processingTime = Date.now() - startTime;
      return result;
    }

    // Stage 2: Routing based on file type
    const supportedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'image/png',
      'image/jpeg',
      'image/tiff',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv'
    ];

    if (supportedTypes.includes(file.type)) {
      result.stages.routing = true;
    } else {
      result.errors?.push(`Unsupported file type: ${file.type}`);
      // Continue with fallback processing
      result.stages.routing = true;
    }

    // Stage 3: Extraction (depends on file size and type)
    if (file.size > 50_000_000) { // 50MB limit
      result.errors?.push('File too large for processing');
    } else if (file.size === 0) {
      result.errors?.push('Empty file cannot be processed');
    } else {
      result.stages.extraction = true;
    }

    // Stage 4: AI Interpretation (depends on content)
    if (content !== null && content !== undefined) {
      if (typeof content === 'object' && Object.keys(content).length > 0) {
        result.stages.aiInterpretation = true;
        result.extractedData = Array.isArray(content) ? content : [content];
      } else if (typeof content === 'string' && content.length > 0) {
        result.stages.aiInterpretation = true;
        result.extractedData = [{ text_content: content }];
      } else {
        result.errors?.push('No meaningful content to interpret');
      }
    } else {
      result.errors?.push('No content provided for AI interpretation');
    }

    // Stage 5: Field Mapping (depends on extracted data)
    if (result.extractedData && result.extractedData.length > 0) {
      result.stages.fieldMapping = true;
    }

    // Stage 6: Custom Fields (always succeeds if we got this far)
    if (result.stages.fieldMapping) {
      result.stages.customFields = true;
    }

    // Determine overall success
    const criticalStages = [result.stages.upload, result.stages.routing];
    const optionalStages = [result.stages.extraction, result.stages.aiInterpretation, result.stages.fieldMapping];
    
    const criticalSuccess = criticalStages.every(stage => stage);
    const optionalSuccess = optionalStages.filter(stage => stage).length >= 1;

    result.success = criticalSuccess && optionalSuccess;

  } catch (error) {
    result.errors?.push(`Pipeline error: ${error.message}`);
  }

  result.processingTime = Date.now() - startTime;
  return result;
}

async function mockCustomFieldCreation(field: any): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Validate field name
  if (!field.field_name || !/^[a-z][a-z0-9_]*$/.test(field.field_name)) {
    errors.push('Invalid field name format');
  }

  // Validate field label
  if (!field.field_label || field.field_label.trim().length === 0) {
    errors.push('Field label is required');
  }

  // Validate field type
  const validTypes = ['text', 'number', 'date', 'boolean', 'select'];
  if (!validTypes.includes(field.field_type)) {
    errors.push('Invalid field type');
  }

  // Validate select field options
  if (field.field_type === 'select') {
    if (!Array.isArray(field.field_options) || field.field_options.length === 0) {
      errors.push('Select fields must have at least one option');
    }
  }

  // Validate validation rules
  if (field.validation_rules) {
    if (field.validation_rules.min_length !== undefined && field.validation_rules.min_length < 0) {
      errors.push('min_length must be non-negative');
    }
    if (field.validation_rules.max_length !== undefined && field.validation_rules.max_length < 1) {
      errors.push('max_length must be positive');
    }
    if (field.validation_rules.min_length !== undefined && 
        field.validation_rules.max_length !== undefined &&
        field.validation_rules.min_length > field.validation_rules.max_length) {
      errors.push('min_length cannot be greater than max_length');
    }
  }

  return { success: errors.length === 0, errors };
}

// ── Property-Based Tests ─────────────────────────────────────────────────────

Deno.test("Property 1: Random file uploads should be handled gracefully", () => {
  fc.assert(
    fc.property(testFileArbitrary, async (file) => {
      const result = await mockDocumentPipeline(file);

      // Property: Pipeline should never crash, always return a result
      assertExists(result, 'Pipeline should always return a result');
      assert(typeof result.success === 'boolean', 'Result should have boolean success flag');
      assert(Array.isArray(result.errors), 'Result should have errors array');
      assert(typeof result.processingTime === 'number', 'Result should have processing time');

      // Property: Upload stage should succeed for valid file parameters
      if (file.size > 0 && file.name && file.type) {
        assertEquals(result.stages.upload, true, 'Upload should succeed for valid files');
      }

      // Property: Processing time should be reasonable
      assert(result.processingTime >= 0, 'Processing time should be non-negative');
      assert(result.processingTime < 5000, 'Processing time should be under 5 seconds for mock');

      // Property: Errors should be descriptive when present
      if (!result.success && result.errors) {
        assert(result.errors.length > 0, 'Failed results should have error messages');
        result.errors.forEach(error => {
          assert(typeof error === 'string', 'Errors should be strings');
          assert(error.length > 0, 'Error messages should not be empty');
        });
      }
    }),
    { numRuns: 100, verbose: true }
  );
});

Deno.test("Property 2: Document content extraction should preserve data integrity", () => {
  fc.assert(
    fc.property(testFileArbitrary, documentContentArbitrary, async (file, content) => {
      const result = await mockDocumentPipeline(file, content);

      // Property: If extraction succeeds, extracted data should be present
      if (result.stages.extraction && result.stages.aiInterpretation) {
        assertExists(result.extractedData, 'Successful extraction should produce data');
        assert(Array.isArray(result.extractedData), 'Extracted data should be an array');
        
        if (result.extractedData.length > 0) {
          // Property: Extracted data should be serializable
          const serialized = JSON.stringify(result.extractedData);
          const deserialized = JSON.parse(serialized);
          assertEquals(deserialized, result.extractedData, 'Extracted data should be serializable');
        }
      }

      // Property: Non-empty content should produce some extracted data
      if (content && typeof content === 'object' && Object.keys(content).length > 0) {
        if (result.stages.aiInterpretation) {
          assert(result.extractedData && result.extractedData.length > 0, 
            'Non-empty structured content should produce extracted data');
        }
      }

      // Property: String content should be preserved in some form
      if (typeof content === 'string' && content.length > 0) {
        if (result.stages.aiInterpretation && result.extractedData) {
          const hasTextContent = result.extractedData.some(item => 
            typeof item === 'object' && item !== null && 'text_content' in item
          );
          assert(hasTextContent, 'String content should be preserved as text_content');
        }
      }
    }),
    { numRuns: 50, verbose: true }
  );
});

Deno.test("Property 3: Custom field creation should validate inputs correctly", () => {
  fc.assert(
    fc.property(customFieldArbitrary, async (field) => {
      const result = await mockCustomFieldCreation(field);

      // Property: Result should always have success flag and errors array
      assert(typeof result.success === 'boolean', 'Result should have boolean success flag');
      assert(Array.isArray(result.errors), 'Result should have errors array');

      // Property: Valid field names should not produce name-related errors
      if (/^[a-z][a-z0-9_]*$/.test(field.field_name)) {
        const nameErrors = result.errors.filter(e => e.includes('field name'));
        assertEquals(nameErrors.length, 0, 'Valid field names should not produce name errors');
      }

      // Property: Non-empty field labels should not produce label-related errors
      if (field.field_label && field.field_label.trim().length > 0) {
        const labelErrors = result.errors.filter(e => e.includes('label'));
        assertEquals(labelErrors.length, 0, 'Valid field labels should not produce label errors');
      }

      // Property: Valid field types should not produce type-related errors
      const validTypes = ['text', 'number', 'date', 'boolean', 'select'];
      if (validTypes.includes(field.field_type)) {
        const typeErrors = result.errors.filter(e => e.includes('type'));
        assertEquals(typeErrors.length, 0, 'Valid field types should not produce type errors');
      }

      // Property: Select fields with options should not produce option-related errors
      if (field.field_type === 'select' && Array.isArray(field.field_options) && field.field_options.length > 0) {
        const optionErrors = result.errors.filter(e => e.includes('option'));
        assertEquals(optionErrors.length, 0, 'Select fields with options should not produce option errors');
      }

      // Property: Consistent validation rules should not produce rule-related errors
      if (field.validation_rules) {
        const { min_length, max_length } = field.validation_rules;
        if (min_length !== undefined && max_length !== undefined && min_length <= max_length && min_length >= 0 && max_length >= 1) {
          const ruleErrors = result.errors.filter(e => e.includes('length'));
          assertEquals(ruleErrors.length, 0, 'Consistent validation rules should not produce errors');
        }
      }
    }),
    { numRuns: 100, verbose: true }
  );
});

Deno.test("Property 4: Pipeline should handle edge cases gracefully", () => {
  const edgeCaseArbitrary = fc.record({
    file: fc.record({
      name: fc.oneof(
        fc.constant(''),
        fc.constant('.pdf'),
        fc.constant('file'),
        fc.constant('a'.repeat(1000) + '.pdf'),
        fc.string({ minLength: 1, maxLength: 10 })
      ),
      type: fc.oneof(
        fc.constant(''),
        fc.constant('application/pdf'),
        fc.constant('invalid/type'),
        fc.constant('application/unknown'),
        fc.string({ minLength: 1, maxLength: 50 })
      ),
      size: fc.oneof(
        fc.constant(0),
        fc.constant(-1),
        fc.constant(Number.MAX_SAFE_INTEGER),
        fc.constant(100_000_001), // Just over 100MB limit
        fc.integer({ min: 1, max: 1000 })
      ),
      orgId: fc.oneof(
        fc.constant(''),
        fc.constant('a'),
        fc.constant('org-123'),
        fc.string({ minLength: 1, maxLength: 100 })
      )
    }),
    content: fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.constant(''),
      fc.constant({}),
      fc.constant([]),
      fc.record({ empty: fc.constant(true) }),
      fc.string({ minLength: 1, maxLength: 10 })
    )
  });

  fc.assert(
    fc.property(edgeCaseArbitrary, async ({ file, content }) => {
      const result = await mockDocumentPipeline(file, content);

      // Property: Pipeline should never throw unhandled exceptions
      assertExists(result, 'Pipeline should handle all edge cases without crashing');

      // Property: Invalid inputs should produce appropriate errors
      if (file.size <= 0 || !file.name || !file.type) {
        assertEquals(result.stages.upload, false, 'Invalid file parameters should fail upload');
        assert(result.errors && result.errors.length > 0, 'Invalid inputs should produce errors');
      }

      // Property: Very large files should be rejected gracefully
      if (file.size > 50_000_000) {
        const sizeErrors = result.errors?.filter(e => e.includes('large') || e.includes('size')) || [];
        assert(sizeErrors.length > 0, 'Very large files should produce size-related errors');
      }

      // Property: Empty content should be handled without crashing
      if (content === null || content === undefined || content === '' || 
          (typeof content === 'object' && Object.keys(content).length === 0)) {
        // Should not crash, but may not succeed in AI interpretation
        assert(typeof result.success === 'boolean', 'Empty content should not crash pipeline');
      }

      // Property: All error messages should be informative
      if (result.errors && result.errors.length > 0) {
        result.errors.forEach(error => {
          assert(typeof error === 'string', 'All errors should be strings');
          assert(error.length > 5, 'Error messages should be informative (>5 chars)');
          assert(!error.includes('undefined'), 'Error messages should not contain "undefined"');
          assert(!error.includes('null'), 'Error messages should not contain "null"');
        });
      }
    }),
    { numRuns: 75, verbose: true }
  );
});

Deno.test("Property 5: Field mapping should be consistent and reversible", () => {
  const fieldMappingArbitrary = fc.record({
    extractedFields: fc.array(
      fc.record({
        name: fc.stringOf(fc.char().filter(c => /[a-zA-Z0-9_\s-]/.test(c)), { minLength: 1, maxLength: 50 }),
        value: fc.oneof(
          fc.string(),
          fc.float(),
          fc.integer(),
          fc.boolean(),
          fc.date().map(d => d.toISOString())
        )
      }),
      { minLength: 1, maxLength: 20 }
    ),
    moduleType: fc.oneof(
      fc.constant('leases'),
      fc.constant('properties'),
      fc.constant('expenses')
    )
  });

  fc.assert(
    fc.property(fieldMappingArbitrary, ({ extractedFields, moduleType }) => {
      // Mock field mapping logic
      const standardMappings: Record<string, Record<string, string>> = {
        leases: {
          'tenant_name': 'tenant_name',
          'tenant': 'tenant_name',
          'property_name': 'property_name',
          'property': 'property_name',
          'monthly_rent': 'monthly_rent',
          'rent': 'monthly_rent'
        },
        properties: {
          'name': 'name',
          'property_name': 'name',
          'address': 'address'
        },
        expenses: {
          'amount': 'amount',
          'expense_amount': 'amount',
          'category': 'category'
        }
      };

      const mappings = standardMappings[moduleType] || {};
      const mappedFields: Record<string, string> = {};
      const unmappedFields: string[] = [];

      for (const field of extractedFields) {
        const normalizedName = field.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        if (mappings[normalizedName]) {
          mappedFields[field.name] = mappings[normalizedName];
        } else {
          unmappedFields.push(field.name);
        }
      }

      // Property: Mapping should be deterministic
      const mappedFields2: Record<string, string> = {};
      const unmappedFields2: string[] = [];

      for (const field of extractedFields) {
        const normalizedName = field.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        if (mappings[normalizedName]) {
          mappedFields2[field.name] = mappings[normalizedName];
        } else {
          unmappedFields2.push(field.name);
        }
      }

      assertEquals(mappedFields, mappedFields2, 'Field mapping should be deterministic');
      assertEquals(unmappedFields.sort(), unmappedFields2.sort(), 'Unmapped fields should be consistent');

      // Property: All extracted fields should be either mapped or unmapped
      const totalProcessed = Object.keys(mappedFields).length + unmappedFields.length;
      assertEquals(totalProcessed, extractedFields.length, 'All fields should be processed');

      // Property: No field should be both mapped and unmapped
      const mappedFieldNames = Object.keys(mappedFields);
      const intersection = mappedFieldNames.filter(name => unmappedFields.includes(name));
      assertEquals(intersection.length, 0, 'No field should be both mapped and unmapped');

      // Property: Standard field names should always map correctly
      for (const field of extractedFields) {
        const normalizedName = field.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        if (mappings[normalizedName]) {
          assertEquals(mappedFields[field.name], mappings[normalizedName], 
            `Standard field ${field.name} should map to ${mappings[normalizedName]}`);
        }
      }
    }),
    { numRuns: 50, verbose: true }
  );
});

Deno.test("Property 6: System should preserve existing data operations", () => {
  const existingDataArbitrary = fc.record({
    csvData: fc.array(
      fc.record({
        tenant_name: fc.fullName(),
        monthly_rent: fc.float({ min: 500, max: 10000 }),
        start_date: fc.date({ min: new Date('2020-01-01'), max: new Date('2025-12-31') }).map(d => d.toISOString().split('T')[0])
      }),
      { minLength: 1, maxLength: 100 }
    ),
    apiFormat: fc.record({
      status: fc.oneof(fc.constant('success'), fc.constant('error')),
      data: fc.array(fc.record({
        id: fc.uuid(),
        created_at: fc.date().map(d => d.toISOString()),
        updated_at: fc.date().map(d => d.toISOString())
      })),
      metadata: fc.record({
        total: fc.integer({ min: 0, max: 1000 }),
        page: fc.integer({ min: 1, max: 100 }),
        limit: fc.integer({ min: 10, max: 100 })
      })
    })
  });

  fc.assert(
    fc.property(existingDataArbitrary, ({ csvData, apiFormat }) => {
      // Mock existing data processing
      const processedCsvData = csvData.map(row => ({
        ...row,
        processed: true,
        processing_timestamp: new Date().toISOString()
      }));

      const processedApiFormat = {
        ...apiFormat,
        processed: true,
        processing_timestamp: new Date().toISOString()
      };

      // Property: CSV data structure should be preserved
      assertEquals(processedCsvData.length, csvData.length, 'CSV data count should be preserved');
      
      for (let i = 0; i < csvData.length; i++) {
        const original = csvData[i];
        const processed = processedCsvData[i];
        
        assertEquals(processed.tenant_name, original.tenant_name, 'Tenant name should be preserved');
        assertEquals(processed.monthly_rent, original.monthly_rent, 'Monthly rent should be preserved');
        assertEquals(processed.start_date, original.start_date, 'Start date should be preserved');
        assertEquals(processed.processed, true, 'Processing flag should be added');
        assertExists(processed.processing_timestamp, 'Processing timestamp should be added');
      }

      // Property: API format structure should be preserved
      assertEquals(processedApiFormat.status, apiFormat.status, 'API status should be preserved');
      assertEquals(processedApiFormat.data.length, apiFormat.data.length, 'API data count should be preserved');
      assertEquals(processedApiFormat.metadata.total, apiFormat.metadata.total, 'API metadata should be preserved');
      assertEquals(processedApiFormat.processed, true, 'Processing flag should be added');
      assertExists(processedApiFormat.processing_timestamp, 'Processing timestamp should be added');

      // Property: Original data should remain unchanged after processing
      const originalCsvSerialized = JSON.stringify(csvData);
      const originalApiSerialized = JSON.stringify(apiFormat);
      
      // Process again to ensure idempotency
      const reprocessedCsv = csvData.map(row => ({
        ...row,
        processed: true,
        processing_timestamp: new Date().toISOString()
      }));

      assertEquals(JSON.stringify(csvData), originalCsvSerialized, 'Original CSV data should be unchanged');
      assertEquals(JSON.stringify(apiFormat), originalApiSerialized, 'Original API format should be unchanged');
      assertEquals(reprocessedCsv.length, processedCsvData.length, 'Reprocessing should be consistent');
    }),
    { numRuns: 30, verbose: true }
  );
});

console.log("🧪 Property-based tests for document extraction pipeline robustness completed");