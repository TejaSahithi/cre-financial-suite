const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

let supabaseUrl = "https://cjdwuqqdokblakheyjb.supabase.co";
let supabaseAnonKey = "";

try {
  const envText = fs.readFileSync('.env', 'utf8');
  for (const line of envText.split('\n')) {
    if (line.startsWith('VITE_SUPABASE_ANON_KEY=')) supabaseAnonKey = line.split('=')[1].trim();
  }
} catch (e) {}

console.log("Supabase URL:", supabaseUrl);
console.log("Anon Key present:", Boolean(supabaseAnonKey));

const client = createClient(supabaseUrl, supabaseAnonKey);

async function checkData() {
  console.log("\n--- Checking Properties ---");
  const { data: props, error: propsErr } = await client.from("properties").select("id, name, org_id");
  console.log("Properties count:", props?.length, "Rows:", props, "Error:", propsErr);

  console.log("\n--- Checking Leases ---");
  const { data: leases, error: leasesErr } = await client.from("leases").select("id, tenant_name, property_id, org_id");
  console.log("Leases count:", leases?.length, "Sample:", leases?.slice(0, 5), "Error:", leasesErr);

  console.log("\n--- Checking Expenses ---");
  const { data: exp, error: expErr } = await client.from("expenses").select("id, amount, property_id, org_id");
  console.log("Expenses count:", exp?.length, "Sample:", exp?.slice(0, 5), "Error:", expErr);

  console.log("\n--- Checking Recovery Calendars ---");
  const { data: cals, error: calErr } = await client.from("recovery_calendars").select("*");
  console.log("Calendars count:", cals?.length, "Rows:", cals, "Error:", calErr);

  console.log("\n--- Checking Recovery Pools ---");
  const { data: pools, error: poolErr } = await client.from("recovery_pools").select("*");
  console.log("Pools count:", pools?.length, "Rows:", pools, "Error:", poolErr);

  console.log("\n--- Checking CAM Runs ---");
  const { data: runs, error: runErr } = await client.from("cam_runs").select("*");
  console.log("CAM Runs count:", runs?.length, "Rows:", runs, "Error:", runErr);

  console.log("\n--- Checking CAM Expense Inputs ---");
  const { data: inputs, error: inputErr } = await client.from("cam_expense_inputs").select("*");
  console.log("CAM Expense Inputs count:", inputs?.length, "Sample:", inputs?.slice(0, 5), "Error:", inputErr);

  console.log("\n--- Checking Memberships ---");
  const { data: mems, error: memErr } = await client.from("memberships").select("*");
  console.log("Memberships count:", mems?.length, "Rows:", mems, "Error:", memErr);
}

checkData();
