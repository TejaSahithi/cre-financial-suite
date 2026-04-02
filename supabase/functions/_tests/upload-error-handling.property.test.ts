// @ts-nocheck
/**
 * Property-Based Test: Upload Error Handling
 * Feature: backend-driven-pipeline, Property 3: Upload Error Handling
 * 
 * **Validates: Requirements 1.4**
 * 
 * For any file upload that fails (due to invalid format, size limit, or storage error), 
 * the system shall return a descriptive error message indicating the specific failure reason.
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
async function cleanupTestData(adminClient: any, orgIds: string[]) {
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
 * Generator: Invalid file types (not in the allowed list)
 */
const invalidFileTypeArb = fc.constantFrom(
  'invalid',
  'documents',
  'images',
  'videos',
  'unknown',
  'lease',  // singular instead of plural
  'expense',
  ''
);

/**
 * Generator: Invalid MIME types (not CSV or Excel)
 */
const invalidMimeTypeArb = fc.constantFrom(
  'application/pdf',
  'image/jpeg',
  'image/png',
  'text/plain',
  'application/json',
  'application/zip',
  'video/mp4'
);

/**
 * Generator: File size exceeding 50MB limit
 */
const oversizedFileSizeArb = fc.integer({ 
  min: 50 * 1024 * 1024 + 1,  // Just over 50MB
  max: 100 * 1024 * 1024       // Up to 100MB
});

/**
 * Generator: Valid file types for testing other error conditions
 */
const validFileTypeArb = fc.constantFrom('leases', 'expenses', 'properties', 'revenue', 'cam', 'budgets');

/**
 * Generator: Valid MIME types for testing other error conditions
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
  fc.constantFrom('.csv', '.xls', '.xlsx', '.pdf', '.jpg')
).map(([name, ext]) => name + ext);

/**
 * Generator: Small CSV content for valid size tests
 */
const smallCsvContentArb = fc.constant('header1,header2,header3\nvalue1,value2,value3\n');

Deno.test({
  name: "Property 3: Upload Error Handling - Invalid File Type",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    
    try {
      await fc.assert(
        fc.asyncProperty(
          fileNameArb,
          invalidFileTypeArb,
          validMimeTypeArb,
          smallCsvContentArb,
          async (fileName, invalidFileType, mimeType, csvContent) => {
            // Setup: Create organization and user
            const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
            testOrgIds.push(org.id);
            
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
            
            // Create test file
            const testFile = new File([csvContent], fileName, { type: mimeType });
            
            // Create form data with invalid file_type
            const formData = new FormData();
            formData.append('file', testFile);
            formData.append('file_type', invalidFileType);
            
            // Call upload-handler
            const response = await fetch(UPLOAD_HANDLER_URL, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${user.accessToken}`
              },
              body: formData
            });
            
            const result = await response.json();
            
            // Property Assertion 1: Upload fails with 400 status for invalid file_type
            assertEquals(response.status, 400, 'Invalid file_type should return 400 Bad Request');
            
            // Property Assertion 2: Response contains error flag
            assertEquals(result.error, true, 'Response should have error=true');
            
            // Property Assertion 3: Response contains descriptive error message
            assertExists(result.message, 'Response should contain error message');
            assertEquals(
              result.message.includes('Invalid file_type') || result.message.includes('file_type'),
              true,
              'Error message should describe the invalid file_type issue'
            );
            
            // Cleanup for this iteration
            await cleanupTestData(adminClient, [org.id]);
            testOrgIds.length = 0;
          }
        ),
        { numRuns: 100 }
      );
    } finally {
      // Final cleanup
      if (testOrgIds.length > 0) {
        await cleanupTestData(adminClient, testOrgIds);
      }
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Property 3: Upload Error Handling - Unsupported File Format",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    
    try {
      await fc.assert(
        fc.asyncProperty(
          fileNameArb,
          validFileTypeArb,
          invalidMimeTypeArb,
          smallCsvContentArb,
          async (fileName, fileType, invalidMimeType, csvContent) => {
            // Setup: Create organization and user
            const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
            testOrgIds.push(org.id);
            
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
            
            // Create test file with invalid MIME type
            const testFile = new File([csvContent], fileName, { type: invalidMimeType });
            
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
            
            // Property Assertion 1: Upload fails with 400 status for unsupported format
            assertEquals(response.status, 400, 'Unsupported file format should return 400 Bad Request');
            
            // Property Assertion 2: Response contains error flag
            assertEquals(result.error, true, 'Response should have error=true');
            
            // Property Assertion 3: Response contains descriptive error message
            assertExists(result.message, 'Response should contain error message');
            assertEquals(
              result.message.includes('Unsupported file format') || result.message.includes('format'),
              true,
              'Error message should describe the unsupported format issue'
            );
            
            // Property Assertion 4: Error message mentions supported formats
            assertEquals(
              result.message.includes('CSV') || result.message.includes('Excel'),
              true,
              'Error message should mention supported formats (CSV, Excel)'
            );
            
            // Cleanup for this iteration
            await cleanupTestData(adminClient, [org.id]);
            testOrgIds.length = 0;
          }
        ),
        { numRuns: 100 }
      );
    } finally {
      // Final cleanup
      if (testOrgIds.length > 0) {
        await cleanupTestData(adminClient, testOrgIds);
      }
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Property 3: Upload Error Handling - File Size Exceeds Limit",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    
    try {
      await fc.assert(
        fc.asyncProperty(
          fileNameArb,
          validFileTypeArb,
          validMimeTypeArb,
          oversizedFileSizeArb,
          async (fileName, fileType, mimeType, fileSize) => {
            // Setup: Create organization and user
            const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
            testOrgIds.push(org.id);
            
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
            
            // Create oversized file content
            const oversizedContent = new Uint8Array(fileSize);
            const testFile = new File([oversizedContent], fileName, { type: mimeType });
            
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
            
            // Property Assertion 1: Upload fails with 413 status for oversized file
            assertEquals(response.status, 413, 'Oversized file should return 413 Payload Too Large');
            
            // Property Assertion 2: Response contains error flag
            assertEquals(result.error, true, 'Response should have error=true');
            
            // Property Assertion 3: Response contains descriptive error message
            assertExists(result.message, 'Response should contain error message');
            assertEquals(
              result.message.includes('50MB') || result.message.includes('size'),
              true,
              'Error message should describe the size limit issue'
            );
            
            // Property Assertion 4: Error message mentions the actual file size
            assertEquals(
              result.message.includes('MB'),
              true,
              'Error message should include file size in MB'
            );
            
            // Cleanup for this iteration
            await cleanupTestData(adminClient, [org.id]);
            testOrgIds.length = 0;
          }
        ),
        { numRuns: 100 }
      );
    } finally {
      // Final cleanup
      if (testOrgIds.length > 0) {
        await cleanupTestData(adminClient, testOrgIds);
      }
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Property 3: Upload Error Handling - Missing File Parameter",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    
    try {
      await fc.assert(
        fc.asyncProperty(
          validFileTypeArb,
          async (fileType) => {
            // Setup: Create organization and user
            const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
            testOrgIds.push(org.id);
            
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
            
            // Create form data WITHOUT file
            const formData = new FormData();
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
            
            // Property Assertion 1: Upload fails with 400 status for missing file
            assertEquals(response.status, 400, 'Missing file should return 400 Bad Request');
            
            // Property Assertion 2: Response contains error flag
            assertEquals(result.error, true, 'Response should have error=true');
            
            // Property Assertion 3: Response contains descriptive error message
            assertExists(result.message, 'Response should contain error message');
            assertEquals(
              result.message.includes('Missing file') || result.message.includes('file'),
              true,
              'Error message should describe the missing file issue'
            );
            
            // Cleanup for this iteration
            await cleanupTestData(adminClient, [org.id]);
            testOrgIds.length = 0;
          }
        ),
        { numRuns: 100 }
      );
    } finally {
      // Final cleanup
      if (testOrgIds.length > 0) {
        await cleanupTestData(adminClient, testOrgIds);
      }
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Property 3: Upload Error Handling - Missing File Type Parameter",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    
    try {
      await fc.assert(
        fc.asyncProperty(
          fileNameArb,
          validMimeTypeArb,
          smallCsvContentArb,
          async (fileName, mimeType, csvContent) => {
            // Setup: Create organization and user
            const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
            testOrgIds.push(org.id);
            
            const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
            
            // Create test file
            const testFile = new File([csvContent], fileName, { type: mimeType });
            
            // Create form data WITHOUT file_type
            const formData = new FormData();
            formData.append('file', testFile);
            
            // Call upload-handler
            const response = await fetch(UPLOAD_HANDLER_URL, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${user.accessToken}`
              },
              body: formData
            });
            
            const result = await response.json();
            
            // Property Assertion 1: Upload fails with 400 status for missing file_type
            assertEquals(response.status, 400, 'Missing file_type should return 400 Bad Request');
            
            // Property Assertion 2: Response contains error flag
            assertEquals(result.error, true, 'Response should have error=true');
            
            // Property Assertion 3: Response contains descriptive error message
            assertExists(result.message, 'Response should contain error message');
            assertEquals(
              result.message.includes('Missing file_type') || result.message.includes('file_type'),
              true,
              'Error message should describe the missing file_type issue'
            );
            
            // Cleanup for this iteration
            await cleanupTestData(adminClient, [org.id]);
            testOrgIds.length = 0;
          }
        ),
        { numRuns: 100 }
      );
    } finally {
      // Final cleanup
      if (testOrgIds.length > 0) {
        await cleanupTestData(adminClient, testOrgIds);
      }
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});
