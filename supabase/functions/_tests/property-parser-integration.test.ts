// @ts-nocheck
/**
 * Integration Tests: Property Parser with Parse File Function
 * Feature: backend-driven-pipeline, Task 3.4
 * 
 * **Validates: Requirements 2.2, 2.5, 2.6**
 * 
 * Tests the integration of property parser with parse-file Edge Function:
 * - Maps property column variations to standardized field names
 * - Handles portfolio/building/unit hierarchy fields
 * - Converts numeric fields appropriately
 * - Preserves row numbers for error reporting
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

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
      module_type: 'properties',
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

const testFileIds: string[] = [];

Deno.test({
  name: "Property Parser Integration: Maps property column variations",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // CSV with 'property name' instead of 'name'
      const csvContent = 'property name,street address,city,state,zip code,sqft,asset type\nSunset Plaza,123 Main St,Los Angeles,CA,90001,50000,Office\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      assertEquals(response.status, 200);
      assertEquals(result.parsed_data[0].name, 'Sunset Plaza', 'Should map property name to name');
      assertEquals(result.parsed_data[0].address, '123 Main St', 'Should map street address to address');
      assertEquals(result.parsed_data[0].zip_code, '90001', 'Should map zip code to zip_code');
      assertEquals(result.parsed_data[0].square_footage, 50000, 'Should convert sqft to number');
      assertEquals(result.parsed_data[0].property_type, 'Office', 'Should map asset type to property_type');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});

Deno.test({
  name: "Property Parser Integration: Handles portfolio/building/unit hierarchy",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // CSV with hierarchy fields
      const csvContent = 'name,portfolio name,building name,unit number\nBuilding A,West Coast Portfolio,Building A,Suite 100\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      assertEquals(response.status, 200);
      assertEquals(result.parsed_data[0].portfolio_name, 'West Coast Portfolio');
      assertEquals(result.parsed_data[0].building_name, 'Building A');
      assertEquals(result.parsed_data[0].unit_number, 'Suite 100');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});

Deno.test({
  name: "Property Parser Integration: Converts numeric fields with commas",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // CSV with numeric fields containing commas
      const csvContent = 'name,square_footage,year_built,number_of_units\nLarge Complex,"125,000",1985,24\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      assertEquals(response.status, 200);
      assertEquals(result.parsed_data[0].square_footage, 125000, 'Should convert square footage to number');
      assertEquals(result.parsed_data[0].year_built, 1985, 'Should convert year_built to number');
      assertEquals(result.parsed_data[0].number_of_units, 24, 'Should convert number_of_units to number');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});

Deno.test({
  name: "Property Parser Integration: Handles missing values as null",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      // CSV with missing values
      const csvContent = 'name,address,city,square_footage\nSimple Property,123 Main St,,\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      assertEquals(response.status, 200);
      assertEquals(result.parsed_data[0].name, 'Simple Property');
      assertEquals(result.parsed_data[0].address, '123 Main St');
      assertEquals(result.parsed_data[0].city, null, 'Missing city should be null');
      assertEquals(result.parsed_data[0].square_footage, null, 'Missing square_footage should be null');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});

Deno.test({
  name: "Property Parser Integration: Preserves row numbers",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminClient = createAdminClient();
    const org = await createTestOrg(adminClient, `Test Org ${Date.now()}`);
    
    try {
      const user = await createTestUser(adminClient, `user-${Date.now()}@test.com`, org.id);
      
      const csvContent = 'name,square_footage\nProperty 1,10000\nProperty 2,20000\nProperty 3,30000\n';
      const fileRecord = await uploadTestFile(adminClient, org.id, csvContent);
      testFileIds.push(fileRecord.id);
      
      const response = await fetch(PARSE_FILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: fileRecord.id })
      });
      
      const result = await response.json();
      
      assertEquals(response.status, 200);
      assertEquals(result.parsed_data[0]._row_number, 2, 'First data row should be row 2');
      assertEquals(result.parsed_data[1]._row_number, 3, 'Second data row should be row 3');
      assertEquals(result.parsed_data[2]._row_number, 4, 'Third data row should be row 4');
      
      await cleanup(adminClient, org.id, user.userId, testFileIds);
    } catch (error) {
      await cleanup(adminClient, org.id, '', testFileIds);
      throw error;
    }
  }
});
