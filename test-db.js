import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = fs.readFileSync('.env', 'utf-8').split('\n').reduce((acc, line) => {
  const [key, val] = line.split('=');
  if (key && val) acc[key.trim()] = val.trim();
  return acc;
}, {});

const supabaseUrl = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const { data, error } = await supabase.from('leases').select('*, unit:units!leases_unit_id_fkey(*), property:properties(*), building:buildings(*)').eq('id', '310ab875-f516-4a2b-94d9-686cf4b87d90').single();
  if (error) {
    console.error("ERROR FROM SUPABASE:", error);
  } else {
    console.log("SUCCESS");
  }
  if (error) {
    console.error(error);
    return;
  }
  console.log(JSON.stringify(Object.keys(data.extraction_data || {}), null, 2));
  
  if (data.extraction_data.fields) {
    console.log("FIELDS:", Object.keys(data.extraction_data.fields));
  }
  if (data.extraction_data.expenses) {
    console.log("EXPENSES:", data.extraction_data.expenses.length);
  } else {
    console.log("NO EXPENSES ARRAY");
  }
}
main();
