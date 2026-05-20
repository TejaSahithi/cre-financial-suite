import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'http://127.0.0.1:54321';
const supabaseKey = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  console.log("Logging in...");
  const { data, error } = await supabase.auth.signInWithPassword({
    email: 'chtsahithi01@gmail.com',
    password: 'Sahithi@1234'
  });

  if (error) {
    console.error("Login Error:", error.message);
    return;
  }

  console.log("Logged in successfully! User:", data.user.id);
  
  if (data.mfa && data.mfa.amr && data.mfa.amr.length === 0) {
     console.log("MFA required?");
  }

  console.log("Fetching leases...");
  const { data: leases, error: leasesError } = await supabase.from('leases').select('*').limit(1);
  if (leasesError) {
    console.error("Error fetching leases:", leasesError);
  } else {
    console.log("Leases fetched:", leases.length);
  }

  // Simulate Expense Classification queries
  console.log("Fetching expense categories...");
  const { data: categories, error: categoriesError } = await supabase.from('expense_categories').select('*').limit(1);
  if (categoriesError) {
    console.error("Error fetching expense_categories:", categoriesError.message || categoriesError);
  } else {
    console.log("Categories fetched:", categories.length);
  }

  console.log("Fetching expense classifications...");
  const { data: classifications, error: classificationsError } = await supabase.from('expense_classifications').select('*').limit(1);
  if (classificationsError) {
    console.error("Error fetching expense_classifications:", classificationsError.message || classificationsError);
  } else {
    console.log("Classifications fetched:", classifications?.length);
  }

}

run().catch(console.error);
