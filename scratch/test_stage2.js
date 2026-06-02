const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
require('dotenv').config({ path: '.env.local' });
if (!process.env.VITE_SUPABASE_URL) {
    require('dotenv').config({ path: '.env' });
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const adminAuth = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function run() {
  console.log("=== Setting up test user and org ===");
  const email = 'e2e_billing_' + Date.now() + '@example.com';
  const password = 'TempPassword123!';
  
  const { data: userRes, error: userErr } = await adminAuth.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr) throw userErr;
  const user = userRes.user;
  
  const orgId = "org_test_" + Date.now();
  const { error: orgErr } = await adminAuth.from('organizations').insert({
    id: orgId,
    name: 'Test Webhook Org',
    status: 'onboarding',
    plan: 'professional',
    billing_cycle: 'monthly'
  });
  if (orgErr) throw orgErr;

  await adminAuth.from('organization_members').insert({
    org_id: orgId,
    user_id: user.id,
    role: 'org_admin'
  });

  const { data: sessionData, error: loginErr } = await supabase.auth.signInWithPassword({ email, password });
  if (loginErr) throw loginErr;
  const token = sessionData.session.access_token;
  
  const callFunc = async (name, payload, jwt) => {
    const headers = { 'Content-Type': 'application/json' };
    if (jwt) headers['Authorization'] = Bearer  + jwt;
    const res = await fetch(SUPABASE_URL + '/functions/v1/' + name, {
      method: 'POST',
      headers,
      body: payload ? JSON.stringify(payload) : undefined
    });
    return { status: res.status, body: await res.json().catch(()=>({})) };
  };

  console.log("\n=== 3. complete-onboarding disabled ===");
  const res3 = await callFunc('complete-onboarding', {}, token);
  console.log("Status:", res3.status);
  console.log("Body:", res3.body);

  console.log("\n=== 4. Unknown plan rejected ===");
  const res4 = await callFunc('create-checkout-session', { planKey: "fake_plan", billingCycle: "monthly", orgId }, token);
  console.log("Status:", res4.status);
  console.log("Body:", res4.body);

  console.log("\n=== 5. No-JWT checkout rejected ===");
  const res5 = await callFunc('create-checkout-session', { planKey: "professional", billingCycle: "monthly", orgId }, null);
  console.log("Status:", res5.status);
  console.log("Body:", res5.body);

  console.log("\n=== 6. Valid checkout session ===");
  const res6 = await callFunc('create-checkout-session', { planKey: "professional", billingCycle: "monthly", orgId }, token);
  console.log("Status:", res6.status);
  console.log("Body:", res6.body);
  if (res6.body.url) {
    console.log("Got checkout URL:", res6.body.url.startsWith('https://checkout.stripe.com') ? "Yes" : "No");
  }

  console.log("\n=== 8 & 9. Webhook result & replay ===");
  if (!STRIPE_SECRET || !STRIPE_WEBHOOK_SECRET) {
      console.log("Skipping webhook tests: missing STRIPE_SECRET or STRIPE_WEBHOOK_SECRET");
  } else {
      const stripe = require('stripe')(STRIPE_SECRET);
      
      const payload = {
        id: "evt_test_" + Date.now(),
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_" + Date.now(),
            amount_total: 59900,
            currency: "usd",
            customer: "cus_test_" + Date.now(),
            payment_intent: "pi_test_" + Date.now(),
            metadata: {
              org_id: orgId,
              user_id: user.id,
              plan_key: "professional",
              billing_cycle: "monthly"
            }
          }
        }
      };

      const payloadString = JSON.stringify(payload);
      const signature = stripe.webhooks.generateTestHeaderString({
        payload: payloadString,
        secret: STRIPE_WEBHOOK_SECRET,
      });

      const sendWebhook = async () => {
        const res = await fetch(SUPABASE_URL + '/functions/v1/stripe-webhook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
          body: payloadString
        });
        return res;
      };

      console.log("Sending initial webhook...");
      const wh1 = await sendWebhook();
      console.log("Webhook 1 Status:", wh1.status, await wh1.text());

      console.log("Sending duplicate webhook...");
      const wh2 = await sendWebhook();
      console.log("Webhook 2 Status:", wh2.status, await wh2.text());

      // Check DB
      console.log("Checking DB state...");
      const { data: inv } = await adminAuth.from('invoices').select('*').eq('stripe_session_id', payload.data.object.id).single();
      console.log("Invoice row count:", inv ? 1 : 0);
      if (inv) {
        console.log("Invoice amount:", inv.amount);
        console.log("Invoice status:", inv.status);
      }
      
      const { data: org } = await adminAuth.from('organizations').select('status').eq('id', orgId).single();
      console.log("Org status:", org.status);

      const { data: p } = await adminAuth.from('profiles').select('status').eq('id', user.id).single();
      console.log("Profile status:", p.status);
      
      const { count: evtCount } = await adminAuth.from('stripe_events').select('*', { count: 'exact' }).eq('stripe_event_id', payload.id);
      console.log("Stripe event row count:", evtCount);
  }

  console.log("\n=== 10. RLS spoofing tests ===");
  // Use the normal logged in client to try to spoof RLS
  const { error: rls1 } = await supabase.from('invoices').insert({ org_id: orgId, amount: 100, status: 'paid' });
  console.log("RLS Insert invoice:", rls1 ? "Blocked" : "Allowed");

  const { error: rls2 } = await supabase.from('organizations').update({ status: 'active' }).eq('id', orgId);
  console.log("RLS Update org status:", rls2 ? "Blocked" : "Allowed");
  
  process.exit(0);
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
