import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Stripe from 'https://esm.sh/stripe@14.10.0?target=deno';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // 1. Verify caller
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', details: authError?.message }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const bodyData = await req.json().catch(() => ({}));
    const { planKey, billingCycle, orgId } = bodyData;

    if (!planKey || !billingCycle || !orgId) {
      return new Response(JSON.stringify({ error: 'Missing planKey, billingCycle, or orgId' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. Validate membership
    const { data: memberships, error: memError } = await supabaseAdmin
      .from('memberships')
      .select('role')
      .eq('user_id', user.id)
      .eq('org_id', orgId);

    if (memError || !memberships || memberships.length === 0) {
      return new Response(JSON.stringify({ error: 'Forbidden: You are not a member of this organization' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const role = memberships[0].role;
    if (role !== 'org_admin' && role !== 'super_admin' && role !== 'owner') {
      return new Response(JSON.stringify({ error: 'Forbidden: Must be org_admin or owner to initiate payment' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 3. Validate org state
    const { data: orgData, error: orgError } = await supabaseAdmin
      .from('organizations')
      .select('status')
      .eq('id', orgId)
      .single();

    if (orgError || !orgData) {
      return new Response(JSON.stringify({ error: 'Organization not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (orgData.status === 'active') {
      return new Response(JSON.stringify({ error: 'Organization is already active' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 4. Map planKey + billingCycle to Stripe Price ID
    const planUpper = String(planKey).toUpperCase();
    const cycleUpper = String(billingCycle).toUpperCase();
    const priceSecretName = `STRIPE_PRICE_${planUpper}_${cycleUpper}`;
    const priceId = Deno.env.get(priceSecretName);

    if (!priceId) {
      console.error(`[create-checkout-session] Unknown or unconfigured price mapping: ${priceSecretName}`);
      return new Response(JSON.stringify({ error: 'Invalid plan or billing cycle' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeSecretKey) {
      throw new Error('Missing STRIPE_SECRET_KEY');
    }

    const frontendUrl = Deno.env.get('FRONTEND_URL') || 'https://cre-financial-suite-n9be.vercel.app';
    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    });

    // 5. Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${frontendUrl}/PaymentSuccess?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/Onboarding?step=3`,
      metadata: {
        user_id: user.id,
        org_id: orgId,
        plan_key: planKey,
        billing_cycle: billingCycle,
      },
      customer_email: user.email,
    });

    // 6. Audit Log
    const { error: auditErr } = await supabaseAdmin.from('audit_logs').insert({
      org_id: orgId,
      actor_user_id: user.id,
      actor_email: user.email,
      actor_role: role,
      entity_type: 'CheckoutSession',
      entity_id: session.id,
      action: 'create',
      source: 'edge_function',
      severity: 'info'
    });
    if (auditErr) {
      console.error('[create-checkout-session] Audit log failed:', auditErr);
      throw new Error(`Audit log failed: ${auditErr.message}`);
    }

    return new Response(JSON.stringify({ url: session.url, sessionId: session.id }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[create-checkout-session] Internal error:', error);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
