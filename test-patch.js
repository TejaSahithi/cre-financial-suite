import fs from 'fs';
import path from 'path';

const envLocal = fs.readFileSync(path.resolve('.env'), 'utf-8');
const env = {};
for (const line of envLocal.split('\n')) {
  const [key, ...values] = line.split('=');
  if (key && values.length > 0) {
    env[key.trim()] = values.join('=').trim().replace(/^['"]|['"]$/g, '');
  }
}

async function run() {
  const url = `${env.VITE_SUPABASE_URL}/rest/v1/audit_logs`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': env.VITE_SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${env.VITE_SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({
      entity_type: "expenses",
      entity_id: "3639257c-9ee2-4a9f-9a4c-d135dd7013d7",
      action: "update",
      org_id: "7d16919f-6587-4fbc-b21f-e27e15a752ee"
    })
  });
  
  const text = await res.text();
  console.log('POST audit_logs status:', res.status);
  console.log('POST audit_logs result:', text);
}

run();
