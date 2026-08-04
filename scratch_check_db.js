const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// Read .env or .env.local
let supabaseUrl = "https://cjdwuqqdokblakheyjb.supabase.co";
let supabaseAnonKey = "";

try {
  const envText = fs.readFileSync('.env', 'utf8');
  for (const line of envText.split('\n')) {
    if (line.startsWith('VITE_SUPABASE_URL=')) supabaseUrl = line.split('=')[1].trim();
    if (line.startsWith('VITE_SUPABASE_ANON_KEY=')) supabaseAnonKey = line.split('=')[1].trim();
  }
} catch (e) {}

console.log("Supabase URL:", supabaseUrl);
console.log("Anon Key present:", Boolean(supabaseAnonKey));

const client = createClient(supabaseUrl, supabaseAnonKey);

async function checkData() {
  console.log("\n--- Checking Properties ---");
  const { data: props, error: propsErr } = await client.from("properties").select("id, name, org_id");
  console.log("Properties error:", propsErr);
  console.log("Properties count:", props?.length, "Rows:", props);

  console.log("\n--- Checking Leases ---");
  const { data: leases, error: leasesErr } = await client.from("leases").select("id, tenant_name, property_id, org_id");
  console.log("Leases error:", leasesErr);
  console.log("Leases count:", leases?.length, "Sample:", leases?.slice(0, 5));

  console.log("\n--- Checking Expenses ---");
  const { data: exp, error: expErr } = await client.from("expenses").select("id, amount, property_id, org_id");
  console.log("Expenses error:", expErr);
  console.log("Expenses count:", exp?.length, "Sample:", exp?.slice(0, 5));

  console.log("\n--- Checking Recovery Calendars ---");
  const { data: cals, error: calErr } = await client.from("recovery_calendars").select("*");
  console.log("Calendars error:", calErr);
  console.log("Calendars count:", cals?.length, "Rows:", cals);

  console.log("\n--- Checking Recovery Pools ---");
  const { data: pools, error: poolErr } = await client.from("recovery_pools").select("*");
  console.log("Pools error:", poolErr);
  console.log("Pools count:", pools?.length, "Rows:", pools);

  console.log("\n--- Checking CAM Runs ---");
  const { data: runs, error: runErr } = await client.from("cam_runs").select("*");
  console.log("CAM Runs error:", runErr);
  console.log("CAM Runs count:", runs?.length, "Rows:", runs);

  console.log("\n--- Checking CAM Expense Inputs ---");
  const { data: inputs, error: inputErr } = await client.from("cam_expense_inputs").select("*");
  console.log("CAM Expense Inputs error:", inputErr);
  console.log("CAM Expense Inputs count:", inputs?.length, "Sample:", inputs?.slice(0, 5));
}

checkData();
