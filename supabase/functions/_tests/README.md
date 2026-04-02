# Backend-Driven Pipeline Tests

This directory contains property-based tests for the backend-driven pipeline feature.

## Test Framework

- **Testing Library**: Deno's built-in test runner
- **Property-Based Testing**: fast-check (v3.15.0)
- **Assertions**: Deno standard library assertions

## Running Tests

### Prerequisites

1. Ensure Supabase is running locally:
   ```bash
   supabase start
   ```

2. Set environment variables (automatically set by Supabase CLI):
   - `SUPABASE_URL`: Your Supabase project URL
   - `SUPABASE_ANON_KEY`: Anonymous key for client access
   - `SUPABASE_SERVICE_ROLE_KEY`: Service role key for admin access

### Run All Tests

```bash
cd supabase/functions/_tests
deno test --allow-net --allow-env
```

### Run Specific Test File

```bash
deno test --allow-net --allow-env org-isolation.test.ts
```

### Run with Verbose Output

```bash
deno test --allow-net --allow-env --trace-ops
```

## Test Structure

### Property-Based Tests

Property-based tests verify universal properties that should hold across all inputs. Each test:

- Runs a minimum of 10-100 iterations with randomized inputs
- References the design document property in a comment
- Uses the tag format: `// Feature: backend-driven-pipeline, Property {number}: {property_text}`

Example:
```typescript
Deno.test({
  name: "Property 2: Org_id Isolation - uploaded_files table",
  fn: async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 5, maxLength: 20 }),
        async (fileName) => {
          // Test logic here
        }
      ),
      { numRuns: 10 }
    );
  }
});
```

## Test Files

- `org-isolation.test.ts`: Tests for Property 2 (Org_id Isolation Across All Operations)
  - Validates Requirements 1.3, 4.2, 17.1, 17.2, 17.3, 17.4, 18.6
  - Tests isolation across: uploaded_files, properties, leases, expenses, computation_snapshots

## Notes

- Tests use `sanitizeResources: false` and `sanitizeOps: false` to avoid Deno's resource leak detection interfering with Supabase connections
- Each test creates temporary organizations and users, then cleans them up after execution
- Tests use the service role key to create test data, then verify RLS policies work correctly with user-level access tokens
