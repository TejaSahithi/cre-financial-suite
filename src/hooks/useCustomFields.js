import { useState, useEffect, useCallback } from 'react';
import { customFieldService } from '@/services/customFieldService';
import useOrgId from '@/hooks/useOrgId';

/**
 * useCustomFields - Hook for managing custom fields and their values
 * 
 * Features:
 * - Load custom field definitions for a module
 * - Load and save custom field values for records
 * - Real-time updates and caching
 * - Error handling and loading states
 */
export function useCustomFields(moduleType, recordId = null, recordType = null) {
  const { orgId } = useOrgId();
  const [fields, setFields] = useState([]);
  const [values, setValues] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Load custom field definitions
  const loadFields = useCallback(async () => {
    if (!orgId || orgId === '__none__' || !moduleType) return;

    try {
      setLoading(true);
      setError(null);
      
      const fieldDefinitions = await customFieldService.listCustomFields(moduleType, orgId);
      setFields(fieldDefinitions || []);
    } catch (err) {
      console.error('Failed to load custom fields:', err);
      setError(err.message || 'Failed to load custom fields');
    } finally {
      setLoading(false);
    }
  }, [moduleType, orgId]);

  // Load custom field values for a record
  const loadValues = useCallback(async () => {
    if (!orgId || orgId === '__none__' || !recordId || !recordType) return;

    try {
      const fieldValues = await customFieldService.getCustomFieldValues(recordId, recordType);
      
      // Convert array to object
      const valueMap = {};
      fieldValues.forEach(fv => {
        if (fv.field_name && fv.field_value !== null) {
          valueMap[fv.field_name] = fv.field_value;
        }
      });
      
      setValues(valueMap);
    } catch (err) {
      console.error('Failed to load custom field values:', err);
      setError(err.message || 'Failed to load custom field values');
    }
  }, [orgId, recordId, recordType]);

  // Save custom field values
  const saveValues = useCallback(async (newValues) => {
    if (!recordId || !recordType) {
      throw new Error('Cannot save values: missing record information');
    }

    try {
      setSaving(true);
      setError(null);
      
      await customFieldService.setCustomFieldValues(recordId, recordType, newValues);
      setValues(prev => ({ ...prev, ...newValues }));
      
      return true;
    } catch (err) {
      console.error('Failed to save custom field values:', err);
      setError(err.message || 'Failed to save custom field values');
      throw err;
    } finally {
      setSaving(false);
    }
  }, [recordId, recordType]);

  // Save a single field value
  const saveFieldValue = useCallback(async (fieldName, value) => {
    return saveValues({ [fieldName]: value });
  }, [saveValues]);

  // Create a new custom field
  const createField = useCallback(async (fieldData) => {
    try {
      setError(null);
      
      const newField = await customFieldService.createCustomField({
        ...fieldData,
        module_type: moduleType,
      });
      
      // Refresh fields list
      await loadFields();
      
      return newField;
    } catch (err) {
      console.error('Failed to create custom field:', err);
      setError(err.message || 'Failed to create custom field');
      throw err;
    }
  }, [moduleType, loadFields]);

  // Update a custom field
  const updateField = useCallback(async (fieldId, updates) => {
    try {
      setError(null);
      
      const updatedField = await customFieldService.updateCustomField(fieldId, updates);
      
      // Refresh fields list
      await loadFields();
      
      return updatedField;
    } catch (err) {
      console.error('Failed to update custom field:', err);
      setError(err.message || 'Failed to update custom field');
      throw err;
    }
  }, [loadFields]);

  // Delete a custom field
  const deleteField = useCallback(async (fieldId) => {
    try {
      setError(null);
      
      await customFieldService.deleteCustomField(fieldId);
      
      // Refresh fields list
      await loadFields();
      
      return true;
    } catch (err) {
      console.error('Failed to delete custom field:', err);
      setError(err.message || 'Failed to delete custom field');
      throw err;
    }
  }, [loadFields]);

  // Extract document with custom field support
  const extractWithCustomFields = useCallback(async (fileId, options = {}) => {
    try {
      setError(null);
      
      const result = await customFieldService.extractWithCustomFields(fileId, {
        moduleType,
        ...options,
      });
      
      // Refresh fields if new ones were created
      if (result.auto_created_fields?.length > 0) {
        await loadFields();
      }
      
      return result;
    } catch (err) {
      console.error('Failed to extract with custom fields:', err);
      setError(err.message || 'Failed to extract document');
      throw err;
    }
  }, [moduleType, loadFields]);

  // Load fields on mount and when dependencies change
  useEffect(() => {
    loadFields();
  }, [loadFields]);

  // Load values when record info changes
  useEffect(() => {
    if (recordId && recordType) {
      loadValues();
    }
  }, [loadValues]);

  // Get field definition by name
  const getFieldByName = useCallback((fieldName) => {
    return fields.find(field => field.field_name === fieldName);
  }, [fields]);

  // Get formatted value for display
  const getFormattedValue = useCallback((fieldName) => {
    const field = getFieldByName(fieldName);
    const value = values[fieldName];
    
    if (!field || value === null || value === undefined || value === '') {
      return null;
    }

    switch (field.field_type) {
      case 'boolean':
        return value === 'true' || value === true ? 'Yes' : 'No';
      case 'date':
        try {
          return new Date(value).toLocaleDateString();
        } catch {
          return value;
        }
      case 'number':
        const num = Number(value);
        return isNaN(num) ? value : num.toLocaleString();
      default:
        return value;
    }
  }, [getFieldByName, values]);

  // Check if any fields have values
  const hasValues = Object.keys(values).some(key => 
    values[key] !== null && values[key] !== undefined && values[key] !== ''
  );

  return {
    // Data
    fields,
    values,
    
    // States
    loading,
    saving,
    error,
    hasValues,
    
    // Actions
    loadFields,
    loadValues,
    saveValues,
    saveFieldValue,
    createField,
    updateField,
    deleteField,
    extractWithCustomFields,
    
    // Utilities
    getFieldByName,
    getFormattedValue,
  };
}

export default useCustomFields;