import { deriveRuleDecision } from "@/services/utils/ruleDecisionEngine";

const EXPENSE_FINDING_PATTERNS = [
  { category: "real_estate_taxes", label: "Real Estate Taxes", patterns: [/real\s+estate\s+tax/i, /property\s+tax/i, /\btaxes\b/i, /assessment/i] },
  { category: "property_insurance", label: "Property Insurance", patterns: [/property\s+insurance/i, /insurance\s+premium/i] },
  { category: "tenant_insurance", label: "Tenant Insurance", patterns: [/tenant.{0,100}(?:insurance|liability|certificate)/i, /commercial\s+general\s+liability/i, /additional\s+insured/i, /waiver\s+of\s+subrogation/i] },
  { category: "common_area_maintenance", label: "Common Area Maintenance", patterns: [/common\s+area\s+maintenance/i, /\bcam\b/i, /operating\s+expenses?/i] },
  { category: "utilities", label: "Utilities", patterns: [/utilit/i, /electric/i, /water/i, /sewer/i, /gas/i] },
  { category: "repairs_maintenance", label: "Repairs & Maintenance", patterns: [/repair/i, /maintenance/i, /\bhvac\b/i, /roof/i, /structure/i, /parking/i] },
  { category: "late_fees", label: "Late Fee", patterns: [/late\s+(?:fee|charge)/i, /delinquent/i, /overdue/i] },
  { category: "legal_enforcement_fees", label: "Legal / Enforcement Fees", patterns: [/attorney/i, /legal\s+(?:fee|cost)/i, /enforcement/i, /consent\s+review/i] },
  { category: "capital_expenditures", label: "Capital Expenditures", patterns: [/capital\s+(?:expenditure|improvement|replacement)/i, /amorti/i] },
  { category: "reimbursement", label: "Reimbursement", patterns: [/reimburs/i, /additional\s+rent/i, /pass[-\s]?through/i, /pro[-\s]?rata/i] },
];

function textOf(value) {
  return String(value || "").trim();
}

function compactText(value) {
  return textOf(value).replace(/\s+/g, " ");
}

function normalizeKey(value) {
  return compactText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeComparableText(value) {
  return compactText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function humanize(value) {
  const text = textOf(value).replace(/[_-]+/g, " ");
  if (!text) return "-";
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

function readNestedArrays(root, paths) {
  const arrays = [];
  for (const path of paths) {
    const value = path.reduce((current, key) => current?.[key], root);
    if (Array.isArray(value)) arrays.push(value);
  }
  return arrays;
}

const GENERIC_EXPLICIT_CATEGORIES = new Set([
  "clause",
  "contract_clause",
  "lease_clause",
  "expense",
  "expenses",
  "insurance",
  "tax",
  "taxes",
  "maintenance",
  "repairs",
  "cam",
  "utilities",
]);

function findExpenseCategory(text, explicitCategory) {
  const explicit = normalizeKey(explicitCategory);
  if (explicit && !GENERIC_EXPLICIT_CATEGORIES.has(explicit)) {
    const matched = EXPENSE_FINDING_PATTERNS.find((entry) => entry.category === explicit);
    if (matched) return matched;
    return { category: explicit, label: humanize(explicit) };
  }
  return EXPENSE_FINDING_PATTERNS.find((entry) => entry.patterns.some((pattern) => pattern.test(text))) || null;
}

function isComplianceOnlyText(text) {
  return /(?:carry|maintain|obtain|provide|certificate|additional\s+insured|waiver\s+of\s+subrogation|coverage|liability\s+insurance)/i.test(text)
    && !/(?:premium|reimburs|additional\s+rent|pass[-\s]?through|landlord.{0,80}insurance\s+cost)/i.test(text);
}

function isTenantDirectText(text) {
  return /tenant.{0,120}(?:direct|sole|own).{0,120}(?:cost|expense|responsibility|contract)|direct(?:ly)?\s+to\s+(?:the\s+)?(?:provider|utility|company)|separately\s+metered/i.test(text);
}

function isDirectRecoveryText(text) {
  return /tenant[-\s]?caused|reimburs|indemnif|direct\s+bill|separately\s+billed|late\s+(?:fee|charge)|consent\s+review|attorney/i.test(text);
}

function isLandlordExpenseText(text) {
  return /landlord.{0,140}(?:pay|incur|maintain|repair|insure)|tenant.{0,140}(?:pro[-\s]?rata|share|reimburse).{0,140}(?:tax|insurance|cam|operating\s+expense|common\s+area)/i.test(text);
}

function evidenceTextFromRecord(record) {
  return compactText(
    record?.exact_source_text ||
    record?.source_text ||
    record?.source_clause ||
    record?.clause_text ||
    record?.summary ||
    record?.text ||
    record?.value ||
    "",
  );
}

function sourcePageFromRecord(record) {
  const page = record?.source_page ?? record?.sourcePage ?? record?.page_number ?? record?.pageNumber ?? record?.page;
  const numeric = Number(page);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function extractExpenseClauseFindings(lease) {
  const extractionData = lease?.extraction_data || {};
  const workflowOutput = extractionData.workflow_output?.workflow_output || extractionData.workflow_output || {};
  const normalizedOutput = extractionData.normalized_output || {};
  const arrays = readNestedArrays(
    { lease, extractionData, workflowOutput, normalizedOutput },
    [
      ["lease", "clause_records"],
      ["lease", "clauses"],
      ["extractionData", "clause_records"],
      ["extractionData", "document_items"],
      ["workflowOutput", "clause_records"],
      ["workflowOutput", "clauses"],
      ["workflowOutput", "document_items"],
      ["normalizedOutput", "clause_records"],
      ["normalizedOutput", "workflow_output", "clause_records"],
      ["normalizedOutput", "document_items"],
    ],
  );

  const findingsByKey = new Map();
  for (const records of arrays) {
    for (const record of records) {
      const sourceText = evidenceTextFromRecord(record);
      if (sourceText.length < 18) continue;
      const category = findExpenseCategory(
        sourceText,
        record?.expense_category || record?.category || record?.field_key || record?.clause_type,
      );
      if (!category) continue;
      const sourcePage = sourcePageFromRecord(record);
      const key = [
        lease?.id || "",
        category.category,
        sourcePage || "",
        normalizeComparableText(sourceText).slice(0, 180),
      ].join("::");
      if (findingsByKey.has(key)) continue;
      findingsByKey.set(key, {
        id: `expense-finding-${lease?.id || "lease"}-${findingsByKey.size}`,
        leaseId: lease?.id || null,
        category: category.category,
        categoryLabel: category.label,
        sourceText,
        sourcePage,
        title: record?.clause_title || record?.title || record?.label || category.label,
        raw: record,
      });
    }
  }
  return [...findingsByKey.values()];
}

export function deriveFindingCoverageDecision(rule = {}) {
  if (rule?._findingOnly) {
    const text = rule.exact_source_text || rule.source_text || "";
    const category = normalizeKey(rule.expense_category || rule.category_name);
    let expenseTreatment = "Not Applicable";
    let camParticipation = "Not Eligible";
    let actualExpenseExpected = "no";
    let reason = "Evidence retained for review; it has not been promoted to a normalized rule candidate.";

    if (category.includes("tenant_insurance") || isComplianceOnlyText(text)) {
      expenseTreatment = "Compliance Only";
      reason = "Compliance requirement, not a financial recovery rule.";
    } else if (isTenantDirectText(text)) {
      expenseTreatment = "Tenant Direct";
      reason = "Tenant appears to pay or perform directly; no landlord actual expense is expected.";
    } else if (isDirectRecoveryText(text)) {
      expenseTreatment = "Direct Reimbursement";
      camParticipation = "Direct Recovery Only";
      actualExpenseExpected = "conditional";
      reason = "Potential direct recovery or fee; reviewer should decide whether it is an actionable rule.";
    } else if (isLandlordExpenseText(text)) {
      expenseTreatment = "Landlord Expense";
      camParticipation = "Conditional";
      actualExpenseExpected = "conditional";
      reason = "Potential landlord-incurred cost; reviewer should promote or merge if contractually actionable.";
    }

    return {
      contractStatus: "Evidence Only",
      expenseTreatment,
      camParticipation,
      actualExpenseExpected,
      materialization: "Not Materialized",
      reason,
    };
  }

  const decision = deriveRuleDecision(rule);
  const paymentTreatment = decision.legacy.paymentTreatment;
  const recoverability = decision.recoverability;
  const camEligibility = decision.camEligibility;
  const category = normalizeKey(rule.normalized_key || rule.expense_category || rule.category_name);
  const sourceText = rule.exact_source_text || rule.source_text || rule.source || "";

  let expenseTreatment = "Not Applicable";
  if (decision.legacy.includedInBaseRent || paymentTreatment === "included_in_base_rent") {
    expenseTreatment = "Included in Rent";
  } else if (paymentTreatment === "tenant_direct_contract") {
    expenseTreatment = "Tenant Direct";
  } else if (category.includes("tenant_insurance") || category.includes("liability_insurance") || isComplianceOnlyText(sourceText)) {
    expenseTreatment = "Compliance Only";
  } else if (["late_fees", "interest", "legal_enforcement_fees", "percentage_rent"].includes(category)) {
    expenseTreatment = "Fee / Charge";
  } else if (["direct_bill", "actual_usage", "fixed_amount"].includes(normalizeKey(rule.recovery_method)) && recoverability !== "not_recoverable") {
    expenseTreatment = "Direct Reimbursement";
  } else if (recoverability === "recoverable" || camEligibility === "eligible") {
    expenseTreatment = "Landlord Expense";
  }

  let camParticipation = "Not Eligible";
  if (camEligibility === "eligible") camParticipation = "Eligible";
  else if (camEligibility === "conditional") camParticipation = "Conditional";
  else if (recoverability === "recoverable" && ["Direct Reimbursement", "Fee / Charge"].includes(expenseTreatment)) {
    camParticipation = "Direct Recovery Only";
  }

  let actualExpenseExpected = "conditional";
  if (["Tenant Direct", "Compliance Only", "Fee / Charge"].includes(expenseTreatment)) {
    actualExpenseExpected = "no";
  } else if (expenseTreatment === "Landlord Expense" && camParticipation === "Eligible") {
    actualExpenseExpected = "yes";
  }

  const materialization =
    camParticipation === "Eligible" && decision.status === "approved"
      ? "CAM-Enabled Subset"
      : decision.status === "approved"
        ? "Approved Contractual Rule"
        : "Rule Candidate";

  return {
    contractStatus: humanize(decision.status || "draft"),
    expenseTreatment,
    camParticipation,
    actualExpenseExpected,
    materialization,
    reason: decision.blockingReasons?.length
      ? decision.blockingReasons.map(humanize).join(", ")
      : "Rule is tracked independently from CAM participation.",
  };
}

function findingMatchesRule(finding, ruleRows) {
  const findingText = normalizeComparableText(finding.sourceText);
  if (!findingText) return false;
  return ruleRows.some(({ rule }) => {
    const rulePage = Number(rule?.source_page ?? rule?.page_number);
    const ruleText = normalizeComparableText(rule?.exact_source_text || rule?.source_text || rule?.source || "");
    if (!ruleText) return false;
    const samePage = !finding.sourcePage || !Number.isFinite(rulePage) || rulePage === finding.sourcePage;
    if (!samePage) return false;
    return ruleText.includes(findingText.slice(0, 120)) || findingText.includes(ruleText.slice(0, 120));
  });
}

export function buildExpenseFindingCoverageRows({ leases = [], ruleRows = [], propertyById = new Map() } = {}) {
  const rows = ruleRows.map((row) => ({
    ...row,
    rule: {
      ...row.rule,
      _coverage: deriveFindingCoverageDecision(row.rule),
    },
  }));

  const ruleRowsByLeaseId = new Map();
  for (const row of ruleRows) {
    const leaseId = row?.lease?.id || row?.rule?.lease_id;
    if (!leaseId) continue;
    if (!ruleRowsByLeaseId.has(leaseId)) ruleRowsByLeaseId.set(leaseId, []);
    ruleRowsByLeaseId.get(leaseId).push(row);
  }

  for (const lease of leases) {
    const leaseRuleRows = ruleRowsByLeaseId.get(lease.id) || [];
    for (const finding of extractExpenseClauseFindings(lease)) {
      if (findingMatchesRule(finding, leaseRuleRows)) continue;
      const syntheticRule = {
        id: finding.id,
        lease_id: lease.id,
        expense_category: finding.category,
        category_name: finding.categoryLabel,
        expense_subcategory: "Evidence retained",
        payment_treatment: "not_applicable",
        recoverable_from_tenant: "needs_review",
        cam_eligible: "needs_review",
        recovery_method: "not_applicable",
        allocation_basis: "none",
        exact_source_text: finding.sourceText,
        source_text: finding.sourceText,
        source_page: finding.sourcePage,
        review_status: "needs_review",
        approval_status: "draft",
        row_status: "evidence_only",
        _findingOnly: true,
      };
      rows.push({
        rule: {
          ...syntheticRule,
          _coverage: deriveFindingCoverageDecision(syntheticRule),
        },
        ruleSet: null,
        lease,
        property: lease?.property_id ? propertyById.get(lease.property_id) ?? null : null,
        category: null,
      });
    }
  }

  return rows;
}

export function calculateFindingCoverageCounts(rows = []) {
  const summary = {
    all: rows.length,
    rule_candidates: 0,
    contract_approved: 0,
    cam_enabled: 0,
    actual_expected: 0,
    evidence_only: 0,
  };
  for (const { rule } of rows) {
    const coverage = rule?._coverage || deriveFindingCoverageDecision(rule);
    if (coverage.materialization === "Rule Candidate") summary.rule_candidates += 1;
    if (coverage.materialization === "Approved Contractual Rule") summary.contract_approved += 1;
    if (coverage.materialization === "CAM-Enabled Subset" || coverage.camParticipation === "Eligible") summary.cam_enabled += 1;
    if (coverage.actualExpenseExpected === "yes") summary.actual_expected += 1;
    if (coverage.contractStatus === "Evidence Only") summary.evidence_only += 1;
  }
  return summary;
}
