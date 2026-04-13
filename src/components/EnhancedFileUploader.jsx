import React, { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { FileText, Sparkles, Upload } from 'lucide-react';
import { toast } from 'sonner';
import FileUploader from './FileUploader';
import DocumentExtractionWithCustomFields from './DocumentExtractionWithCustomFields';
import CustomFieldManager from './CustomFieldManager';

/**
 * EnhancedFileUploader - File uploader with integrated custom field support
 * 
 * Features:
 * - Standard file upload for CSV/Excel (existing workflow)
 * - Enhanced document processing with custom field extraction
 * - Custom field management interface
 * - Real-time extraction results and field suggestions
 */
export default function EnhancedFileUploader({
  propertyId,
  defaultFileType,
  allowedFileTypes,
  onUploadComplete,
  className = ''
}) {
  const [activeTab, setActiveTab] = useState('upload');
  const [uploadedFile, setUploadedFile] = useState(null);
  const [extractionMode, setExtractionMode] = useState(false);

  // Handle file upload completion
  const handleUploadComplete = useCallback((result) => {
    const fileResult = Array.isArray(result) ? result[0] : result;
    
    if (fileResult?.file_id) {
      setUploadedFile(fileResult);
      
      // Check if this is a document that should use enhanced extraction
      const documentExtensions = ['.pdf', '.doc', '.docx', '.txt', '.jpg', '.jpeg', '.png', '.tiff', '.tif'];
      const fileName = fileResult.file_name || '';
      const isDocument = documentExtensions.some(ext => 
        fileName.toLowerCase().endsWith(ext)
      );
      
      if (isDocument) {
        setExtractionMode(true);
        setActiveTab('extraction');
        toast.success('Document uploaded! Starting enhanced extraction with custom field support...');
      } else {
        // Standard CSV/Excel processing
        setExtractionMode(false);
        toast.success('File uploaded successfully! Processing through standard pipeline...');
      }
    }

    // Call parent callback
    if (onUploadComplete) {
      onUploadComplete(result);
    }
  }, [onUploadComplete]);

  // Handle extraction completion
  const handleExtractionComplete = useCallback((extractionResult) => {
    if (extractionResult.custom_field_suggestions?.length > 0) {
      setActiveTab('suggestions');
    }
  }, []);

  // Determine module type from file type
  const getModuleType = () => {
    if (defaultFileType) return defaultFileType;
    if (uploadedFile?.file_type) return uploadedFile.file_type;
    return 'leases';
  };

  return (
    <div className={className}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5" />
            Enhanced File Upload & Processing
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="upload">Upload Files</TabsTrigger>
              <TabsTrigger value="extraction" disabled={!extractionMode}>
                Document Extraction
              </TabsTrigger>
              <TabsTrigger value="suggestions" disabled={!extractionMode}>
                Field Suggestions
              </TabsTrigger>
              <TabsTrigger value="manage">Manage Fields</TabsTrigger>
            </TabsList>

            <TabsContent value="upload" className="space-y-4">
              <Alert>
                <FileText className="h-4 w-4" />
                <AlertDescription>
                  <strong>Enhanced Processing:</strong> PDF, Word, and image files will use AI-powered extraction with custom field support. 
                  CSV and Excel files will use the standard structured data pipeline.
                </AlertDescription>
              </Alert>

              <FileUploader
                propertyId={propertyId}
                defaultFileType={defaultFileType}
                allowedFileTypes={allowedFileTypes}
                onUploadComplete={handleUploadComplete}
              />

              {uploadedFile && (
                <Card className="bg-green-50 border-green-200">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{uploadedFile.file_name}</div>
                        <div className="text-sm text-gray-600">
                          File ID: {uploadedFile.file_id}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={extractionMode ? 'default' : 'secondary'}>
                          {extractionMode ? 'Enhanced Processing' : 'Standard Processing'}
                        </Badge>
                        {extractionMode && (
                          <Badge variant="outline">
                            <Sparkles className="w-3 h-3 mr-1" />
                            AI Extraction
                          </Badge>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="extraction" className="space-y-4">
              {uploadedFile?.file_id && extractionMode ? (
                <DocumentExtractionWithCustomFields
                  fileId={uploadedFile.file_id}
                  moduleType={getModuleType()}
                  onExtractionComplete={handleExtractionComplete}
                />
              ) : (
                <Alert>
                  <AlertDescription>
                    Upload a document file (PDF, Word, or image) to see extraction results.
                  </AlertDescription>
                </Alert>
              )}
            </TabsContent>

            <TabsContent value="suggestions" className="space-y-4">
              {uploadedFile?.file_id && extractionMode ? (
                <Alert>
                  <Sparkles className="h-4 w-4" />
                  <AlertDescription>
                    Custom field suggestions will appear here after document extraction completes.
                    You can review and create new fields based on the extracted data.
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <AlertDescription>
                    Upload and extract a document to see custom field suggestions.
                  </AlertDescription>
                </Alert>
              )}
            </TabsContent>

            <TabsContent value="manage" className="space-y-4">
              <CustomFieldManager
                moduleType={getModuleType()}
                onFieldsChange={(fields) => {
                  // Optionally handle field changes
                  console.log('Custom fields updated:', fields);
                }}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}