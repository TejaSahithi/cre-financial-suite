import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Edit, X, FileText } from 'lucide-react';
import { toast } from 'sonner';
import CustomFieldForm from './CustomFieldForm';
import CustomFieldDisplay from './CustomFieldDisplay';
import useCustomFields from '@/hooks/useCustomFields';

/**
 * LeaseWithCustomFields - Enhanced lease component with custom field support
 * 
 * Features:
 * - Shows standard lease information
 * - Displays custom field values
 * - Allows editing of custom fields
 * - Integrates seamlessly with existing lease workflows
 */
export default function LeaseWithCustomFields({
  lease,
  onLeaseUpdate,
  editable = true,
  className = ''
}) {
  const [editingCustomFields, setEditingCustomFields] = useState(false);
  const [activeTab, setActiveTab] = useState('details');

  const {
    fields,
    values,
    loading,
    saving,
    error,
    hasValues,
    saveValues,
    getFormattedValue,
  } = useCustomFields('leases', lease?.id, 'lease');

  // Handle custom field save
  const handleSaveCustomFields = async (newValues) => {
    try {
      await saveValues(newValues);
      toast.success('Custom fields saved successfully');
      setEditingCustomFields(false);
    } catch (error) {
      toast.error('Failed to save custom fields');
    }
  };

  // Format standard lease fields for display
  const formatLeaseValue = (key, value) => {
    if (value === null || value === undefined || value === '') return '—';
    
    switch (key) {
      case 'monthly_rent':
      case 'annual_rent':
      case 'security_deposit':
        return new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
        }).format(value);
      case 'start_date':
      case 'end_date':
        return new Date(value).toLocaleDateString();
      case 'square_footage':
        return `${Number(value).toLocaleString()} sq ft`;
      case 'escalation_rate':
        return `${value}%`;
      default:
        return value;
    }
  };

  // Standard lease fields to display
  const standardFields = [
    { key: 'tenant_name', label: 'Tenant Name' },
    { key: 'property_name', label: 'Property' },
    { key: 'unit_number', label: 'Unit' },
    { key: 'start_date', label: 'Start Date' },
    { key: 'end_date', label: 'End Date' },
    { key: 'monthly_rent', label: 'Monthly Rent' },
    { key: 'annual_rent', label: 'Annual Rent' },
    { key: 'square_footage', label: 'Square Footage' },
    { key: 'lease_type', label: 'Lease Type' },
    { key: 'status', label: 'Status' },
  ];

  if (!lease) {
    return (
      <Card className={className}>
        <CardContent className="py-8">
          <div className="text-center text-gray-500">No lease selected</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className={className}>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5" />
              Lease Details - {lease.tenant_name}
            </CardTitle>
            <div className="flex items-center gap-2">
              {hasValues && (
                <Badge variant="outline">
                  {fields.length} custom fields
                </Badge>
              )}
              <Badge variant={lease.status === 'active' ? 'default' : 'secondary'}>
                {lease.status || 'Active'}
              </Badge>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="details">Standard Details</TabsTrigger>
              <TabsTrigger value="custom">
                Custom Fields
                {hasValues && <Badge variant="secondary" className="ml-2">{fields.length}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="documents">Documents</TabsTrigger>
            </TabsList>

            <TabsContent value="details" className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {standardFields.map(({ key, label }) => (
                  <div key={key} className="space-y-1">
                    <div className="text-sm font-medium text-gray-700">{label}</div>
                    <div className="text-sm">
                      {formatLeaseValue(key, lease[key])}
                    </div>
                  </div>
                ))}
              </div>

              {lease.notes && (
                <div className="space-y-1 pt-4 border-t">
                  <div className="text-sm font-medium text-gray-700">Notes</div>
                  <div className="text-sm text-gray-600 whitespace-pre-wrap">
                    {lease.notes}
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="custom" className="space-y-4">
              {loading ? (
                <div className="text-center py-8 text-gray-500">Loading custom fields...</div>
              ) : fields.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  No custom fields defined for leases.
                  <br />
                  <span className="text-sm">Upload a document to automatically create custom fields based on extracted data.</span>
                </div>
              ) : editingCustomFields ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-medium">Edit Custom Fields</h3>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingCustomFields(false)}
                        disabled={saving}
                      >
                        <X className="w-4 h-4 mr-2" />
                        Cancel
                      </Button>
                    </div>
                  </div>
                  
                  <CustomFieldForm
                    recordId={lease.id}
                    recordType="lease"
                    moduleType="leases"
                    initialValues={values}
                    onValuesChange={handleSaveCustomFields}
                    autoSave={false}
                    showSaveButton={true}
                  />
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-medium">Custom Field Values</h3>
                    {editable && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingCustomFields(true)}
                      >
                        <Edit className="w-4 h-4 mr-2" />
                        Edit Fields
                      </Button>
                    )}
                  </div>

                  <CustomFieldDisplay
                    recordId={lease.id}
                    recordType="lease"
                    moduleType="leases"
                    values={values}
                    editable={editable}
                    onEdit={() => setEditingCustomFields(true)}
                    showEmpty={false}
                    groupByType={true}
                  />
                </div>
              )}

              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                  <div className="text-sm text-red-600">{error}</div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="documents" className="space-y-4">
              <div className="text-center py-8 text-gray-500">
                Document management integration would go here.
                <br />
                <span className="text-sm">This could show lease documents, amendments, and related files.</span>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}