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
async function sendEmail({ to, subject, html }) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
      console.warn('[email] No active session — cannot send email');
      return { success: false, error: 'Not authenticated' };
    }

    const { data, error } = await supabase.functions.invoke('send-email', {
      body: { to, subject, html },
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
    subject: "You're invited to CRE Suite",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <div style="display: inline-block; background: #1a2744; border-radius: 12px; padding: 12px;">
            <span style="color: white; font-size: 18px; font-weight: bold;">CRE Suite</span>
          </div>
        </div>
        <h1 style="color: #1a2744; font-size: 24px; margin-bottom: 8px;">Welcome to CRE Suite</h1>
        <p style="color: #64748b; font-size: 14px; line-height: 1.6;">
          Hi ${recipientName || 'there'},<br/><br/>
          Your access to CRE Suite has been approved! Click the button below to sign in and get started.
        </p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${magicLink || '#'}" style="display: inline-block; background: #1a2744; color: white; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px;">
            Sign In to CRE Suite
          </a>
        </div>
        <p style="color: #94a3b8; font-size: 12px;">
          If you didn't request access, you can safely ignore this email.
        </p>
      </div>
    `,
  });
}

/**
 * Send a notification to the admin about a new access request.
 */
export async function sendAdminNotification(adminEmail, request) {
  return sendEmail({
    to: adminEmail,
    subject: `New Access Request: ${request.full_name} (${request.company_name})`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #1a2744;">New Access Request</h2>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr><td style="padding: 8px 0; color: #64748b; font-size: 13px;">Name</td><td style="padding: 8px 0; font-weight: 600;">${request.full_name}</td></tr>
          <tr><td style="padding: 8px 0; color: #64748b; font-size: 13px;">Email</td><td style="padding: 8px 0;">${request.email}</td></tr>
          <tr><td style="padding: 8px 0; color: #64748b; font-size: 13px;">Company</td><td style="padding: 8px 0;">${request.company_name}</td></tr>
          <tr><td style="padding: 8px 0; color: #64748b; font-size: 13px;">Role</td><td style="padding: 8px 0;">${request.role || 'Not specified'}</td></tr>
          <tr><td style="padding: 8px 0; color: #64748b; font-size: 13px;">Properties</td><td style="padding: 8px 0;">${request.property_count || 'Not specified'}</td></tr>
        </table>
        <p style="color: #64748b; font-size: 13px;">Review this request in your SuperAdmin Dashboard.</p>
      </div>
    `,
  });
}

export default { sendInviteEmail, sendAdminNotification };
