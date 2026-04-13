# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Document Extraction Pipeline Failures
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the pipeline breaks between upload and extraction
  - **Scoped PBT Approach**: Scope the property to concrete failing cases: PDF uploads, Word documents, images, and custom field scenarios
  - Test that document uploads fail at various pipeline stages (routing, extraction, AI interpretation, field mapping)
  - Test PDF processing through ingest-file → parse-pdf-docling connection
  - Test Word document format detection and routing
  - Test image OCR extraction and AI interpretation
  - Test custom field creation when extracted data doesn't match existing UI fields
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document counterexamples found to understand root cause
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Existing Pipeline Behavior
  - **IMPORTANT**: Follow observation-first methodology
  - Observe behavior on UNFIXED code for CSV/Excel uploads and structured data operations
  - Observe existing file upload functionality for previously supported formats
  - Observe database storage patterns and API response formats
  - Observe field validation and formatting rules for existing UI fields
  - Write property-based tests capturing observed behavior patterns from Preservation Requirements
  - Test CSV upload processing continues to work identically
  - Test Excel file processing through existing structured pipeline
  - Test API response format consistency
  - Test database schema preservation for existing tables
  - Test existing UI field behavior and validation
  - Property-based testing generates many test cases for stronger guarantees
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [ ] 3. Fix document extraction pipeline

  - [x] 3.1 Enhance pipeline router (ingest-file function)
    - Fix routing logic to properly handle all file formats (PDF, DOC, DOCX, TXT, images)
    - Add comprehensive error handling with detailed logging
    - Ensure proper status updates throughout the routing process
    - Add retry mechanisms for transient failures
    - Improve connection between upload and extraction processes
    - _Bug_Condition: isBugCondition(input) where input.fileFormat IN ['pdf', 'doc', 'docx', 'txt', 'image', 'xlsx', 'xls', 'unknown'] AND pipeline stages fail_
    - _Expected_Behavior: Complete end-to-end processing from upload through AI interpretation to UI field mapping_
    - _Preservation: Existing CSV/Excel processing, database storage, and API response formats unchanged_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [x] 3.2 Improve format detection (file-detector.ts)
    - Enhance magic byte detection for edge cases
    - Improve MIME type handling for various document formats
    - Add better fallback logic when format detection is uncertain
    - Support comprehensive format detection for PDF, Word, Excel, images, and text files
    - _Bug_Condition: Format detection failures causing routing errors_
    - _Expected_Behavior: Accurate format detection for all supported file types_
    - _Preservation: Existing format detection for CSV/Excel files unchanged_
    - _Requirements: 2.1, 2.2_

  - [x] 3.3 Fix extraction process connection (parse-pdf-docling function)
    - Fix connection issues between upload and extraction
    - Improve error handling and status reporting
    - Add proper fallback to Gemini when Docling API is unavailable
    - Enhance support for additional file formats (Word documents, images)
    - Implement robust OCR processing for scanned documents
    - _Bug_Condition: Broken connection between ingest-file and parse-pdf-docling_
    - _Expected_Behavior: Successful extraction for PDF, Word, and image formats_
    - _Preservation: Existing extraction behavior for supported formats unchanged_
    - _Requirements: 2.2, 2.3_

  - [x] 3.4 Enhance AI integration (extract-document-fields function)
    - Improve input validation and preprocessing for AI interpretation
    - Add better error handling for Vertex AI calls
    - Enhance field mapping logic for various document types
    - Add confidence scoring for extracted fields
    - Implement intelligent field mapping to existing UI fields
    - _Bug_Condition: AI interpretation failures and incomplete field mapping_
    - _Expected_Behavior: Successful AI interpretation and field mapping for all document types_
    - _Preservation: Existing AI processing behavior unchanged_
    - _Requirements: 2.3, 2.4_

  - [x] 3.5 Implement custom field system database schema
    - Create custom_fields table for field definitions
    - Create custom_field_values table for field data
    - Add docling_raw column to uploaded_files table
    - Implement proper foreign key relationships and constraints
    - Add indexes for performance optimization
    - _Bug_Condition: No mechanism for custom field creation when extracted data doesn't match existing UI fields_
    - _Expected_Behavior: Database support for dynamic custom field creation and storage_
    - _Preservation: Existing database schema and tables unchanged_
    - _Requirements: 2.5, 2.6_

  - [x] 3.6 Create custom field management API endpoints
    - Implement GET /api/custom-fields for listing custom fields
    - Implement POST /api/custom-fields for creating new custom fields
    - Implement PUT /api/custom-fields/:id for updating custom fields
    - Implement DELETE /api/custom-fields/:id for removing custom fields
    - Implement GET /api/custom-field-values for retrieving field values
    - Implement POST /api/custom-field-values for setting field values
    - Add proper validation and error handling for all endpoints
    - _Bug_Condition: No API support for custom field management_
    - _Expected_Behavior: Complete API interface for custom field operations_
    - _Preservation: Existing API endpoints and response formats unchanged_
    - _Requirements: 2.5, 2.6_

  - [x] 3.7 Enhance extraction pipeline with custom field support
    - Implement POST /api/extract-with-custom-fields endpoint
    - Add logic to suggest custom fields for unmapped extracted data
    - Implement automatic custom field creation when enabled
    - Add field type inference based on extracted data patterns
    - Integrate custom field suggestions into the extraction workflow
    - _Bug_Condition: Extracted data lost when fields don't match existing UI fields_
    - _Expected_Behavior: Custom field creation options for unmapped data_
    - _Preservation: Existing extraction pipeline behavior unchanged_
    - _Requirements: 2.5, 2.6, 2.7_

  - [x] 3.8 Add frontend UI components for custom fields
    - Create CustomFieldManager component for field definition management
    - Create CustomFieldForm component for dynamic form generation
    - Create CustomFieldDisplay component for showing custom field values
    - Integrate custom field components with existing document processing UI
    - Add real-time updates when custom fields are added or modified
    - _Bug_Condition: No UI support for custom field creation and management_
    - _Expected_Behavior: Complete UI interface for custom field operations_
    - _Preservation: Existing UI components and behavior unchanged_
    - _Requirements: 2.5, 2.6, 2.7_

  - [x] 3.9 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Document Extraction Pipeline Success
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - Verify PDF processing works end-to-end
    - Verify Word document processing works end-to-end
    - Verify image OCR and extraction works end-to-end
    - Verify custom field creation works for unmapped data
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [x] 3.10 Verify preservation tests still pass
    - **Property 2: Preservation** - Existing Pipeline Behavior
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm CSV upload processing still works identically
    - Confirm Excel file processing through existing pipeline unchanged
    - Confirm API response formats remain consistent
    - Confirm database schema preservation for existing tables
    - Confirm existing UI field behavior unchanged

- [ ] 4. Comprehensive testing and validation

  - [x] 4.1 Create unit tests for pipeline components
    - Test file format detection for all supported formats and edge cases
    - Test pipeline routing decisions for various file types and error conditions
    - Test extraction functions individually with mock inputs
    - Test AI interpretation with various document content types
    - Test custom field creation and management APIs
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 4.2 Create integration tests for end-to-end pipeline
    - Test complete pipeline from upload to UI field population
    - Test error handling and recovery across all pipeline stages
    - Test custom field integration with existing UI components
    - Test performance and scalability with large documents
    - _Requirements: 2.7, 3.1, 3.2, 3.3_

  - [x] 4.3 Create property-based tests for robustness
    - Generate random file uploads across all supported formats
    - Test AI interpretation with various document content types
    - Test custom field creation with various field types and validation rules
    - Generate random existing data operations to verify preservation
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise
  - Verify complete document extraction pipeline functionality
  - Verify preservation of existing system behavior
  - Verify custom field system integration
  - Confirm system ready for production deployment