// @ts-nocheck
// Phase 9 pure tests for v3 profile ensemble and diagnostic extraction planner.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildExtractionPlan, buildProfileEnsemble } from "../_shared/extraction/document-intelligence-v3/profile-planner.ts";

function moduleKeys(plan: any, side: "run" | "skip" = "run") {
  return (side === "run" ? plan.modules_to_run : plan.modules_skipped).map((m: any) => m.module_key);
}

Deno.test("profile planner: base_lease produces base lease module plan", () => {
  const plan = buildExtractionPlan("base_lease");
  const keys = moduleKeys(plan);
  for (const expected of [
    "rent_and_charges",
    "expense_recovery",
    "cam_rules",
    "taxes",
    "insurance",
    "utilities",
    "repairs_maintenance",
    "legal_options",
    "notices",
    "signatures",
    "clauses",
  ]) {
    assert(keys.includes(expected), `expected base lease plan to include ${expected}`);
  }
  assertEquals(plan.diagnostic_only, true);
});

Deno.test("profile planner: assignment_assumption skips CAM/full-budget modules with original lease advisory", () => {
  const plan = buildExtractionPlan("assignment_assumption");
  const runKeys = moduleKeys(plan);
  const skippedKeys = moduleKeys(plan, "skip");
  assert(runKeys.includes("assignment_terms"));
  assert(runKeys.includes("consent_terms"));
  assert(runKeys.includes("references_and_missing_documents"));
  assert(!runKeys.includes("amendment_terms"));
  assert(skippedKeys.includes("cam_rules"));
  assert(skippedKeys.includes("money_and_schedules"));
  assert(plan.related_documents_needed.includes("original_lease"));
  assert(plan.planner_warnings.some((warning: string) => /CAM and full budget/i.test(warning)));
});

Deno.test("profile planner: assignment_assumption_amendment includes amendment_terms", () => {
  const plan = buildExtractionPlan("assignment_assumption_amendment");
  const keys = moduleKeys(plan);
  assert(keys.includes("assignment_terms"));
  assert(keys.includes("amendment_terms"));
  assert(keys.includes("consent_terms"));
});

Deno.test("profile planner: unknown_cre_document uses discovery modules only and never base lease modules", () => {
  const plan = buildExtractionPlan("unknown_cre_document");
  const keys = moduleKeys(plan);
  assert(keys.includes("unknown_document_discovery"));
  assert(keys.includes("profile_discovery"));
  assert(!keys.includes("rent_and_charges"));
  assert(!keys.includes("cam_rules"));
});

Deno.test("profile planner: non_cre_document returns not_applicable discovery-safe status", () => {
  const plan = buildExtractionPlan("non_cre_document");
  assertEquals(plan.status, "not_applicable");
  assert(plan.modules_to_run.every((module: any) => module.status === "not_applicable"));
});

Deno.test("profile ensemble: candidates and deterministic signals appear in output", () => {
  const ensemble = buildProfileEnsemble({
    uploadedFile: {
      document_subtype: "assignment",
      docling_raw: {
        full_text: "Assignment and Assumption of Lease. Assignor assigns to Assignee all tenant interest under the original lease. Landlord consent is required.",
      },
    },
    result: {
      metadata: {
        extractionDebug: {
          vertex_fact_ledger: {
            document_profile: "assignment",
            document_profile_confidence: 0.91,
            document_profile_method: "vertex",
          },
        },
      },
    },
    layoutSummary: { page_count: 2, full_text_chars: 140, text_block_count: 3 },
  });

  assertEquals(ensemble.selected_policy_key, "assignment_assumption");
  assertEquals(ensemble.profile_source, "vertex_fact_ledger");
  assert(ensemble.candidates.length >= 2);
  assert(ensemble.signals.deterministic);
});
