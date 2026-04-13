/**
 * Custom Field Service
 * 
 * Provides API integration for custom field management and values.
 * Integrates with the custom-fields and extract-with-custom-fields edge functions.
 */

import { supabase } from '@/services/supabaseClient';

export const customFieldService = {
  // ── Custom Field Definitions ─────────────────────────────────────────────

  /**
   * List custom fields for a module type
   * @param {string} moduleType - Module type (leases, properties, expenses, etc.)
   * @param {string} orgId - Organization ID
   * @returns {Promise<Array>}
   */
  async listCustomFields(moduleType, orgId) {
    try {
      const { data, error } = await supabase.functions.invoke('custom-fields', {
        method: 'GET',
        body: null,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (error) throw error;
      
      // Filter by module type if specified
      const fields = data?.custom_fields || [];
      return moduleType ? fields.filter(field => field.module_type === moduleType) : fields;
    } catch (error) {
      console.error('[customFieldService] listCustomFields error:', error);
      throw error;
    }
  },

  /**
   * Create a new custom field
   * @param {object} fieldData - Field definition
   * @returns {Promise<object>}
   */
  async createCustomField(fieldData) {
    try {
      const { data, error } = await supabase.functions.invoke('custom-fields', {
        method: 'POST',
        body: fieldData,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (error) throw error;
      return data?.custom_field;
    } catch (error) {
      console.error('[customFieldService] createCustomField error:', error);
      throw error;
    }
  },

  /**
   * Update a custom field
   * @param {string} fieldId - Field ID
   * @param {object} updates - Field updates
   * @returns {Promise<object>}
   */
  async updateCustomField(fieldId, updates) {
    try {
      const { data, error } = await supabase.functions.invoke('custom-fields', {
        method: 'PUT',
        body: updates,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (error) throw error;
      return data?.custom_field;
    } catch (error) {
      console.error('[customFieldService] updateCustomField error:', error);
      throw error;
    }
  },

  /**
   * Delete a custom field
   * @param {string} fieldId - Field ID
   * @returns {Promise<void>}
   */
  async deleteCustomField(fieldId) {
    try {
      const { data, error } = await supabase.functions.invoke('custom-fields', {
        method: 'DELETE',
        body: null,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('[customFieldService] deleteCustomField error:', error);
      throw error;
    }
  },

  // ── Custom Field Values ──────────────────────────────────────────────────

  /**
   * Get custom field values for a record
   * @param {string} recordId - Record ID
   * @param {string} recordType - Record type (lease, property, etc.)
   * @returns {Promise<Array>}
   */
  async getCustomFieldValues(recordId, recordType) {
    try {
      const { data, error } = await supabase.functions.invoke('custom-fields', {
        method: 'GET',
        body: null,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (error) throw error;
      return data?.custom_field_values || [];
    } catch (error) {
      console.error('[customFieldService] getCustomFieldValues error:', error);
      throw error;
    }
  },

  /**
   * Set custom field values for a record
   * @param {string} recordId - Record ID
   * @param {string} recordType - Record type
   * @param {object} values - Field name to value mapping
   * @returns {Promise<object>}
   */
  async setCustomFieldValues(recordId, recordType, values) {
    try {
      const { data, error } = await supabase.functions.invoke('custom-fields', {
        method: 'POST',
        body: {
          record_id: recordId,
          record_type: recordType,
          values: values,
        },
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('[customFieldService] setCustomFieldValues error:', error);
      throw error;
    }
  },

  // ── Enhanced Extraction ──────────────────────────────────────────────────

  /**
   * Extract document with custom field support
   * @param {string} fileId - File ID
   * @param {object} options - Extraction options
   * @returns {Promise<object>}
   */
  async extractWithCustomFields(fileId, options = {}) {
    try {
      const {
        autoCreateFields = false,
        moduleType = 'leases',
        confidenceThreshold = 70,
      } = options;

      const { data, error } = await supabase.functions.invoke('extract-with-custom-fields', {
        method: 'POST',
        body: {
          file_id: fileId,
          auto_create_fields: autoCreateFields,
          module_type: moduleType,
          confidence_threshold: confidenceThreshold,
        },
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('[customFieldService] extractWithCustomFields error:', error);
      throw error;
    }
  },
};

export default customFieldService;