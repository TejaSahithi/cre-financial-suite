import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FileText, Settings, Upload, Sparkles } from 'lucide-react';
import CustomFieldManager from './CustomFieldManager';
import CustomFieldForm from './CustomFieldForm';
import CustomFieldDisplay from './CustomFieldDisplay';
import DocumentExtractionWithCustomFields from './DocumentExtractionWithCustomFields';
import CustomFieldSuggestionNotification from './CustomFieldSuggestionNotification';
import useCustomFields from '@/hooks/useCustomFields';

/**
 * CustomFieldIntegrationExample - Demonstrates how to integrate custom field components
 * 
 * This example shows:
 * - How to manage custom field definitions
 * - How to display and edit custom field values
 * - How to integrate with document extraction
 * - How to handle real-time field suggestions
 */
export default function CustomFieldIntegrationExample() {
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [uploadedFileId, setUploadedFileId] = useState(null);

  // Example lease record
  const exampleLease = {
    id: 'example-lease-123',
    tenant_name: 'Example Tenant Corp',
    property_name: 'Example Office Building',
    unit_number: '101',
    start_date: '2024-01-01',
    end_date: '2026-12-31',
    monthly_rent: 5000,
    annual_rent: 60000,
    square_footage: 1200,
    lease_type: 'Commercial',
    status: 'active',
  };

  // Example custom field suggestions (would come from document extraction)
  const exampleSuggestions = [
    {
      field_name: 'parking_spaces',
      field_label: 'Parking Spaces',
      field_type: 'number',
      confidence: 85,
      sample_values: ['2', '3', '1'],
    },
    {
      field_name: 'pet_policy',
      field_label: 'Pet Policy',
      field_type: 'select',
      field_options: ['Allowed', 'Not Allowed', 'With Deposit'],
      confidence: 92,
      sample_values: ['Allowed', 'With Deposit'],
    },
    {
      field_name: 'renewal_option',
      field_label: 'Renewal Option',
      field_type: 'boolean',
      confidence: 78,
      sample_values: ['true', 'false'],
    },
  ];

  const handleFieldCreated = (newField, suggestion) => {
    console.log('New field created:', newField);
    // Remove the suggestion that was just created
    setSuggestions(prev => prev.filter(s => s.field_name !== suggestion.field_name));
  };

  const handleExtractionComplete = (result) => {
    if (result.custom_field_suggestions?.length > 0) {
      setSuggestions(result.custom_field_suggestions);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5" />
            Custom Fields Integration Example
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <FileText className="h-4 w-4" />
            <AlertDescription>
              This example demonstrates the complete custom fields workflow: 
              field management, document extraction, value editing, and real-time suggestions.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="manage">Manage Fields</TabsTrigger>
          <TabsTrigger value="extraction">Document Extraction</TabsTrigger>
          <TabsTrigger value="display">Display Values</TabsTrigger>
          <TabsTrigger value="edit">Edit Values</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Settings className="w-4 h-4" />
                  Field Management
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-600 mb-4">
                  Create and manage custom field definitions for different modules (leases, properties, etc.).
                </p>
                <Button onClick={() => setActiveTab('manage')} size="sm">
                  Manage Fields
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Upload className="w-4 h-4" />
                  Document Extraction
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-600 mb-4">
                  Upload documents and automatically extract data with AI-powered field suggestions.
                </p>
                <Button onClick={() => setActiveTab('extraction')} size="sm">
                  Try Extraction
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <FileText className="w-4 h-4" />
                  Display Values
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-600 mb-4">
                  View custom field values in a clean, organized format with type-specific formatting.
                </p>
                <Button 
                  onClick={() => {
                    setSelectedRecord(exampleLease);
                    setActiveTab('display');
                  }} 
                  size="sm"
                >
                  View Example
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Sparkles className="w-4 h-4" />
                  Real-time Suggestions
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-600 mb-4">
                  See how field suggestions appear during document processing.
                </p>
                <Button 
                  onClick={() => setSuggestions(exampleSuggestions)} 
                  size="sm"
                >
                  Show Suggestions
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="manage" className="space-y-4">
          <CustomFieldManager
            moduleType="leases"
            onFieldsChange={(fields) => console.log('Fields updated:', fields)}
          />
        </TabsContent>

        <TabsContent value="extraction" className="space-y-4">
          <Alert>
            <Upload className="h-4 w-4" />
            <AlertDescription>
              In a real implementation, this would show the DocumentExtractionWithCustomFields component.
              For this example, you can simulate the extraction process.
            </AlertDescription>
          </Alert>
          
          <Card>
            <CardContent className="p-6">
              <div className="text-center space-y-4">
                <div className="text-lg font-medium">Document Extraction Simulation</div>
                <p className="text-sm text-gray-600">
                  Click below to simulate document extraction with custom field suggestions.
                </p>
                <Button 
                  onClick={() => {
                    setSuggestions(exampleSuggestions);
                    setActiveTab('overview');
                  }}
                >
                  Simulate Extraction
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="display" className="space-y-4">
          {selectedRecord ? (
            <CustomFieldDisplay
              recordId={selectedRecord.id}
              recordType="lease"
              moduleType="leases"
              editable={true}
              onEdit={() => setActiveTab('edit')}
              showEmpty={true}
              groupByType={true}
            />
          ) : (
            <Alert>
              <AlertDescription>
                Select a record from the Overview tab to see custom field display.
              </AlertDescription>
            </Alert>
          )}
        </TabsContent>

        <TabsContent value="edit" className="space-y-4">
          {selectedRecord ? (
            <CustomFieldForm
              recordId={selectedRecord.id}
              recordType="lease"
              moduleType="leases"
              autoSave={false}
              showSaveButton={true}
              onValuesChange={(values) => console.log('Values changed:', values)}
            />
          ) : (
            <Alert>
              <AlertDescription>
                Select a record from the Overview tab to edit custom field values.
              </AlertDescription>
            </Alert>
          )}
        </TabsContent>
      </Tabs>

      {/* Real-time suggestion notifications */}
      <CustomFieldSuggestionNotification
        suggestions={suggestions}
        moduleType="leases"
        onFieldCreated={handleFieldCreated}
        onDismiss={() => setSuggestions([])}
        autoHide={false}
      />
    </div>
  );
}