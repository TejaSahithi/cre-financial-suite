import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config({ path: '.env.local' });

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data, error } = await supabase.from('leases').select('extraction_data').eq('id', '1928ef1b-5072-4f64-b5b8-44aecc1798dd').single();
  if (error) console.error(error);
  else {
    fs.writeFileSync('extraction_data.json', JSON.stringify(data.extraction_data, null, 2));
  }
}
run();
