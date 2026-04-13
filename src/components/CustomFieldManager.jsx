import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Plus, Edit, Trash2, Settings, GripVertical } from 'lucide-react';
import { toast } from 'sonner';
import { customFieldService } from '@/services/customFieldService';
import useOrgId from '@/hooks/useOrgId';

const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Yes/No' },
  { value: 'select', label: 'Dropdown' },
];

const MODULE_TYPES = [
  { value: 'leases', label: 'Leases' },
  { value: 'properties', label: 'Properties' },
  { value: 'expenses', label: 'Expenses' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'budgets', label: 'Budgets' },
  { value: 'tenants', label: 'Tenants' },
  { value: 'units', label: 'Units' },
  { value: 'buildings', label: 'Buildings' },
];

/**
 * CustomFieldManager - Component for managing custom field definitions
 * 
 * Features:
 * - List existing custom fields for a module
 * - Create new custom fields with validation
 * - Edit existing field properties
 * - Delete fields with confirmation
 * - Reorder fields for display
 */
export default function CustomFieldManager({ 
  moduleType = 'leases',
  onFieldsChange,
  className = '' 
}) {
  const { orgId } = useOrgId();
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingField, setEditingField] = useState(null);
  const [formData, setFormData] = useState({
    field_name: '',
    field_label: '',
    field_type: 'text',
    field_options: [],
    is_required: false,
    display_order: 0,
  });
  const [optionInput, setOptionInput] = useState('');

  // Load custom fields
  const loadFields = useCallback(async () => {
    if (!orgId || orgId === '__none__') return;
    
    try {
      setLoading(true);
      const data = await customFieldService.listCustomFields(moduleType, orgId);
      setFields(data || []);
    } catch (error) {
      console.error('Failed to load custom fields:', error);
      toast.error('Failed to load custom fields');
    } finally {
      setLoading(false);
    }
  }, [moduleType, orgId]);

  useEffect(() => {
    loadFields();
  }, [loadFields]);

  // Notify parent of field changes
  useEffect(() => {
    if (onFieldsChange) {
      onFieldsChange(fields);
    }
  }, [fields, onFieldsChange]);

  // Reset form
  const resetForm = () => {
    setFormData({
      field_name: '',
      field_label: '',
      field_type: 'text',
      field_options: [],
      is_required: false,
      display_order: fields.length,
    });
    setOptionInput('');
    setEditingField(null);
  };

  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.field_name.trim() || !formData.field_label.trim()) {
      toast.error('Field name and label are required');
      return;
    }

    // Validate field name format
    const fieldNameRegex = /^[a-z][a-z0-9_]*$/;
    if (!fieldNameRegex.test(formData.field_name)) {
      toast.error('Field name must be lowercase, start with a letter, and contain only letters, numbers, and underscores');
      return;
    }

    // Validate select field options
    if (formData.field_type === 'select' && formData.field_options.length === 0) {
      toast.error('Dropdown fields must have at least one option');
      return;
    }

    try {
      const fieldData = {
        ...formData,
        module_type: moduleType,
      };

      if (editingField) {
        // Update existing field
        await customFieldService.updateCustomField(editingField.id, fieldData);
        toast.success('Custom field updated successfully');
      } else {
        // Create new field
        await customFieldService.createCustomField(fieldData);
        toast.success('Custom field created successfully');
      }

      await loadFields();
      setShowCreateDialog(false);
      resetForm();
    } catch (error) {
      console.error('Failed to save custom field:', error);
      toast.error(error.message || 'Failed to save custom field');
    }
  };

  // Handle field deletion
  const handleDelete = async (fieldId) => {
    try {
      await customFieldService.deleteCustomField(fieldId);
      toast.success('Custom field deleted successfully');
      await loadFields();
    } catch (error) {
      console.error('Failed to delete custom field:', error);
      toast.error('Failed to delete custom field');
    }
  };

  // Handle edit
  const handleEdit = (field) => {
    setFormData({
      field_name: field.field_name,
      field_label: field.field_label,
      field_type: field.field_type,
      field_options: field.field_options || [],
      is_required: field.is_required || false,
      display_order: field.display_order || 0,
    });
    setEditingField(field);
    setShowCreateDialog(true);
  };

  // Add option for select fields
  const addOption = () => {
    if (!optionInput.trim()) return;
    
    const newOptions = [...formData.field_options, optionInput.trim()];
    setFormData({ ...formData, field_options: newOptions });
    setOptionInput('');
  };

  // Remove option
  const removeOption = (index) => {
    const newOptions = formData.field_options.filter((_, i) => i !== index);
    setFormData({ ...formData, field_options: newOptions });
  };

  // Generate field name from label
  const generateFieldName = (label) => {
    return label
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '_')
      .replace(/^[^a-z]/, 'field_');
  };

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5" />
            Custom Fields - {MODULE_TYPES.find(m => m.value === moduleType)?.label}
          </CardTitle>
          <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
            <DialogTrigger asChild>
              <Button onClick={resetForm}>
                <Plus className="w-4 h-4 mr-2" />
                Add Field
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {editingField ? 'Edit Custom Field' : 'Create Custom Field'}
                </DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="field_label">Field Label</Label>
                  <Input
                    id="field_label"
                    value={formData.field_label}
                    onChange={(e) => {
                      const label = e.target.value;
                      setFormData({
                        ...formData,
                        field_label: label,
                        field_name: formData.field_name || generateFieldName(label),
                      });
                    }}
                    placeholder="e.g., Parking Spaces"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="field_name">Field Name</Label>
                  <Input
                    id="field_name"
                    value={formData.field_name}
                    onChange={(e) => setFormData({ ...formData, field_name: e.target.value })}
                    placeholder="e.g., parking_spaces"
                    pattern="^[a-z][a-z0-9_]*$"
                    title="Must be lowercase, start with a letter, and contain only letters, numbers, and underscores"
                    required
                  />
                  <p className="text-xs text-gray-500">
                    Used in code. Must be lowercase with underscores.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="field_type">Field Type</Label>
                  <Select
                    value={formData.field_type}
                    onValueChange={(value) => setFormData({ ...formData, field_type: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_TYPES.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {formData.field_type === 'select' && (
                  <div className="space-y-2">
                    <Label>Dropdown Options</Label>
                    <div className="flex gap-2">
                      <Input
                        value={optionInput}
                        onChange={(e) => setOptionInput(e.target.value)}
                        placeholder="Add option..."
                        onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addOption())}
                      />
                      <Button type="button" onClick={addOption} size="sm">
                        Add
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {formData.field_options.map((option, index) => (
                        <Badge key={index} variant="secondary" className="flex items-center gap-1">
                          {option}
                          <button
                            type="button"
                            onClick={() => removeOption(index)}
                            className="ml-1 text-red-500 hover:text-red-700"
                          >
                            ×
                          </button>
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center space-x-2">
                  <Switch
                    id="is_required"
                    checked={formData.is_required}
                    onCheckedChange={(checked) => setFormData({ ...formData, is_required: checked })}
                  />
                  <Label htmlFor="is_required">Required field</Label>
                </div>

                <div className="flex gap-2 pt-4">
                  <Button type="submit" className="flex-1">
                    {editingField ? 'Update Field' : 'Create Field'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowCreateDialog(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="text-center py-8 text-gray-500">Loading custom fields...</div>
        ) : fields.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            No custom fields defined for this module.
            <br />
            <span className="text-sm">Click "Add Field" to create your first custom field.</span>
          </div>
        ) : (
          <div className="space-y-3">
            {fields.map((field) => (
              <div
                key={field.id}
                className="flex items-center justify-between p-3 border rounded-lg bg-white"
              >
                <div className="flex items-center gap-3">
                  <GripVertical className="w-4 h-4 text-gray-400" />
                  <div>
                    <div className="font-medium">{field.field_label}</div>
                    <div className="text-sm text-gray-500">
                      {field.field_name} • {FIELD_TYPES.find(t => t.value === field.field_type)?.label}
                      {field.is_required && <Badge variant="outline" className="ml-2">Required</Badge>}
                    </div>
                    {field.field_type === 'select' && field.field_options?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {field.field_options.slice(0, 3).map((option, index) => (
                          <Badge key={index} variant="secondary" className="text-xs">
                            {option}
                          </Badge>
                        ))}
                        {field.field_options.length > 3 && (
                          <Badge variant="secondary" className="text-xs">
                            +{field.field_options.length - 3} more
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleEdit(field)}
                  >
                    <Edit className="w-4 h-4" />
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete Custom Field</AlertDialogTitle>
                        <AlertDialogDescription>
                          Are you sure you want to delete "{field.field_label}"? 
                          This will also delete all values for this field across all records.
                          This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleDelete(field.id)}
                          className="bg-red-600 hover:bg-red-700"
                        >
                          Delete Field
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}