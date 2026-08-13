/**
 * Integration Services
 *
 * LLM invocation, file upload, email sending, and data extraction.
 */
import { supabase } from "@/services/supabaseClient";

function withProFormaBranding(content) {
  const logoUrl = "https://www.proformaos.ai/assets/proforma-os-logo.png";
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body { font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 24px; background: #f8fafc; color: #334155; }
      .wrapper { max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; }
      .header { background: #071326; padding: 26px 32px; }
      .brand { display: flex; align-items: center; gap: 10px; }
      .brand-logo { width: 196px; height: auto; display: block; background: #ffffff; border-radius: 8px; padding: 8px 10px; }
      .content { padding: 32px; }
      .footer { padding: 18px 32px; background: #f8fafc; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #94a3b8; }
      .content h1, .content h2, .content h3 { color: #0f172a; margin-top: 0; }
      .content p { line-height: 1.6; }
      .content a { color: #1d4ed8; }
    </style>
  </head>
  <body>
    <div class="wrapper">
      <div class="header">
        <div class="brand">
          <img class="brand-logo" src="${logoUrl}" alt="ProForma OS" />
        </div>
      </div>
      <div class="content">${content}</div>
      <div class="footer">ProForma OS &middot; support@proformaos.ai</div>
    </div>
  </body>
  </html>`;
}

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
 * @param {object} params - { to, templateId, variables }
 * @returns {Promise<{success: boolean}>}
 */
export async function sendEmail(params) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const { data, error } = await supabase.functions.invoke('send-email', {
      body: {
        to: params.to,
        templateId: params.templateId,
        variables: params.variables
      },
      headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
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
 * Validate a billing address using the UPS-backed Edge Function.
 * Returns normalized candidate addresses for dropdown autofill.
 * @param {object} params - { addressLine1, city, state, postalCode, countryCode }
 * @returns {Promise<object>}
 */
export async function validateAddress(params) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const { data, error } = await supabase.functions.invoke("validate-address-ups", {
      body: params,
      headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
    });

    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data || { candidates: [], valid: false };
  } catch (err) {
    console.error("[integrations] validateAddress() error:", err.message || err);
    return {
      success: false,
      valid: false,
      candidates: [],
      source: "error",
      message: "Unable to validate the billing address right now. Please review the fields and try again.",
    };
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
