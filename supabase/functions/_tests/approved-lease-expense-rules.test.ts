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

Deno.test("authoritative workflow selection unwraps nested workflow_output payloads", () => {
  const selected = getAuthoritativeWorkflowOutput(
    {
      extraction_data: {
        workflow_output: {
          workflow_output: {
            expense_rule_source: "whole_document_llm_expense_obligations",
            expense_rules: [{ expense_category: "utilities" }],
          },
        },
      },
    },
    null,
  );

  assertEquals(selected.expense_rule_source, "whole_document_llm_expense_obligations");
  assertEquals(selected.expense_rules[0].expense_category, "utilities");
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

Deno.test("approved publication ignores coverage gaps before persistence", () => {
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
      rule_type: "coverage_gap",
      expense_category: "common_area_maintenance",
      source_clause: "Original lease required to confirm CAM treatment.",
      generation_source: "original_lease_required",
    },
  );

  assert(prepared);
  assertEquals(__test__.isSourceBackedExpenseRule(prepared.rule), false);
});


Deno.test("source-backed TypeScript workflow rules are valid fallback", () => {
  const workflow = {
    expense_rule_source: "typescript_schema_expense_rules_fallback",
    expense_rules: [{
      expense_category: "real_estate_taxes",
      source_clause: "Tenant shall reimburse Landlord for Tenant's share of real estate taxes.",
      source_page: 8,
      generation_source: "typescript_schema_workflow",
    }],
  };

  assertEquals(__test__.shouldPublishWorkflowExpenseRules(workflow), true);
  assertEquals(__test__.isSourceBackedExpenseRule(workflow.expense_rules[0]), true);
});

Deno.test("template checklist expense rows are not valid publication fallback", () => {
  const workflow = {
    expense_rules: [{
      expense_category: "common_area_maintenance",
      source_clause: "Template CAM checklist row",
      source_page: 1,
      generation_source: "template_checklist",
    }],
  };

  assertEquals(__test__.shouldPublishWorkflowExpenseRules(workflow), false);
  assertEquals(__test__.isSourceBackedExpenseRule(workflow.expense_rules[0]), false);
});

Deno.test("authoritative workflow selection can publish LLM expense candidates from fact-ledger diagnostics", () => {
  const quote = "Tenant shall reimburse Landlord for insurance premiums as Additional Rent.";
  const selected = getAuthoritativeWorkflowOutput(
    {
      extraction_data: {
        extraction_debug: {
          openai_fact_ledger: {
            expense_rule_candidates: [{
              expense_category: "property_insurance",
              source_clause: quote,
              exact_source_text: quote,
              source_page: 11,
              recoverable_from_tenant: "yes",
              cam_eligible: "yes",
              generation_source: "whole_document_llm_expense_obligation_v1",
            }],
            dynamic_items: [],
            validated_field_values: { tenant_name: { value: "Acme" } },
          },
        },
      },
    },
    null,
  );

  assertEquals(selected.expense_rule_source, "whole_document_llm_expense_obligations");
  assertEquals(selected.expense_rules.length, 1);
  assertEquals(selected.expense_rules[0].expense_category, "property_insurance");
  assertEquals(__test__.isSourceBackedExpenseRule(selected.expense_rules[0]), true);
});

Deno.test("authoritative workflow selection can build fallback rules from LLM dynamic CAM evidence", () => {
  const quote = "Tenant shall pay its pro rata share of common area maintenance expenses annually.";
  const selected = getAuthoritativeWorkflowOutput(
    {},
    {
      ui_review_payload: {
        metadata: {
          extractionDebug: {
            openai_fact_ledger: {
              expense_rule_candidates: [],
              dynamic_items: [{
                field_key: "cam_reimbursement_clause",
                business_area: "cam_rules",
                value: "Tenant pays CAM pro rata",
                exact_source_text: quote,
                source_text: quote,
                source_page: 6,
                confidence: 0.88,
              }],
            },
          },
        },
      },
    },
  );

  const fallbackRules = __test__.fallbackExpenseRulesFromWorkflowEvidence(selected);
  assertEquals(selected.expense_rule_source, "whole_document_llm_debug_evidence");
  assertEquals(fallbackRules.length, 1);
  assertEquals(fallbackRules[0].expense_category, "common_area_maintenance");
  assertEquals(__test__.isSourceBackedExpenseRule(fallbackRules[0]), true);
});
