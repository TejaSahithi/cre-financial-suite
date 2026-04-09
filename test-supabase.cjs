const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = "https://cjwdwuqqdokblakheyjb.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqd2R3dXFxZG9rYmxha2hleWpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTgyNjEsImV4cCI6MjA4OTU5NDI2MX0.zBHQJPHcm4OCZPgQRvJleiXKcu5iKgUOyo1HKqMu0OQ";

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
