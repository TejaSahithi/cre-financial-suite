# Supabase Edge Functions - Backend-Driven Pipeline

This directory contains Supabase Edge Functions that implement the backend-driven financial computation pipeline for the CRE Financial Suite.

## Architecture

### Multi-Format Ingestion Pipeline

```
Any File (CSV / Excel / PDF / Text)
         │
         ▼
  upload-handler          ← accepts all formats, stores to Storage
         │
         ▼
   ingest-file            ← detects format + module, routes to correct parser
    ├── CSV/Excel/Text → parse-file          → status: parsed
    └── PDF            → parse-pdf-docling  → status: pdf_parsed
                                │
                                ▼
                       normalize-pdf-output  → status: parsed
                                │
                                ▼ (same from here for ALL formats)
                        validate-data        → status: validated
                                │
                                ▼
                         store-data          → status: stored
                                │
                                ▼
                      compute-* engines      → computation_snapshots
                                │
                                ▼
                         export-data         → CSV/Excel download
```

### Shared Modules (`_shared/`)

| Module | Purpose |
|--------|---------|
| `file-detector.ts` | Detects file format (csv/xlsx/pdf/text) and module type (leases/expenses/etc.) from MIME, extension, magic bytes, and content keywords |
| `normalizer.ts` | Converts Docling PDF output, plain text, or CSV rows into canonical row format for the module parsers |
| `cors.ts` | CORS headers |
| `supabase.ts` | Auth helpers |
| `config-helper.ts` | Business rule configuration |
| `error-handler.ts` | Standardized error formatting |

## Edge Functions

### Ingestion Functions

1. **upload-handler**
   - Accepts CSV, Excel, PDF, plain text (up to 50MB)
   - Stores to `financial-uploads/{org_id}/{file_id}`
   - Creates `uploaded_files` record with status=`uploaded`

2. **ingest-file** ← NEW unified entry point
   - Detects file format and module type automatically
   - Routes to `parse-file` (CSV/Excel/text) or `parse-pdf-docling` + `normalize-pdf-output` (PDF)
   - Returns detection result + routing decision

3. **parse-file**
   - Handles CSV, Excel, plain text
   - Applies module-specific parser (lease/expense/property/revenue)
   - Sets status=`parsed`

4. **parse-pdf-docling** ← PDF OCR
   - Downloads PDF from Storage
   - Calls Docling API for structured extraction
   - Stores raw output in `docling_raw` column
   - Sets status=`pdf_parsed`

5. **normalize-pdf-output** ← PDF normalization
   - Reads `docling_raw` from uploaded_files
   - Normalizes Docling fields/tables into canonical rows
   - Runs through existing module parser
   - Sets status=`parsed` (same as CSV from here)

### Validation & Storage

6. **validate-data** — validates parsed_data, sets status=`validated`
7. **store-data** — inserts validated rows into business tables, sets status=`stored`

### Computation Engines

8. **compute-lease** — rent schedules, escalations
9. **compute-expense** — expense classification, tenant allocation
10. **compute-cam** — CAM charges per tenant
11. **compute-revenue** — monthly revenue projections
12. **compute-budget** — budget generation and approval workflow
13. **compute-reconciliation** — variance analysis

### Utilities

14. **export-data** — CSV/Excel export from computation results
15. **pipeline-status** — query processing status for any file

## Status Flow

```
uploaded → parsing → parsed → validating → validated → storing → stored → processed
                  ↗
         pdf_parsed (PDF only, intermediate)
```

Any step can transition to `failed` with an `error_message`.

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key for admin operations |
| `SUPABASE_ANON_KEY` | Yes | Anon key for inter-function calls |
| `DOCLING_API_URL` | No | Docling service URL (mock used if absent) |
| `DOCLING_API_KEY` | No | Optional auth token for Docling |
   - Updates processing_status to 'stored'

### Computation Functions

5. **compute-lease** (Task 8.1)
   - Calculates rent schedules
   - Applies escalations (fixed, CPI)
   - Enforces CAM caps
   - Handles base year expense recovery
   - Stores results in computation_snapshots

6. **compute-expense** (Task 9.1)
   - Classifies expenses as recoverable/non-recoverable
   - Allocates expenses across tenants
   - Respects lease-specific recovery rules
   - Stores results in computation_snapshots

7. **compute-cam** (Task 10.1)
   - Applies CAM calculation methods (pro_rata, fixed, percentage)
   - Enforces CAM caps and exclusions
   - Generates CAM reconciliation reports
   - Stores results in computation_snapshots

8. **compute-revenue** (Task 11.1)
   - Projects monthly revenue
   - Handles vacancy periods
   - Aggregates at property/portfolio/org levels
   - Generates 12-month rolling forecast
   - Stores results in computation_snapshots

9. **compute-budget** (Task 12.1)
   - Aggregates revenue projections and expense plans
   - Generates budget line items
   - Supports approval workflow
   - Locks approved budgets
   - Stores results in budgets table

10. **compute-reconciliation** (Task 13.1)
    - Compares budgeted vs actual amounts
    - Calculates variance and variance_percentage
    - Flags high variance items (>10%)
    - Stores results in reconciliations table

### Export Functions

11. **export-data** (Task 18.1)
    - Generates CSV/Excel from computed results
    - Formats with human-readable headers
    - Includes metadata
    - Enforces org_id isolation

## Shared Utilities

### `_shared/cors.ts`
- Common CORS headers for all functions

### `_shared/supabase.ts`
- `createAdminClient()` - Creates Supabase admin client
- `verifyUser(req)` - Verifies user from Authorization header
- `getUserOrgId(userId, supabaseAdmin, req?)` - Gets org_id for user. For super-admins with no org-scoped membership, requires the caller to pass the request so the `x-acting-org-id` header can be read (there is no implicit "first org" fallback — see audit finding S2).

## Multi-Tenant Isolation

All functions enforce org_id isolation:
1. Verify user authentication
2. Get user's org_id from memberships table
3. Filter all queries by org_id
4. Validate all inserts include correct org_id

## Error Handling

All functions return consistent error format:
```json
{
  "error": true,
  "error_code": "VALIDATION_FAILED",
  "message": "Data validation failed",
  "details": [...],
  "timestamp": "2024-01-15T10:30:00Z"
}
```

## Development Status

- ✅ Directory structure created
- ✅ Shared utilities implemented
- ✅ Function placeholders created
- ⏳ Upload handler (Task 2.1)
- ⏳ Parse file (Task 3.1)
- ⏳ Validate data (Task 5.1)
- ⏳ Store data (Task 6.1)
- ⏳ Compute functions (Tasks 8-13)
- ⏳ Export data (Task 18.1)

## Testing

Each function will have:
- Property-based tests (using fast-check)
- Unit tests for specific examples and edge cases
- Integration tests for full pipeline flow

See `tasks.md` for detailed implementation plan.
