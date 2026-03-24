const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/VITE_SUPABASE_URL=(.*)/)[1].trim();
const key = env.match(/VITE_SUPABASE_SERVICE_ROLE_KEY=(.*)/)[1].trim();

const email = 'e2e_pass_test_' + Date.now() + '@example.com';

fetch(url + '/auth/v1/admin/users', {
  method: 'POST',
  headers: {
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    email,
    password: 'TempPassword123!',
    email_confirm: true,
    user_metadata: {
      full_name: 'Test Auto',
      role: 'org_admin',
      onboarding_type: 'owner'
    }
  })
}).then(res => res.json()).then(data => {
  if (data.id) console.log('TEST_EMAIL=' + email);
  else console.log('Error:', data);
}).catch(console.error);
