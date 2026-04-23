// @ts-nocheck
/**
 * extract-with-custom-fields — Enhanced Document Extraction with Custom Field Support
 *
 * This function extends the document extraction pipeline to support custom field creation
 * when extracted data doesn't match existing UI fields. It integrates with the custom
 * fields system to suggest and optionally create new fields automatically.
 *
 * Request:
 *   POST { 
 *     file_id: string, 
 *     auto_create_fields?: boolean,
 *     module_type?: string,
 *     confidence_threshold?: number 
 *   }
 *
 * Response:
 *   {
 *     extracted_data: object[],
 *     mapped_fields: Record<string, string>,
 *     unmapped_fields: object[],
 *     custom_field_suggestions: object[],
 *     auto_created_fields?: object[]
 *   }
 */

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExtractWithCustomFieldsRequest {
  file_id: string;
  auto_create_fields?: boolean;
  module_type?: string;
  confidence_threshold?: number;
}

interface UnmappedField {
  field_name: string;
  sample_values: string[];
  suggested_type: 'text' | 'number' | 'date' | 'boolean' | 'select';
  confidence: number;
  occurrence_count: number;
}

interface CustomFieldSuggestion {
  field_name: string;
  field_label: string;
  field_type: string;
  field_options?: string[];
  confidence: number;
  sample_values: string[];
}

interface ExtractWithCustomFieldsResponse {
  extracted_data: Record<string, any>[];
  mapped_fields: Record<string, string>;
  unmapped_fields: UnmappedField[];
  custom_field_suggestions: CustomFieldSuggestion[];
  auto_created_fields?: Record<string, any>[];
  processing_summary: {
    total_records: number;
    mapped_field_count: number;
    unmapped_field_count: number;
    suggestions_count: number;
    auto_created_count: number;
  };
}

// ── Standard field mappings for different modules ────────────────────────────

const STANDARD_FIELD_MAPPINGS: Record<string, Record<string, string>> = {
  leases: {
    'tenant_name': 'tenant_name',
    'tenant': 'tenant_name',
    'lessee': 'tenant_name',
    'occupant': 'tenant_name',
    'property_name': 'property_name',
    'property': 'property_name',
    'building': 'property_name',
    'unit_number': 'unit_number',
    'unit': 'unit_number',
    'suite': 'unit_number',
    'space': 'unit_number',
    'start_date': 'start_date',
    'commencement_date': 'start_date',
    'lease_start': 'start_date',
    'end_date': 'end_date',
    'expiration_date': 'end_date',
    'lease_end': 'end_date',
    'monthly_rent': 'monthly_rent',
    'base_rent': 'monthly_rent',
    'rent': 'monthly_rent',
    'annual_rent': 'annual_rent',
    'yearly_rent': 'annual_rent',
    'square_footage': 'square_footage',
    'sqft': 'square_footage',
    'rsf': 'square_footage',
    'area': 'square_footage',
    'lease_type': 'lease_type',
    'security_deposit': 'security_deposit',
    'deposit': 'security_deposit',
    'escalation_rate': 'escalation_rate',
    'escalation': 'escalation_rate',
    'increase_rate': 'escalation_rate',
  },
  properties: {
    'name': 'name',
    'property_name': 'name',
    'building_name': 'name',
    'address': 'address',
    'street_address': 'address',
    'location': 'address',
    'city': 'city',
    'state': 'state',
    'zip': 'zip',
    'postal_code': 'zip',
    'property_type': 'property_type',
    'type': 'property_type',
    'total_sqft': 'total_sqft',
    'square_footage': 'total_sqft',
    'size': 'total_sqft',
    'year_built': 'year_built',
    'built': 'year_built',
    'construction_year': 'year_built',
  },
  expenses: {
    'date': 'date',
    'expense_date': 'date',
    'invoice_date': 'date',
    'category': 'category',
    'expense_category': 'category',
    'type': 'category',
    'amount': 'amount',
    'expense_amount': 'amount',
    'cost': 'amount',
    'vendor': 'vendor',
    'supplier': 'vendor',
    'payee': 'vendor',
    'description': 'description',
    'expense_description': 'description',
    'details': 'description',
  }
};

// ── Field analysis and suggestion logic ──────────────────────────────────────

function analyzeExtractedData(
  extractedData: Record<string, any>[],
  moduleType: string
): {
  mappedFields: Record<string, string>;
  unmappedFields: UnmappedField[];
} {
  const standardMappings = STANDARD_FIELD_MAPPINGS[moduleType] || {};
  const mappedFields: Record<string, string> = {};
  const unmappedFieldMap = new Map<string, { values: any[], count: number }>();

  // Analyze all extracted records
  for (const record of extractedData) {
    for (const [fieldName, value] of Object.entries(record)) {
      // Skip metadata fields
      if (fieldName.startsWith('_') || fieldName === 'confidence_score' || fieldName === 'extraction_notes') {
        continue;
      }

      const normalizedFieldName = fieldName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      
      // Check if this field maps to a standard field
      if (standardMappings[normalizedFieldName]) {
        mappedFields[fieldName] = standardMappings[normalizedFieldName];
      } else {
        // This is an unmapped field
        if (!unmappedFieldMap.has(fieldName)) {
          unmappedFieldMap.set(fieldName, { values: [], count: 0 });
        }
        const fieldData = unmappedFieldMap.get(fieldName)!;
        if (value !== null && value !== undefined && value !== '') {
          fieldData.values.push(value);
        }
        fieldData.count++;
      }
    }
  }

  // Convert unmapped fields to structured format
  const unmappedFields: UnmappedField[] = [];
  for (const [fieldName, data] of unmappedFieldMap.entries()) {
    const uniqueValues = [...new Set(data.values.map(v => String(v)))];
    const suggestedType = inferFieldType(uniqueValues);
    
    unmappedFields.push({
      field_name: fieldName,
      sample_values: uniqueValues.slice(0, 5), // First 5 unique values
      suggested_type: suggestedType,
      confidence: Math.min(95, 60 + (data.count * 5)), // Higher confidence with more occurrences
      occurrence_count: data.count
    });
  }

  return { mappedFields, unmappedFields };
}

function inferFieldType(values: string[]): 'text' | 'number' | 'date' | 'boolean' | 'select' {
  if (values.length === 0) return 'text';

  // Check for boolean values
  const booleanValues = values.filter(v => 
    /^(true|false|yes|no|y|n|1|0)$/i.test(v.trim())
  );
  if (booleanValues.length / values.length > 0.8) return 'boolean';

  // Check for numeric values
  const numericValues = values.filter(v => {
    const cleaned = v.replace(/[$,\s%]/g, '');
    return !isNaN(Number(cleaned)) && cleaned !== '';
  });
  if (numericValues.length / values.length > 0.8) return 'number';

  // Check for date values
  const dateValues = values.filter(v => {
    const datePatterns = [
      /\d{1,2}\/\d{1,2}\/\d{4}/,
      /\d{4}-\d{2}-\d{2}/,
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
      /\b\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}/i
    ];
    return datePatterns.some(pattern => pattern.test(v));
  });
  if (dateValues.length / values.length > 0.6) return 'date';

  // Check for select field (limited unique values with repetition)
  const uniqueValues = new Set(values.map(v => v.toLowerCase().trim()));
  if (uniqueValues.size <= 10 && values.length > uniqueValues.size * 1.5) return 'select';

  return 'text';
}

function generateCustomFieldSuggestions(
  unmappedFields: UnmappedField[],
  confidenceThreshold: number = 70
): CustomFieldSuggestion[] {
  return unmappedFields
    .filter(field => field.confidence >= confidenceThreshold)
    .map(field => {
      const suggestion: CustomFieldSuggestion = {
        field_name: field.field_name.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        field_label: field.field_name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        field_type: field.suggested_type,
        confidence: field.confidence,
        sample_values: field.sample_values
      };

      // For select fields, suggest options
      if (field.suggested_type === 'select') {
        const uniqueValues = [...new Set(field.sample_values.map(v => v.trim()))];
        suggestion.field_options = uniqueValues;
      }

      return suggestion;
    });
}

async function autoCreateCustomFields(
  supabaseAdmin: any,
  orgId: string,
  moduleType: string,
  suggestions: CustomFieldSuggestion[]
): Promise<Record<string, any>[]> {
  const createdFields: Record<string, any>[] = [];

  for (const suggestion of suggestions) {
    try {
      // Check if field already exists
      const { data: existing } = await supabaseAdmin
        .from('custom_fields')
        .select('id')
        .eq('org_id', orgId)
        .eq('module_type', moduleType)
        .eq('field_name', suggestion.field_name)
        .single();

      if (existing) {
        console.log(`[extract-with-custom-fields] Field ${suggestion.field_name} already exists, skipping`);
        continue;
      }

      // Create the custom field
      const { data, error } = await supabaseAdmin
        .from('custom_fields')
        .insert({
          org_id: orgId,
          module_type: moduleType,
          field_name: suggestion.field_name,
          field_label: suggestion.field_label,
          field_type: suggestion.field_type,
          field_options: suggestion.field_options || [],
          is_required: false,
          validation_rules: {},
          display_order: 1000 + createdFields.length // Put auto-created fields at the end
        })
        .select()
        .single();

      if (error) {
        console.error(`[extract-with-custom-fields] Failed to create field ${suggestion.field_name}:`, error);
        continue;
      }

      createdFields.push(data);
      console.log(`[extract-with-custom-fields] Auto-created custom field: ${suggestion.field_name}`);

    } catch (err) {
      console.error(`[extract-with-custom-fields] Error creating field ${suggestion.field_name}:`, err);
    }
  }

  return createdFields;
}

// ── Main extraction logic ────────────────────────────────────────────────────

async function performEnhancedExtraction(
  supabaseAdmin: any,
  orgId: string,
  fileId: string,
  moduleType: string,
  autoCreateFields: boolean,
  confidenceThreshold: number
): Promise<ExtractWithCustomFieldsResponse> {
  // First, get the file record and its extracted data
  const { data: fileRecord, error: fileError } = await supabaseAdmin
    .from('uploaded_files')
    .select('*')
    .eq('id', fileId)
    .eq('org_id', orgId)
    .single();

  if (fileError || !fileRecord) {
    throw new Error(`File not found: ${fileError?.message || 'Invalid file_id'}`);
  }

  // Check if we have docling_raw data
  let extractedData: Record<string, any>[] = [];
  
  if (fileRecord.docling_raw) {
    // Use docling data to extract fields
    const doclingData = fileRecord.docling_raw;
    
    // Convert docling fields to structured data
    if (doclingData.fields && Array.isArray(doclingData.fields)) {
      const fieldData: Record<string, any> = {};
      
      for (const field of doclingData.fields) {
        if (field.key && field.value) {
          fieldData[field.key] = field.value;
        }
      }
      
      if (Object.keys(fieldData).length > 0) {
        extractedData.push(fieldData);
      }
    }
    
    // Also extract from tables if available
    if (doclingData.tables && Array.isArray(doclingData.tables)) {
      for (const table of doclingData.tables) {
        if (table.headers && table.rows) {
          for (const row of table.rows) {
            const rowData: Record<string, any> = {};
            for (let i = 0; i < table.headers.length && i < row.length; i++) {
              if (table.headers[i] && row[i]) {
                rowData[table.headers[i]] = row[i];
              }
            }
            if (Object.keys(rowData).length > 0) {
              extractedData.push(rowData);
            }
          }
        }
      }
    }
  }

  // If no docling data, try to use parsed_data
  if (extractedData.length === 0 && fileRecord.parsed_data) {
    extractedData = Array.isArray(fileRecord.parsed_data) ? fileRecord.parsed_data : [fileRecord.parsed_data];
  }

  if (extractedData.length === 0) {
    throw new Error('No extracted data found in file record');
  }

  // Analyze the extracted data
  const { mappedFields, unmappedFields } = analyzeExtractedData(extractedData, moduleType);
  
  // Generate custom field suggestions
  const customFieldSuggestions = generateCustomFieldSuggestions(unmappedFields, confidenceThreshold);
  
  // Auto-create fields if requested
  let autoCreatedFields: Record<string, any>[] = [];
  if (autoCreateFields && customFieldSuggestions.length > 0) {
    autoCreatedFields = await autoCreateCustomFields(
      supabaseAdmin,
      orgId,
      moduleType,
      customFieldSuggestions
    );
  }

  return {
    extracted_data: extractedData,
    mapped_fields: mappedFields,
    unmapped_fields: unmappedFields,
    custom_field_suggestions: customFieldSuggestions,
    auto_created_fields: autoCreatedFields.length > 0 ? autoCreatedFields : undefined,
    processing_summary: {
      total_records: extractedData.length,
      mapped_field_count: Object.keys(mappedFields).length,
      unmapped_field_count: unmappedFields.length,
      suggestions_count: customFieldSuggestions.length,
      auto_created_count: autoCreatedFields.length
    }
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Auth
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    // Parse request
    const body = await req.json().catch(() => ({}));
    const {
      file_id,
      auto_create_fields = false,
      module_type = 'leases',
      confidence_threshold = 70
    }: ExtractWithCustomFieldsRequest = body;

    if (!file_id) {
      return new Response(
        JSON.stringify({ error: 'file_id is required' }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[extract-with-custom-fields] Processing file_id=${file_id}, module=${module_type}, auto_create=${auto_create_fields}`);

    // Perform enhanced extraction
    const result = await performEnhancedExtraction(
      supabaseAdmin,
      orgId,
      file_id,
      module_type,
      auto_create_fields,
      confidence_threshold
    );

    console.log(`[extract-with-custom-fields] Extraction completed: ${result.processing_summary.total_records} records, ${result.processing_summary.suggestions_count} suggestions, ${result.processing_summary.auto_created_count} auto-created fields`);

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error('[extract-with-custom-fields] Error:', err.message);
    return new Response(
      JSON.stringify({
        error: 'Enhanced extraction failed',
        message: err.message,
        details: err.stack
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});