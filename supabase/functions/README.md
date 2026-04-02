# Supabase Edge Functions - Backend-Driven Pipeline

This directory contains Supabase Edge Functions that implement the backend-driven financial computation pipeline for the CRE Financial Suite.

## Architecture

The pipeline follows this flow:
```
Upload → Parse → Validate → Store → Compute → Export
```

## Edge Functions

### Pipeline Functions

1. **upload-handler** (Task 2.1)
   - Receives file uploads (CSV/Excel)
   - Stores files in Supabase Storage
   - Creates `uploaded_files` record with status='uploaded'
   - Enforces 50MB file size limit

2. **parse-file** (Task 3.1)
   - Reads file from Supabase Storage
   - Parses CSV/Excel into structured JSON
   - Updates processing_status to 'parsed' or 'failed'
   - Stores parsed_data in uploaded_files table

3. **validate-data** (Task 5.1)
   - Validates parsed JSON against schema
   - Normalizes dates and currency values
   - Checks referential integrity
   - Returns all validation errors at once
   - Updates processing_status to 'validated' or 'failed'

4. **store-data** (Task 6.1)
   - Inserts validated records into appropriate tables
   - Enforces org_id isolation
   - Maintains referential integrity
   - Uses transactions with rollback on error
   - Logs audit trail
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
- `getUserOrgId(userId, supabaseAdmin)` - Gets org_id for user

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
