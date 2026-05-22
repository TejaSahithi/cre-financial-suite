import { leaseRulePipelineService } from "@/services/leaseRulePipelineService";

async function run() {
  console.log("Testing Summit...");
  await leaseRulePipelineService.generateLeaseExpenseRulesForLease({
    leaseId: "310ab875-f516-4a2b-94d9-686cf4b87d90",
    force: true,
    source: "manual_test"
  });

  console.log("\nTesting Assignment (Narendra)...");
  await leaseRulePipelineService.generateLeaseExpenseRulesForLease({
    leaseId: "1928ef1b-5072-4f64-b5b8-44aecc1798dd",
    force: true,
    source: "manual_test"
  });
}

run().catch(console.error);
