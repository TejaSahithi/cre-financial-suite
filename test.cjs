const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
const env = {};
envFile.split('\n').forEach(line => {
  const match = line.match(/^([^#=]+)=(.+)$/);
  if (match) env[match[1].trim()] = match[2].trim();
});

const SUPABASE_URL = env.VITE_SUPABASE_URL || "https://cjwdwuqqdokblakheyjb.supabase.co";
const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function testInsert() {
  console.log("Testing insert...");
  // Use same data as from browser subagent
  const payload = {
    date: '2026-04-09',
    amount: 50,
    category: 'janitorial',
    description: 'Test Office Supplies',
    source: 'manual',
    fiscal_year: 2026,
    org_id: 'e3a04c72-c7ff-494f-92dc-0d5fc16939e8' // Use a typical org ID
  };
  
  const { data, error } = await supabase.from('expenses').insert(payload).select();
  if (error) {
    console.error("ERROR from Supabase:", JSON.stringify(error, null, 2));
  } else {
    console.log("SUCCESS:", data);
  }
}

testInsert().catch(console.error);
