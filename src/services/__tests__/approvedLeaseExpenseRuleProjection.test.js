import { describe, expect, it, vi } from "vitest";
import {
  __test__,
  getAuthoritativeWorkflowOutput,
  isLeaseApprovedForExpensePublication,
} from "../../../supabase/functions/_shared/approved-lease-expense-rules.ts";
import {
  buildLeaseWorkflowAbstraction,
} from "../../../supabase/functions/_shared/extraction/lease-workflow.ts";
import { isLeaseDerivedRule } from "@/components/lease-expense/utils/leaseExpenseRulesHelpers";

describe("approved lease expense-rule projection", () => {
  it("enforces approval and prefers the workflow containing generated rules", () => {
    expect(isLeaseApprovedForExpensePublication({
      status: "draft",
      abstract_status: "pending_review",
    })).toBe(false);

    const workflow = getAuthoritativeWorkflowOutput(
      {
        extraction_data: {
          workflow_output: {
            lease_fields: { lease_type: { value: "triple_net" } },
            expense_rules: [],
          },
        },
      },
      {
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
      },
    );

    expect(workflow.expense_rules).toHaveLength(1);
  });

  it("prefers the canonical LLM workflow over a larger legacy projection", () => {
    const canonical = {
      expense_rule_source: "whole_document_llm_expense_obligations",
      expense_rules: [{ expense_category: "utilities" }],
    };
    const legacy = {
      expense_rule_source: "legacy_typescript_projection",
      expense_rules: Array.from({ length: 25 }, (_, index) => ({
        expense_category: `legacy_${index}`,
      })),
    };

    expect(getAuthoritativeWorkflowOutput(
      { extraction_data: { workflow_output: legacy } },
      { ui_review_payload: { metadata: { workflow_output: canonical } } },
    )).toBe(canonical);
  });

  it("uses the LLM expense candidates without running the TypeScript blueprint projection", () => {
    const clauseText =
      "Tenant shall pay its proportionate share of all common area maintenance expenses as Additional Rent.";
    const directCandidate = {
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
      llmExpenseRuleCandidates: [directCandidate],
    });

    expect(workflow.expense_rule_source).toBe("whole_document_llm_expense_obligations");
    expect(workflow.expense_rules).toEqual([directCandidate]);

    const prepared = __test__.prepareRulePayload(
      { id: "11111111-1111-4111-8111-111111111111" },
      "22222222-2222-4222-8222-222222222222",
      directCandidate,
    );
    expect(prepared.rule).toMatchObject({
      row_status: "needs_review",
      review_status: "needs_review",
      approval_status: "draft",
      published_to_cam: false,
    });
    expect(prepared.clause.page_number).toBeNull();
    expect(isLeaseDerivedRule({
      ...prepared.rule,
      clauses: [prepared.clause],
    })).toBe(true);
  });

  it("builds publisher fallback rules from source-backed expense clauses when canonical expense_rules are absent", () => {
    const clauseText =
      "This is a Gross Lease. The Tenant is aware that in the Monthly Rent amount and payment that all CAM, property taxes, insurance, maintenance and utility and janitorial costs are included as shown on Summary page.";
    const fallbackRules = __test__.fallbackExpenseRulesFromWorkflowEvidence({
      lease_clauses: [{
        clause_text: clauseText,
        source_page: 5,
        confidence: 0.98,
      }],
      expense_rules: [],
    });

    const categories = fallbackRules.map((rule) => rule.expense_category);
    expect(categories).toEqual(expect.arrayContaining([
      "common_area_maintenance",
      "real_estate_taxes",
      "property_insurance",
      "repairs_maintenance",
      "utilities",
      "janitorial",
    ]));

    const camRule = fallbackRules.find((rule) => rule.expense_category === "common_area_maintenance");
    expect(camRule).toMatchObject({
      included_in_base_rent: true,
      recoverable_from_tenant: false,
      payment_treatment: "included_in_base_rent",
      recovery_method: "included_in_base_rent",
      source_page: 5,
    });
    expect(__test__.isSourceBackedExpenseRule(camRule)).toBe(true);

    const prepared = __test__.prepareRulePayload(
      { id: "11111111-1111-4111-8111-111111111111" },
      "22222222-2222-4222-8222-222222222222",
      camRule,
    );
    expect(prepared.rule).toMatchObject({
      expense_category: "common_area_maintenance",
      included_in_base_rent: true,
      recoverable_from_tenant: "no",
      payment_treatment: "included_in_base_rent",
      row_status: "mapped",
      review_status: "approved",
      approval_status: "approved",
      published_to_cam: false,
    });
  });

  it("auto-approves and publishes source-backed recoverable CAM rules after lease approval", () => {
    const reimbursablePrepared = __test__.prepareRulePayload(
      { id: "11111111-1111-4111-8111-111111111111" },
      "22222222-2222-4222-8222-222222222222",
      {
        expense_category: "common_area_maintenance",
        exact_source_text: "Tenant shall reimburse Landlord for Tenant's pro rata share of common area maintenance expenses as Additional Rent.",
        source_page: 4,
        recoverable_from_tenant: "yes",
        cam_eligible: "yes",
        payment_treatment: "reimbursable",
        recovery_method: "pro_rata_share",
      },
    );
    expect(reimbursablePrepared.rule).toMatchObject({
      expense_category: "common_area_maintenance",
      row_status: "mapped",
      review_status: "approved",
      approval_status: "approved",
      published_to_cam: true,
    });
  });

  it("resolves the required database category id without changing LLM semantics", async () => {
    const query = {
      select: vi.fn(() => query),
      or: vi.fn(() => query),
      in: vi.fn().mockResolvedValue({
        data: [{
          id: "33333333-3333-4333-8333-333333333333",
          org_id: null,
          normalized_key: "utilities",
        }],
        error: null,
      }),
    };
    const supabaseAdmin = {
      from: vi.fn(() => query),
    };
    const prepared = [{
      rule: {
        expense_category: "utilities",
        exact_source_text: "Tenant shall pay all electricity charges directly.",
      },
      value: null,
      clause: {},
    }];

    const resolved = await __test__.resolveExpenseCategoryIds(
      supabaseAdmin,
      "22222222-2222-4222-8222-222222222222",
      prepared,
    );

    expect(resolved[0].rule).toEqual({
      ...prepared[0].rule,
      expense_category_id: "33333333-3333-4333-8333-333333333333",
    });
    expect(resolved[0].rule.expense_category).toBe("utilities");
  });
});
