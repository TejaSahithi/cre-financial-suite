# Document Extraction Pipeline Integration Tests

## Overview

This document describes the integration tests created for Task 4.2 of the document extraction pipeline fix specification.

## Test File

`document-extraction-pipeline-end-to-end-integration.test.ts`

## Test Coverage

The integration tests validate the four key areas specified in Task 4.2:

### 1. Complete Pipeline from Upload to UI Field Population
- **Test**: `Integration Test 1: Complete pipeline from upload to UI field population`
- **Coverage**: Tests the entire document processing workflow from file upload through AI interpretation to UI field population
- **Document Types**: PDF, text with custom fields, large performance test documents
- **Validation**: Verifies all pipeline stages complete successfully and data is properly extracted and stored

### 2. Error Handling and Recovery Across All Pipeline Stages
- **Test**: `Integration Test 2: Error handling and recovery across all pipeline stages`
- **Coverage**: Tests various error scenarios and validates proper error handling
- **Error Scenarios**:
  - Non-existent files
  - Corrupted PDF files
  - Empty files
  - Unsupported file formats
- **Validation**: Ensures errors are detected, properly structured, and include recovery mechanisms where appropriate

### 3. Custom Field Integration with Existing UI Components
- **Test**: `Integration Test 3: Custom field integration with existing UI components`
- **Coverage**: Tests the complete custom field workflow
- **Features Tested**:
  - Custom field detection from document content
  - Custom field suggestion generation
  - Custom field creation via API
  - Custom field value management
  - Custom field listing for UI rendering
- **Validation**: Verifies custom fields are properly detected, created, and integrated with the UI system

### 4. Performance and Scalability with Large Documents
- **Test**: `Integration Test 4: Performance and scalability with large documents`
- **Coverage**: Tests system performance with documents of varying sizes
- **Document Sizes**: 5KB, 50KB, 200KB, 500KB
- **Metrics Tracked**:
  - Processing time
  - Throughput (bytes per second)
  - Memory efficiency
  - Stage-by-stage performance breakdown
- **Validation**: Ensures reasonable performance across document sizes and identifies scalability characteristics

## Mock vs Real Testing

The tests are designed to work in both mock and real environments:

- **Mock Mode**: Used when Supabase is not available locally (default)
- **Real Mode**: Used when proper Supabase environment variables are set

### Environment Variables
- `SUPABASE_URL`: Supabase instance URL
- `SUPABASE_ANON_KEY`: Anonymous key for client operations
- `SUPABASE_SERVICE_ROLE_KEY`: Service role key for admin operations

## Requirements Validation

The integration tests validate the following requirements:

- **Requirement 2.7**: Complete end-to-end document processing for lease assignments
- **Requirement 3.1**: Preservation of existing file upload functionality
- **Requirement 3.2**: Maintenance of database storage patterns
- **Requirement 3.3**: Consistency of API response formats

## Running the Tests

```bash
# Run integration tests
deno test supabase/functions/_tests/document-extraction-pipeline-end-to-end-integration.test.ts --allow-net --allow-env

# Run with specific environment
SUPABASE_URL=http://localhost:54321 SUPABASE_SERVICE_ROLE_KEY=your-key deno test supabase/functions/_tests/document-extraction-pipeline-end-to-end-integration.test.ts --allow-net --allow-env
```

## Test Results

When all tests pass, you should see:
- ✅ Complete pipeline integration test passed!
- ✅ Error handling and recovery test passed!
- ✅ Custom field integration test passed!
- ✅ Performance and scalability test passed!

## Integration with Existing Tests

These integration tests complement the existing test suite:
- `document-extraction-end-to-end.test.ts`: Comprehensive end-to-end testing
- `document-extraction-integration.test.ts`: Mock-based integration testing
- `document-extraction-pipeline-integration.test.ts`: Real API integration testing

The new integration tests focus specifically on the four areas required by Task 4.2 while providing both mock and real testing capabilities.