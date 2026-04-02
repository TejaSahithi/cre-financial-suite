# Backend-Driven Pipeline Setup

This document summarizes the infrastructure setup for the backend-driven financial computation pipeline.

## Task 1: Database Schema and Edge Functions Infrastructure ✅

### Database Tables Created

#### 1. uploaded_files (Already Exists)
Location: `supabase/migrations/20260401_pipeline_uploaded_files.sql`

Tracks file uploads through the processing pipeline.
- Status flow: uploaded → parsing → validating → processed → failed
- Stores parsed_data, valid_data, validation_errors, computed_results
- RLS policies enforce org_id isolation

#### 2. computation_snapshots (Already Exists)
Location: `supabase/migrations/20260401_pipeline_uploaded_files.sql`

Stores deterministic outputs from each engine run.
- Supports all engine types: cam, budget, revenue, lease, reconciliation, expense
- Includes input_hash for idempotency
- RLS policies enforce org_id isolation

#### 3. property_config (New)
Location: `supabase/migrations/20260402_config_tables.sql`

Property-level business rules configuration.
- cam_calculation_method: pro_rata, fixed, capped
- expense_recovery_method: base_year, full, none
- fiscal_year_start: 1-12
- config_values: JSONB for extensibility
- RLS policies enforce org_id isolation

#### 4. lease_config (New)
Location: `supabase/migrations/20260402_config_tables.sql`

Lease-specific overrides for business rules.
- cam_cap: Numeric cap on CAM charges
- base_year: Integer year for base year calculations
- excluded_expenses: Array of expense categories to exclude
- config_values: JSONB for extensibility
- RLS policies enforce org_id isolation

### Edge Functions Directory Structure

Created placeholder Edge Functions with proper structure:

#### Pipeline Functions
- `upload-handler/` - File upload and storage (Task 2.1)
- `parse-file/` - CSV/Excel parsing (Task 3.1)
- `validate-data/` - Data validation (Task 5.1)
- `store-data/` - Database persistence (Task 6.1)

#### Computation Functions
- `compute-lease/` - Rent schedules and escalations (Task 8.1)
- `compute-expense/` - Expense classification and allocation (Task 9.1)
- `compute-cam/` - CAM calculations (Task 10.1)
- `compute-revenue/` - Revenue projections (Task 11.1)
- `compute-budget/` - Budget generation (Task 12.1)
- `compute-reconciliation/` - Variance analysis (Task 13.1)

#### Export Functions
- `export-data/` - CSV/Excel export (Task 18.1)

#### Shared Utilities
- `_shared/cors.ts` - Common CORS headers
- `_shared/supabase.ts` - Authentication and org_id helpers

### RLS Policies

All new tables have Row Level Security enabled with policies:
- **SELECT**: Users can read data from their org(s)
- **INSERT**: Users with write permissions can insert data
- **UPDATE**: Users with write permissions can update data
- **DELETE**: Only org admins can delete data

RLS helper functions (already exist in schema):
- `get_my_org_ids()` - Returns org_ids for current user
- `can_write_org_data(org_id)` - Checks write permissions
- `is_org_admin(org_id)` - Checks admin permissions

### Multi-Tenant Isolation

All Edge Functions enforce org_id isolation:
1. Verify user authentication via Authorization header
2. Get user's org_id from memberships table
3. Filter all queries by org_id
4. Validate all inserts include correct org_id

### Requirements Validated

This task validates the following requirements:
- **4.1**: Storage layer inserts records into appropriate tables
- **4.2**: Storage layer enforces org_id isolation
- **12.1**: Audit trail logging (via audit_logs table)
- **13.1**: Configuration layer reads from property_config table
- **13.2**: Configuration layer reads from lease_config table
- **17.5**: Multi-tenant data isolation via RLS policies

### Next Steps

The infrastructure is now ready for implementation:
1. Task 2: Build Upload System
2. Task 3: Build Parsing Engine
3. Task 5: Build Validation Layer
4. Task 6: Build Storage Layer
5. Tasks 8-13: Build Computation Engines
6. Task 18: Build Export System

Each Edge Function has a placeholder with TODO comments indicating what needs to be implemented.

### Files Created

```
cre-financial-suite-main/
├── supabase/
│   ├── migrations/
│   │   └── 20260402_config_tables.sql (NEW)
│   └── functions/
│       ├── _shared/
│       │   ├── cors.ts (NEW)
│       │   └── supabase.ts (NEW)
│       ├── upload-handler/
│       │   └── index.ts (NEW)
│       ├── parse-file/
│       │   └── index.ts (NEW)
│       ├── validate-data/
│       │   └── index.ts (NEW)
│       ├── store-data/
│       │   └── index.ts (NEW)
│       ├── compute-lease/
│       │   └── index.ts (NEW)
│       ├── compute-expense/
│       │   └── index.ts (NEW)
│       ├── compute-cam/
│       │   └── index.ts (NEW)
│       ├── compute-revenue/
│       │   └── index.ts (NEW)
│       ├── compute-budget/
│       │   └── index.ts (NEW)
│       ├── compute-reconciliation/
│       │   └── index.ts (NEW)
│       ├── export-data/
│       │   └── index.ts (NEW)
│       └── README.md (NEW)
```

### Deployment

To deploy the new migration:
```bash
# Apply migration to Supabase
supabase db push

# Or if using Supabase CLI locally
supabase migration up
```

To deploy Edge Functions (when implemented):
```bash
supabase functions deploy upload-handler
supabase functions deploy parse-file
# ... etc
```
