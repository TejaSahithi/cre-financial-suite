import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Stripe from 'https://esm.sh/stripe@14.10.0?target=deno';

const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
const stripeWebhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');

const stripe = stripeSecretKey ? new Stripe(stripeSecretKey, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
}) : null;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok');
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  let event;

  try {
    if (!stripe || !stripeWebhookSecret) {
      console.error('[stripe-webhook] Missing Stripe keys or webhook secret');
      return new Response('Stripe not configured', { status: 500 });
    }

    const signature = req.headers.get('Stripe-Signature');
    if (!signature) {
      console.warn('[stripe-webhook] Missing Stripe-Signature header');
      return new Response('Missing signature', { status: 400 });
    }

    const bodyText = await req.text();
    try {
      event = await stripe.webhooks.constructEventAsync(bodyText, signature, stripeWebhookSecret);
    } catch (err: any) {
      console.error(`[stripe-webhook] Webhook signature verification failed. Message: ${err.message}`);
      const { error: auditErr } = await supabaseAdmin.from('audit_logs').insert({
        entity_type: 'StripeWebhook',
        action: 'verify_failed',
        severity: 'error',
        source: 'webhook',
        error_message: 'Signature verification failed',
      });
      if (auditErr) console.error('[stripe-webhook] Failed to write audit log:', auditErr);
      return new Response(`Webhook Error: Invalid signature`, { status: 400 });
    }

    // Attempt Idempotency
    const { data: existingEvent, error: findErr } = await supabaseAdmin
      .from('stripe_events')
      .select('processing_status')
      .eq('stripe_event_id', event.id)
      .maybeSingle();

    if (existingEvent) {
      if (existingEvent.processing_status === 'processed') {
        console.log(`[stripe-webhook] Event ${event.id} already processed`);
        const { error: auditErr } = await supabaseAdmin.from('audit_logs').insert({
          entity_type: 'StripeWebhook',
          entity_id: event.id,
          action: 'duplicate_event',
          source: 'webhook',
          severity: 'warning'
        });
        if (auditErr) console.error('[stripe-webhook] Failed to write audit log:', auditErr);
        return new Response('Already processed', { status: 200 });
      }
    } else {
      // Insert new event marker
      const { error: insertErr } = await supabaseAdmin
        .from('stripe_events')
        .insert({
          stripe_event_id: event.id,
          event_type: event.type,
          processing_status: 'processing'
        });
      
      if (insertErr) {
        // If concurrent webhook replay inserted it first
        if (insertErr.code === '23505') {
           return new Response('Already processing', { status: 200 });
        }
        console.error('[stripe-webhook] Failed to insert event marker:', insertErr);
        return new Response('Internal error', { status: 500 });
      }
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as any;
      const metadata = session.metadata || {};
      
      const orgId = metadata.org_id;
      const userId = metadata.user_id;

      if (!orgId) {
        throw new Error('Missing org_id in session metadata');
      }

      // Insert invoice
      const invoiceData = {
        org_id: orgId,
        amount: session.amount_total / 100, // Amount is in cents
        status: 'paid',
        issued_date: new Date().toISOString().split('T')[0],
        stripe_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent,
        stripe_event_id: event.id,
        paid_at: new Date().toISOString(),
      };

      const { error: invoiceError } = await supabaseAdmin
        .from('invoices')
        .insert(invoiceData);
      
      if (invoiceError && invoiceError.code !== '23505') { // Ignore duplicate key if somehow replayed
        throw new Error(`Failed to insert invoice: ${invoiceError.message}`);
      }

      // Update Org to under_review
      const orgUpdate: any = {
        status: 'under_review',
        plan: metadata.plan_key || null,
        billing_cycle: metadata.billing_cycle || null,
        updated_at: new Date().toISOString(),
      };
      
      if (session.customer) {
        orgUpdate.stripe_customer_id = typeof session.customer === 'string' ? session.customer : session.customer.id;
      }
      if (session.subscription) {
        orgUpdate.stripe_sub_id = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
      }

      const { error: orgError } = await supabaseAdmin
        .from('organizations')
        .update(orgUpdate)
        .eq('id', orgId);
      
      if (orgError) {
        throw new Error(`Failed to update org: ${orgError.message}`);
      }

      // Update profile to under_review
      if (userId) {
        await supabaseAdmin
          .from('profiles')
          .update({ status: 'under_review', updated_at: new Date().toISOString() })
          .eq('id', userId);
      }

      // Audit Log Success
      const { error: auditErr } = await supabaseAdmin.from('audit_logs').insert({
        org_id: orgId,
        actor_user_id: userId || null,
        entity_type: 'StripeWebhook',
        entity_id: event.id,
        action: 'checkout_completed_processed',
        source: 'webhook',
        severity: 'info'
      });
      if (auditErr) {
        throw new Error(`Failed to write audit log: ${auditErr.message}`);
      }
    }

    // Mark event processed
    await supabaseAdmin
      .from('stripe_events')
      .update({ processing_status: 'processed', processed_at: new Date().toISOString() })
      .eq('stripe_event_id', event.id);

    return new Response('Webhook received and processed', { status: 200 });

  } catch (err: any) {
    console.error(`[stripe-webhook] Error processing event:`, err.message);
    
    if (event && event.id) {
      const { error: updateErr } = await supabaseAdmin
        .from('stripe_events')
        .update({ processing_status: 'failed', error_message: err.message })
        .eq('stripe_event_id', event.id);
      if (updateErr) console.error('[stripe-webhook] update failed:', updateErr);
        
      const { error: auditErr } = await supabaseAdmin.from('audit_logs').insert({
        entity_type: 'StripeWebhook',
        entity_id: event.id,
        action: 'processing_failed',
        error_message: err.message,
        source: 'webhook',
        severity: 'error'
      });
      if (auditErr) console.error('[stripe-webhook] Failed to write audit log:', auditErr);
    }
    
    return new Response(`Internal Server Error`, { status: 500 });
  }
});
