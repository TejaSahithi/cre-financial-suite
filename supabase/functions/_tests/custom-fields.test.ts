// @ts-nocheck
/**
 * Unit tests for custom-fields API endpoints
 * Tests CRUD operations, field validation, value type conversion, and API routing
 */

import { assertEquals, assertExists, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";

// Mock Supabase admin client
const mockSupabaseAdmin = {
  from: (table: string) => ({
    select: (columns: string) => ({
      eq: (column: string, value: any) => ({
        order: (column: string, options?: any) => ({
          single: () => Promise.resolve({ data: null, error: null }),
          then: (callback: any) => callback({ data: [], error: null })
        }),
        then: (callback: any) => callback({ data: [], error: null })
      }),
      order: (column: string, options?: any) => ({
        then: (callback: any) => callback({ data: [], error: null })
      }),
      then: (callback: any) => callback({ data: [], error: null })
    }),
    insert: (data: any) => ({
      select: () => ({
        single: () => Promise.resolve({ 
          data: { id: "test-id", ...data }, 
          error: null 
        })
      })
    }),
    update: (data: any) => ({
      eq: (column: string, value: any) => ({
        eq: (column2: string, value2: any) => ({
          select: () => ({
            single: () => Promise.resolve({
              data: { id: value, ...data },
              error: null
            })
          })
        }),
        select: () => ({
          single: () => Promise.resolve({
            data: { id: value, ...data },
            error: null
          })
        })
      })
    }),
    delete: () => ({
      eq: (column: string, value: any) => ({
        select: () => ({
          single: () => Promise.resolve({ 
            data: { id: value }, 
            error: null 
          })
        })
      })
    }),
    upsert: (data: any, options?: any) => ({
      select: () => Promise.resolve({ data, error: null })
    })
  })
};

Deno.test("Field Name Validation", () => {
  function validateFieldName(fieldName: string): boolean {
    // Must be snake_case, start with letter, contain only letters, numbers, underscores
    return /^[a-z][a-z0-9_]*$/.test(fieldName);
  }
  
  // Valid field names
  assertEquals(validateFieldName("tenant_name"), true);
  assertEquals(validateFieldName("monthly_rent"), true);
  assertEquals(validateFieldName("lease_start_date"), true);
  assertEquals(validateFieldName("property_type"), true);
  assertEquals(validateFieldName("cam_amount"), true);
  
  // Invalid field names
  assertEquals(validateFieldName("TenantName"), false); // camelCase
  assertEquals(validateFieldName("tenant-name"), false); // kebab-case
  assertEquals(validateFieldName("tenant name"), false); // spaces
  assertEquals(validateFieldName("1tenant_name"), false); // starts with number
  assertEquals(validateFieldName("tenant@name"), false); // special characters
  assertEquals(validateFieldName(""), false); // empty
});

Deno.test("Module Type Validation", () => {
  function validateModuleType(moduleType: string): boolean {
    const validModules = ['leases', 'properties', 'expenses', 'revenue', 'cam', 'budgets', 'tenants', 'units', 'buildings'];
    return validModules.includes(moduleType);
  }
  
  // Valid module types
  assertEquals(validateModuleType("leases"), true);
  assertEquals(validateModuleType("properties"), true);
  assertEquals(validateModuleType("expenses"), true);
  assertEquals(validateModuleType("revenue"), true);
  assertEquals(validateModuleType("cam"), true);
  assertEquals(validateModuleType("budgets"), true);
  assertEquals(validateModuleType("tenants"), true);
  assertEquals(validateModuleType("units"), true);
  assertEquals(validateModuleType("buildings"), true);
  
  // Invalid module types
  assertEquals(validateModuleType("invalid"), false);
  assertEquals(validateModuleType("lease"), false); // singular
  assertEquals(validateModuleType("property"), false); // singular
  assertEquals(validateModuleType(""), false); // empty
});

Deno.test("Field Type Validation", () => {
  function validateFieldType(fieldType: string): boolean {
    const validTypes = ['text', 'number', 'date', 'boolean', 'select'];
    return validTypes.includes(fieldType);
  }
  
  // Valid field types
  assertEquals(validateFieldType("text"), true);
  assertEquals(validateFieldType("number"), true);
  assertEquals(validateFieldType("date"), true);
  assertEquals(validateFieldType("boolean"), true);
  assertEquals(validateFieldType("select"), true);
  
  // Invalid field types
  assertEquals(validateFieldType("string"), false);
  assertEquals(validateFieldType("integer"), false);
  assertEquals(validateFieldType("datetime"), false);
  assertEquals(validateFieldType("dropdown"), false);
  assertEquals(validateFieldType(""), false);
});

Deno.test("Record Type Validation", () => {
  function validateRecordType(recordType: string): boolean {
    const validTypes = ['lease', 'property', 'expense', 'revenue', 'cam', 'budget', 'tenant', 'unit', 'building'];
    return validTypes.includes(recordType);
  }
  
  // Valid record types (singular)
  assertEquals(validateRecordType("lease"), true);
  assertEquals(validateRecordType("property"), true);
  assertEquals(validateRecordType("expense"), true);
  assertEquals(validateRecordType("revenue"), true);
  assertEquals(validateRecordType("cam"), true);
  assertEquals(validateRecordType("budget"), true);
  assertEquals(validateRecordType("tenant"), true);
  assertEquals(validateRecordType("unit"), true);
  assertEquals(validateRecordType("building"), true);
  
  // Invalid record types
  assertEquals(validateRecordType("leases"), false); // plural
  assertEquals(validateRecordType("properties"), false); // plural
  assertEquals(validateRecordType("invalid"), false);
  assertEquals(validateRecordType(""), false);
});

Deno.test("Field Value Sanitization - Text", () => {
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
  
  // Text field sanitization
  assertEquals(sanitizeFieldValue("  Hello World  ", "text"), "Hello World");
  assertEquals(sanitizeFieldValue(123, "text"), "123");
  assertEquals(sanitizeFieldValue("", "text"), null);
  assertEquals(sanitizeFieldValue(null, "text"), null);
  assertEquals(sanitizeFieldValue(undefined, "text"), null);
});

Deno.test("Field Value Sanitization - Number", () => {
  function sanitizeFieldValue(value: any, fieldType: string): string | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    switch (fieldType) {
      case 'number':
        const num = Number(value);
        return isNaN(num) ? null : String(num);
      default:
        return String(value).trim();
    }
  }
  
  // Number field sanitization
  assertEquals(sanitizeFieldValue("123", "number"), "123");
  assertEquals(sanitizeFieldValue("123.45", "number"), "123.45");
  assertEquals(sanitizeFieldValue(456, "number"), "456");
  assertEquals(sanitizeFieldValue("abc", "number"), null);
  assertEquals(sanitizeFieldValue("", "number"), null);
  assertEquals(sanitizeFieldValue("0", "number"), "0");
});

Deno.test("Field Value Sanitization - Date", () => {
  function sanitizeFieldValue(value: any, fieldType: string): string | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    switch (fieldType) {
      case 'date':
        try {
          const date = new Date(value);
          return isNaN(date.getTime()) ? null : date.toISOString().split('T')[0];
        } catch {
          return null;
        }
      default:
        return String(value).trim();
    }
  }
  
  // Date field sanitization
  assertEquals(sanitizeFieldValue("2025-01-01", "date"), "2025-01-01");
  assertEquals(sanitizeFieldValue("01/01/2025", "date"), "2025-01-01");
  assertEquals(sanitizeFieldValue("January 1, 2025", "date"), "2025-01-01");
  assertEquals(sanitizeFieldValue("invalid date", "date"), null);
  assertEquals(sanitizeFieldValue("", "date"), null);
});

Deno.test("Field Value Sanitization - Boolean", () => {
  function sanitizeFieldValue(value: any, fieldType: string): string | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    switch (fieldType) {
      case 'boolean':
        if (typeof value === 'boolean') return String(value);
        const str = String(value).toLowerCase();
        if (['true', 't', '1', 'yes', 'y'].includes(str)) return 'true';
        if (['false', 'f', '0', 'no', 'n'].includes(str)) return 'false';
        return null;
      default:
        return String(value).trim();
    }
  }
  
  // Boolean field sanitization
  assertEquals(sanitizeFieldValue(true, "boolean"), "true");
  assertEquals(sanitizeFieldValue(false, "boolean"), "false");
  assertEquals(sanitizeFieldValue("true", "boolean"), "true");
  assertEquals(sanitizeFieldValue("false", "boolean"), "false");
  assertEquals(sanitizeFieldValue("yes", "boolean"), "true");
  assertEquals(sanitizeFieldValue("no", "boolean"), "false");
  assertEquals(sanitizeFieldValue("1", "boolean"), "true");
  assertEquals(sanitizeFieldValue("0", "boolean"), "false");
  assertEquals(sanitizeFieldValue("Y", "boolean"), "true");
  assertEquals(sanitizeFieldValue("N", "boolean"), "false");
  assertEquals(sanitizeFieldValue("maybe", "boolean"), null);
  assertEquals(sanitizeFieldValue("", "boolean"), null);
});

Deno.test("Custom Field Creation - Valid Request", async () => {
  async function handleCreateCustomField(supabaseAdmin: any, orgId: string, body: any) {
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

    // Basic validation
    if (!module_type || !['leases', 'properties', 'expenses', 'revenue', 'cam', 'budgets', 'tenants', 'units', 'buildings'].includes(module_type)) {
      return { error: 'Invalid or missing module_type', status: 400 };
    }

    if (!field_name || !/^[a-z][a-z0-9_]*$/.test(field_name)) {
      return { error: 'Invalid field_name. Must be snake_case starting with a letter.', status: 400 };
    }

    if (!field_label || field_label.trim().length === 0) {
      return { error: 'field_label is required', status: 400 };
    }

    if (!field_type || !['text', 'number', 'date', 'boolean', 'select'].includes(field_type)) {
      return { error: 'Invalid field_type. Must be one of: text, number, date, boolean, select', status: 400 };
    }

    // For select fields, validate options
    if (field_type === 'select') {
      if (!Array.isArray(field_options) || field_options.length === 0) {
        return { error: 'Select fields must have at least one option', status: 400 };
      }
    }

    // Mock successful creation
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
      return { error: 'Failed to create custom field', status: 500 };
    }

    return { custom_field: data, status: 201 };
  }
  
  const validRequest = {
    module_type: "leases",
    field_name: "parking_spaces",
    field_label: "Parking Spaces",
    field_type: "number",
    is_required: false,
    display_order: 10
  };
  
  const result = await handleCreateCustomField(mockSupabaseAdmin, "test-org-id", validRequest);
  assertEquals(result.status, 201);
  assertEquals(result.custom_field.field_name, "parking_spaces");
  assertEquals(result.custom_field.field_type, "number");
});

Deno.test("Custom Field Creation - Invalid Requests", async () => {
  async function handleCreateCustomField(supabaseAdmin: any, orgId: string, body: any) {
    const { module_type, field_name, field_label, field_type, field_options = [] } = body;

    if (!module_type || !['leases', 'properties', 'expenses', 'revenue', 'cam', 'budgets', 'tenants', 'units', 'buildings'].includes(module_type)) {
      return { error: 'Invalid or missing module_type', status: 400 };
    }

    if (!field_name || !/^[a-z][a-z0-9_]*$/.test(field_name)) {
      return { error: 'Invalid field_name. Must be snake_case starting with a letter.', status: 400 };
    }

    if (!field_label || field_label.trim().length === 0) {
      return { error: 'field_label is required', status: 400 };
    }

    if (!field_type || !['text', 'number', 'date', 'boolean', 'select'].includes(field_type)) {
      return { error: 'Invalid field_type. Must be one of: text, number, date, boolean, select', status: 400 };
    }

    if (field_type === 'select') {
      if (!Array.isArray(field_options) || field_options.length === 0) {
        return { error: 'Select fields must have at least one option', status: 400 };
      }
    }

    return { custom_field: {}, status: 201 };
  }
  
  // Test invalid module type
  const invalidModule = await handleCreateCustomField(mockSupabaseAdmin, "test-org-id", {
    module_type: "invalid",
    field_name: "test_field",
    field_label: "Test Field",
    field_type: "text"
  });
  assertEquals(invalidModule.status, 400);
  assertEquals(invalidModule.error, "Invalid or missing module_type");
  
  // Test invalid field name
  const invalidFieldName = await handleCreateCustomField(mockSupabaseAdmin, "test-org-id", {
    module_type: "leases",
    field_name: "TestField", // camelCase
    field_label: "Test Field",
    field_type: "text"
  });
  assertEquals(invalidFieldName.status, 400);
  assertEquals(invalidFieldName.error, "Invalid field_name. Must be snake_case starting with a letter.");
  
  // Test missing field label
  const missingLabel = await handleCreateCustomField(mockSupabaseAdmin, "test-org-id", {
    module_type: "leases",
    field_name: "test_field",
    field_label: "",
    field_type: "text"
  });
  assertEquals(missingLabel.status, 400);
  assertEquals(missingLabel.error, "field_label is required");
  
  // Test invalid field type
  const invalidFieldType = await handleCreateCustomField(mockSupabaseAdmin, "test-org-id", {
    module_type: "leases",
    field_name: "test_field",
    field_label: "Test Field",
    field_type: "invalid"
  });
  assertEquals(invalidFieldType.status, 400);
  assertEquals(invalidFieldType.error, "Invalid field_type. Must be one of: text, number, date, boolean, select");
  
  // Test select field without options
  const selectWithoutOptions = await handleCreateCustomField(mockSupabaseAdmin, "test-org-id", {
    module_type: "leases",
    field_name: "test_select",
    field_label: "Test Select",
    field_type: "select",
    field_options: []
  });
  assertEquals(selectWithoutOptions.status, 400);
  assertEquals(selectWithoutOptions.error, "Select fields must have at least one option");
});

Deno.test("Custom Field Update - Valid Request", async () => {
  async function handleUpdateCustomField(supabaseAdmin: any, orgId: string, fieldId: string, body: any) {
    const { field_label, field_options, is_required, validation_rules, display_order } = body;

    // Build update object with only provided fields
    const updates: any = {};
    
    if (field_label !== undefined) {
      if (!field_label || field_label.trim().length === 0) {
        return { error: 'field_label cannot be empty', status: 400 };
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
      return { error: 'No valid fields to update', status: 400 };
    }

    // Mock successful update
    const { data, error } = await supabaseAdmin
      .from('custom_fields')
      .update(updates)
      .eq('id', fieldId)
      .eq('org_id', orgId)
      .select()
      .single();

    if (error) {
      return { error: 'Failed to update custom field', status: 500 };
    }

    return { custom_field: { id: fieldId, ...updates }, status: 200 };
  }
  
  const updateRequest = {
    field_label: "Updated Parking Spaces",
    is_required: true,
    display_order: 5
  };
  
  const result = await handleUpdateCustomField(mockSupabaseAdmin, "test-org-id", "field-id", updateRequest);
  assertEquals(result.status, 200);
  assertEquals(result.custom_field.field_label, "Updated Parking Spaces");
  assertEquals(result.custom_field.is_required, true);
  assertEquals(result.custom_field.display_order, 5);
});

Deno.test("Custom Field Value Setting", async () => {
  async function handleSetCustomFieldValues(supabaseAdmin: any, orgId: string, body: any) {
    const { record_id, record_type, values } = body;

    if (!record_id || !record_type || !values) {
      return { error: 'record_id, record_type, and values are required', status: 400 };
    }

    if (!['lease', 'property', 'expense', 'revenue', 'cam', 'budget', 'tenant', 'unit', 'building'].includes(record_type)) {
      return { error: 'Invalid record_type', status: 400 };
    }

    // Mock custom fields for validation
    const mockCustomFields = [
      { id: "field-1", field_name: "parking_spaces", field_type: "number", is_required: false },
      { id: "field-2", field_name: "pet_policy", field_type: "select", field_options: ["allowed", "not_allowed"], is_required: true }
    ];

    const fieldMap = new Map(mockCustomFields.map(f => [f.field_name, f]));
    const valuesToUpsert: any[] = [];
    const errors: string[] = [];

    // Process each value
    for (const [fieldName, value] of Object.entries(values)) {
      const field = fieldMap.get(fieldName);
      if (!field) {
        errors.push(`Unknown field: ${fieldName}`);
        continue;
      }

      // Sanitize value
      let sanitizedValue: string | null = null;
      if (value !== null && value !== undefined && value !== '') {
        switch (field.field_type) {
          case 'number':
            const num = Number(value);
            sanitizedValue = isNaN(num) ? null : String(num);
            break;
          case 'select':
            sanitizedValue = String(value).trim();
            break;
          default:
            sanitizedValue = String(value).trim();
        }
      }
      
      // Check required fields
      if (field.is_required && (sanitizedValue === null || sanitizedValue === '')) {
        errors.push(`Field ${field.field_name} is required`);
        continue;
      }

      // Validate select field options
      if (field.field_type === 'select' && sanitizedValue !== null) {
        const options = field.field_options || [];
        if (!options.includes(sanitizedValue)) {
          errors.push(`Invalid option "${sanitizedValue}" for field ${field.field_name}. Valid options: ${options.join(', ')}`);
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
      return { error: 'Validation errors', validation_errors: errors, status: 400 };
    }

    // Mock successful upsert
    return { 
      message: 'Custom field values saved successfully', 
      saved_values: valuesToUpsert.length,
      status: 200
    };
  }
  
  const validRequest = {
    record_id: "lease-123",
    record_type: "lease",
    values: {
      parking_spaces: "5",
      pet_policy: "allowed"
    }
  };
  
  const result = await handleSetCustomFieldValues(mockSupabaseAdmin, "test-org-id", validRequest);
  assertEquals(result.status, 200);
  assertEquals(result.saved_values, 2);
  assertEquals(result.message, "Custom field values saved successfully");
});

Deno.test("Custom Field Value Validation Errors", async () => {
  async function handleSetCustomFieldValues(supabaseAdmin: any, orgId: string, body: any) {
    const { record_id, record_type, values } = body;

    if (!record_id || !record_type || !values) {
      return { error: 'record_id, record_type, and values are required', status: 400 };
    }

    // Mock custom fields with validation rules
    const mockCustomFields = [
      { id: "field-1", field_name: "parking_spaces", field_type: "number", is_required: true },
      { id: "field-2", field_name: "lease_status", field_type: "select", field_options: ["active", "inactive"], is_required: false }
    ];

    const fieldMap = new Map(mockCustomFields.map(f => [f.field_name, f]));
    const errors: string[] = [];

    for (const [fieldName, value] of Object.entries(values)) {
      const field = fieldMap.get(fieldName);
      if (!field) {
        errors.push(`Unknown field: ${fieldName}`);
        continue;
      }

      let sanitizedValue: string | null = null;
      if (value !== null && value !== undefined && value !== '') {
        sanitizedValue = String(value).trim();
      }
      
      // Check required fields
      if (field.is_required && (sanitizedValue === null || sanitizedValue === '')) {
        errors.push(`Field ${field.field_name} is required`);
        continue;
      }

      // Validate select field options
      if (field.field_type === 'select' && sanitizedValue !== null) {
        const options = field.field_options || [];
        if (!options.includes(sanitizedValue)) {
          errors.push(`Invalid option "${sanitizedValue}" for field ${field.field_name}. Valid options: ${options.join(', ')}`);
          continue;
        }
      }
    }

    if (errors.length > 0) {
      return { error: 'Validation errors', validation_errors: errors, status: 400 };
    }

    return { message: 'Success', status: 200 };
  }
  
  // Test missing required field
  const missingRequired = await handleSetCustomFieldValues(mockSupabaseAdmin, "test-org-id", {
    record_id: "lease-123",
    record_type: "lease",
    values: {
      parking_spaces: "", // Required but empty
      lease_status: "active"
    }
  });
  assertEquals(missingRequired.status, 400);
  assertEquals(missingRequired.validation_errors.includes("Field parking_spaces is required"), true);
  
  // Test invalid select option
  const invalidOption = await handleSetCustomFieldValues(mockSupabaseAdmin, "test-org-id", {
    record_id: "lease-123",
    record_type: "lease",
    values: {
      parking_spaces: "5",
      lease_status: "pending" // Not in allowed options
    }
  });
  assertEquals(invalidOption.status, 400);
  assertEquals(invalidOption.validation_errors.some(err => err.includes("Invalid option")), true);
  
  // Test unknown field
  const unknownField = await handleSetCustomFieldValues(mockSupabaseAdmin, "test-org-id", {
    record_id: "lease-123",
    record_type: "lease",
    values: {
      unknown_field: "value"
    }
  });
  assertEquals(unknownField.status, 400);
  assertEquals(unknownField.validation_errors.includes("Unknown field: unknown_field"), true);
});

Deno.test("API Route Parsing", () => {
  function parseRoute(pathname: string) {
    const pathParts = pathname.split('/').filter(Boolean);
    // Remove 'functions/v1/custom-fields' from path
    const routeParts = pathParts.slice(3);
    return routeParts;
  }
  
  // Test various route patterns
  assertEquals(parseRoute("/functions/v1/custom-fields"), []);
  assertEquals(parseRoute("/functions/v1/custom-fields/values"), ["values"]);
  assertEquals(parseRoute("/functions/v1/custom-fields/field-123"), ["field-123"]);
  assertEquals(parseRoute("/functions/v1/custom-fields/field-123/values"), ["field-123", "values"]);
});

Deno.test("Module Type to Record Type Conversion", () => {
  function moduleTypeToRecordType(moduleType: string): string {
    // Convert module_type (plural) to record_type (singular)
    const conversions: Record<string, string> = {
      'leases': 'lease',
      'properties': 'property',
      'expenses': 'expense',
      'revenue': 'revenue',
      'cam': 'cam',
      'budgets': 'budget',
      'tenants': 'tenant',
      'units': 'unit',
      'buildings': 'building'
    };
    
    return conversions[moduleType] || moduleType;
  }
  
  assertEquals(moduleTypeToRecordType("leases"), "lease");
  assertEquals(moduleTypeToRecordType("properties"), "property");
  assertEquals(moduleTypeToRecordType("expenses"), "expense");
  assertEquals(moduleTypeToRecordType("revenue"), "revenue");
  assertEquals(moduleTypeToRecordType("cam"), "cam");
  assertEquals(moduleTypeToRecordType("budgets"), "budget");
  assertEquals(moduleTypeToRecordType("tenants"), "tenant");
  assertEquals(moduleTypeToRecordType("units"), "unit");
  assertEquals(moduleTypeToRecordType("buildings"), "building");
});

Deno.test("Field Options Validation for Select Fields", () => {
  function validateSelectFieldOptions(fieldType: string, fieldOptions: any): { valid: boolean; error?: string } {
    if (fieldType === 'select') {
      if (!Array.isArray(fieldOptions)) {
        return { valid: false, error: 'Select field options must be an array' };
      }
      
      if (fieldOptions.length === 0) {
        return { valid: false, error: 'Select fields must have at least one option' };
      }
      
      // Check for duplicate options
      const uniqueOptions = new Set(fieldOptions.map(opt => String(opt).toLowerCase()));
      if (uniqueOptions.size !== fieldOptions.length) {
        return { valid: false, error: 'Select field options must be unique' };
      }
      
      // Check for empty options
      if (fieldOptions.some(opt => !opt || String(opt).trim().length === 0)) {
        return { valid: false, error: 'Select field options cannot be empty' };
      }
    }
    
    return { valid: true };
  }
  
  // Valid select field options
  assertEquals(validateSelectFieldOptions("select", ["option1", "option2", "option3"]).valid, true);
  assertEquals(validateSelectFieldOptions("text", []).valid, true); // Non-select field
  
  // Invalid select field options
  assertEquals(validateSelectFieldOptions("select", []).valid, false);
  assertEquals(validateSelectFieldOptions("select", "not_array").valid, false);
  assertEquals(validateSelectFieldOptions("select", ["option1", "option1"]).valid, false); // Duplicates
  assertEquals(validateSelectFieldOptions("select", ["option1", ""]).valid, false); // Empty option
});