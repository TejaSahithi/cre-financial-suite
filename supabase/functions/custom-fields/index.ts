// @ts-nocheck
/**
 * custom-fields — Custom Field Management API
 *
 * Provides CRUD operations for custom fields and their values.
 * Supports dynamic field creation when extracted data doesn't match existing UI fields.
 *
 * Endpoints:
 *   GET    /custom-fields?module_type=leases&org_id=xxx  - List custom fields
 *   POST   /custom-fields                                - Create custom field
 *   PUT    /custom-fields/:id                           - Update custom field
 *   DELETE /custom-fields/:id                           - Delete custom field
 *   
 *   GET    /custom-fields/values?record_id=xxx&record_type=lease - Get field values
 *   POST   /custom-fields/values                                 - Set field values
 */

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CustomField {
  id?: string;
  org_id: string;
  module_type: string;
  field_name: string;
  field_label: string;
  field_type: 'text' | 'number' | 'date' | 'boolean' | 'select';
  field_options?: string[];
  is_required?: boolean;
  validation_rules?: Record<string, any>;
  display_order?: number;
}

interface CustomFieldValue {
  custom_field_id: string;
  record_id: string;
  record_type: string;
  field_value: string | null;
}

interface SetCustomFieldValuesRequest {
  record_id: string;
  record_type: string;
  values: Record<string, any>; // field_name -> value mapping
}

// ── Validation helpers ───────────────────────────────────────────────────────

function validateFieldName(fieldName: string): boolean {
  // Must be snake_case, start with letter, contain only letters, numbers, underscores
  return /^[a-z][a-z0-9_]*$/.test(fieldName);
}

function validateModuleType(moduleType: string): boolean {
  const validModules = ['leases', 'properties', 'expenses', 'revenue', 'cam', 'budgets', 'tenants', 'units', 'buildings'];
  return validModules.includes(moduleType);
}

function validateFieldType(fieldType: string): boolean {
  const validTypes = ['text', 'number', 'date', 'boolean', 'select'];
  return validTypes.includes(fieldType);
}

function validateRecordType(recordType: string): boolean {
  const validTypes = ['lease', 'property', 'expense', 'revenue', 'cam', 'budget', 'tenant', 'unit', 'building'];
  return validTypes.includes(recordType);
}

function sanitizeFieldValue(value: any, fieldType: string): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  switch (fieldType) {
    case 'text':
      return String(value).trim();
    case 'number':
      const num = Number(value);
      return isNaN(num) ? null : String(num);
    case 'date':
      try {
        const date = new Date(value);
        return isNaN(date.getTime()) ? null : date.toISOString().split('T')[0];
      } catch {
        return null;
      }
    case 'boolean':
      if (typeof value === 'boolean') return String(value);
      const str = String(value).toLowerCase();
      if (['true', 't', '1', 'yes', 'y'].includes(str)) return 'true';
      if (['false', 'f', '0', 'no', 'n'].includes(str)) return 'false';
      return null;
    case 'select':
      return String(value).trim();
    default:
      return String(value).trim();
  }
}

// ── Route handlers ───────────────────────────────────────────────────────────

async function handleListCustomFields(
  supabaseAdmin: any,
  orgId: string,
  url: URL
): Promise<Response> {
  const moduleType = url.searchParams.get('module_type');
  
  if (moduleType && !validateModuleType(moduleType)) {
    return new Response(
      JSON.stringify({ error: 'Invalid module_type', valid_modules: ['leases', 'properties', 'expenses', 'revenue', 'cam', 'budgets', 'tenants', 'units', 'buildings'] }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  let query = supabaseAdmin
    .from('custom_fields')
    .select('*')
    .eq('org_id', orgId)
    .order('display_order', { ascending: true })
    .order('field_label', { ascending: true });

  if (moduleType) {
    query = query.eq('module_type', moduleType);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[custom-fields] List error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch custom fields', details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ custom_fields: data || [] }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleCreateCustomField(
  supabaseAdmin: any,
  orgId: string,
  body: any
): Promise<Response> {
  const {
    module_type,
    field_name,
    field_label,
    field_type,
    field_options = [],
    is_required = false,
    validation_rules = {},
    display_order = 0
  } = body;

  // Validation
  if (!module_type || !validateModuleType(module_type)) {
    return new Response(
      JSON.stringify({ error: 'Invalid or missing module_type' }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!field_name || !validateFieldName(field_name)) {
    return new Response(
      JSON.stringify({ error: 'Invalid field_name. Must be snake_case starting with a letter.' }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!field_label || field_label.trim().length === 0) {
    return new Response(
      JSON.stringify({ error: 'field_label is required' }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!field_type || !validateFieldType(field_type)) {
    return new Response(
      JSON.stringify({ error: 'Invalid field_type. Must be one of: text, number, date, boolean, select' }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // For select fields, validate options
  if (field_type === 'select') {
    if (!Array.isArray(field_options) || field_options.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Select fields must have at least one option' }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  // Check for duplicate field names
  const { data: existing } = await supabaseAdmin
    .from('custom_fields')
    .select('id')
    .eq('org_id', orgId)
    .eq('module_type', module_type)
    .eq('field_name', field_name)
    .single();

  if (existing) {
    return new Response(
      JSON.stringify({ error: 'A field with this name already exists for this module' }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Create the field
  const { data, error } = await supabaseAdmin
    .from('custom_fields')
    .insert({
      org_id: orgId,
      module_type,
      field_name,
      field_label: field_label.trim(),
      field_type,
      field_options: field_type === 'select' ? field_options : [],
      is_required: Boolean(is_required),
      validation_rules,
      display_order: Number(display_order) || 0
    })
    .select()
    .single();

  if (error) {
    console.error('[custom-fields] Create error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to create custom field', details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ custom_field: data }),
    { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleUpdateCustomField(
  supabaseAdmin: any,
  orgId: string,
  fieldId: string,
  body: any
): Promise<Response> {
  const {
    field_label,
    field_options,
    is_required,
    validation_rules,
    display_order
  } = body;

  // Build update object with only provided fields
  const updates: any = {};
  
  if (field_label !== undefined) {
    if (!field_label || field_label.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: 'field_label cannot be empty' }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    updates.field_label = field_label.trim();
  }

  if (field_options !== undefined) {
    updates.field_options = Array.isArray(field_options) ? field_options : [];
  }

  if (is_required !== undefined) {
    updates.is_required = Boolean(is_required);
  }

  if (validation_rules !== undefined) {
    updates.validation_rules = validation_rules || {};
  }

  if (display_order !== undefined) {
    updates.display_order = Number(display_order) || 0;
  }

  if (Object.keys(updates).length === 0) {
    return new Response(
      JSON.stringify({ error: 'No valid fields to update' }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data, error } = await supabaseAdmin
    .from('custom_fields')
    .update(updates)
    .eq('id', fieldId)
    .eq('org_id', orgId)
    .select()
    .single();

  if (error) {
    console.error('[custom-fields] Update error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to update custom field', details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!data) {
    return new Response(
      JSON.stringify({ error: 'Custom field not found' }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ custom_field: data }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleDeleteCustomField(
  supabaseAdmin: any,
  orgId: string,
  fieldId: string
): Promise<Response> {
  // First delete all values for this field
  await supabaseAdmin
    .from('custom_field_values')
    .delete()
    .eq('custom_field_id', fieldId)
    .eq('org_id', orgId);

  // Then delete the field definition
  const { data, error } = await supabaseAdmin
    .from('custom_fields')
    .delete()
    .eq('id', fieldId)
    .eq('org_id', orgId)
    .select()
    .single();

  if (error) {
    console.error('[custom-fields] Delete error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to delete custom field', details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!data) {
    return new Response(
      JSON.stringify({ error: 'Custom field not found' }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ message: 'Custom field deleted successfully', deleted_field: data }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleGetCustomFieldValues(
  supabaseAdmin: any,
  orgId: string,
  url: URL
): Promise<Response> {
  const recordId = url.searchParams.get('record_id');
  const recordType = url.searchParams.get('record_type');

  if (!recordId) {
    return new Response(
      JSON.stringify({ error: 'record_id is required' }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!recordType || !validateRecordType(recordType)) {
    return new Response(
      JSON.stringify({ error: 'Invalid record_type' }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Get custom fields with their values for this record
  const { data, error } = await supabaseAdmin
    .from('custom_fields_with_values')
    .select('*')
    .eq('org_id', orgId)
    .eq('record_id', recordId)
    .eq('record_type', recordType)
    .order('display_order', { ascending: true })
    .order('field_label', { ascending: true });

  if (error) {
    console.error('[custom-fields] Get values error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch custom field values', details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ custom_field_values: data || [] }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleSetCustomFieldValues(
  supabaseAdmin: any,
  orgId: string,
  body: SetCustomFieldValuesRequest
): Promise<Response> {
  const { record_id, record_type, values } = body;

  if (!record_id || !record_type || !values) {
    return new Response(
      JSON.stringify({ error: 'record_id, record_type, and values are required' }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!validateRecordType(record_type)) {
    return new Response(
      JSON.stringify({ error: 'Invalid record_type' }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Get all custom fields for this module
  const moduleType = record_type + 's'; // Convert record_type to module_type
  const { data: customFields, error: fieldsError } = await supabaseAdmin
    .from('custom_fields')
    .select('*')
    .eq('org_id', orgId)
    .eq('module_type', moduleType);

  if (fieldsError) {
    console.error('[custom-fields] Get fields error:', fieldsError);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch custom fields', details: fieldsError.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const fieldMap = new Map(customFields.map(f => [f.field_name, f]));
  const valuesToUpsert: any[] = [];
  const errors: string[] = [];

  // Process each value
  for (const [fieldName, value] of Object.entries(values)) {
    const field = fieldMap.get(fieldName);
    if (!field) {
      errors.push(`Unknown field: ${fieldName}`);
      continue;
    }

    const sanitizedValue = sanitizeFieldValue(value, field.field_type);
    
    // Check required fields
    if (field.is_required && (sanitizedValue === null || sanitizedValue === '')) {
      errors.push(`Field ${field.field_label} is required`);
      continue;
    }

    // Validate select field options
    if (field.field_type === 'select' && sanitizedValue !== null) {
      const options = field.field_options || [];
      if (!options.includes(sanitizedValue)) {
        errors.push(`Invalid option "${sanitizedValue}" for field ${field.field_label}. Valid options: ${options.join(', ')}`);
        continue;
      }
    }

    valuesToUpsert.push({
      org_id: orgId,
      custom_field_id: field.id,
      record_id,
      record_type,
      field_value: sanitizedValue
    });
  }

  if (errors.length > 0) {
    return new Response(
      JSON.stringify({ error: 'Validation errors', validation_errors: errors }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Upsert values
  const { data, error } = await supabaseAdmin
    .from('custom_field_values')
    .upsert(valuesToUpsert, { 
      onConflict: 'custom_field_id,record_id',
      ignoreDuplicates: false 
    })
    .select();

  if (error) {
    console.error('[custom-fields] Upsert values error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to save custom field values', details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ 
      message: 'Custom field values saved successfully', 
      saved_values: data?.length || 0 
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Auth
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);

    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    // Remove 'functions/v1/custom-fields' from path
    const routeParts = pathParts.slice(3);

    // Route handling
    if (req.method === 'GET') {
      if (routeParts.length === 0) {
        // GET /custom-fields
        return await handleListCustomFields(supabaseAdmin, orgId, url);
      } else if (routeParts[0] === 'values') {
        // GET /custom-fields/values
        return await handleGetCustomFieldValues(supabaseAdmin, orgId, url);
      }
    } else if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      
      if (routeParts.length === 0) {
        // POST /custom-fields
        return await handleCreateCustomField(supabaseAdmin, orgId, body);
      } else if (routeParts[0] === 'values') {
        // POST /custom-fields/values
        return await handleSetCustomFieldValues(supabaseAdmin, orgId, body);
      }
    } else if (req.method === 'PUT') {
      if (routeParts.length === 1) {
        // PUT /custom-fields/:id
        const fieldId = routeParts[0];
        const body = await req.json().catch(() => ({}));
        return await handleUpdateCustomField(supabaseAdmin, orgId, fieldId, body);
      }
    } else if (req.method === 'DELETE') {
      if (routeParts.length === 1) {
        // DELETE /custom-fields/:id
        const fieldId = routeParts[0];
        return await handleDeleteCustomField(supabaseAdmin, orgId, fieldId);
      }
    }

    // Route not found
    return new Response(
      JSON.stringify({ error: 'Route not found' }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error('[custom-fields] Error:', err.message);
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        message: err.message,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});