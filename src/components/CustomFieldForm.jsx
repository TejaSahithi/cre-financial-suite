import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CalendarIcon, Save, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { customFieldService } from '@/services/customFieldService';
import useOrgId from '@/hooks/useOrgId';

/**
 * CustomFieldForm - Dynamic form component for custom field values
 * 
 * Features:
 * - Dynamically renders form fields based on custom field definitions
 * - Supports all field types (text, number, date, boolean, select)
 * - Validates required fields and data types
 * - Auto-saves values on change or manual save
 * - Shows validation errors inline
 */
export default function CustomFieldForm({
  recordId,
  recordType,
  moduleType,
  initialValues = {},
  onValuesChange,
  autoSave = true,
  showSaveButton = false,
  className = ''
}) {
  const { orgId } = useOrgId();
  const [fields, setFields] = useState([]);
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load custom fields and values
  const loadFieldsAndValues = useCallback(async () => {
    if (!orgId || orgId === '__none__' || !recordId) return;

    try {
      setLoading(true);
      
      // Load field definitions
      const fieldDefinitions = await customFieldService.listCustomFields(moduleType, orgId);
      setFields(fieldDefinitions || []);

      // Load existing values if recordId is provided
      if (recordId && recordType) {
        const fieldValues = await customFieldService.getCustomFieldValues(recordId, recordType);
        
        // Convert array of field values to object
        const valueMap = {};
        fieldValues.forEach(fv => {
          if (fv.field_name && fv.field_value !== null) {
            valueMap[fv.field_name] = fv.field_value;
          }
        });
        
        setValues({ ...initialValues, ...valueMap });
      }
    } catch (error) {
      console.error('Failed to load custom fields and values:', error);
      toast.error('Failed to load custom fields');
    } finally {
      setLoading(false);
    }
  }, [moduleType, orgId, recordId, recordType, initialValues]);

  useEffect(() => {
    loadFieldsAndValues();
  }, [loadFieldsAndValues]);

  // Notify parent of value changes
  useEffect(() => {
    if (onValuesChange) {
      onValuesChange(values);
    }
  }, [values, onValuesChange]);

  // Validate field value
  const validateField = (field, value) => {
    const errors = [];

    // Required field validation
    if (field.is_required && (value === null || value === undefined || value === '')) {
      errors.push(`${field.field_label} is required`);
    }

    // Type-specific validation
    if (value !== null && value !== undefined && value !== '') {
      switch (field.field_type) {
        case 'number':
          if (isNaN(Number(value))) {
            errors.push(`${field.field_label} must be a valid number`);
          }
          break;
        case 'date':
          if (isNaN(Date.parse(value))) {
            errors.push(`${field.field_label} must be a valid date`);
          }
          break;
        case 'select':
          if (field.field_options && !field.field_options.includes(value)) {
            errors.push(`${field.field_label} must be one of: ${field.field_options.join(', ')}`);
          }
          break;
      }
    }

    return errors;
  };

  // Handle field value change
  const handleFieldChange = async (fieldName, value, field) => {
    const newValues = { ...values, [fieldName]: value };
    setValues(newValues);

    // Validate the field
    const fieldErrors = validateField(field, value);
    setErrors(prev => ({
      ...prev,
      [fieldName]: fieldErrors.length > 0 ? fieldErrors[0] : null
    }));

    // Auto-save if enabled and no errors
    if (autoSave && fieldErrors.length === 0 && recordId && recordType) {
      try {
        await customFieldService.setCustomFieldValues(recordId, recordType, { [fieldName]: value });
      } catch (error) {
        console.error('Failed to auto-save field value:', error);
        toast.error('Failed to save field value');
      }
    }
  };

  // Manual save all values
  const handleSave = async () => {
    if (!recordId || !recordType) {
      toast.error('Cannot save: missing record information');
      return;
    }

    // Validate all fields
    const allErrors = {};
    let hasErrors = false;

    fields.forEach(field => {
      const fieldErrors = validateField(field, values[field.field_name]);
      if (fieldErrors.length > 0) {
        allErrors[field.field_name] = fieldErrors[0];
        hasErrors = true;
      }
    });

    setErrors(allErrors);

    if (hasErrors) {
      toast.error('Please fix validation errors before saving');
      return;
    }

    try {
      setSaving(true);
      await customFieldService.setCustomFieldValues(recordId, recordType, values);
      toast.success('Custom field values saved successfully');
    } catch (error) {
      console.error('Failed to save custom field values:', error);
      toast.error('Failed to save custom field values');
    } finally {
      setSaving(false);
    }
  };

  // Render field input based on type
  const renderFieldInput = (field) => {
    const value = values[field.field_name] || '';
    const error = errors[field.field_name];

    switch (field.field_type) {
      case 'text':
        return (
          <Input
            value={value}
            onChange={(e) => handleFieldChange(field.field_name, e.target.value, field)}
            placeholder={`Enter ${field.field_label.toLowerCase()}`}
            className={error ? 'border-red-500' : ''}
          />
        );

      case 'number':
        return (
          <Input
            type="number"
            value={value}
            onChange={(e) => handleFieldChange(field.field_name, e.target.value, field)}
            placeholder={`Enter ${field.field_label.toLowerCase()}`}
            className={error ? 'border-red-500' : ''}
          />
        );

      case 'date':
        return (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={`w-full justify-start text-left font-normal ${error ? 'border-red-500' : ''} ${!value ? 'text-muted-foreground' : ''}`}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {value ? format(new Date(value), 'PPP') : `Select ${field.field_label.toLowerCase()}`}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0">
              <Calendar
                mode="single"
                selected={value ? new Date(value) : undefined}
                onSelect={(date) => handleFieldChange(field.field_name, date ? date.toISOString().split('T')[0] : '', field)}
                initialFocus
              />
            </PopoverContent>
          </Popover>
        );

      case 'boolean':
        return (
          <div className="flex items-center space-x-2">
            <Switch
              checked={value === 'true' || value === true}
              onCheckedChange={(checked) => handleFieldChange(field.field_name, checked.toString(), field)}
            />
            <Label className="text-sm text-gray-600">
              {value === 'true' || value === true ? 'Yes' : 'No'}
            </Label>
          </div>
        );

      case 'select':
        return (
          <Select
            value={value}
            onValueChange={(newValue) => handleFieldChange(field.field_name, newValue, field)}
          >
            <SelectTrigger className={error ? 'border-red-500' : ''}>
              <SelectValue placeholder={`Select ${field.field_label.toLowerCase()}`} />
            </SelectTrigger>
            <SelectContent>
              {(field.field_options || []).map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      default:
        return (
          <Input
            value={value}
            onChange={(e) => handleFieldChange(field.field_name, e.target.value, field)}
            placeholder={`Enter ${field.field_label.toLowerCase()}`}
            className={error ? 'border-red-500' : ''}
          />
        );
    }
  };

  if (loading) {
    return (
      <Card className={className}>
        <CardContent className="py-8">
          <div className="text-center text-gray-500">Loading custom fields...</div>
        </CardContent>
      </Card>
    );
  }

  if (fields.length === 0) {
    return null; // Don't render anything if no custom fields
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-lg">Custom Fields</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {fields.map((field) => (
          <div key={field.id} className="space-y-2">
            <Label htmlFor={field.field_name} className="flex items-center gap-2">
              {field.field_label}
              {field.is_required && <span className="text-red-500">*</span>}
            </Label>
            
            {renderFieldInput(field)}
            
            {errors[field.field_name] && (
              <div className="flex items-center gap-2 text-sm text-red-600">
                <AlertCircle className="w-4 h-4" />
                {errors[field.field_name]}
              </div>
            )}
          </div>
        ))}

        {showSaveButton && (
          <div className="pt-4 border-t">
            <Button 
              onClick={handleSave} 
              disabled={saving}
              className="w-full"
            >
              <Save className="w-4 h-4 mr-2" />
              {saving ? 'Saving...' : 'Save Custom Fields'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}