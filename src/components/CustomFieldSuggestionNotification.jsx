import React, { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Sparkles, Plus, X, Eye, CheckCircle } from 'lucide-react';
import { toast } from 'sonner';
import { customFieldService } from '@/services/customFieldService';

/**
 * CustomFieldSuggestionNotification - Real-time notification for custom field suggestions
 * 
 * Features:
 * - Shows when new custom fields are suggested during extraction
 * - Allows quick creation of suggested fields
 * - Provides preview of suggested field properties
 * - Auto-dismisses after user action
 * - Integrates with real-time extraction updates
 */
export default function CustomFieldSuggestionNotification({
  suggestions = [],
  moduleType,
  onFieldCreated,
  onDismiss,
  autoHide = true,
  className = ''
}) {
  const [visibleSuggestions, setVisibleSuggestions] = useState(suggestions);
  const [creatingFields, setCreatingFields] = useState(new Set());
  const [createdFields, setCreatedFields] = useState(new Set());

  useEffect(() => {
    setVisibleSuggestions(suggestions);
  }, [suggestions]);

  // Auto-hide after 10 seconds if no interaction
  useEffect(() => {
    if (autoHide && visibleSuggestions.length > 0) {
      const timer = setTimeout(() => {
        if (onDismiss) onDismiss();
      }, 10000);
      
      return () => clearTimeout(timer);
    }
  }, [visibleSuggestions, autoHide, onDismiss]);

  // Create custom field from suggestion
  const handleCreateField = async (suggestion, index) => {
    const fieldKey = `${suggestion.field_name}_${index}`;
    setCreatingFields(prev => new Set([...prev, fieldKey]));

    try {
      const newField = await customFieldService.createCustomField({
        ...suggestion,
        module_type: moduleType,
      });

      setCreatedFields(prev => new Set([...prev, fieldKey]));
      toast.success(`Custom field "${suggestion.field_label}" created successfully!`);

      if (onFieldCreated) {
        onFieldCreated(newField, suggestion);
      }

      // Remove from visible suggestions after a delay
      setTimeout(() => {
        setVisibleSuggestions(prev => prev.filter((_, i) => i !== index));
      }, 2000);

    } catch (error) {
      console.error('Failed to create custom field:', error);
      toast.error(`Failed to create field "${suggestion.field_label}": ${error.message}`);
    } finally {
      setCreatingFields(prev => {
        const newSet = new Set(prev);
        newSet.delete(fieldKey);
        return newSet;
      });
    }
  };

  // Dismiss a single suggestion
  const handleDismissSuggestion = (index) => {
    setVisibleSuggestions(prev => prev.filter((_, i) => i !== index));
  };

  // Dismiss all suggestions
  const handleDismissAll = () => {
    setVisibleSuggestions([]);
    if (onDismiss) onDismiss();
  };

  if (visibleSuggestions.length === 0) {
    return null;
  }

  return (
    <div className={`fixed bottom-4 right-4 z-50 max-w-md space-y-2 ${className}`}>
      {/* Header notification */}
      <Alert className="bg-blue-50 border-blue-200">
        <Sparkles className="h-4 w-4 text-blue-600" />
        <AlertDescription className="flex items-center justify-between">
          <span className="text-blue-800 font-medium">
            {visibleSuggestions.length} custom field{visibleSuggestions.length !== 1 ? 's' : ''} suggested
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDismissAll}
            className="h-6 w-6 p-0 text-blue-600 hover:text-blue-800"
          >
            <X className="h-4 w-4" />
          </Button>
        </AlertDescription>
      </Alert>

      {/* Individual suggestions */}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {visibleSuggestions.map((suggestion, index) => {
          const fieldKey = `${suggestion.field_name}_${index}`;
          const isCreating = creatingFields.has(fieldKey);
          const isCreated = createdFields.has(fieldKey);

          return (
            <Card key={fieldKey} className="bg-white shadow-lg border-l-4 border-l-blue-500">
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1">
                    <div className="font-medium text-sm">{suggestion.field_label}</div>
                    <div className="text-xs text-gray-500">
                      {suggestion.field_name} • {suggestion.field_type}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDismissSuggestion(index)}
                    className="h-6 w-6 p-0 text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>

                <div className="flex items-center gap-2 mb-3">
                  <Badge variant="outline" className="text-xs">
                    {suggestion.confidence}% confidence
                  </Badge>
                  {suggestion.field_options && (
                    <Badge variant="secondary" className="text-xs">
                      {suggestion.field_options.length} options
                    </Badge>
                  )}
                </div>

                <div className="text-xs text-gray-600 mb-3">
                  Sample: {suggestion.sample_values.slice(0, 2).join(', ')}
                  {suggestion.sample_values.length > 2 && ` (+${suggestion.sample_values.length - 2})`}
                </div>

                <div className="flex items-center gap-2">
                  {isCreated ? (
                    <Button size="sm" disabled className="flex-1">
                      <CheckCircle className="w-3 h-3 mr-2" />
                      Created
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => handleCreateField(suggestion, index)}
                      disabled={isCreating}
                      className="flex-1"
                    >
                      {isCreating ? (
                        <>
                          <div className="w-3 h-3 mr-2 animate-spin rounded-full border-2 border-white border-t-transparent" />
                          Creating...
                        </>
                      ) : (
                        <>
                          <Plus className="w-3 h-3 mr-2" />
                          Create Field
                        </>
                      )}
                    </Button>
                  )}
                  
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      // Could open a preview modal here
                      toast.info(`Field "${suggestion.field_label}" would be created as ${suggestion.field_type} type`);
                    }}
                  >
                    <Eye className="w-3 h-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}