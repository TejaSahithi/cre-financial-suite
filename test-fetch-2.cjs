const fs = require('fs');
const env = fs.readFileSync('.env', 'utf-8');
const urlMatch = env.match(/VITE_SUPABASE_URL=(.*)/);
const keyMatch = env.match(/VITE_SUPABASE_ANON_KEY=(.*)/);
const url = urlMatch[1].trim();
const key = keyMatch[1].trim();

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const queryUrl = `${url}/rest/v1/expense_classifications?select=id,org_id,expense_id,lease_expense_rule_id,property_id,building_id,unit_id,lease_id,tenant_id,category,subcategory,amount,service_period_start,service_period_end,cam_eligible,recovery_method,recovery_reason,recoverability_result,recovery_status,exception_type,classification_status,row_type,classification_key,recoverable_amount,non_recoverable_amount,conditional_amount,excluded_amount,sent_to_cam,finalized_at,reviewed_at,approved_status&expense_id=in.(f47ac10b-58cc-4372-a567-0e02b2c3d479)`;

global.fetch(queryUrl, {
  headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
}).then(res => res.json().then(data => console.log(res.status, data)));
