import { supabase } from './src/lib/supabase.js'; 

async function x() { 
  const {data, error} = await supabase.from('leases').select('id, name, abstract_status').eq('id', '310ab875-f516-4a2b-94d9-686cf4b87d90'); 
  console.log('leases:', {data, error}); 

  const {data: ad, error: ae} = await supabase.from('approved_lease_abstracts').select('id, abstract_status').eq('id', '310ab875-f516-4a2b-94d9-686cf4b87d90');
  console.log('approved_lease_abstracts:', {data: ad, error: ae});
} 
x();
