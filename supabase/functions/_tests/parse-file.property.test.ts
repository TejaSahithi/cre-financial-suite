// @ts-nocheck
/**
 * Property-Based Tests: Parse File Edge Function
 * Feature: backend-driven-pipeline, Task 3.1
 * 
 * **Validates: Requirements 2.5, 2.6**
 * 
 * Property 6: Column and Type Preservation
 * For any CSV file parsed by the system, all column headers from the source file 
 * shall be preserved in the parsed JSON, and missing values shall be represented as null.
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import fc from "https://esm.sh/fast-check@3.15.0";

// Test configuration
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'http://localhost:54321';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PARSE_FILE_URL = `${SUPABASE_URL}/functions/v1/parse-file`;

/**
 * Creates a Supabase client with service role (admin) access
 */
function createAdminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

/**
 * Test helper: Create a test organization
 */
async function createTestOrg(adminClient: any, orgName: string) {
  const { data, error } = await adminClient
    .from('organizations')
    .insert({ name: orgName, status: 'active' })
    .select()
    .single();
  
  if (error) throw new Error(`Failed to create org: ${error.message}`);
  return data;
}

/**
 * Test helper: Create a test user and membership
 */
async function createTestUser(adminClient: any, email: string, orgId: string) {
  const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
    email,
    password: 'test-password-123',
    email_confirm: true
  });
  
  if (authError) throw new Error(`Failed to create user: ${authError.message}`);
  
  const { error: membershipError } = await adminClient
    .from('memberships')
    .insert({
      user_id: authData.user.id,
      org_id: orgId,
      role: 'member',
      status: 'active'
    });
  
  if (membershipError) throw new Error(`Failed to create membership: ${membershipError.message}`);
  
  const { data: sessionData, error: sessionError } = await adminClient.auth.signInWithPassword({
    email,
    password: 'test-password-123'
  });
  
  if (sessionError) throw new Error(`Failed to sign in: ${sessionError.message}`);
  
  return {
    userId: authData.user.id,
    accessToken: sessionData.session.access_token
  };
}

/**
 * Test helper: Upload a CSV file to storage and create uploaded_files record
 */
async function uploadTestFile(adminClient: any, orgId: string, csvContent: string, fileName: string = 'test.csv') {
  const fileId = crypto.randomUUID();
  const storagePath = `${orgId}/${fileId}`;
  
  const { error: uploadError } = await adminClient
    .storage
    .from('financial-uploads')
    .upload(storagePath, new Blob([csvContent], { type: 'text/csv' }), {
      contentType: 'text/csv',
      upsert: false
    });
  
  if (uploadError) throw new Error(`Failed to upload file: ${uploadError.message}`);
  
  const { data: fileRecord, error: insertError } = await adminClient
    .from('uploaded_files')
    .insert({
      id: fileId,
      org_id: orgId,
      module_type: 'leases',
      file_name: fileName,
      file_url: `${SUPABASE_URL}/storage/v1/object/public/financial-uploads/${storagePath}`,
      file_size: new Blob([csvContent]).size,
      mime_type: 'text/csv',
      status: 'uploaded'
    })
    .select()
    .single();
  
  if (insertError) throw new Error(`Failed to create file record: ${insertError.message}`);
  
  return fileRecord;
}

/**
 * Test helper: Cleanup test data
 */
async function cleanup(adminClient: any, orgId: string, userId: string, fileIds: string[]) {
  for (const fileId of fileIds) {
    await adminClient.from('uploaded_files').delete().eq('id', fileId);
    await adminClient.storage.from('financial-uploads').remove([`${orgId}/${fileId}`]);
  }
  
  await adminClient.from('memberships').delete().eq('user_id', userId);
  await adminClient.auth.admin.deleteUser(userId);
  await adminClient.from('organizations').delete().eq('id', orgId);
}

/**
 * Generator: Valid column header names
 */
const columnHeaderArb = fc.string({ 
  minLength: 3, 
  maxLength: 20,
  unit: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '_')
});

/**
 * Generator: CSV cell value (can be empty for null testing)
 */
const cellValueArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 30 }),
  fc.integer({ min: 0, max: 100000 }).map(n => n.toString()),
  fc.constant('') // Empty value for null testing
);

/**
 * Generator: CSV row (array of cell values)
 */
const csvRowArb = (numColumns: number) => fc.array(cellValueArb, { minLength: numColumns, maxLength: numColumns });

/**
 * Generator: Complete CSV content with headers and rows
 */
const csvContentArb = fc.tuple(
  fc.array(columnHeaderArb, { minLength: 2, maxLength: 8 }),
  fc.integer({ min: 1, max: 10 })
).chain(([headers, numRows]) => {
  return fc.tuple(
    fc.constant(headers),
    fc.array(csvRowArb(headers.length), { minLength: numRows, maxLength: numRows })
  );
}).map(([headers, rows]) => {
  const headerLine = headers.join(',');
  const dataLines = rows.map(row => row.join(','));
  return {
    csvText: [headerLine, ...dataLines].join('\n') + '\n',
    headers,
    rows,
    expectedRowCount: rows.length
  };
});

Deno.test({
  name: "Property 6: Column and Type Preservation - All headers preserved and nulls handled",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    
    await fc.assert(
      fc.asyncProperty(
        csvContentArb,
        async (csvData) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];
          
          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
            
            // Upload CSV file
            const fileRecord = await uploadTestFile(adminClient, org.id, csvData.csvText);
            fileIds.push(fileRecord.id);
            
            // Call parse-file function
            const response = await fetch(PARSE_FILE_URL, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${user.accessToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ file_id: fileRecord.id })
            });
            
            const result = await response.json();
            
            // Property Assertion 1: All headers are preserved
            assertEquals(
              result.headers.length,
              csvData.headers.length,
              'All column headers should be preserved'
            );
            
            for (let i = 0; i < csvData.headers.length; i++) {
              assertEquals(
                result.headers[i],
                csvData.headers[i],
                `Header ${i} should match`
              );
            }
            
            // Property Assertion 2: Row count matches
            assertEquals(
              result.row_count,
              csvData.expectedRowCount,
              'Row count should match expected'
            );
            
            // Property Assertion 3: Each parsed row has all header keys
            for (const parsedRow of result.parsed_data) {
              for (const header of csvData.headers) {
                assertExists(
                  parsedRow.hasOwnProperty(header),
                  `Parsed row should have key for header: ${header}`
                );
              }
            }
            
            // Property Assertion 4: Empty values are represented as null
            for (let rowIdx = 0; rowIdx < result.parsed_data.length; rowIdx++) {
              const parsedRow = result.parsed_data[rowIdx];
              const originalRow = csvData.rows[rowIdx];
              
              for (let colIdx = 0; colIdx < csvData.headers.length; colIdx++) {
                const header = csvData.headers[colIdx];
                const originalValue = originalRow[colIdx];
                const parsedValue = parsedRow[header];
                
                if (originalValue === '') {
                  assertEquals(
                    parsedValue,
                    null,
                    `Empty value should be null for ${header} in row ${rowIdx}`
                  );
                } else {
                  assertEquals(
                    parsedValue,
                    originalValue,
                    `Non-empty value should be preserved for ${header} in row ${rowIdx}`
                  );
                }
              }
            }
            
            await cleanup(adminClient, org.id, user.userId, fileIds);
          } catch (error) {
            await cleanup(adminClient, org.id, '', fileIds);
            throw error;
          }
        }
      ),
      { numRuns: 100 }
    );
  }
});

Deno.test({
  name: "Property 6: Column Preservation - Headers with special characters",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    
    // Generator for headers with underscores and numbers
    const specialHeaderArb = fc.tuple(
      fc.string({ minLength: 3, maxLength: 10, unit: fc.constantFrom('a', 'b', 'c', 'd', 'e') }),
      fc.oneof(
        fc.constant('_id'),
        fc.constant('_name'),
        fc.constant('_date'),
        fc.integer({ min: 1, max: 99 }).map(n => `_${n}`)
      )
    ).map(([base, suffix]) => base + suffix);
    
    const specialCsvArb = fc.tuple(
      fc.array(specialHeaderArb, { minLength: 2, maxLength: 5 }),
      fc.integer({ min: 1, max: 5 })
    ).chain(([headers, numRows]) => {
      return fc.tuple(
        fc.constant(headers),
        fc.array(csvRowArb(headers.length), { minLength: numRows, maxLength: numRows })
      );
    }).map(([headers, rows]) => {
      const headerLine = headers.join(',');
      const dataLines = rows.map(row => row.join(','));
      return {
        csvText: [headerLine, ...dataLines].join('\n') + '\n',
        headers,
        expectedRowCount: rows.length
      };
    });
    
    await fc.assert(
      fc.asyncProperty(
        specialCsvArb,
        async (csvData) => {
          const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
          const fileIds: string[] = [];
          
          try {
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
            
            const fileRecord = await uploadTestFile(adminClient, org.id, csvData.csvText);
            fileIds.push(fileRecord.id);
            
            const response = await fetch(PARSE_FILE_URL, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${user.accessToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ file_id: fileRecord.id })
            });
            
            const result = await response.json();
            
            // Property Assertion: Headers with special characters are preserved exactly
            for (let i = 0; i < csvData.headers.length; i++) {
              assertEquals(
                result.headers[i],
                csvData.headers[i],
                `Special header ${csvData.headers[i]} should be preserved exactly`
              );
            }
            
            await cleanup(adminClient, org.id, user.userId, fileIds);
          } catch (error) {
            await cleanup(adminClient, org.id, '', fileIds);
            throw error;
          }
        }
      ),
      { numRuns: 100 }
    );
  }
});
