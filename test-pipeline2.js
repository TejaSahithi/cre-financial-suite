import { leaseRulePipelineService } from "./src/services/leaseRulePipelineService.js";

async function run() {
  console.log("Running pipeline for Summit...");
  try {
    const result = await leaseRulePipelineService.generateLeaseExpenseRulesForLease({
      leaseId: "310ab875-f516-4a2b-94d9-686cf4b87d90",
      force: true,
      source: "manual_extract"
    });
    console.log("Result:", result);
  } catch (err) {
    console.error("Pipeline crashed:", err);
  }
}

run();
