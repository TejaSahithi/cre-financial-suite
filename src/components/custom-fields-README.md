# Custom Fields UI Components

This directory contains a complete set of React components for managing custom fields in the CRE Financial Suite application. These components integrate with the backend custom fields system to provide dynamic field creation, management, and data entry capabilities.

## Components Overview

### Core Components

#### 1. CustomFieldManager
**Purpose**: Manage custom field definitions for different modules
**Location**: `./CustomFieldManager.jsx`

**Features**:
- Create, edit, and delete custom field definitions
- Support for all field types (text, number, date, boolean, select)
- Field validation and ordering
- Module-specific field management

**Usage**:
```jsx
import CustomFieldManager from '@/components/CustomFieldManager';

<CustomFieldManager
  moduleType="leases"
  onFieldsChange={(fields) => console.log('Fields updated:', fields)}
/>
```

#### 2. CustomFieldForm
**Purpose**: Dynamic form generation for custom field values
**Location**: `./CustomFieldForm.jsx`

**Features**:
- Dynamically renders form fields based on custom field definitions
- Type-specific input components (date picker, dropdown, etc.)
- Real-time validation
- Auto-save or manual save options

**Usage**:
```jsx
import CustomFieldForm from '@/components/CustomFieldForm';

<CustomFieldForm
  recordId="lease-123"
  recordType="lease"
  moduleType="leases"
  autoSave={true}
  onValuesChange={(values) => console.log('Values:', values)}
/>
```

#### 3. CustomFieldDisplay
**Purpose**: Display custom field values in a clean, organized format
**Location**: `./CustomFieldDisplay.jsx`

**Features**:
- Type-specific value formatting
- Show/hide empty fields
- Group fields by type
- Edit mode integration

**Usage**:
```jsx
import CustomFieldDisplay from '@/components/CustomFieldDisplay';

<CustomFieldDisplay
  recordId="lease-123"
  recordType="lease"
  moduleType="leases"
  editable={true}
  onEdit={() => setEditMode(true)}
  groupByType={true}
/>
```

### Integration Components

#### 4. DocumentExtractionWithCustomFields
**Purpose**: Enhanced document processing with custom field support
**Location**: `./DocumentExtractionWithCustomFields.jsx`

**Features**:
- AI-powered document extraction
- Custom field suggestions based on extracted data
- Auto-creation of suggested fields
- Real-time extraction progress

**Usage**:
```jsx
import DocumentExtractionWithCustomFields from '@/components/DocumentExtractionWithCustomFields';

<DocumentExtractionWithCustomFields
  fileId="uploaded-file-123"
  moduleType="leases"
  onExtractionComplete={(result) => console.log('Extraction:', result)}
/>
```

#### 5. EnhancedFileUploader
**Purpose**: File uploader with integrated custom field support
**Location**: `./EnhancedFileUploader.jsx`

**Features**:
- Standard file upload for CSV/Excel
- Enhanced document processing for PDF/Word/Images
- Automatic routing based on file type
- Custom field management interface

**Usage**:
```jsx
import EnhancedFileUploader from '@/components/EnhancedFileUploader';

<EnhancedFileUploader
  propertyId="property-123"
  defaultFileType="leases"
  onUploadComplete={(result) => console.log('Upload:', result)}
/>
```

#### 6. LeaseWithCustomFields
**Purpose**: Enhanced lease component with custom field integration
**Location**: `./LeaseWithCustomFields.jsx`

**Features**:
- Standard lease information display
- Custom field values integration
- Tabbed interface for organization
- Edit mode for custom fields

**Usage**:
```jsx
import LeaseWithCustomFields from '@/components/LeaseWithCustomFields';

<LeaseWithCustomFields
  lease={leaseData}
  onLeaseUpdate={(lease) => console.log('Updated:', lease)}
  editable={true}
/>
```

### Utility Components

#### 7. CustomFieldSuggestionNotification
**Purpose**: Real-time notifications for custom field suggestions
**Location**: `./CustomFieldSuggestionNotification.jsx`

**Features**:
- Toast-style notifications for field suggestions
- Quick field creation from suggestions
- Auto-dismiss functionality
- Preview of suggested field properties

**Usage**:
```jsx
import CustomFieldSuggestionNotification from '@/components/CustomFieldSuggestionNotification';

<CustomFieldSuggestionNotification
  suggestions={extractionSuggestions}
  moduleType="leases"
  onFieldCreated={(field) => console.log('Created:', field)}
  onDismiss={() => setSuggestions([])}
/>
```

## Hooks and Services

### useCustomFields Hook
**Purpose**: React hook for managing custom fields and values
**Location**: `../hooks/useCustomFields.js`

**Features**:
- Load custom field definitions
- Manage custom field values
- Create, update, delete fields
- Document extraction integration

**Usage**:
```jsx
import useCustomFields from '@/hooks/useCustomFields';

const {
  fields,
  values,
  loading,
  saveValues,
  createField,
  extractWithCustomFields
} = useCustomFields('leases', 'lease-123', 'lease');
```

### customFieldService
**Purpose**: API service for custom field operations
**Location**: `../services/customFieldService.js`

**Features**:
- CRUD operations for custom fields
- Custom field value management
- Enhanced document extraction
- Error handling and validation

## Field Types Supported

1. **Text**: Single-line text input
2. **Number**: Numeric input with validation
3. **Date**: Date picker with calendar
4. **Boolean**: Yes/No toggle switch
5. **Select**: Dropdown with predefined options

## Integration Patterns

### 1. Adding Custom Fields to Existing Forms

```jsx
// In your existing lease form component
import CustomFieldForm from '@/components/CustomFieldForm';

function LeaseForm({ lease }) {
  return (
    <div>
      {/* Your existing lease form fields */}
      
      {/* Add custom fields section */}
      <CustomFieldForm
        recordId={lease.id}
        recordType="lease"
        moduleType="leases"
        autoSave={true}
      />
    </div>
  );
}
```

### 2. Document Upload with Custom Field Extraction

```jsx
// Replace standard FileUploader with EnhancedFileUploader
import EnhancedFileUploader from '@/components/EnhancedFileUploader';

function DocumentUploadPage() {
  return (
    <EnhancedFileUploader
      defaultFileType="leases"
      onUploadComplete={(result) => {
        // Handle both standard and enhanced processing
        console.log('Upload result:', result);
      }}
    />
  );
}
```

### 3. Real-time Field Suggestions

```jsx
// Add to your document processing workflow
import CustomFieldSuggestionNotification from '@/components/CustomFieldSuggestionNotification';

function DocumentProcessor() {
  const [suggestions, setSuggestions] = useState([]);

  const handleExtractionComplete = (result) => {
    if (result.custom_field_suggestions) {
      setSuggestions(result.custom_field_suggestions);
    }
  };

  return (
    <div>
      {/* Your document processing UI */}
      
      <CustomFieldSuggestionNotification
        suggestions={suggestions}
        moduleType="leases"
        onFieldCreated={() => {
          // Refresh your data
          refetchData();
        }}
        onDismiss={() => setSuggestions([])}
      />
    </div>
  );
}
```

## Styling and Theming

All components use the existing UI component library (`@/components/ui/*`) and follow the established design patterns:

- **Cards**: For main component containers
- **Tabs**: For organizing related functionality
- **Buttons**: Consistent button styles and variants
- **Forms**: Standard form inputs with validation
- **Badges**: For status indicators and metadata
- **Alerts**: For notifications and important information

## Error Handling

Components include comprehensive error handling:

- **Network errors**: Graceful fallbacks and user-friendly messages
- **Validation errors**: Real-time field validation with inline error display
- **Permission errors**: Appropriate messaging for access restrictions
- **Loading states**: Skeleton loaders and progress indicators

## Performance Considerations

- **Lazy loading**: Components load data on-demand
- **Caching**: Field definitions are cached to reduce API calls
- **Debouncing**: Auto-save functionality uses debouncing to prevent excessive API calls
- **Virtualization**: Large field lists use virtual scrolling when needed

## Testing

Each component includes:
- Unit tests for core functionality
- Integration tests for API interactions
- Accessibility tests for screen reader compatibility
- Visual regression tests for UI consistency

## Browser Support

Components are tested and supported on:
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## Accessibility

All components follow WCAG 2.1 AA guidelines:
- Keyboard navigation support
- Screen reader compatibility
- High contrast mode support
- Focus management
- ARIA labels and descriptions

## Migration Guide

### From Standard Forms to Custom Field Forms

1. **Identify integration points**: Find where you want to add custom fields
2. **Add the hook**: Use `useCustomFields` to manage field data
3. **Add the component**: Include `CustomFieldForm` or `CustomFieldDisplay`
4. **Handle updates**: Connect field changes to your existing data flow

### From Standard File Upload to Enhanced Upload

1. **Replace component**: Change `FileUploader` to `EnhancedFileUploader`
2. **Handle new result types**: Update upload completion handlers
3. **Add suggestion handling**: Implement custom field suggestion workflow
4. **Update routing**: Ensure proper navigation after enhanced processing

## Troubleshooting

### Common Issues

1. **Fields not loading**: Check org_id and module_type parameters
2. **Values not saving**: Verify record_id and record_type are correct
3. **Suggestions not appearing**: Ensure document extraction is working
4. **Permission errors**: Check user roles and access permissions

### Debug Mode

Enable debug logging by setting:
```javascript
localStorage.setItem('customFields:debug', 'true');
```

This will log detailed information about API calls, field operations, and component state changes.

## Contributing

When adding new features or modifying existing components:

1. Follow the established patterns and conventions
2. Add comprehensive tests for new functionality
3. Update this documentation
4. Ensure accessibility compliance
5. Test across supported browsers

## Support

For questions or issues with custom field components:
- Check the troubleshooting section above
- Review the integration examples
- Consult the API documentation for backend endpoints
- Test with the CustomFieldIntegrationExample component