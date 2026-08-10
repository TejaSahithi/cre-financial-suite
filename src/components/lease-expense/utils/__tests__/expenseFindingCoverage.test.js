import { describe, expect, it } from "vitest";
import {
  buildExpenseFindingCoverageRows,
  deriveFindingCoverageDecision,
  extractExpenseClauseFindings,
} from "../expenseFindingCoverage";

const lease = {
  id: "lease-1",
  property_id: "property-1",
  extraction_data: {
    workflow_output: {
      clause_records: [
        {
          clause_type: "insurance",
          clause_text: "Tenant shall maintain commercial general liability insurance coverage of $1,000,000 and provide certificates of insurance.",
          source_page: 7,
        },
        {
          clause_type: "taxes",
          clause_text: "Tenant shall reimburse Landlord for Tenant's pro-rata share of real estate taxes as additional rent.",
          source_page: 9,
        },
        {
          clause_type: "utilities",
          clause_text: "Tenant shall pay all electricity and water charges directly to the utility provider at Tenant's sole expense.",
          source_page: 4,
        },
      ],
    },
  },
};

describe("expense finding coverage", () => {
  it("preserves expense-related clauses as evidence-only findings when no rule exists", () => {
    const findings = extractExpenseClauseFindings(lease);

    expect(findings.map((finding) => finding.category)).toEqual([
      "tenant_insurance",
      "real_estate_taxes",
      "utilities",
    ]);

    const rows = buildExpenseFindingCoverageRows({ leases: [lease], ruleRows: [] });
    expect(rows).toHaveLength(3);
    expect(rows[0].rule._coverage.contractStatus).toBe("Evidence Only");
    expect(rows[0].rule._coverage.expenseTreatment).toBe("Compliance Only");
    expect(rows[0].rule._coverage.actualExpenseExpected).toBe("no");
  });

  it("does not duplicate a raw finding already materialized as a rule", () => {
    const ruleRows = [{
      lease,
      property: { id: "property-1", name: "Macon Crossing" },
      ruleSet: { version: 1, status: "approved" },
      category: null,
      rule: {
        id: "11111111-1111-4111-8111-111111111111",
        lease_id: lease.id,
        expense_category: "real_estate_taxes",
        exact_source_text: "Tenant shall reimburse Landlord for Tenant's pro-rata share of real estate taxes as additional rent.",
        source_page: 9,
        review_status: "approved",
        approval_status: "approved",
        recoverable_from_tenant: "yes",
        cam_eligible: "yes",
      },
    }];

    const rows = buildExpenseFindingCoverageRows({ leases: [lease], ruleRows });
    expect(rows.filter(({ rule }) => rule.expense_category === "real_estate_taxes")).toHaveLength(1);
  });

  it("does not let a generic clause type hide the expense category found in evidence text", () => {
    const leaseWithGenericClause = {
      id: "lease-generic-clause",
      extraction_data: {
        workflow_output: {
          clause_records: [{
            clause_type: "clause",
            clause_text: "All real estate taxes and insurance premiums on the Premises shall be reimbursed by Tenant as additional rent.",
            source_page: 2,
          }],
        },
      },
    };

    const findings = extractExpenseClauseFindings(leaseWithGenericClause);

    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe("real_estate_taxes");
    expect(findings[0].categoryLabel).toBe("Real Estate Taxes");
  });

  it("keeps contract approval separate from CAM eligibility and actual expense expectation", () => {
    const tenantInsuranceRule = {
      expense_category: "tenant_insurance",
      exact_source_text: "Tenant shall maintain commercial general liability insurance coverage of $1,000,000.",
      payment_treatment: "tenant_direct_contract",
      recoverable_from_tenant: "no",
      cam_eligible: "no",
      review_status: "approved",
      approval_status: "approved",
    };

    expect(deriveFindingCoverageDecision(tenantInsuranceRule)).toMatchObject({
      contractStatus: "Approved",
      expenseTreatment: "Tenant Direct",
      camParticipation: "N/A",
      actualExpenseExpected: "no",
      materialization: "Approved",
    });

    const taxRule = {
      expense_category: "real_estate_taxes",
      exact_source_text: "Tenant shall reimburse Landlord for Tenant's pro-rata share of real estate taxes.",
      payment_treatment: "reimbursable",
      recoverable_from_tenant: "yes",
      cam_eligible: "yes",
      review_status: "approved",
      approval_status: "approved",
    };

    expect(deriveFindingCoverageDecision(taxRule)).toMatchObject({
      contractStatus: "Approved",
      expenseTreatment: "Pooled Recovery",
      camParticipation: "Eligible",
      actualExpenseExpected: "yes",
      materialization: "CAM Eligible",
    });
  });

  it("marks a base-year tax escalation Conditional, not N/A, so the CAM Eligible stat isn't undercounted", () => {
    // Same production row as ruleDecisionEngine.test.js's regression test:
    // cam_eligible explicitly "no" on a reimbursable/recoverable rule with a
    // real 70% share was falling through to camParticipation "N/A", making
    // the header's "CAM Eligible" count silently exclude it even though it's
    // a textbook base-year real estate tax pass-through.
    const unreviewedTaxRule = {
      expense_category: "real_estate_taxes",
      exact_source_text: "Tenant pays 70% of the increase in combined city, county, school, and special-district real estate taxes.",
      payment_treatment: "reimbursable",
      recoverable_from_tenant: "yes",
      tenant_share_percent: 70,
      allocation_basis: "70% of increase over stated base taxes",
      cam_eligible: "no",
      review_status: "needs_review",
      approval_status: "needs_review",
    };

    expect(deriveFindingCoverageDecision(unreviewedTaxRule)).toMatchObject({
      contractStatus: "Needs Review",
      expenseTreatment: "Pooled Recovery",
      camParticipation: "Conditional",
    });
  });
});