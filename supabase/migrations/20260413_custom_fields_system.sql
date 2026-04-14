-- Custom Fields System Migration
-- Adds support for dynamic custom fields when extracted data doesn't match existing UI fields

-- Custom field definitions table
CREATE TABLE IF NOT EXISTS public.custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  module_type TEXT NOT NULL CHECK (module_type IN ('leases', 'properties', 'expenses', 'revenue', 'cam', 'budgets', 'tenants', 'units', 'buildings')),
  field_name TEXT NOT NULL CHECK (field_name ~ '^[a-z][a-z0-9_]*$'), -- Snake case validation
  field_label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text', 'number', 'date', 'boolean', 'select')),
  field_options JSONB DEFAULT '[]'::jsonb, -- For select fields
  is_required BOOLEAN DEFAULT FALSE,
  validation_rules JSONB DEFAULT '{}'::jsonb,
  display_order INTEGER DEFAULT 0,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  -- Ensure unique field names per org and module
  UNIQUE(org_id, module_type, field_name)
);

-- Custom field values table
CREATE TABLE IF NOT EXISTS public.custom_field_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  custom_field_id UUID NOT NULL REFERENCES public.custom_fields(id) ON DELETE CASCADE,
  record_id UUID NOT NULL, -- References the actual record (lease, property, etc.)
  record_type TEXT NOT NULL CHECK (record_type IN ('lease', 'property', 'expense', 'revenue', 'cam', 'budget', 'tenant', 'unit', 'building')),
  field_value TEXT, -- Stored as text, converted based on field_type
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  -- Ensure unique values per field and record
  UNIQUE(custom_field_id, record_id)
);

-- Add docling_raw column to uploaded_files if not exists
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'uploaded_files' 
    AND column_name = 'docling_raw'
  ) THEN
    ALTER TABLE public.uploaded_files ADD COLUMN docling_raw JSONB;
  END IF;
END $$;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_custom_fields_org_module ON public.custom_fields(org_id, module_type);
CREATE INDEX IF NOT EXISTS idx_custom_fields_field_name ON public.custom_fields(field_name);
CREATE INDEX IF NOT EXISTS idx_custom_field_values_org_record ON public.custom_field_values(org_id, record_type, record_id);
CREATE INDEX IF NOT EXISTS idx_custom_field_values_field_id ON public.custom_field_values(custom_field_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_docling_raw ON public.uploaded_files USING GIN (docling_raw) WHERE docling_raw IS NOT NULL;

-- Row Level Security (RLS) policies
ALTER TABLE public.custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_field_values ENABLE ROW LEVEL SECURITY;

-- Custom fields policies
CREATE POLICY "Users can view custom fields for their org" ON public.custom_fields
  FOR SELECT USING (
    org_id IN (
      SELECT org_id FROM public.user_organizations 
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create custom fields for their org" ON public.custom_fields
  FOR INSERT WITH CHECK (
    org_id IN (
      SELECT org_id FROM public.user_organizations 
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update custom fields for their org" ON public.custom_fields
  FOR UPDATE USING (
    org_id IN (
      SELECT org_id FROM public.user_organizations 
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete custom fields for their org" ON public.custom_fields
  FOR DELETE USING (
    org_id IN (
      SELECT org_id FROM public.user_organizations 
      WHERE user_id = auth.uid()
    )
  );

-- Custom field values policies
CREATE POLICY "Users can view custom field values for their org" ON public.custom_field_values
  FOR SELECT USING (
    org_id IN (
      SELECT org_id FROM public.user_organizations 
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create custom field values for their org" ON public.custom_field_values
  FOR INSERT WITH CHECK (
    org_id IN (
      SELECT org_id FROM public.user_organizations 
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update custom field values for their org" ON public.custom_field_values
  FOR UPDATE USING (
    org_id IN (
      SELECT org_id FROM public.user_organizations 
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete custom field values for their org" ON public.custom_field_values
  FOR DELETE USING (
    org_id IN (
      SELECT org_id FROM public.user_organizations 
      WHERE user_id = auth.uid()
    )
  );

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_custom_fields_updated_at 
  BEFORE UPDATE ON public.custom_fields 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_custom_field_values_updated_at 
  BEFORE UPDATE ON public.custom_field_values 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Helper function to validate field values based on field type
CREATE OR REPLACE FUNCTION validate_custom_field_value(
  field_type TEXT,
  field_value TEXT,
  field_options JSONB DEFAULT '[]'::jsonb
) RETURNS BOOLEAN AS $$
BEGIN
  -- Allow NULL values
  IF field_value IS NULL THEN
    RETURN TRUE;
  END IF;

  CASE field_type
    WHEN 'text' THEN
      RETURN TRUE; -- Any text is valid
    
    WHEN 'number' THEN
      -- Check if value is a valid number
      BEGIN
        PERFORM field_value::NUMERIC;
        RETURN TRUE;
      EXCEPTION WHEN OTHERS THEN
        RETURN FALSE;
      END;
    
    WHEN 'date' THEN
      -- Check if value is a valid date
      BEGIN
        PERFORM field_value::DATE;
        RETURN TRUE;
      EXCEPTION WHEN OTHERS THEN
        RETURN FALSE;
      END;
    
    WHEN 'boolean' THEN
      -- Check if value is a valid boolean
      RETURN field_value::TEXT IN ('true', 'false', 't', 'f', '1', '0', 'yes', 'no', 'y', 'n');
    
    WHEN 'select' THEN
      -- Check if value is in the allowed options
      RETURN field_value::TEXT = ANY(
        SELECT jsonb_array_elements_text(field_options)
      );
    
    ELSE
      RETURN FALSE; -- Unknown field type
  END CASE;
END;
$$ LANGUAGE plpgsql;

-- Trigger to validate field values before insert/update
CREATE OR REPLACE FUNCTION validate_custom_field_value_trigger()
RETURNS TRIGGER AS $$
DECLARE
  field_record RECORD;
BEGIN
  -- Get the field definition
  SELECT field_type, field_options, is_required 
  INTO field_record
  FROM public.custom_fields 
  WHERE id = NEW.custom_field_id;

  -- Check if required field is empty
  IF field_record.is_required AND (NEW.field_value IS NULL OR NEW.field_value = '') THEN
    RAISE EXCEPTION 'Field value is required but was not provided';
  END IF;

  -- Validate the field value
  IF NOT validate_custom_field_value(field_record.field_type, NEW.field_value, field_record.field_options) THEN
    RAISE EXCEPTION 'Invalid field value "%" for field type "%"', NEW.field_value, field_record.field_type;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_custom_field_value_before_insert
  BEFORE INSERT ON public.custom_field_values
  FOR EACH ROW EXECUTE FUNCTION validate_custom_field_value_trigger();

CREATE TRIGGER validate_custom_field_value_before_update
  BEFORE UPDATE ON public.custom_field_values
  FOR EACH ROW EXECUTE FUNCTION validate_custom_field_value_trigger();

-- View to get custom fields with their values for a specific record
CREATE OR REPLACE VIEW public.custom_fields_with_values AS
SELECT 
  cf.id as field_id,
  cf.org_id,
  cf.module_type,
  cf.field_name,
  cf.field_label,
  cf.field_type,
  cf.field_options,
  cf.is_required,
  cf.validation_rules,
  cf.display_order,
  cfv.record_id,
  cfv.record_type,
  cfv.field_value,
  cfv.created_at as value_created_at,
  cfv.updated_at as value_updated_at
FROM public.custom_fields cf
LEFT JOIN public.custom_field_values cfv ON cf.id = cfv.custom_field_id
ORDER BY cf.display_order, cf.field_label;

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_fields TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_field_values TO authenticated;
GRANT SELECT ON public.custom_fields_with_values TO authenticated;

-- Add comments for documentation
COMMENT ON TABLE public.custom_fields IS 'Defines custom field schemas for different modules when extracted data doesn''t match existing UI fields';
COMMENT ON TABLE public.custom_field_values IS 'Stores actual values for custom fields linked to specific records';
COMMENT ON COLUMN public.custom_fields.field_name IS 'Snake case field name used in code (e.g., parking_spaces)';
COMMENT ON COLUMN public.custom_fields.field_label IS 'Human readable label shown in UI (e.g., Parking Spaces)';
COMMENT ON COLUMN public.custom_fields.field_options IS 'JSON array of options for select fields';
COMMENT ON COLUMN public.custom_fields.validation_rules IS 'JSON object with validation rules (min, max, pattern, etc.)';
COMMENT ON COLUMN public.custom_field_values.field_value IS 'Value stored as text, converted based on field_type when retrieved';
COMMENT ON VIEW public.custom_fields_with_values IS 'Convenient view joining custom fields with their values for easy querying';