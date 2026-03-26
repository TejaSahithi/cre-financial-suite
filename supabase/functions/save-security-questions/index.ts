// @ts-nocheck
// @ts-ignore
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
// @ts-ignore
import * as bcrypt from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('FRONTEND_URL') || 'http://localhost:5173',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// @ts-ignore
Deno.serve(async (req: any) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization') || req.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No Authorization header' }), { 
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    const supabaseClient = createClient(
      // @ts-ignore
      Deno.env.get('SUPABASE_URL') ?? '',
      // @ts-ignore
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    // 1. Verify caller
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      console.error('[save-security-questions] Auth Error:', authError?.message);
      return new Response(JSON.stringify({ error: 'Unauthorized', details: authError?.message }), { 
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    const body = await req.json();
    const { q1, a1, q2, a2, q3, a3 } = body;
    console.log('[save-security-questions] Received payload for user:', user.id);

    if (!q1 || !a1 || !q2 || !a2 || !q3 || !a3) {
      console.error('[save-security-questions] Missing fields');
      return new Response(JSON.stringify({ error: 'All 3 questions and answers are required.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Process answers: lowercase and trim for reliable hashing and future verification
    const normalize = (str: string) => str.toLowerCase().trim();

    // 2. Hash answers using bcrypt
    console.log('[save-security-questions] Hashing answers...');
    const salt = await bcrypt.genSalt(10);
    const hash1 = await bcrypt.hash(normalize(a1), salt);
    const hash2 = await bcrypt.hash(normalize(a2), salt);
    const hash3 = await bcrypt.hash(normalize(a3), salt);

    // We use a Service Role client to bypass RLS for inserting and updating the profile safely
    const supabaseAdmin = createClient(
      // @ts-ignore
      Deno.env.get('SUPABASE_URL') ?? '',
      // @ts-ignore
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // 3. Upsert into security_questions table
    console.log('[save-security-questions] Upserting security_questions...');
    const { error: insertError } = await supabaseAdmin
      .from('security_questions')
      .upsert({
        user_id: user.id,
        question_1: q1,
        answer_1_hash: hash1,
        question_2: q2,
        answer_2_hash: hash2,
        question_3: q3,
        answer_3_hash: hash3
      }, { onConflict: 'user_id' });

    if (insertError) {
      console.error('[save-security-questions] Insert Error:', insertError);
      throw insertError;
    }

    // 4. Update profile completion flag
    console.log('[save-security-questions] Updating profile...');
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .update({ security_questions_setup: true })
      .eq('id', user.id);

    if (profileError) {
      console.error('[save-security-questions] Profile Update Error:', profileError);
      throw profileError;
    }

    console.log('[save-security-questions] Success!');
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

