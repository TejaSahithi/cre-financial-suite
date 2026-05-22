import { supabase } from "./src/services/supabaseClient.js";

async function checkCols() {
  const { data, error } = await supabase.from('expense_classifications').select('*').limit(1);
  if (error) {
    console.error(error);
  } else if (data.length > 0) {
    console.log(Object.keys(data[0]));
  } else {
    // Insert a dummy record or get column info via an OPTIONS request?
    // Let's just do a query that fails intentionally on the column
    const { error: e2 } = await supabase.from('expense_classifications').select('manual_override').limit(1);
    console.log("Check manual_override:", e2);
  }
}

checkCols();
