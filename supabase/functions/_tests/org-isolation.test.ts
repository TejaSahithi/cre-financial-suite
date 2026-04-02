// @ts-nocheck
/**
 * Property-Based Test: Org_id Isolation Across All Operations
 * Feature: backend-driven-pipeline, Property 2: Org_id Isolation Across All Operations
 * 
 * **Validates: Requirements 1.3, 4.2, 17.1, 17.2, 17.3, 17.4, 18.6**
 * 
 * For any user and any data entity (uploaded files, leases, expenses, properties, 
 * computations, exports), the system shall enforce that users can only access, modify, 
 * or delete entities belonging to their org_id, and any attempt to access entities 
 * from a different org_id shall return an authorization error.
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import * as fc from "https://cdn.skypack.dev/fast-check@3.15.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// Test configuration
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'http://localhost:54321';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

/**
 * Creates a Supabase client with service role (admin) access
 */
function createAdminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

/**
 * Creates a Supabase client with user-level access
 */
function createUserClient(accessToken: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
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
 * Test helper: Create a test uploaded file
 */
async function createTestUploadedFile(adminClient: any, orgId: string, fileName: string) {
  const { data, error } = await adminClient
    .from('uploaded_files')
    .insert({
      org_id: orgId,
      module_type: 'leases',
      file_name: fileName,
      file_url: `test/${fileName}`,
      status: 'uploaded'
    })
    .select()
    .single();
  
  if (error) throw new Error(`Failed to create uploaded file: ${error.message}`);
  return data;
}

/**
 * Test helper: Create a test property
 */
async function createTestProperty(adminClient: any, orgId: string, propertyName: string) {
  const { data, error } = await adminClient
    .from('properties')
    .insert({
      org_id: orgId,
      name: propertyName,
      status: 'active'
    })
    .select()
    .single();
  
  if (error) throw new Error(`Failed to create property: ${error.message}`);
  return data;
}

/**
 * Test helper: Create a test lease
 */
async function createTestLease(adminClient: any, orgId: string, propertyId: string, tenantName: string) {
  const { data, error } = await adminClient
    .from('leases')
    .insert({
      org_id: orgId,
      property_id: propertyId,
      tenant_name: tenantName,
      start_date: '2024-01-01',
      end_date: '2025-12-31',
      monthly_rent: 1000,
      status: 'active'
    })
    .select()
    .single();
  
  if (error) throw new Error(`Failed to create lease: ${error.message}`);
  return data;
}

/**
 * Test helper: Create a test expense
 */
async function createTestExpense(adminClient: any, orgId: string, propertyId: string, amount: number) {
  const { data, error } = await adminClient
    .from('expenses')
    .insert({
      org_id: orgId,
      property_id: propertyId,
      category: 'Maintenance',
      amount: amount,
      classification: 'recoverable',
      fiscal_year: 2024,
      month: 1,
      date: '2024-01-15'
    })
    .select()
    .single();
  
  if (error) throw new Error(`Failed to create expense: ${error.message}`);
  return data;
}

/**
 * Test helper: Create a test computation snapshot
 */
async function createTestComputationSnapshot(adminClient: any, orgId: string, propertyId: string) {
  const { data, error } = await adminClient
    .from('computation_snapshots')
    .insert({
      org_id: orgId,
      property_id: propertyId,
      engine_type: 'lease',
      fiscal_year: 2024,
      inputs: { test: 'data' },
      outputs: { result: 'computed' }
    })
    .select()
    .single();
  
  if (error) throw new Error(`Failed to create computation snapshot: ${error.message}`);
  return data;
}

/**
 * Test helper: Cleanup test data
 */
async function cleanupTestData(adminClient: any, orgIds: string[]) {
  // Delete in reverse order of dependencies
  for (const orgId of orgIds) {
    await adminClient.from('computation_snapshots').delete().eq('org_id', orgId);
    await adminClient.from('expenses').delete().eq('org_id', orgId);
    await adminClient.from('leases').delete().eq('org_id', orgId);
    await adminClient.from('properties').delete().eq('org_id', orgId);
    await adminClient.from('uploaded_files').delete().eq('org_id', orgId);
    await adminClient.from('memberships').delete().eq('org_id', orgId);
    await adminClient.from('organizations').delete().eq('id', orgId);
  }
}

// ============================================================
// PROPERTY-BASED TESTS
// ============================================================

Deno.test({
  name: "Property 2: Org_id Isolation - uploaded_files table",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 5, maxLength: 20 }),
          fc.string({ minLength: 5, maxLength: 20 }),
          async (fileName1, fileName2) => {
            // Setup: Create two organizations with users and data
            const org1 = await createTestOrg(adminClient, `Test Org 1 ${Date.now()}`);
            const org2 = await createTestOrg(adminClient, `Test Org 2 ${Date.now()}`);
            testOrgIds.push(org1.id, org2.id);
            
            const user1 = await createTestUser(adminClient, `user1-${Date.now()}@test.com`, org1.id);
            const user2 = await createTestUser(adminClient, `user2-${Date.now()}@test.com`, org2.id);
            
            const file1 = await createTestUploadedFile(adminClient, org1.id, fileName1);
            const file2 = await createTestUploadedFile(adminClient, org2.id, fileName2);
            
            // Test: User 1 can access their own file
            const client1 = createUserClient(user1.accessToken);
            const { data: ownFile, error: ownError } = await client1
              .from('uploaded_files')
              .select('*')
              .eq('id', file1.id)
              .single();
            
            assertEquals(ownError, null, 'User should be able to access their own org file');
            assertExists(ownFile, 'User should retrieve their own org file');
            assertEquals(ownFile.org_id, org1.id, 'File should belong to user org');
            
            // Test: User 1 cannot access User 2's file
            const { data: otherFile, error: otherError } = await client1
              .from('uploaded_files')
              .select('*')
              .eq('id', file2.id)
              .single();
            
            assertEquals(otherFile, null, 'User should not retrieve other org file');
            
            // Test: User 1 cannot update User 2's file
            const { error: updateError } = await client1
              .from('uploaded_files')
              .update({ status: 'parsed' })
              .eq('id', file2.id);
            
            assertExists(updateError, 'User should not be able to update other org file');
            
            // Test: User 1 cannot delete User 2's file
            const { error: deleteError } = await client1
              .from('uploaded_files')
              .delete()
              .eq('id', file2.id);
            
            assertExists(deleteError, 'User should not be able to delete other org file');
            
            // Cleanup for this iteration
            await cleanupTestData(adminClient, [org1.id, org2.id]);
            testOrgIds.length = 0;
          }
        ),
        { numRuns: 10 } // Run 10 iterations with different file names
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
  name: "Property 2: Org_id Isolation - properties table",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 5, maxLength: 20 }),
          fc.string({ minLength: 5, maxLength: 20 }),
          async (propertyName1, propertyName2) => {
            // Setup: Create two organizations with users and properties
            const org1 = await createTestOrg(adminClient, `Test Org 1 ${Date.now()}`);
            const org2 = await createTestOrg(adminClient, `Test Org 2 ${Date.now()}`);
            testOrgIds.push(org1.id, org2.id);
            
            const user1 = await createTestUser(adminClient, `user1-${Date.now()}@test.com`, org1.id);
            const user2 = await createTestUser(adminClient, `user2-${Date.now()}@test.com`, org2.id);
            
            const property1 = await createTestProperty(adminClient, org1.id, propertyName1);
            const property2 = await createTestProperty(adminClient, org2.id, propertyName2);
            
            // Test: User 1 can access their own property
            const client1 = createUserClient(user1.accessToken);
            const { data: ownProperty, error: ownError } = await client1
              .from('properties')
              .select('*')
              .eq('id', property1.id)
              .single();
            
            assertEquals(ownError, null, 'User should be able to access their own org property');
            assertExists(ownProperty, 'User should retrieve their own org property');
            assertEquals(ownProperty.org_id, org1.id, 'Property should belong to user org');
            
            // Test: User 1 cannot access User 2's property
            const { data: otherProperty } = await client1
              .from('properties')
              .select('*')
              .eq('id', property2.id)
              .single();
            
            assertEquals(otherProperty, null, 'User should not retrieve other org property');
            
            // Cleanup for this iteration
            await cleanupTestData(adminClient, [org1.id, org2.id]);
            testOrgIds.length = 0;
          }
        ),
        { numRuns: 10 }
      );
    } finally {
      if (testOrgIds.length > 0) {
        await cleanupTestData(adminClient, testOrgIds);
      }
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Property 2: Org_id Isolation - leases table",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 5, maxLength: 20 }),
          fc.string({ minLength: 5, maxLength: 20 }),
          async (tenantName1, tenantName2) => {
            // Setup
            const org1 = await createTestOrg(adminClient, `Test Org 1 ${Date.now()}`);
            const org2 = await createTestOrg(adminClient, `Test Org 2 ${Date.now()}`);
            testOrgIds.push(org1.id, org2.id);
            
            const user1 = await createTestUser(adminClient, `user1-${Date.now()}@test.com`, org1.id);
            
            const property1 = await createTestProperty(adminClient, org1.id, 'Property 1');
            const property2 = await createTestProperty(adminClient, org2.id, 'Property 2');
            
            const lease1 = await createTestLease(adminClient, org1.id, property1.id, tenantName1);
            const lease2 = await createTestLease(adminClient, org2.id, property2.id, tenantName2);
            
            // Test: User 1 can access their own lease
            const client1 = createUserClient(user1.accessToken);
            const { data: ownLease, error: ownError } = await client1
              .from('leases')
              .select('*')
              .eq('id', lease1.id)
              .single();
            
            assertEquals(ownError, null, 'User should be able to access their own org lease');
            assertExists(ownLease, 'User should retrieve their own org lease');
            
            // Test: User 1 cannot access User 2's lease
            const { data: otherLease } = await client1
              .from('leases')
              .select('*')
              .eq('id', lease2.id)
              .single();
            
            assertEquals(otherLease, null, 'User should not retrieve other org lease');
            
            // Cleanup
            await cleanupTestData(adminClient, [org1.id, org2.id]);
            testOrgIds.length = 0;
          }
        ),
        { numRuns: 10 }
      );
    } finally {
      if (testOrgIds.length > 0) {
        await cleanupTestData(adminClient, testOrgIds);
      }
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Property 2: Org_id Isolation - expenses table",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.float({ min: 100, max: 10000 }),
          fc.float({ min: 100, max: 10000 }),
          async (amount1, amount2) => {
            // Setup
            const org1 = await createTestOrg(adminClient, `Test Org 1 ${Date.now()}`);
            const org2 = await createTestOrg(adminClient, `Test Org 2 ${Date.now()}`);
            testOrgIds.push(org1.id, org2.id);
            
            const user1 = await createTestUser(adminClient, `user1-${Date.now()}@test.com`, org1.id);
            
            const property1 = await createTestProperty(adminClient, org1.id, 'Property 1');
            const property2 = await createTestProperty(adminClient, org2.id, 'Property 2');
            
            const expense1 = await createTestExpense(adminClient, org1.id, property1.id, amount1);
            const expense2 = await createTestExpense(adminClient, org2.id, property2.id, amount2);
            
            // Test: User 1 can access their own expense
            const client1 = createUserClient(user1.accessToken);
            const { data: ownExpense, error: ownError } = await client1
              .from('expenses')
              .select('*')
              .eq('id', expense1.id)
              .single();
            
            assertEquals(ownError, null, 'User should be able to access their own org expense');
            assertExists(ownExpense, 'User should retrieve their own org expense');
            
            // Test: User 1 cannot access User 2's expense
            const { data: otherExpense } = await client1
              .from('expenses')
              .select('*')
              .eq('id', expense2.id)
              .single();
            
            assertEquals(otherExpense, null, 'User should not retrieve other org expense');
            
            // Cleanup
            await cleanupTestData(adminClient, [org1.id, org2.id]);
            testOrgIds.length = 0;
          }
        ),
        { numRuns: 10 }
      );
    } finally {
      if (testOrgIds.length > 0) {
        await cleanupTestData(adminClient, testOrgIds);
      }
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});

Deno.test({
  name: "Property 2: Org_id Isolation - computation_snapshots table",
  fn: async () => {
    const adminClient = createAdminClient();
    const testOrgIds: string[] = [];
    
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.constant(true), // Just a placeholder to run the test
          async () => {
            // Setup
            const org1 = await createTestOrg(adminClient, `Test Org 1 ${Date.now()}`);
            const org2 = await createTestOrg(adminClient, `Test Org 2 ${Date.now()}`);
            testOrgIds.push(org1.id, org2.id);
            
            const user1 = await createTestUser(adminClient, `user1-${Date.now()}@test.com`, org1.id);
            
            const property1 = await createTestProperty(adminClient, org1.id, 'Property 1');
            const property2 = await createTestProperty(adminClient, org2.id, 'Property 2');
            
            const snapshot1 = await createTestComputationSnapshot(adminClient, org1.id, property1.id);
            const snapshot2 = await createTestComputationSnapshot(adminClient, org2.id, property2.id);
            
            // Test: User 1 can access their own computation snapshot
            const client1 = createUserClient(user1.accessToken);
            const { data: ownSnapshot, error: ownError } = await client1
              .from('computation_snapshots')
              .select('*')
              .eq('id', snapshot1.id)
              .single();
            
            assertEquals(ownError, null, 'User should be able to access their own org computation');
            assertExists(ownSnapshot, 'User should retrieve their own org computation');
            
            // Test: User 1 cannot access User 2's computation snapshot
            const { data: otherSnapshot } = await client1
              .from('computation_snapshots')
              .select('*')
              .eq('id', snapshot2.id)
              .single();
            
            assertEquals(otherSnapshot, null, 'User should not retrieve other org computation');
            
            // Cleanup
            await cleanupTestData(adminClient, [org1.id, org2.id]);
            testOrgIds.length = 0;
          }
        ),
        { numRuns: 10 }
      );
    } finally {
      if (testOrgIds.length > 0) {
        await cleanupTestData(adminClient, testOrgIds);
      }
    }
  },
  sanitizeResources: false,
  sanitizeOps: false
});
