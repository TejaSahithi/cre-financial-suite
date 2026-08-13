/**
 * Email Service
 *
 * Routes all email sending through Supabase Edge Functions.
 * 
 * SECURITY FIX (2026-03-26): Removed direct Resend API calls from the
 * frontend. The Resend API key was previously exposed in the browser
 * bundle via VITE_RESEND_API_KEY. All email operations now go through
 * the server-side `send-email` Edge Function which holds the key securely.
 */

import { supabase } from '@/services/supabaseClient';

/**
 * Send an email via the server-side Edge Function.
 * The Resend API key is stored securely in Supabase secrets, never exposed to the browser.
 */
async function sendEmail({ to, templateId, variables }) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    
    // We allow unauthenticated calls if the edge function supports it for public templates.
    // The edge function itself validates whether anon is allowed for the specific template.

    const { data, error } = await supabase.functions.invoke('send-email', {
      body: { to, templateId, variables },
      headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
    });

    if (error) {
      console.error('[email] Edge Function error:', error.message);
      return { success: false, error: error.message };
    }

    return { success: true, data };
  } catch (err) {
    console.error('[email] Send failed:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Send an invite email with a magic login link.
 */
export async function sendInviteEmail(recipientEmail, recipientName, magicLink) {
  return sendEmail({
    to: recipientEmail,
    templateId: 'generic_internal_notification',
    variables: {
      subject: "You're invited to ProForma OS",
      message: `Hi ${recipientName || 'there'},<br/><br/>Your access to ProForma OS has been approved. <a href="${magicLink || '#'}">Click here to sign in</a>.`
    }
  });
}

/**
 * Send a notification to the admin about a new access request.
 */
export async function sendAdminNotification(adminEmail, request) {
  return sendEmail({
    to: adminEmail,
    templateId: 'request_access_admin_notification',
    variables: {
      name: request.full_name,
      email: request.email,
      company: request.company_name,
      role: request.role || 'Not specified'
    }
  });
}

export default { sendInviteEmail, sendAdminNotification };
