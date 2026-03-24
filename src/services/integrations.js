/**
 * Integration Services
 *
 * LLM invocation, file upload, email sending, and data extraction.
 */
import { supabase } from "@/services/supabaseClient";

/**
 * Invoke an LLM with the given parameters.
 * @param {object} params - { prompt, response_json_schema, ... }
 * @returns {Promise<any>} LLM response (object if schema provided, otherwise string)
 */
export async function invokeLLM(params) {
  try {
    const apiUrl = import.meta.env.VITE_API_URL;
    if (apiUrl) {
      const response = await fetch(`${apiUrl}/integrations/llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!response.ok) throw new Error(`LLM invocation failed: ${response.statusText}`);
      return await response.json();
    }
    console.log('[integrations] invokeLLM() — no backend configured', params);
    return params.response_json_schema ? {} : 'LLM response placeholder';
  } catch (err) {
    console.error('[integrations] invokeLLM() error:', err);
    return params.response_json_schema ? {} : '';
  }
}

/**
 * Upload a file and return its URL.
 * @param {object} params - { file }
 * @returns {Promise<{file_url: string}>}
 */
export async function uploadFile(params) {
  try {
    const apiUrl = import.meta.env.VITE_API_URL;
    if (apiUrl) {
      const formData = new FormData();
      formData.append('file', params.file);
      const response = await fetch(`${apiUrl}/integrations/upload`, {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) throw new Error(`Upload failed: ${response.statusText}`);
      return await response.json();
    }
    console.log('[integrations] uploadFile() — no backend configured');
    return { file_url: URL.createObjectURL(params.file) };
  } catch (err) {
    console.error('[integrations] uploadFile() error:', err);
    return { file_url: '' };
  }
}

/**
 * Send an email using Supabase Edge Functions mapping to Resend.
 * @param {object} params - { to, subject, body, html }
 * @returns {Promise<{success: boolean}>}
 */
export async function sendEmail(params) {
  try {
    const { data, error } = await supabase.functions.invoke('send-email', {
      body: {
        to: params.to,
        subject: params.subject,
        text: params.body,
        html: params.html
      }
    });
    
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);

    return { success: true };
  } catch (err) {
    console.error('[integrations] sendEmail() error:', err.message || err);
    return { success: false };
  }
}

/**
 * Extract structured data from an uploaded file (e.g. PDF lease, CSV).
 * @param {object} params - { file_url, json_schema }
 * @returns {Promise<any>} Extracted data (object)
 */
export async function extractDataFromUploadedFile(params) {
  try {
    const apiUrl = import.meta.env.VITE_API_URL;
    if (apiUrl) {
      const response = await fetch(`${apiUrl}/integrations/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!response.ok) throw new Error(`Extraction failed: ${response.statusText}`);
      return await response.json();
    }
    console.log('[integrations] extractDataFromUploadedFile() — no backend configured', params);
    return {};
  } catch (err) {
    console.error('[integrations] extractDataFromUploadedFile() error:', err);
    return {};
  }
}
