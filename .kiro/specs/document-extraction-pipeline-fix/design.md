# Document Extraction Pipeline Fix - Technical Design

## Overview

The document extraction pipeline is currently broken with a disconnection between the upload and extraction processes. This design addresses the core pipeline architecture issues while adding comprehensive multi-format support, custom field capabilities, and robust AI integration. The fix ensures seamless processing of PDF, DOC, DOCX, TXT, images, and other formats through a unified pipeline that maintains backward compatibility with existing CSV/Excel workflows.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug - when the document extraction pipeline fails to connect upload and extraction processes for any file format
- **Property (P)**: The desired behavior when documents are uploaded - complete end-to-end processing from upload through AI interpretation to UI field mapping
- **Preservation**: Existing CSV/Excel processing, database storage, and API response formats that must remain unchanged by the fix
- **Pipeline Router**: The `ingest-file` function that detects file formats and routes to appropriate processors
- **Docling Processor**: The `parse-pdf-docling` function that handles PDF, Word, Excel, and image extraction using Docling API or Gemini fallback
- **AI Interpreter**: The `extract-document-fields` function that uses Vertex AI to interpret extracted content and map to structured fields
- **Custom Field System**: Database schema and API endpoints for dynamic field creation when extracted data doesn't match existing UI fields
- **Normalization Layer**: The `normalize-pdf-output` function that converts raw extraction output into canonical database format

## Bug Details

### Bug Condition

The bug manifests when any document (PDF, DOC, DOCX, TXT, image, or other format) is uploaded through the system and the extraction pipeline fails to complete the full workflow from upload to UI field population. The pipeline has multiple potential failure points including format detection, routing decisions, extraction processing, AI interpretation, and custom field handling.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type DocumentUploadEvent
  OUTPUT: boolean
  
  RETURN input.fileFormat IN ['pdf', 'doc', 'docx', 'txt', 'image', 'xlsx', 'xls', 'unknown']
         AND (pipelineRouting(input.fileId) = 'failed'
              OR extractionProcess(input.fileId) = 'failed'
              OR aiInterpretation(input.fileId) = 'failed'
              OR fieldMapping(input.fileId) = 'incomplete')
END FUNCTION
```

### Examples

- **PDF Lease Document**: Upload a lease agreement PDF → extraction fails due to broken connection between `ingest-file` and `parse-pdf-docling`
- **Word Document**: Upload a DOC file with property data → routing fails because format detection doesn't properly handle Word documents
- **Image Scan**: Upload a scanned lease image → OCR extraction succeeds but AI interpretation fails to map fields to UI
- **Custom Fields**: Upload any document with non-standard fields → extraction succeeds but no mechanism exists to create custom fields for unmapped data

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- CSV and Excel file processing through the existing structured data pipeline must continue to work exactly as before
- Database storage patterns and table schemas for standard fields must remain unchanged
- API response formats to the frontend must maintain the same structure
- Existing validation rules and field formatting must be preserved
- User interactions with standard (non-custom) fields must behave identically

**Scope:**
All inputs that do NOT involve the document extraction pipeline (CSV/Excel uploads, direct data entry, existing computed results) should be completely unaffected by this fix. This includes:
- Structured data uploads (CSV, XLSX via existing parse-file function)
- Manual data entry through existing forms
- Computation engine results and caching
- Existing API endpoints for data retrieval and manipulation

## Hypothesized Root Cause

Based on the bug description and code analysis, the most likely issues are:

1. **Pipeline Routing Failures**: The `ingest-file` function may not be properly routing all file formats to the correct processors
   - Format detection logic in `file-detector.ts` may miss edge cases
   - Routing decisions may not handle all supported formats correctly

2. **Extraction Process Disconnection**: The connection between upload and extraction steps is broken
   - `parse-pdf-docling` may not be properly called for all document types
   - Error handling may cause silent failures in the pipeline

3. **AI Integration Issues**: The AI interpretation layer may not be properly mapping extracted data
   - `extract-document-fields` may not be receiving properly formatted input
   - Vertex AI calls may be failing without proper fallback handling

4. **Missing Custom Field Infrastructure**: No system exists for handling extracted fields that don't match existing UI fields
   - Database schema lacks custom field support
   - API endpoints for custom field creation are missing

## Correctness Properties

Property 1: Bug Condition - Complete Pipeline Processing

_For any_ document upload where the bug condition holds (isBugCondition returns true), the fixed pipeline SHALL successfully process the document through all stages: format detection, extraction, AI interpretation, field mapping, and custom field creation when needed, resulting in populated UI fields and stored data.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7**

Property 2: Preservation - Existing Pipeline Behavior

_For any_ input that is NOT a document requiring the extraction pipeline (CSV uploads, manual entry, existing data operations), the fixed system SHALL produce exactly the same behavior as the original system, preserving all existing functionality for structured data processing.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: Multiple files across the pipeline

**Function**: Various pipeline functions

**Specific Changes**:

1. **Pipeline Router Enhancement** (`supabase/functions/ingest-file/index.ts`):
   - Fix routing logic to properly handle all file formats
   - Add comprehensive error handling with detailed logging
   - Ensure proper status updates throughout the routing process
   - Add retry mechanisms for transient failures

2. **Format Detection Improvements** (`supabase/functions/_shared/file-detector.ts`):
   - Enhance magic byte detection for edge cases
   - Improve MIME type handling for various document formats
   - Add better fallback logic when format detection is uncertain

3. **Extraction Process Fixes** (`supabase/functions/parse-pdf-docling/index.ts`):
   - Fix connection issues between upload and extraction
   - Improve error handling and status reporting
   - Add proper fallback to Gemini when Docling API is unavailable
   - Enhance support for additional file formats (Word, images)

4. **AI Integration Enhancements** (`supabase/functions/extract-document-fields/index.ts`):
   - Improve input validation and preprocessing
   - Add better error handling for Vertex AI calls
   - Enhance field mapping logic for various document types
   - Add confidence scoring for extracted fields

5. **Custom Field System Implementation**:
   - Create database schema for custom fields
   - Implement API endpoints for custom field management
   - Add UI components for custom field creation and editing
   - Integrate custom field handling into the extraction pipeline

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Upload various document formats through the pipeline and monitor each stage for failures. Run these tests on the UNFIXED code to observe failures and understand the root cause.

**Test Cases**:
1. **PDF Processing Test**: Upload a lease PDF and verify it fails at routing or extraction stage (will fail on unfixed code)
2. **Word Document Test**: Upload a DOC/DOCX file and verify format detection and processing (will fail on unfixed code)
3. **Image OCR Test**: Upload a scanned document image and verify OCR extraction (will fail on unfixed code)
4. **Custom Field Test**: Upload a document with non-standard fields and verify no custom field creation occurs (will fail on unfixed code)

**Expected Counterexamples**:
- Pipeline routing failures for certain file formats
- Extraction process disconnections causing silent failures
- AI interpretation errors due to malformed input
- Missing custom field creation capabilities

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed pipeline produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := documentExtractionPipeline_fixed(input)
  ASSERT expectedBehavior(result)
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed pipeline produces the same result as the original pipeline.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalPipeline(input) = fixedPipeline(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-document inputs

**Test Plan**: Observe behavior on UNFIXED code first for CSV uploads and structured data operations, then write property-based tests capturing that behavior.

**Test Cases**:
1. **CSV Upload Preservation**: Verify CSV processing continues to work identically after fix
2. **Excel Processing Preservation**: Verify Excel files process through existing structured pipeline
3. **API Response Preservation**: Verify all API responses maintain the same format and content
4. **Database Schema Preservation**: Verify existing table structures and data remain unchanged

### Unit Tests

- Test file format detection for all supported formats and edge cases
- Test pipeline routing decisions for various file types and error conditions
- Test extraction functions individually with mock inputs
- Test AI interpretation with various document content types
- Test custom field creation and management APIs

### Property-Based Tests

- Generate random file uploads across all supported formats and verify successful processing
- Generate random document content and verify AI interpretation produces valid field mappings
- Generate random existing data operations and verify preservation of original behavior
- Test custom field creation with various field types and validation rules

### Integration Tests

- Test complete end-to-end pipeline from upload to UI field population
- Test error handling and recovery across all pipeline stages
- Test custom field integration with existing UI components
- Test performance and scalability with large documents and high upload volumes

## System Architecture

### Pipeline Flow Diagram

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────┐
│   File Upload   │───▶│   ingest-file    │───▶│  Format Detection   │
│   (Any Format)  │    │   (Router)       │    │  (file-detector)    │
└─────────────────┘    └──────────────────┘    └─────────────────────┘
                                │                          │
                                ▼                          ▼
                       ┌─────────────────┐    ┌─────────────────────┐
                       │  Routing Logic  │    │   Format Analysis   │
                       │   Decision      │    │  (MIME, Extension,  │
                       └─────────────────┘    │   Magic Bytes)      │
                                │             └─────────────────────┘
                                ▼
                    ┌─────────────────────────────────────────┐
                    │              Route Decision             │
                    └─────────────────────────────────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
    ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
    │   parse-file    │ │parse-pdf-docling│ │   Unsupported   │
    │ (CSV/Text)      │ │(PDF/Word/Image) │ │     Format      │
    └─────────────────┘ └─────────────────┘ └─────────────────┘
                │               │                     │
                ▼               ▼                     ▼
    ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
    │ Structured Data │ │ Raw Extraction  │ │  Error Handler  │
    │   Processing    │ │   (Docling)     │ │                 │
    └─────────────────┘ └─────────────────┘ └─────────────────┘
                │               │
                │               ▼
                │       ┌─────────────────┐
                │       │normalize-pdf-out│
                │       │   (AI Layer)    │
                │       └─────────────────┘
                │               │
                └───────────────┼───────────────┐
                                ▼               │
                    ┌─────────────────────────────────────────┐
                    │         validate-data                   │
                    │      (Field Validation)                 │
                    └─────────────────────────────────────────┘
                                │
                                ▼
                    ┌─────────────────────────────────────────┐
                    │          store-data                     │
                    │     (Database Storage)                  │
                    └─────────────────────────────────────────┘
                                │
                                ▼
                    ┌─────────────────────────────────────────┐
                    │       Custom Field Handler              │
                    │    (Dynamic Field Creation)             │
                    └─────────────────────────────────────────┘
                                │
                                ▼
                    ┌─────────────────────────────────────────┐
                    │        UI Field Population              │
                    │      (Frontend Integration)             │
                    └─────────────────────────────────────────┘
```

### Database Schema Changes for Custom Fields

**New Tables:**

```sql
-- Custom field definitions
CREATE TABLE public.custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  module_type TEXT NOT NULL, -- 'leases', 'properties', 'expenses', etc.
  field_name TEXT NOT NULL,
  field_label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text', 'number', 'date', 'boolean', 'select')),
  field_options JSONB DEFAULT '[]', -- For select fields
  is_required BOOLEAN DEFAULT FALSE,
  validation_rules JSONB DEFAULT '{}',
  display_order INTEGER DEFAULT 0,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, module_type, field_name)
);

-- Custom field values
CREATE TABLE public.custom_field_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  custom_field_id UUID NOT NULL REFERENCES public.custom_fields(id) ON DELETE CASCADE,
  record_id UUID NOT NULL, -- References the actual record (lease, property, etc.)
  record_type TEXT NOT NULL, -- 'lease', 'property', 'expense', etc.
  field_value TEXT, -- Stored as text, converted based on field_type
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(custom_field_id, record_id)
);

-- Add docling_raw column to uploaded_files if not exists
ALTER TABLE public.uploaded_files ADD COLUMN IF NOT EXISTS docling_raw JSONB;
```

### API Endpoints for Custom Fields

**Custom Field Management:**

```typescript
// GET /api/custom-fields?module_type=leases&org_id=xxx
// List custom fields for a module

// POST /api/custom-fields
// Create a new custom field
interface CreateCustomFieldRequest {
  module_type: string;
  field_name: string;
  field_label: string;
  field_type: 'text' | 'number' | 'date' | 'boolean' | 'select';
  field_options?: string[]; // For select fields
  is_required?: boolean;
  validation_rules?: Record<string, any>;
}

// PUT /api/custom-fields/:id
// Update custom field definition

// DELETE /api/custom-fields/:id
// Delete custom field and all its values

// GET /api/custom-field-values?record_id=xxx&record_type=lease
// Get custom field values for a record

// POST /api/custom-field-values
// Set custom field values for a record
interface SetCustomFieldValuesRequest {
  record_id: string;
  record_type: string;
  values: Record<string, any>; // field_name -> value mapping
}
```

**Enhanced Extraction Pipeline:**

```typescript
// POST /api/extract-with-custom-fields
// Enhanced extraction that suggests custom fields for unmapped data
interface ExtractWithCustomFieldsRequest {
  file_id: string;
  auto_create_fields?: boolean; // Automatically create suggested custom fields
}

interface ExtractWithCustomFieldsResponse {
  extracted_data: Record<string, any>[];
  mapped_fields: Record<string, string>; // extracted_field -> ui_field mapping
  unmapped_fields: {
    field_name: string;
    sample_values: string[];
    suggested_type: 'text' | 'number' | 'date' | 'boolean' | 'select';
    confidence: number;
  }[];
  custom_field_suggestions: {
    field_name: string;
    field_label: string;
    field_type: string;
    field_options?: string[];
  }[];
}
```

### Integration Points Between Components

**1. Upload → Router Integration:**
- `ingest-file` receives upload notifications via webhook or direct API call
- File metadata is stored in `uploaded_files` table with initial status
- Router downloads file preview for format detection

**2. Router → Processor Integration:**
- Router calls appropriate processor function via internal HTTP
- Status updates are propagated back through the pipeline
- Error handling ensures failed files are marked appropriately

**3. Processor → AI Integration:**
- Raw extraction output is stored in `docling_raw` column
- AI interpreter receives structured data for field mapping
- Custom field suggestions are generated for unmapped data

**4. AI → Database Integration:**
- Validated data is stored in appropriate module tables
- Custom field definitions are created as needed
- Custom field values are linked to records

**5. Database → UI Integration:**
- Frontend queries both standard and custom fields
- Dynamic form generation based on custom field definitions
- Real-time updates when custom fields are added or modified

### Error Handling and Recovery Mechanisms

**Pipeline-Level Error Handling:**

```typescript
interface PipelineError {
  stage: 'upload' | 'routing' | 'extraction' | 'ai_interpretation' | 'storage';
  error_code: string;
  error_message: string;
  retry_count: number;
  max_retries: number;
  is_recoverable: boolean;
  recovery_action?: string;
}

// Error recovery strategies
const RECOVERY_STRATEGIES = {
  'DOCLING_API_UNAVAILABLE': 'fallback_to_gemini',
  'VERTEX_AI_TIMEOUT': 'retry_with_smaller_input',
  'FORMAT_DETECTION_FAILED': 'manual_format_override',
  'CUSTOM_FIELD_CREATION_FAILED': 'store_as_notes'
};
```

**Retry Logic:**
- Exponential backoff for transient failures
- Circuit breaker pattern for external API calls
- Graceful degradation when AI services are unavailable
- Manual intervention queue for unrecoverable errors

**Monitoring and Alerting:**
- Pipeline stage completion metrics
- Error rate monitoring by file format and stage
- Performance metrics for extraction and AI processing
- Custom field usage analytics

**Data Consistency:**
- Transactional updates across related tables
- Rollback mechanisms for partial failures
- Audit logging for all pipeline operations
- Data validation at each stage boundary

This comprehensive design addresses all aspects of the broken document extraction pipeline while maintaining backward compatibility and adding robust custom field capabilities. The architecture ensures scalability, reliability, and maintainability while providing a seamless user experience for document processing across all supported formats.