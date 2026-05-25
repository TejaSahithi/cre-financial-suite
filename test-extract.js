import fs from 'fs';
import path from 'path';

const envLocal = fs.readFileSync(path.resolve('.env'), 'utf-8');
for (const line of envLocal.split('\n')) {
  const [key, ...values] = line.split('=');
  if (key && values.length > 0) {
    process.env[key.trim()] = values.join('=').trim().replace(/^['"]|['"]$/g, '');
  }
}

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data: leases } = await supabase.from('leases').select('id, name, tenant_name, extracted_text');
  
  if (!leases || leases.length === 0) {
    console.log("No leases found.");
    return;
  }
  
  const lease = leases.find(l => (l.name || '').toLowerCase().includes('mindful') || (l.tenant_name || '').toLowerCase().includes('mindful'));
  
  if (!lease) {
    console.log("Mindful not found. Available leases:", leases.map(l => l.name || l.tenant_name));
    return;
  }
  
  console.log("Found lease:", lease.name || lease.tenant_name, lease.id);
  
  if (!lease.extracted_text) {
    console.log("Lease has no extracted text!");
    return;
  }
  
  const { data: llmData, error: llmErr } = await supabase.functions.invoke("extract-lease-expense-rules", { body: { text: lease.extracted_text.substring(0, 15000) } });
  
  console.log("LLM Error:", llmErr);
  console.log("LLM Data:", JSON.stringify(llmData, null, 2));
}

run();
