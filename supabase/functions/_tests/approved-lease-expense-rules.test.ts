import { assert, assertEquals } from "jsr:@std/assert";
import {
  __test__,
  getAuthoritativeWorkflowOutput,
  isLeaseApprovedForExpensePublication,
} from "../_shared/approved-lease-expense-rules.ts";
import { buildLeaseWorkflowAbstraction } from "../_shared/extraction/lease-workflow.ts";

Deno.test("expense publication is blocked until the lease abstract is approved", () => {
  assertEquals(isLeaseApprovedForExpensePublication({
    status: "draft",
    abstract_status: "pending_review",
    abstract_approved_at: null,
  }), false);
  assertEquals(isLeaseApprovedForExpensePublication({
    status: "approved",
    abstract_status: "approved",
    abstract_approved_at: "2026-07-30T12:00:00Z",
  }), true);
});

Deno.test("authoritative workflow selection prefers source output containing expense rules", () => {
  const lease = {
    extraction_data: {
      workflow_output: {
        lease_fields: { lease_type: { value: "triple_net" } },
        lease_clauses: [],
        expense_rules: [],
      },
    },
  };
  const fileRecord = {
    ui_review_payload: {
      metadata: {
        workflow_output: {
          records: [{
            lease_fields: { lease_type: { value: "triple_net" } },
            lease_clauses: [{ clause_text: "Tenant shall pay CAM.", source_page: 4 }],
            expense_rules: [{ expense_category: "common_area_maintenance" }],
          }],
        },
      },
    },
  };

  const selected = getAuthoritativeWorkflowOutput(lease, fileRecord);
  assertEquals(selected.expense_rules.length, 1);
  assertEquals(selected.expense_rules[0].expense_category, "common_area_maintenance");
});

Deno.test("workflow keeps the exact LLM expense candidate without TypeScript semantic projection", () => {
  const clauseText =
    "Tenant shall pay its proportionate share of all common area maintenance expenses as Additional Rent.";
  const candidate = {
    expense_category: "common_area_maintenance",
    obligation_kind: "cam",
    source_page: null,
    exact_source_text: clauseText,
    extraction_status: "needs_review",
    review_status: "needs_review",
    approval_status: "draft",
    published_to_cam: false,
    generation_source: "whole_document_llm_expense_obligation_v1",
  };
  const workflow = buildLeaseWorkflowAbstraction({
    row: {},
    doclingRaw: { full_text: clauseText, text_blocks: [] },
    llmExpenseRuleCandidates: [candidate],
  });

  assertEquals(workflow.expense_rule_source, "whole_document_llm_expense_obligations");
  assertEquals(workflow.expense_rules, [candidate]);
});

Deno.test("approved publication payload remains needs-review and unpublished", () => {
  const prepared = __test__.prepareRulePayload(
    {
      id: "11111111-1111-4111-8111-111111111111",
      tenant_id: null,
      property_id: null,
      building_id: null,
      unit_id: null,
    },
    "22222222-2222-4222-8222-222222222222",
    {
      expense_category: "property_insurance",
      source_clause: "Tenant shall reimburse Landlord for property insurance premiums.",
      source_page: null,
      confidence_score: 0.82,
      recoverable_from_tenant: true,
      cam_eligible: true,
    },
  );

  assert(prepared);
  assertEquals(prepared.rule.review_status, "needs_review");
  assertEquals(prepared.rule.approval_status, "draft");
  assertEquals(prepared.rule.published_to_cam, false);
  assertEquals(prepared.rule.extraction_status, "inferred");
  assertEquals(prepared.clause.page_number, null);
});
