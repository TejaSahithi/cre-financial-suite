import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { 
  FileText, 
  Sparkles, 
  CheckCircle, 
  AlertTriangle, 
  Plus,
  Eye,
  RefreshCw
} from 'lucide-react';
import { toast } from 'sonner';
import { customFieldService } from '@/services/customFieldService';
import CustomFieldManager from './CustomFieldManager';
import useOrgId from '@/hooks/useOrgId';

/**
 * DocumentExtractionWithCustomFields - Enhanced document processing with custom field support
 * 
 * Features:
 * - Integrates with existing document upload workflow
 * - Shows extraction results with mapped and unmapped fields
 * - Suggests custom fields for unmapped data
 * - Allows auto-creation of suggested fields
 * - Provides real-time updates during extraction
 * - Manages custom field definitions
 */
export default function DocumentExtractionWithCustomFields({
  fileId,
  moduleType = 'leases',
  onExtractionComplete,
  className = ''
}) {
  const { orgId } = useOrgId();
  const [extractionResult, setExtractionResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [autoCreateFields, setAutoCreateFields] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState(70);
  const [activeTab, setActiveTab] = useState('extraction');
  const [customFields, setCustomFields] = useState([]);

  // Extract document with custom field support
  const handleExtraction = useCallback(async () => {
    if (!fileId || !orgId || orgId === '__none__') return;

    try {
      setLoading(true);
      
      const result = await customFieldService.extractWithCustomFields(fileId, {
        autoCreateFields,
        moduleType,
        confidenceThreshold,
      });

      setExtractionResult(result);
      
      if (result.auto_created_fields?.length > 0) {
        toast.success(`Extraction complete! Auto-created ${result.auto_created_fields.length} custom fields.`);
      } else if (result.custom_field_suggestions?.length > 0) {
        toast.success(`Extraction complete! Found ${result.custom_field_suggestions.length} field suggestions.`);
      } else {
        toast.success('Document extraction completed successfully!');
      }

      if (onExtractionComplete) {
        onExtractionComplete(result);
      }

    } catch (error) {
      console.error('Document extraction failed:', error);
      toast.error('Document extraction failed: ' + error.message);
    } finally {
      setLoading(false);
    }
  }, [fileId, orgId, autoCreateFields, moduleType, confidenceThreshold, onExtractionComplete]);

  // Auto-extract when fileId changes
  useEffect(() => {
    if (fileId) {
      handleExtraction();
    }
  }, [fileId, handleExtraction]);

  // Create custom field from suggestion
  const handleCreateCustomField = async (suggestion) => {
    try {
      await customFieldService.createCustomField({
        ...suggestion,
        module_type: moduleType,
      });
      
      toast.success(`Custom field "${suggestion.field_label}" created successfully!`);
      
      // Refresh extraction to show updated mapping
      await handleExtraction();
    } catch (error) {
      console.error('Failed to create custom field:', error);
      toast.error('Failed to create custom field: ' + error.message);
    }
  };

  // Render extraction summary
  const renderExtractionSummary = () => {
    if (!extractionResult) return null;

    const { processing_summary } = extractionResult;
    
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold text-blue-600">{processing_summary.total_records}</div>
            <div className="text-sm text-gray-600">Records Extracted</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold text-green-600">{processing_summary.mapped_field_count}</div>
            <div className="text-sm text-gray-600">Mapped Fields</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold text-orange-600">{processing_summary.unmapped_field_count}</div>
            <div className="text-sm text-gray-600">Unmapped Fields</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold text-purple-600">{processing_summary.suggestions_count}</div>
            <div className="text-sm text-gray-600">Suggestions</div>
          </CardContent>
        </Card>
      </div>
    );
  };

  // Render mapped fields
  const renderMappedFields = () => {
    if (!extractionResult?.mapped_fields) return null;

    const mappedEntries = Object.entries(extractionResult.mapped_fields);
    if (mappedEntries.length === 0) return null;

    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-green-600" />
            Mapped Fields ({mappedEntries.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {mappedEntries.map(([extractedField, uiField]) => (
              <div key={extractedField} className="flex items-center justify-between p-3 bg-green-50 rounded-lg">
                <div>
                  <div className="font-medium">{extractedField}</div>
                  <div className="text-sm text-gray-600">→ {uiField}</div>
                </div>
                <Badge variant="default">Mapped</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  };

  // Render unmapped fields with suggestions
  const renderUnmappedFields = () => {
    if (!extractionResult?.custom_field_suggestions) return null;

    const suggestions = extractionResult.custom_field_suggestions;
    if (suggestions.length === 0) return null;

    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-orange-600" />
            Custom Field Suggestions ({suggestions.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {suggestions.map((suggestion, index) => (
            <div key={index} className="p-4 border rounded-lg bg-orange-50">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="font-medium">{suggestion.field_label}</div>
                  <div className="text-sm text-gray-600 mb-2">
                    Field Name: {suggestion.field_name} • Type: {suggestion.field_type}
                  </div>
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="outline">
                      {suggestion.confidence}% confidence
                    </Badge>
                    {suggestion.field_options && (
                      <Badge variant="secondary">
                        {suggestion.field_options.length} options
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm text-gray-600">
                    Sample values: {suggestion.sample_values.slice(0, 3).join(', ')}
                    {suggestion.sample_values.length > 3 && ` (+${suggestion.sample_values.length - 3} more)`}
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => handleCreateCustomField(suggestion)}
                  className="ml-4"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Create Field
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    );
  };

  // Render extracted data preview
  const renderDataPreview = () => {
    if (!extractionResult?.extracted_data) return null;

    const data = extractionResult.extracted_data.slice(0, 5); // Show first 5 records

    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Eye className="w-5 h-5" />
            Extracted Data Preview
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {data.map((record, index) => (
              <div key={index} className="p-3 border rounded-lg bg-gray-50">
                <div className="font-medium mb-2">Record {index + 1}</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                  {Object.entries(record).map(([key, value]) => (
                    <div key={key} className="flex justify-between">
                      <span className="font-medium">{key}:</span>
                      <span className="text-gray-600">{String(value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {extractionResult.extracted_data.length > 5 && (
              <div className="text-center text-gray-500">
                ... and {extractionResult.extracted_data.length - 5} more records
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className={className}>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5" />
              Document Extraction with Custom Fields
            </CardTitle>
            <div className="flex items-center gap-4">
              <div className="flex items-center space-x-2">
                <Switch
                  id="auto-create"
                  checked={autoCreateFields}
                  onCheckedChange={setAutoCreateFields}
                />
                <Label htmlFor="auto-create" className="text-sm">
                  Auto-create fields
                </Label>
              </div>
              <Button
                onClick={handleExtraction}
                disabled={loading || !fileId}
                size="sm"
              >
                <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                {loading ? 'Extracting...' : 'Re-extract'}
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {loading && (
            <Alert>
              <FileText className="h-4 w-4" />
              <AlertDescription>
                Extracting document data and analyzing custom fields...
              </AlertDescription>
            </Alert>
          )}

          {extractionResult && (
            <>
              {renderExtractionSummary()}

              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="grid w-full grid-cols-4">
                  <TabsTrigger value="extraction">Extraction Results</TabsTrigger>
                  <TabsTrigger value="suggestions">Field Suggestions</TabsTrigger>
                  <TabsTrigger value="data">Data Preview</TabsTrigger>
                  <TabsTrigger value="manage">Manage Fields</TabsTrigger>
                </TabsList>

                <TabsContent value="extraction" className="space-y-4">
                  {renderMappedFields()}
                  {extractionResult.unmapped_fields?.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <AlertTriangle className="w-5 h-5 text-orange-600" />
                          Unmapped Fields ({extractionResult.unmapped_fields.length})
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {extractionResult.unmapped_fields.map((field, index) => (
                            <div key={index} className="p-3 bg-orange-50 rounded-lg">
                              <div className="font-medium">{field.field_name}</div>
                              <div className="text-sm text-gray-600">
                                Type: {field.suggested_type} • Confidence: {field.confidence}%
                              </div>
                              <div className="text-xs text-gray-500 mt-1">
                                Sample: {field.sample_values.slice(0, 2).join(', ')}
                              </div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>

                <TabsContent value="suggestions" className="space-y-4">
                  {renderUnmappedFields()}
                  {extractionResult.auto_created_fields?.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <CheckCircle className="w-5 h-5 text-green-600" />
                          Auto-Created Fields ({extractionResult.auto_created_fields.length})
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {extractionResult.auto_created_fields.map((field) => (
                            <div key={field.id} className="p-3 bg-green-50 rounded-lg">
                              <div className="font-medium">{field.field_label}</div>
                              <div className="text-sm text-gray-600">
                                {field.field_name} • {field.field_type}
                              </div>
                              <Badge variant="default" className="mt-2">Auto-created</Badge>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>

                <TabsContent value="data" className="space-y-4">
                  {renderDataPreview()}
                </TabsContent>

                <TabsContent value="manage" className="space-y-4">
                  <CustomFieldManager
                    moduleType={moduleType}
                    onFieldsChange={setCustomFields}
                  />
                </TabsContent>
              </Tabs>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}