import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, line) => {
  const [key, ...val] = line.split('=');
  if (key) acc[key.trim()] = val.join('=').trim();
  return acc;
}, {});

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

async function check() {
  const { data: leases } = await supabase.from('leases').select('id, tenant_name, abstract_status, status');
  console.log('All Leases:', leases.map(l => l.tenant_name));
  
  const mindful = leases.find(l => String(l.tenant_name).toLowerCase().includes('mindful'));
  if (mindful) {
      console.log('Found Mindful:', mindful);
      const { data: rules } = await supabase.from('lease_expense_rules').select('*').eq('lease_id', mindful.id);
      console.log('Rules Count in DB:', rules?.length);
      
      const { data: lease } = await supabase.from('leases').select('*').eq('id', mindful.id).single();
      console.log('Extraction Data Keys:', Object.keys(lease.extraction_data || {}));
      if (lease.extraction_data) {
          console.log('Workflow Output Rules:', lease.extraction_data.workflow_output?.expense_rules?.length);
          console.log('Fallback Rules array?', lease.extraction_data.rules?.length);
      }
  } else {
      console.log('No mindful found');
  }
}

check();
