# Requirements Document

## Introduction

This document specifies the requirements for transforming the CRE Financial Platform from a frontend-heavy architecture into a backend-driven financial computation system. The transformation establishes a unified data pipeline (Upload → Parse → Validate → Store → Compute → Output) that processes financial data through Supabase Edge Functions and Storage, ensuring data integrity, multi-tenant isolation, and audit compliance.

## Glossary

- **Upload_System**: The file upload subsystem that receives CSV/Excel files, stores them in Supabase Storage, and tracks metadata
- **Parsing_Engine**: The data extraction subsystem that converts CSV/Excel files into structured JSON
- **Validation_Layer**: The data quality subsystem that validates required fields, normalizes data, and returns validation results
- **Storage_Layer**: The database persistence subsystem that stores validated data into Supabase tables with org_id isolation
- **Computation_Engine**: The financial calculation subsystem that processes leases, expenses, CAM, revenue, budgets, and reconciliation
- **Pipeline**: The complete data flow from file upload through computation to output
- **Lease_Engine**: The computation module that calculates rent, escalations, CAM charges, and lease-driven financial rules
- **Expense_Engine**: The computation module that processes operating expenses and determines recoverability
- **CAM_Engine**: The computation module that applies Common Area Maintenance calculations based on lease terms
- **Revenue_Engine**: The computation module that projects revenue based on lease terms and occupancy
- **Budget_Engine**: The computation module that generates structured budgets from properties, leases, and expenses
- **Reconciliation_Engine**: The computation module that performs year-end variance analysis between budgeted and actual amounts
- **Uploaded_File**: A record in the uploaded_files table tracking file metadata and processing status
- **Valid_Data**: Data that has passed all validation rules and is ready for storage
- **Validation_Error**: A structured error message indicating which field failed validation and why
- **Org_Id**: The organization identifier used for multi-tenant data isolation
- **Processing_Status**: The current state of a file in the pipeline (uploaded, parsing, validated, stored, computed, failed)
- **Audit_Trail**: A chronological record of all data changes with user, timestamp, and action details
- **Parser**: A module within Parsing_Engine that handles a specific file type (properties, leases, expenses, revenue)
- **Pretty_Printer**: A module that formats structured data back into human-readable CSV/Excel format
- **Round_Trip**: The process of parsing a file, printing it, and parsing again to verify data integrity

## Requirements

### Requirement 1: File Upload System

**User Story:** As a property manager, I want to upload CSV/Excel files containing financial data, so that the system can process and store my data securely.

#### Acceptance Criteria

1. WHEN a user uploads a CSV or Excel file, THE Upload_System SHALL store the file in Supabase Storage with a unique identifier
2. WHEN a file is stored, THE Upload_System SHALL create an Uploaded_File record with filename, file_size, upload_timestamp, org_id, and processing_status set to 'uploaded'
3. THE Upload_System SHALL enforce org_id isolation so users can only access files belonging to their organization
4. WHEN a file upload fails, THE Upload_System SHALL return a descriptive error message indicating the failure reason
5. THE Upload_System SHALL support All file formats
6. WHEN a file exceeds 100MB, THE Upload_System SHALL reject the upload and return a size limit error

### Requirement 2: File Parsing Engine

**User Story:** As a system administrator, I want uploaded files to be automatically parsed into structured JSON, so that data can be validated and stored consistently.

#### Acceptance Criteria

1. WHEN an Uploaded_File has processing_status 'uploaded', THE Parsing_Engine SHALL extract the file from Supabase Storage and parse it into structured JSON
2. THE Parsing_Engine SHALL provide separate Parser modules for properties, leases, expenses, and revenue file types
3. WHEN parsing completes successfully, THE Parsing_Engine SHALL update the Uploaded_File processing_status to 'parsed' and store the parsed JSON
4. WHEN parsing fails, THE Parsing_Engine SHALL update the Uploaded_File processing_status to 'failed' and store the error message
5. THE Parsing_Engine SHALL preserve all column headers and data types from the source file
6. THE Parsing_Engine SHALL handle missing values by representing them as null in the JSON output
7. THE Pretty_Printer SHALL format structured JSON data back into valid CSV format
8. FOR ALL valid JSON data, parsing then printing then parsing SHALL produce equivalent structured data (round-trip property)

### Requirement 3: Data Validation Layer

**User Story:** As a data analyst, I want uploaded data to be validated against business rules, so that only clean data enters the system.

#### Acceptance Criteria

1. WHEN parsed JSON is received, THE Validation_Layer SHALL validate all required fields are present and non-empty
2. THE Validation_Layer SHALL validate data types match expected schema (dates as ISO strings, numbers as numeric, text as strings)
3. WHEN validation succeeds, THE Validation_Layer SHALL return Valid_Data and update processing_status to 'validated'
4. WHEN validation fails, THE Validation_Layer SHALL return a list of Validation_Error objects with field name, row number, and error description
5. THE Validation_Layer SHALL normalize date formats to ISO 8601 (YYYY-MM-DD)
6. THE Validation_Layer SHALL normalize currency values by removing symbols and converting to numeric
7. THE Validation_Layer SHALL validate that org_id matches the authenticated user's organization
8. WHEN a lease record is validated, THE Validation_Layer SHALL verify that property_id references an existing property in the same org_id

### Requirement 4: Data Storage Layer

**User Story:** As a database administrator, I want validated data to be stored in normalized tables, so that data integrity and multi-tenant isolation are maintained.

#### Acceptance Criteria

1. WHEN Valid_Data is received, THE Storage_Layer SHALL insert records into the appropriate table (properties, units, leases, expenses, revenue_lines)
2. THE Storage_Layer SHALL enforce org_id isolation on all insert operations
3. THE Storage_Layer SHALL maintain referential integrity between properties, buildings, units, and leases
4. WHEN a storage operation succeeds, THE Storage_Layer SHALL update processing_status to 'stored' and return the inserted record IDs
5. WHEN a storage operation fails due to constraint violation, THE Storage_Layer SHALL return a descriptive error and rollback the transaction
6. THE Storage_Layer SHALL automatically populate created_at and updated_at timestamps
7. THE Storage_Layer SHALL support Portfolio → Property → Building → Unit hierarchy with proper foreign key relationships

### Requirement 5: Lease Computation Engine

**User Story:** As a leasing manager, I want lease terms to be automatically calculated, so that rent, escalations, and CAM charges are accurate.

#### Acceptance Criteria

1. WHEN a lease record is stored, THE Lease_Engine SHALL calculate monthly rent based on lease_type (gross, modified_gross, triple_net, percentage)
2. WHEN a lease has escalation_type 'fixed', THE Lease_Engine SHALL apply the escalation_rate annually on the escalation_date
3. WHEN a lease has escalation_type 'cpi', THE Lease_Engine SHALL apply CPI-based escalation using the specified index
4. WHEN a lease has a CAM cap, THE Lease_Engine SHALL limit CAM charges to the cap amount per lease terms
5. WHEN a lease has a base_year clause, THE Lease_Engine SHALL calculate expense recovery based on expenses exceeding the base year amount
6. THE Lease_Engine SHALL generate a rent schedule for the entire lease term with monthly breakdowns
7. WHEN lease calculations complete, THE Lease_Engine SHALL store results in a computation_snapshots table with lease_id, calculation_date, and computed_values

### Requirement 6: Expense Processing Engine

**User Story:** As an accounting manager, I want operating expenses to be classified and allocated, so that recoverable amounts are calculated correctly.

#### Acceptance Criteria

1. WHEN an expense record is stored, THE Expense_Engine SHALL classify it as recoverable or non_recoverable based on expense_category
2. THE Expense_Engine SHALL allocate recoverable expenses across tenants based on their pro_rata_share
3. WHEN an expense is allocated, THE Expense_Engine SHALL respect lease-specific recovery rules (base year, caps, exclusions)
4. THE Expense_Engine SHALL calculate total operating expenses per property per month
5. THE Expense_Engine SHALL generate an expense allocation report showing per-tenant recovery amounts
6. WHEN expense processing completes, THE Expense_Engine SHALL update processing_status to 'computed'

### Requirement 7: CAM Calculation Engine

**User Story:** As a property accountant, I want CAM charges to be calculated per lease terms, so that tenant billings are accurate and defensible.

#### Acceptance Criteria

1. WHEN CAM expenses are available, THE CAM_Engine SHALL calculate each tenant's CAM charge based on their lease terms
2. THE CAM_Engine SHALL apply CAM calculation method (pro_rata, fixed, percentage) as specified in the lease
3. WHEN a lease has a CAM cap, THE CAM_Engine SHALL limit the charge to the cap amount
4. WHEN a lease has CAM exclusions, THE CAM_Engine SHALL exclude specified expense categories from the calculation
5. THE CAM_Engine SHALL generate a CAM reconciliation report comparing estimated vs actual CAM charges
6. THE CAM_Engine SHALL store CAM calculation results in the cam_calculations table with tenant_id, period, estimated_amount, actual_amount, and variance

### Requirement 8: Revenue Projection Engine

**User Story:** As a financial analyst, I want revenue to be projected based on lease terms, so that I can forecast cash flow accurately.

#### Acceptance Criteria

1. WHEN lease data is available, THE Revenue_Engine SHALL project monthly revenue for each lease based on rent schedule and occupancy
2. THE Revenue_Engine SHALL include base rent, percentage rent, CAM recovery, and other income in revenue projections
3. WHEN a unit is vacant, THE Revenue_Engine SHALL project zero revenue for that unit during the vacancy period
4. THE Revenue_Engine SHALL aggregate revenue projections at the property, portfolio, and organization levels
5. THE Revenue_Engine SHALL generate a 12-month rolling revenue forecast updated monthly
6. WHEN revenue projections are generated, THE Revenue_Engine SHALL store results in the revenue_projections table

### Requirement 9: Budget Generation Engine

**User Story:** As a portfolio manager, I want budgets to be generated from properties, leases, and expenses, so that I can plan financial performance.

#### Acceptance Criteria

1. WHEN a budget creation is requested, THE Budget_Engine SHALL aggregate revenue projections and expense plans for the specified period
2. THE Budget_Engine SHALL generate line items for base rent, CAM recovery, operating expenses, capital expenses, and net operating income
3. THE Budget_Engine SHALL support budget approval workflow with statuses (draft, pending_approval, approved, rejected)
4. WHEN a budget is approved, THE Budget_Engine SHALL lock the budget and create a baseline for variance analysis
5. THE Budget_Engine SHALL allow budget versioning so multiple scenarios can be compared
6. THE Budget_Engine SHALL store budgets in the budgets table with org_id, property_id, fiscal_year, status, and line_items JSON

### Requirement 10: Reconciliation Engine

**User Story:** As a controller, I want year-end reconciliation to compare budgeted vs actual amounts, so that I can analyze variances and adjust forecasts.

#### Acceptance Criteria

1. WHEN a reconciliation is initiated, THE Reconciliation_Engine SHALL retrieve budgeted amounts from the budgets table and actual amounts from the actuals table
2. THE Reconciliation_Engine SHALL calculate variance for each line item as (actual - budget) and variance_percentage as (variance / budget) * 100
3. WHEN variance exceeds 10%, THE Reconciliation_Engine SHALL flag the line item as requiring review
4. THE Reconciliation_Engine SHALL generate a reconciliation report with line-by-line variance analysis
5. THE Reconciliation_Engine SHALL support drill-down from summary to transaction-level detail
6. THE Reconciliation_Engine SHALL store reconciliation results in the reconciliations table with period, property_id, total_variance, and status

### Requirement 11: Pipeline Status Tracking

**User Story:** As a user, I want to see the processing status of my uploaded files, so that I know when data is ready for use.

#### Acceptance Criteria

1. THE Pipeline SHALL maintain processing_status for each Uploaded_File with values (uploaded, parsing, parsed, validating, validated, storing, stored, computing, computed, failed)
2. WHEN processing_status changes, THE Pipeline SHALL update the updated_at timestamp
3. THE Pipeline SHALL provide a status endpoint that returns current processing_status and progress_percentage for a given file_id
4. WHEN processing_status is 'failed', THE Pipeline SHALL include error_message and failed_step in the response
5. THE Pipeline SHALL allow users to query all files with a specific processing_status filtered by org_id

### Requirement 12: Audit Trail and Versioning

**User Story:** As a compliance officer, I want all data changes to be logged, so that I can maintain an audit trail for regulatory purposes.

#### Acceptance Criteria

1. WHEN a record is created, updated, or deleted, THE Storage_Layer SHALL log the action to the audit_logs table with user_id, entity_type, entity_id, action, timestamp, and org_id
2. THE Storage_Layer SHALL capture before and after values for update operations in the audit log
3. THE Storage_Layer SHALL support versioning for budgets and leases so historical versions can be retrieved
4. THE Storage_Layer SHALL enforce that audit logs cannot be modified or deleted
5. THE Storage_Layer SHALL provide an audit query endpoint that returns all changes for a given entity_id or user_id filtered by org_id

### Requirement 13: Configuration Layer for Business Rules

**User Story:** As a system administrator, I want to configure business rules per property and lease, so that calculations reflect property-specific policies.

#### Acceptance Criteria

1. THE Computation_Engine SHALL read configuration from a property_config table with fields (property_id, cam_calculation_method, expense_recovery_method, fiscal_year_start)
2. THE Computation_Engine SHALL read lease-specific overrides from a lease_config table with fields (lease_id, cam_cap, base_year, excluded_expenses)
3. WHEN a configuration is missing, THE Computation_Engine SHALL use system-wide defaults
4. WHEN a configuration is updated, THE Computation_Engine SHALL apply the new rules to future calculations without affecting historical data
5. THE Computation_Engine SHALL validate that configuration values are within acceptable ranges before applying them

### Requirement 14: UI Integration with Pipeline

**User Story:** As a user, I want the UI to trigger pipeline operations and display results, so that I can interact with the backend-driven system seamlessly.

#### Acceptance Criteria

1. WHEN a user uploads a file via the UI, THE UI SHALL call the Upload_System API and display upload progress
2. WHEN processing_status changes, THE UI SHALL poll the status endpoint and update the display in real-time
3. WHEN validation errors occur, THE UI SHALL display Validation_Error messages with field names and row numbers
4. WHEN computation completes, THE UI SHALL fetch and display computed results (rent schedules, CAM charges, budgets, reconciliations)
5. THE UI SHALL provide a file history view showing all Uploaded_File records with their processing_status filtered by org_id
6. THE UI SHALL allow users to download computed results as CSV or Excel files using the Pretty_Printer

### Requirement 15: Error Handling and Recovery

**User Story:** As a system operator, I want the pipeline to handle errors gracefully, so that partial failures do not corrupt data or block processing.

#### Acceptance Criteria

1. WHEN a parsing error occurs, THE Parsing_Engine SHALL log the error, update processing_status to 'failed', and allow the user to re-upload the file
2. WHEN a validation error occurs, THE Validation_Layer SHALL return all errors at once (not fail on first error) so the user can fix all issues in one iteration
3. WHEN a storage error occurs, THE Storage_Layer SHALL rollback the transaction and return a descriptive error message
4. WHEN a computation error occurs, THE Computation_Engine SHALL log the error, mark the computation as failed, and notify the user
5. THE Pipeline SHALL provide a retry mechanism for failed operations that can be triggered manually or automatically
6. THE Pipeline SHALL implement exponential backoff for transient errors (network timeouts, database locks)

### Requirement 16: Performance and Scalability

**User Story:** As a platform architect, I want the pipeline to handle large files and concurrent users, so that the system scales with business growth.

#### Acceptance Criteria

1. THE Parsing_Engine SHALL process files up to 50MB within 60 seconds
2. THE Validation_Layer SHALL validate 10,000 rows within 30 seconds
3. THE Storage_Layer SHALL insert 10,000 records within 60 seconds using batch operations
4. THE Computation_Engine SHALL calculate a full-year rent schedule for 100 leases within 30 seconds
5. THE Pipeline SHALL support at least 10 concurrent file uploads without performance degradation
6. THE Pipeline SHALL use Supabase Edge Functions for compute-intensive operations to avoid blocking the main application

### Requirement 17: Multi-Tenant Data Isolation

**User Story:** As a security officer, I want all data to be isolated by org_id, so that organizations cannot access each other's data.

#### Acceptance Criteria

1. THE Upload_System SHALL automatically tag all Uploaded_File records with the authenticated user's org_id
2. THE Storage_Layer SHALL enforce org_id filtering on all SELECT, UPDATE, and DELETE operations
3. THE Computation_Engine SHALL only process data belonging to the requesting user's org_id
4. THE Pipeline SHALL return an authorization error if a user attempts to access data from a different org_id
5. THE Pipeline SHALL use Supabase Row Level Security (RLS) policies to enforce org_id isolation at the database level

### Requirement 18: Data Export and Reporting

**User Story:** As a financial analyst, I want to export computed results, so that I can use them in external tools like Excel or BI platforms.

#### Acceptance Criteria

1. THE Pipeline SHALL provide an export endpoint that generates CSV or Excel files from computed results
2. THE Pretty_Printer SHALL format exported data with human-readable column headers and proper data types
3. WHEN a user requests an export, THE Pipeline SHALL generate the file asynchronously and provide a download link
4. THE Pipeline SHALL support exporting rent schedules, CAM calculations, budgets, and reconciliation reports
5. THE Pipeline SHALL include metadata in exports (export_date, org_name, property_name, period)
6. THE Pipeline SHALL enforce org_id isolation on all export operations

