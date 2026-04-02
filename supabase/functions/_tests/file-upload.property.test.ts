// @ts-nocheck
/**
 * Property-Based Test: File Upload Creates Storage Record
 * Feature: backend-driven-pipeline, Property 1: File Upload Creates Storage Record
 * 
 * **Validates: Requirements 1.1, 1.2, 17.1**
 * 
 * For any valid CSV or Excel file uploaded by an authenticated user, the system 
 * shall store the file in Supabase Storage with a unique identifier and create an 
 * uploaded_files record containing filename, file_size, upload_timestamp, the user's 
 * org_id, and processing_status='uploaded'.
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import * as fc from "https://cdn.skypack.dev/fast-check@3.15.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// Test configuration
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'http://localhost:54321';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const UPLOAD_HANDLER_URL = `${SUPABASE_URL}/functions/v1/upload-handler`;

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
  // Create auth user
  const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
    email,
    password: 'test-password-123',
    email_confirm: true
  });
  
  if (authError) throw new Error(`Failed to create user: ${authError.message}`);
  
  // Create membership
  const { error: membershipError } = await adminClient
    .from('memberships')
    .insert({
      user_id: authData.user.id,
      org_id: orgId,
      role: 'member',
      status: 'active'
    });
  
  if (membershipError) throw new Error(`Failed to create membership: ${membershipError.message}`);
  
  // Get access token
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
 * Test helper: Cleanup test data
 */
async function cleanupTestData(adminClient: any, orgIds: string[], fileIds: string[]) {
  // Delete uploaded files
  for (const fileId of fileIds) {
    await adminClient.from('uploaded_files').delete().eq('id', fileId);
  }
  
  // Delete storage files
  for (const orgId of orgIds) {
    try {
      const { data: files } = await adminClient.storage
        .from('financial-uploads')
        .list(`financial-uploads/${orgId}`);
      
      if (files && files.length > 0) {
        const filePaths = files.map(f => `financial-uploads/${orgId}/${f.name}`);
        await adminClient.storage
          .from('financial-uploads')
          .remove(filePaths);
      }
    } catch (e) {
      // Ignore storage cleanup errors
    }
  }
  
  // Delete organizations
  for (const orgId of orgIds) {
    await adminClient.from('memberships').delete().eq('org_id', orgId);
    await adminClient.from('organizations').delete().eq('id', orgId);
  }
}

// ============================================================
// PROPERTY-BASED TESTS
// ============================================================

/**
 * Generator: Valid file types
 */
const validFileTypeArb = fc.constantFrom('leases', 'expenses', 'properties', 'revenue', 'cam', 'budgets');

/**
 * Generator: Valid MIME types
 */
const validMimeTypeArb = fc.constantFrom(
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
);

/**
 * Generator: File name with extension
 */
const fileNameArb = fc.tuple(
  fc.string({ minLength: 3, maxLength: 20, unit: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '-', '_') }),
  fc.constantFrom('.csv', '.xls', '.xlsx')
).map(([name, ext]) => name + ext);

/**
 * Generator: File size (in bytes, between 1KB and 10MB for reasonable test performance)
 */
const fileSizeArb = fc.integer({ min: 1024, max: 10 * 1024 * 1024 });

/**
 * Generator: CSV content
 */
const csvContentArb = fc.tuple(
  fc.array(fc.string({ minLength: 3, maxLength: 15 }), { minLength: 3, maxLength: 10 }),
  fc.array(
    fc.array(fc.oneof(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.integer({ min: 0, max: 100000 }).map(n => n.toString()),
      fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }).map(d => d.toISOString().split('T')[0])
    )),
    { minLength: 1, maxLength: 50 }
  )
).map(([headers, rows]) => {
  const headerLine = headers.join(',');
  const dataLines = rows.map(row => {
    // Ensure row has same length as headers
    const paddedRow = [...row];
    while (paddedRow.length < headers.length) {
      paddedRow.push('');
    }
    return paddedRow.slice(0, headers.length).join(',');
  });
  return [headerLine, ...dataLines].join('\n');
});

Deno.test({
  name: "Property 1: File Upload Creates Storage Record",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    const testFileIds: string[] = [];
    
    try {
      await fc.assert(
        fc.asyncProperty(
          fileNameArb,
          validFileTypeArb,
          validMimeTypeArb,
          csvContentArb,
          async (fileName, fileType, mimeType, csvContent) => {
            // Setup: Create organization and user
            const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
            testOrgIds.push(org.id);
            
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
            
            // Create test file with generated content
            const testFile = new File([csvContent], fileName, { type: mimeType });
            
            // Create form data
            const formData = new FormData();
            formData.append('file', testFile);
            formData.append('file_type', fileType);
            
            // Call upload-handler
            const response = await fetch(UPLOAD_HANDLER_URL, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${user.accessToken}`
              },
              body: formData
            });
            
            const result = await response.json();
            
            // Property Assertion 1: Upload succeeds with 200 status
            assertEquals(response.status, 200, 'Upload should succeed with 200 status');
            assertEquals(result.error, false, 'Result should not have error');
            
            // Property Assertion 2: Response contains required fields
            assertExists(result.file_id, 'Response should contain file_id');
            assertExists(result.storage_path, 'Response should contain storage_path');
            assertExists(result.file_name, 'Response should contain file_name');
            assertExists(result.file_size, 'Response should contain file_size');
            assertExists(result.processing_status, 'Response should contain processing_status');
            assertExists(result.created_at, 'Response should contain created_at');
            
            // Property Assertion 3: Processing status is 'uploaded'
            assertEquals(result.processing_status, 'uploaded', 'Processing status should be uploaded');
            
            // Property Assertion 4: File name matches uploaded file
            assertEquals(result.file_name, fileName, 'File name should match uploaded file');
            
            testFileIds.push(result.file_id);
            
            // Property Assertion 5: Database record exists with correct fields
            const { data: uploadRecord, error: dbError } = await adminClient
              .from('uploaded_files')
              .select('*')
              .eq('id', result.file_id)
              .single();
            
            assertEquals(dbError, null, 'Database record should exist');
            assertExists(uploadRecord, 'Upload record should be retrievable');
            
            // Property Assertion 6: Database record has correct org_id (Requirement 17.1)
            assertEquals(uploadRecord.org_id, org.id, 'Upload record should have correct org_id');
            
            // Property Assertion 7: Database record has correct module_type
            assertEquals(uploadRecord.module_type, fileType, 'Upload record should have correct module_type');
            
            // Property Assertion 8: Database record has correct status
            assertEquals(uploadRecord.status, 'uploaded', 'Upload record should have uploaded status');
            
            // Property Assertion 9: Database record has correct file_name
            assertEquals(uploadRecord.file_name, fileName, 'Upload record should have correct file_name');
            
            // Property Assertion 10: Database record has file_size
            assertExists(uploadRecord.file_size, 'Upload record should have file_size');
            assertEquals(uploadRecord.file_size > 0, true, 'File size should be positive');
            
            // Property Assertion 11: Database record has timestamps
            assertExists(uploadRecord.created_at, 'Upload record should have created_at timestamp');
            assertExists(uploadRecord.updated_at, 'Upload record should have updated_at timestamp');
            
            // Property Assertion 12: Storage path follows correct format
            assertEquals(
              result.storage_path.startsWith(`financial-uploads/${org.id}/`),
              true,
              'Storage path should follow financial-uploads/{org_id}/{file_id} format'
            );
            
            // Property Assertion 13: File exists in storage (Requirement 1.1)
            const { data: storageFile, error: storageError } = await adminClient.storage
              .from('financial-uploads')
              .download(result.storage_path);
            
            assertEquals(storageError, null, 'File should exist in storage');
            assertExists(storageFile, 'Storage file should be downloadable');
            
            // Property Assertion 14: Storage file has content
            const storageFileSize = storageFile.size;
            assertEquals(storageFileSize > 0, true, 'Storage file should have content');
            
            // Cleanup for this iteration
            await cleanupTestData(adminClient, [org.id], [result.file_id]);
            testOrgIds.length = 0;
            testFileIds.length = 0;
          }
        ),
        { numRuns: 100 } // Run 100 iterations as specified in design document
      );
    } finally {
      // Final cleanup
      if (testOrgIds.length > 0 || testFileIds.length > 0) {
        await cleanupTestData(adminClient, testOrgIds, testFileIds);
      }
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

