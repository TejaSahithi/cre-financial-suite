import { supabase } from './src/config/supabaseClient';
import { expenseService } from './src/services/expenseService';

async function runTest() {
  console.log("Fetching test lease...");
  const { data: leases } = await supabase.from('leases').select('id, org_id').not('property_id', 'is', null).limit(1);
  const lease = leases[0];
  
  if (!lease) {
    console.error("No test lease found");
    return;
  }
  
  const scope = { lease_id: lease.id, org_id: lease.org_id };
  
  console.log("Running classification logic...");
  try {
    const result = await expenseService.classifyExpenses(scope);
    console.log("Classification Result:", JSON.stringify(result, null, 2));
    
    // Fetch classifications
    const { data: classRows } = await supabase
      .from('expense_classifications')
      .select('category, amount, row_type, classification_status, recovery_status, cam_eligible')
      .eq('lease_id', lease.id);
      
    console.log("\nDatabase Classifications after Run:");
    console.log(JSON.stringify(classRows, null, 2));

    // Finalize Insurance and Tenant Damage
    console.log("\nFinalizing Insurance and Tenant Damage...");
    for (const row of classRows) {
        if (row.category === 'insurance' || row.category === 'general_repairs') {
            await supabase
              .from('expense_classifications')
              .update({ classification_status: 'finalized' })
              .eq('lease_id', lease.id)
              .eq('category', row.category);
        }
    }

    const { data: finalRows } = await supabase
      .from('expense_classifications')
      .select('category, amount, classification_status, recovery_status, cam_eligible')
      .eq('lease_id', lease.id)
      .eq('classification_status', 'finalized');
      
    console.log("\nFinalized Rows (Projection):");
    console.log(JSON.stringify(finalRows, null, 2));
    
    console.log("\nTesting CAM Eligibility:");
    const camEligibleRows = finalRows.filter(r => r.recovery_status === 'recoverable' && r.cam_eligible === 'yes');
    console.log(JSON.stringify(camEligibleRows, null, 2));
    
  } catch (err) {
    console.error("Test failed", err);
  }
}

runTest();
