# Implementation Plan: Backend-Driven Pipeline

## Overview

This implementation plan transforms the CRE Financial Platform from a frontend-heavy architecture into a backend-driven financial computation system. The plan follows a strict step-by-step order: Upload System → Parsing Engine → Validation Layer → Storage Layer → Computation Engine → UI Integration.

Key constraints:
- Work incrementally, do NOT rewrite entire project
- Do NOT modify .env or secrets
- Do NOT move logic to frontend
- Do NOT break existing UI
- Keep code modular and scalable

## Tasks

- [x] 1. Set up database schema and Edge Functions infrastructure
  - Create uploaded_files table with org_id, processing_status, parsed_data fields
  - Create computation_snapshots table for storing computation results
  - Create property_config and lease_config tables for business rules
  - Set up Supabase Edge Functions directory structure
  - Configure RLS policies for org_id isolation on new tables
  - _Requirements: 4.1, 4.2, 12.1, 13.1, 13.2, 17.5_

- [x] 1.1 Write property test for org_id isolation
  - **Property 2: Org_id Isolation Across All Operations**
  - **Validates: Requirements 1.3, 4.2, 17.1, 17.2, 17.3, 17.4, 18.6**

- [x] 2. Build Upload System (Step 1)
  - [x] 2.1 Create upload-handler Edge Function
    - Accept file uploads (CSV/Excel) with file_type parameter
    - Store files in Supabase Storage at financial-uploads/{org_id}/{file_id}
    - Create uploaded_files record with status='uploaded'
    - Enforce 50MB file size limit
    - Return file_id and storage_path
    - _Requirements: 1.1, 1.2, 1.4, 1.6_


  - [x] 2.2 Write property test for file upload
    - **Property 1: File Upload Creates Storage Record**
    - **Validates: Requirements 1.1, 1.2, 17.1**

  - [x] 2.3 Write property test for upload error handling
    - **Property 3: Upload Error Handling**
    - **Validates: Requirements 1.4**

  - [x] 2.4 Write unit tests for upload edge cases
    - Test 50MB boundary file
    - Test unsupported file format rejection
    - Test storage failure handling
    - _Requirements: 1.4, 1.6_

- [ ] 3. Build Parsing Engine (Step 2)
  - [x] 3.1 Create parse-file Edge Function with CSV parser
    - Read file from Supabase Storage by file_id
    - Parse CSV into structured JSON with column headers
    - Handle missing values as null
    - Update processing_status to 'parsed' or 'failed'
    - Store parsed_data in uploaded_files table
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.6_

  - [x] 3.2 Implement lease parser module
    - Map column variations (tenant_name, tenant, lessee → tenant_name)
    - Convert dates to ISO 8601 format
    - Convert currency strings to numeric
    - Preserve row numbers for error reporting
    - _Requirements: 2.2, 2.5, 2.6_

  - [x] 3.3 Implement expense parser module
    - Map expense-specific columns (category, amount, date, property_id)
    - Handle expense classification fields
    - Convert data types appropriately
    - _Requirements: 2.2_

  - [ ] 3.4 Implement property parser module
    - Map property columns (name, address, square_footage, property_type)
    - Handle portfolio/building/unit hierarchy fields
    - _Requirements: 2.2_

  - [-] 3.5 Implement revenue parser module
    - Map revenue columns (revenue_type, amount, period, property_id)
    - Handle revenue line item fields
    - _Requirements: 2.2_

  - [~] 3.6 Write property test for parser round-trip
    - **Property 4: Parser Round-Trip Preservation**
    - **Validates: Requirements 2.8**

  - [~] 3.7 Write property test for parsing status transitions
    - **Property 5: Parsing Status Transitions**
    - **Validates: Requirements 2.1, 2.3, 2.4**

  - [~] 3.8 Write property test for column preservation
    - **Property 6: Column and Type Preservation**
    - **Validates: Requirements 2.5, 2.6**

  - [~] 3.9 Write unit tests for parser edge cases
    - Test empty file (0 rows)
    - Test file with only headers
    - Test malformed CSV with mismatched columns
    - Test various date formats (MM/DD/YYYY, M/D/YYYY, YYYY-MM-DD)
    - Test international currency formats (€, £, $)
    - _Requirements: 2.4, 2.5, 2.6_

- [~] 4. Checkpoint - Ensure parsing tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Build Validation Layer (Step 3)
  - [~] 5.1 Create validate-data Edge Function
    - Read parsed_data from uploaded_files table
    - Validate required fields are present and non-empty
    - Validate data types match schema
    - Return all validation errors at once (not fail-fast)
    - Update processing_status to 'validated' or 'failed'
    - Store validation_errors in uploaded_files table
    - _Requirements: 3.1, 3.2, 3.4, 15.2_

  - [~] 5.2 Implement date normalization
    - Convert all date formats to ISO 8601 (YYYY-MM-DD)
    - Handle MM/DD/YYYY, M/D/YYYY, YYYY-MM-DD formats
    - Validate leap years
    - _Requirements: 3.5_

  - [~] 5.3 Implement currency normalization
    - Remove currency symbols ($, €, £)
    - Remove commas and spaces
    - Convert to numeric format
    - _Requirements: 3.6_

  - [~] 5.4 Implement referential integrity validation
    - Verify property_id exists in properties table
    - Verify org_id matches authenticated user
    - Verify foreign key relationships
    - _Requirements: 3.7, 3.8_

  - [~] 5.5 Write property test for required field validation
    - **Property 7: Required Field Validation**
    - **Validates: Requirements 3.1, 3.4**

  - [~] 5.6 Write property test for type validation
    - **Property 8: Type Validation**
    - **Validates: Requirements 3.2, 3.4**

  - [~] 5.7 Write property test for date normalization
    - **Property 9: Date Normalization**
    - **Validates: Requirements 3.5**

  - [~] 5.8 Write property test for currency normalization
    - **Property 10: Currency Normalization**
    - **Validates: Requirements 3.6**

  - [~] 5.9 Write property test for referential integrity
    - **Property 11: Referential Integrity Validation**
    - **Validates: Requirements 3.8**

  - [~] 5.10 Write property test for validation completeness
    - **Property 12: Validation Completeness**
    - **Validates: Requirements 15.2**

  - [~] 5.11 Write unit tests for validation edge cases
    - Test empty required fields
    - Test wrong data types
    - Test invalid org_id
    - Test missing property_id reference
    - _Requirements: 3.1, 3.2, 3.7, 3.8_

- [ ] 6. Build Storage Layer (Step 4)
  - [~] 6.1 Create store-data Edge Function
    - Read validated parsed_data from uploaded_files table
    - Insert records into appropriate tables based on file_type
    - Enforce org_id isolation on all inserts
    - Maintain referential integrity (properties → buildings → units → leases)
    - Use transactions with rollback on error
    - Update processing_status to 'stored'
    - Return inserted record IDs
    - _Requirements: 4.1, 4.2, 4.3, 4.5_

  - [~] 6.2 Implement automatic timestamp population
    - Set created_at and updated_at on all inserts
    - _Requirements: 4.6_

  - [~] 6.3 Implement audit logging
    - Log all create/update/delete operations to audit_logs table
    - Capture user_id, entity_type, entity_id, action, timestamp, org_id
    - Capture before/after values for updates
    - Enforce audit log immutability
    - _Requirements: 12.1, 12.2, 12.4_

  - [~] 6.4 Write property test for valid data storage
    - **Property 13: Valid Data Storage**
    - **Validates: Requirements 4.1, 4.4**

  - [~] 6.5 Write property test for referential integrity enforcement
    - **Property 14: Referential Integrity Enforcement**
    - **Validates: Requirements 4.3, 4.5**

  - [~] 6.6 Write property test for transaction rollback
    - **Property 15: Transaction Rollback on Error**
    - **Validates: Requirements 4.5, 15.3**

  - [~] 6.7 Write property test for automatic timestamps
    - **Property 16: Automatic Timestamp Population**
    - **Validates: Requirements 4.6**

  - [~] 6.8 Write property test for audit log creation
    - **Property 38: Audit Log Creation**
    - **Validates: Requirements 12.1**

  - [~] 6.9 Write property test for audit log before/after capture
    - **Property 39: Audit Log Before/After Capture**
    - **Validates: Requirements 12.2**

  - [~] 6.10 Write property test for audit log immutability
    - **Property 40: Audit Log Immutability**
    - **Validates: Requirements 12.4**

  - [~] 6.11 Write unit tests for storage edge cases
    - Test constraint violation handling
    - Test duplicate key handling
    - Test database connection failure with retry
    - Test foreign key violation
    - _Requirements: 4.5, 15.3_

- [~] 7. Checkpoint - Ensure storage tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Build Lease Computation Engine (Step 5a)
  - [~] 8.1 Create compute-lease Edge Function
    - Read lease data from leases table by lease_id
    - Read property_config and lease_config for business rules
    - Calculate monthly rent based on lease_type
    - Generate rent schedule for entire lease term
    - Store results in computation_snapshots table
    - _Requirements: 5.1, 5.6, 5.7_

  - [~] 8.2 Implement fixed escalation calculation
    - Apply escalation_rate annually on escalation_date
    - _Requirements: 5.2_

  - [~] 8.3 Implement CPI escalation calculation
    - Apply CPI-based escalation using specified index
    - _Requirements: 5.3_

  - [~] 8.4 Implement CAM cap enforcement in lease engine
    - Limit CAM charges to cap amount per lease terms
    - _Requirements: 5.4_

  - [~] 8.5 Implement base year expense recovery
    - Calculate recovery based on expenses exceeding base year
    - _Requirements: 5.5_

  - [~] 8.6 Write property test for lease rent calculation
    - **Property 17: Lease Rent Calculation by Type**
    - **Validates: Requirements 5.1**

  - [~] 8.7 Write property test for fixed escalation
    - **Property 18: Fixed Escalation Application**
    - **Validates: Requirements 5.2**

  - [~] 8.8 Write property test for CPI escalation
    - **Property 19: CPI Escalation Application**
    - **Validates: Requirements 5.3**

  - [~] 8.9 Write property test for CAM cap enforcement
    - **Property 20: CAM Cap Enforcement**
    - **Validates: Requirements 5.4, 7.3**

  - [~] 8.10 Write property test for base year recovery
    - **Property 21: Base Year Expense Recovery**
    - **Validates: Requirements 5.5**

  - [~] 8.11 Write property test for rent schedule completeness
    - **Property 22: Rent Schedule Completeness**
    - **Validates: Requirements 5.6**

  - [~] 8.12 Write unit tests for lease computation examples
    - Test lease with no escalation
    - Test lease with fixed 3% escalation
    - Test gross vs triple_net lease types
    - Test lease with CAM cap
    - _Requirements: 5.1, 5.2, 5.4_

- [ ] 9. Build Expense Processing Engine (Step 5b)
  - [~] 9.1 Create compute-expense Edge Function
    - Read expense data from expenses table by property_id and period
    - Classify expenses as recoverable or non_recoverable
    - Allocate recoverable expenses across tenants by pro_rata_share
    - Respect lease-specific recovery rules (base year, caps, exclusions)
    - Calculate total operating expenses per property per month
    - Store results in computation_snapshots table
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6_

  - [~] 9.2 Write property test for expense classification
    - **Property 23: Expense Classification**
    - **Validates: Requirements 6.1**

  - [~] 9.3 Write property test for expense allocation totals
    - **Property 24: Expense Allocation Totals**
    - **Validates: Requirements 6.2**

  - [~] 9.4 Write property test for lease-specific recovery rules
    - **Property 25: Lease-Specific Recovery Rules**
    - **Validates: Requirements 6.3**

  - [~] 9.5 Write unit tests for expense processing examples
    - Test expense allocation with 3 tenants
    - Test expense with base year exclusion
    - Test non-recoverable expense handling
    - _Requirements: 6.1, 6.2, 6.3_

- [ ] 10. Build CAM Calculation Engine (Step 5c)
  - [~] 10.1 Create compute-cam Edge Function
    - Read CAM expenses from expenses table
    - Read lease terms for CAM calculation method
    - Apply calculation method (pro_rata, fixed, percentage)
    - Apply CAM caps per lease
    - Apply CAM exclusions per lease
    - Generate CAM reconciliation report
    - Store results in computation_snapshots table
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [~] 10.2 Write property test for CAM calculation method
    - **Property 26: CAM Calculation Method Application**
    - **Validates: Requirements 7.1, 7.2**

  - [~] 10.3 Write property test for CAM exclusion enforcement
    - **Property 27: CAM Exclusion Enforcement**
    - **Validates: Requirements 7.4**

  - [~] 10.4 Write unit tests for CAM calculation examples
    - Test pro_rata method with 3 tenants
    - Test CAM cap enforcement
    - Test CAM exclusions
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [ ] 11. Build Revenue Projection Engine (Step 5d)
  - [~] 11.1 Create compute-revenue Edge Function
    - Read lease data for property_id
    - Project monthly revenue including base rent, percentage rent, CAM recovery, other income
    - Handle vacancy periods with zero revenue
    - Aggregate revenue at property, portfolio, and organization levels
    - Generate 12-month rolling forecast
    - Store results in computation_snapshots table
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [~] 11.2 Write property test for revenue projection completeness
    - **Property 28: Revenue Projection Completeness**
    - **Validates: Requirements 8.1, 8.2**

  - [~] 11.3 Write property test for vacancy revenue handling
    - **Property 29: Vacancy Revenue Handling**
    - **Validates: Requirements 8.3**

  - [~] 11.4 Write property test for revenue aggregation hierarchy
    - **Property 30: Revenue Aggregation Hierarchy**
    - **Validates: Requirements 8.4**

  - [~] 11.5 Write unit tests for revenue projection examples
    - Test revenue with all income types
    - Test revenue with vacancy period
    - Test revenue aggregation across properties
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ] 12. Build Budget Generation Engine (Step 5e)
  - [~] 12.1 Create compute-budget Edge Function
    - Aggregate revenue projections and expense plans for fiscal_year
    - Generate line items for base rent, CAM recovery, operating expenses, capital expenses, NOI
    - Support budget approval workflow (draft, pending_approval, approved, rejected)
    - Lock approved budgets and create baseline for variance analysis
    - Support budget versioning for scenario comparison
    - Store results in budgets table
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [~] 12.2 Write property test for budget line item completeness
    - **Property 31: Budget Line Item Completeness**
    - **Validates: Requirements 9.2**

  - [~] 12.3 Write property test for budget approval locking
    - **Property 32: Budget Approval Locking**
    - **Validates: Requirements 9.4**

  - [~] 12.4 Write unit tests for budget generation examples
    - Test budget with all line items
    - Test budget approval workflow
    - Test budget versioning
    - _Requirements: 9.2, 9.3, 9.4, 9.5_

- [ ] 13. Build Reconciliation Engine (Step 5f)
  - [~] 13.1 Create compute-reconciliation Edge Function
    - Retrieve budgeted amounts from budgets table
    - Retrieve actual amounts from actuals table
    - Calculate variance as (actual - budget)
    - Calculate variance_percentage as (variance / budget) * 100
    - Flag line items with variance > 10% for review
    - Generate reconciliation report with drill-down capability
    - Store results in reconciliations table
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [~] 13.2 Write property test for variance calculation
    - **Property 33: Variance Calculation Formula**
    - **Validates: Requirements 10.2**

  - [~] 13.3 Write property test for high variance flagging
    - **Property 34: High Variance Flagging**
    - **Validates: Requirements 10.3**

  - [~] 13.4 Write unit tests for reconciliation examples
    - Test reconciliation with zero variance
    - Test reconciliation with 100% variance
    - Test reconciliation with mixed variances
    - _Requirements: 10.2, 10.3_

- [ ] 14. Implement configuration layer for business rules
  - [~] 14.1 Create configuration read logic in computation engines
    - Read property_config for property-level rules
    - Read lease_config for lease-level overrides
    - Use system-wide defaults when config is missing
    - Validate configuration values are within acceptable ranges
    - _Requirements: 13.1, 13.2, 13.3, 13.5_

  - [~] 14.2 Write property test for configuration default fallback
    - **Property 41: Configuration Default Fallback**
    - **Validates: Requirements 13.3**

  - [~] 14.3 Write property test for configuration temporal isolation
    - **Property 42: Configuration Temporal Isolation**
    - **Validates: Requirements 13.4**

  - [~] 14.4 Write property test for configuration value validation
    - **Property 43: Configuration Value Validation**
    - **Validates: Requirements 13.5**

- [~] 15. Checkpoint - Ensure computation tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 16. Implement pipeline status tracking
  - [~] 16.1 Add status tracking to all Edge Functions
    - Update processing_status at each pipeline stage
    - Update updated_at timestamp on status changes
    - Store error_message and failed_step on failures
    - Calculate and store progress_percentage
    - _Requirements: 11.1, 11.2, 11.4_

  - [~] 16.2 Create status query endpoint
    - Return current processing_status and progress_percentage for file_id
    - Include error details when status is 'failed'
    - Filter by org_id for multi-tenant isolation
    - _Requirements: 11.3, 11.5_

  - [~] 16.3 Write property test for status transition timestamps
    - **Property 35: Status Transition Timestamp Updates**
    - **Validates: Requirements 11.2**

  - [~] 16.4 Write property test for failed status error information
    - **Property 36: Failed Status Error Information**
    - **Validates: Requirements 11.4**

  - [~] 16.5 Write property test for computation persistence
    - **Property 37: Computation Persistence**
    - **Validates: Requirements 5.7, 6.6, 7.6, 8.6, 9.6, 10.6**

- [ ] 17. Implement error handling and recovery
  - [~] 17.1 Add consistent error response format to all Edge Functions
    - Return error object with error_code, message, details, timestamp
    - Categorize errors (upload, parsing, validation, storage, computation)
    - _Requirements: 15.1, 15.2, 15.3, 15.4_

  - [~] 17.2 Implement retry mechanism with exponential backoff
    - Retry transient errors (network timeouts, database locks)
    - Do not retry permanent errors (validation failures, constraint violations)
    - Provide manual retry capability via API
    - _Requirements: 15.5, 15.6_

  - [~] 17.3 Implement error logging
    - Log all errors to Supabase with error type, user_id, org_id, parameters, stack trace
    - _Requirements: 15.1, 15.2, 15.3, 15.4_

  - [~] 17.4 Write property test for parse error recovery
    - **Property 44: Parse Error Recovery**
    - **Validates: Requirements 15.1**

  - [~] 17.5 Write property test for computation error handling
    - **Property 45: Computation Error Handling**
    - **Validates: Requirements 15.4**

- [ ] 18. Implement data export and pretty printer
  - [~] 18.1 Create export-data Edge Function
    - Generate CSV or Excel from computed results
    - Format with human-readable column headers
    - Include metadata (export_date, org_name, property_name, period)
    - Generate file asynchronously and provide download link
    - Support exporting rent schedules, CAM calculations, budgets, reconciliations
    - Enforce org_id isolation
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6_

  - [~] 18.2 Implement CSV pretty printer
    - Format structured JSON to CSV with proper escaping
    - Handle commas, quotes, newlines in data
    - _Requirements: 2.7, 18.2_

  - [~] 18.3 Write property test for export file generation
    - **Property 46: Export File Generation**
    - **Validates: Requirements 18.1, 18.2**

  - [~] 18.4 Write property test for export metadata inclusion
    - **Property 47: Export Metadata Inclusion**
    - **Validates: Requirements 18.5**

  - [~] 18.5 Write unit tests for pretty printer edge cases
    - Test CSV with commas in values
    - Test CSV with quotes in values
    - Test CSV with newlines in values
    - _Requirements: 2.7, 18.2_

- [ ] 19. Connect UI to Pipeline (Step 6)
  - [~] 19.1 Create FileUploader React component
    - File input with drag-and-drop support
    - File type selector (leases, expenses, properties, revenue)
    - Call upload-handler Edge Function
    - Display upload progress
    - _Requirements: 14.1_

  - [~] 19.2 Create useFileStatus custom hook
    - Poll uploaded_files table for status changes
    - Return current status, progress_percentage, errors
    - Update UI in real-time
    - _Requirements: 14.2_

  - [~] 19.3 Add validation error display to UI
    - Display validation_errors with field names and row numbers
    - Allow user to download error report
    - _Requirements: 14.3_

  - [~] 19.4 Add computation trigger buttons to existing pages
    - Add "Compute Lease" button to Leases page
    - Add "Compute Expenses" button to Expenses page
    - Add "Compute CAM" button to Properties page
    - Add "Compute Revenue" button to Revenue page
    - Add "Generate Budget" button to Budgets page
    - Add "Run Reconciliation" button to Reconciliation page
    - Call appropriate compute-* Edge Functions
    - Display computation results
    - _Requirements: 14.4_

  - [~] 19.5 Add export buttons to existing pages
    - Add "Export" button to each results view
    - Call export-data Edge Function
    - Download generated files
    - _Requirements: 14.6_

  - [~] 19.6 Create file history view
    - Display all uploaded_files with processing_status
    - Filter by org_id
    - Show file metadata (filename, size, upload date)
    - Allow retry for failed files
    - _Requirements: 14.5_

- [~] 20. Final checkpoint - Integration testing
  - Test complete Upload → Parse → Validate → Store → Compute → Export flow
  - Test multi-tenant isolation across all operations
  - Test error handling and recovery
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional property-based and unit tests that can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at key milestones
- Property tests validate universal correctness properties using fast-check with 100+ iterations
- Unit tests validate specific examples and edge cases
- Implementation follows strict order: Upload → Parse → Validate → Store → Compute → UI
- All Edge Functions enforce org_id isolation and audit logging
- Configuration layer allows property and lease-specific business rules
- Export functionality uses pretty printer for round-trip data integrity
