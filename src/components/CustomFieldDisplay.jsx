import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Edit, Eye, EyeOff } from 'lucide-react';
import { format } from 'date-fns';
import { customFieldService } from '@/services/customFieldService';
import useOrgId from '@/hooks/useOrgId';

/**
 * CustomFieldDisplay - Component for displaying custom field values
 * 
 * Features:
 * - Shows custom field values in a clean, organized layout
 * - Formats values based on field type (dates, booleans, etc.)
 * - Supports read-only and editable modes
 * - Groups fields logically
 * - Shows/hides empty fields
 */
export default function CustomFieldDisplay({
  recordId,
  recordType,
  moduleType,
  values = {},
  editable = false,
  onEdit,
  showEmpty = false,
  groupByType = false,
  className = ''
}) {
  const { orgId } = useOrgId();
  const [fields, setFields] = useState([]);
  const [fieldValues, setFieldValues] = useState(values);
  const [loading, setLoading] = useState(true);
  const [showEmptyFields, setShowEmptyFields] = useState(showEmpty);

  // Load custom fields and values
  const loadFieldsAndValues = useCallback(async () => {
    if (!orgId || orgId === '__none__') return;

    try {
      setLoading(true);
      
      // Load field definitions
      const fieldDefinitions = await customFieldService.listCustomFields(moduleType, orgId);
      setFields(fieldDefinitions || []);

      // Load values if recordId is provided and no values passed as props
      if (recordId && recordType && Object.keys(values).length === 0) {
        const loadedValues = await customFieldService.getCustomFieldValues(recordId, recordType);
        
        // Convert array to object
        const valueMap = {};
        loadedValues.forEach(fv => {
          if (fv.field_name && fv.field_value !== null) {
            valueMap[fv.field_name] = fv.field_value;
          }
        });
        
        setFieldValues(valueMap);
      } else {
        setFieldValues(values);
      }
    } catch (error) {
      console.error('Failed to load custom fields and values:', error);
    } finally {
      setLoading(false);
    }
  }, [moduleType, orgId, recordId, recordType, values]);

  useEffect(() => {
    loadFieldsAndValues();
  }, [loadFieldsAndValues]);

  // Format value based on field type
  const formatValue = (field, value) => {
    if (value === null || value === undefined || value === '') {
      return <span className="text-gray-400 italic">Not set</span>;
    }

    switch (field.field_type) {
      case 'boolean':
        return (
          <Badge variant={value === 'true' || value === true ? 'default' : 'secondary'}>
            {value === 'true' || value === true ? 'Yes' : 'No'}
          </Badge>
        );

      case 'date':
        try {
          return format(new Date(value), 'PPP');
        } catch {
          return value;
        }

      case 'number':
        const num = Number(value);
        return isNaN(num) ? value : num.toLocaleString();

      case 'select':
        return <Badge variant="outline">{value}</Badge>;

      default:
        return value;
    }
  };

  // Group fields by type if requested
  const groupedFields = groupByType ? 
    fields.reduce((groups, field) => {
      const type = field.field_type;
      if (!groups[type]) groups[type] = [];
      groups[type].push(field);
      return groups;
    }, {}) : 
    { all: fields };

  // Filter fields based on showEmpty setting
  const getVisibleFields = (fieldsToFilter) => {
    if (showEmptyFields) return fieldsToFilter;
    
    return fieldsToFilter.filter(field => {
      const value = fieldValues[field.field_name];
      return value !== null && value !== undefined && value !== '';
    });
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
    return null; // Don't render if no custom fields defined
  }

  const hasVisibleFields = Object.values(groupedFields).some(groupFields => 
    getVisibleFields(groupFields).length > 0
  );

  if (!hasVisibleFields && !showEmptyFields) {
    return (
      <Card className={className}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Custom Fields</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowEmptyFields(true)}
            >
              <EyeOff className="w-4 h-4 mr-2" />
              Show Empty
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4 text-gray-500">
            No custom field values to display.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Custom Fields</CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowEmptyFields(!showEmptyFields)}
            >
              {showEmptyFields ? (
                <>
                  <Eye className="w-4 h-4 mr-2" />
                  Hide Empty
                </>
              ) : (
                <>
                  <EyeOff className="w-4 h-4 mr-2" />
                  Show Empty
                </>
              )}
            </Button>
            {editable && onEdit && (
              <Button variant="outline" size="sm" onClick={onEdit}>
                <Edit className="w-4 h-4 mr-2" />
                Edit
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {groupByType ? (
          <div className="space-y-6">
            {Object.entries(groupedFields).map(([groupType, groupFields]) => {
              const visibleFields = getVisibleFields(groupFields);
              if (visibleFields.length === 0) return null;

              const typeLabels = {
                text: 'Text Fields',
                number: 'Numeric Fields',
                date: 'Date Fields',
                boolean: 'Yes/No Fields',
                select: 'Dropdown Fields'
              };

              return (
                <div key={groupType}>
                  <h4 className="font-medium text-sm text-gray-700 mb-3 uppercase tracking-wide">
                    {typeLabels[groupType] || 'Other Fields'}
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {visibleFields.map((field) => (
                      <div key={field.id} className="space-y-1">
                        <div className="text-sm font-medium text-gray-700 flex items-center gap-2">
                          {field.field_label}
                          {field.is_required && <span className="text-red-500">*</span>}
                        </div>
                        <div className="text-sm">
                          {formatValue(field, fieldValues[field.field_name])}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {getVisibleFields(fields).map((field) => (
              <div key={field.id} className="space-y-1">
                <div className="text-sm font-medium text-gray-700 flex items-center gap-2">
                  {field.field_label}
                  {field.is_required && <span className="text-red-500">*</span>}
                </div>
                <div className="text-sm">
                  {formatValue(field, fieldValues[field.field_name])}
                </div>
              </div>
            ))}
          </div>
        )}

        {getVisibleFields(fields).length === 0 && showEmptyFields && (
          <div className="text-center py-4 text-gray-500">
            All custom fields are empty.
          </div>
        )}
      </CardContent>
    </Card>
  );
}