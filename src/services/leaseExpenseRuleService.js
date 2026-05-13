import { supabase } from "@/services/supabaseClient";
import { getCurrentOrgId } from "@/services/api";
import { resolveWritableOrgId } from "@/lib/orgUtils";
import { saveLeaseConfig } from "@/services/camConfig";

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeFrequency(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["monthly", "quarterly", "yearly"].includes(raw)) return raw;
  return "yearly";
}

function normalizeRuleSource(value) {
  const raw = String(value || "").trim();
  return raw || null;
}

function normalizeCategoryToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeRuleStatus(rule) {
  const raw = String(rule?.row_status || "").trim().toLowerCase();
  return raw || "needs_review";
}

function normalizeRecoveryStatus(rule) {
  if (rule?.is_excluded) return "excluded";
  if (normalizeRuleStatus(rule) === "uncertain") return "conditional";
  if (normalizeRuleStatus(rule) === "missing_value") return "needs_review";
  if (rule?.is_recoverable) return "recoverable";
  if (rule?.mentioned_in_lease) return "non_recoverable";
  return "needs_review";
}

function extractRuleValue(rule) {
  return asNumber(rule?.final_value ?? rule?.manual_value ?? rule?.extracted_value);
}

function extractRuleClauses(rule, leaseId, ruleId) {
  const explicitClauses = asArray(rule?.clauses);
  if (explicitClauses.length > 0) {
    return explicitClauses
      .map((clause) => {
        const clauseText = String(
          clause?.clause_text ??
            clause?.source_text ??
            clause?.evidence_text ??
            clause?.text ??
            ""
        ).trim();
        if (!clauseText) return null;
        return {
          lease_expense_rule_id: ruleId,
          lease_id: leaseId,
          page_number: Number.isFinite(Number(clause?.page_number)) ? Number(clause.page_number) : null,
          clause_type: clause?.clause_type || "supporting_text",
          clause_text: clauseText,
          confidence: asNumber(clause?.confidence ?? rule?.confidence),
        };
      })
      .filter(Boolean);
  }

  const source = normalizeRuleSource(rule?.source);
  if (!source) return [];

  return [{
    lease_expense_rule_id: ruleId,
    lease_id: leaseId,
    page_number: Number.isFinite(Number(rule?.page_number ?? rule?.evidence_page_number))
      ? Number(rule.page_number ?? rule.evidence_page_number)
      : null,
    clause_type: "supporting_text",
    clause_text: source,
    confidence: asNumber(rule?.confidence),
  }];
}

function buildCategoryMatchIndex(categories = []) {
  const index = new Map();

  for (const category of categories) {
    const tokens = [
      category?.category_name,
      category?.subcategory_name,
      category?.normalized_key,
      [category?.category_name, category?.subcategory_name].filter(Boolean).join(" "),
    ]
      .map(normalizeCategoryToken)
      .filter(Boolean);

    for (const token of tokens) {
      if (!index.has(token)) {
        index.set(token, category);
      }
    }
  }

  return index;
}

function resolveCategoryForRule(rule, categories = [], categoryIndex = buildCategoryMatchIndex(categories)) {
  const directMatches = [
    rule?.expense_category_id ? categories.find((category) => category.id === rule.expense_category_id) : null,
    categoryIndex.get(normalizeCategoryToken(rule?.category_name)),
    categoryIndex.get(normalizeCategoryToken(rule?.subcategory_name)),
    categoryIndex.get(normalizeCategoryToken(rule?.normalized_key)),
    categoryIndex.get(normalizeCategoryToken([rule?.category_name, rule?.subcategory_name].filter(Boolean).join(" "))),
  ].filter(Boolean);

  if (directMatches.length > 0) return directMatches[0];

  const requestedCategory = normalizeCategoryToken(rule?.category_name);
  const requestedSubcategory = normalizeCategoryToken(rule?.subcategory_name);

  return categories.find((category) => {
    const categoryName = normalizeCategoryToken(category?.category_name);
    const subcategoryName = normalizeCategoryToken(category?.subcategory_name);
    return (
      (requestedCategory && (categoryName.includes(requestedCategory) || requestedCategory.includes(categoryName))) ||
      (requestedSubcategory && (subcategoryName.includes(requestedSubcategory) || requestedSubcategory.includes(subcategoryName)))
    );
  }) || null;
}

function mapExtractedRulesToCategories(aiRules = [], categories = [], existingRules = []) {
  const categoryIndex = buildCategoryMatchIndex(categories);
  const existingByCategoryId = new Map(
    (existingRules || [])
      .filter((rule) => rule?.expense_category_id)
      .map((rule) => [rule.expense_category_id, rule])
  );

  return (aiRules || [])
    .map((rule) => {
      const matchedCategory = resolveCategoryForRule(rule, categories, categoryIndex);
      if (!matchedCategory?.id) return null;

      const existingRule = existingByCategoryId.get(matchedCategory.id) || {};
      return {
        ...existingRule,
        ...rule,
        expense_category_id: matchedCategory.id,
        category_name: matchedCategory.category_name,
        subcategory_name: matchedCategory.subcategory_name || null,
      };
    })
    .filter(Boolean);
}

function buildLeaseConfigFromRules(lease, rules = [], categoriesById = new Map()) {
  const approvedRules = rules.filter((rule) => normalizeRuleStatus(rule) === "mapped");
  const excludedExpenses = approvedRules
    .filter((rule) => rule.is_excluded || (!rule.is_recoverable && rule.mentioned_in_lease))
    .map((rule) => {
      const category = categoriesById.get(rule.expense_category_id);
      return category?.normalized_key || category?.subcategory_name || category?.category_name || null;
    })
    .filter(Boolean);

  const cappedRule = approvedRules.find((rule) => rule.is_subject_to_cap);
  const baseYearRule = approvedRules.find((rule) => rule.has_base_year);
  const adminRule = approvedRules.find((rule) => rule.admin_fee_applicable && asNumber(rule.admin_fee_percent) != null);

  return {
    cam_applicable: approvedRules.some((rule) => rule.is_recoverable),
    cam_cap_type: cappedRule?.cap_type || lease?.cam_cap_type || "none",
    cam_cap_rate: cappedRule?.cap_type !== "fixed" ? asNumber(cappedRule?.cap_value ?? lease?.cam_cap_rate) : asNumber(lease?.cam_cap_rate),
    cam_cap: cappedRule?.cap_type === "fixed" ? asNumber(cappedRule?.cap_value ?? lease?.cam_cap) : asNumber(lease?.cam_cap),
    base_year: baseYearRule?.base_year_type || null,
    base_year_amount: asNumber(baseYearRule?.base_year_amount ?? lease?.base_year_amount),
    expense_stop_amount: asNumber(lease?.expense_stop_amount),
    gross_up_clause: approvedRules.some((rule) => rule.gross_up_applicable) || Boolean(lease?.gross_up_clause),
    allocation_method: lease?.allocation_method || "",
    weight_factor: asNumber(lease?.weight_factor),
    excluded_expenses: [...new Set(excludedExpenses)],
    management_fee_pct: asNumber(lease?.management_fee_pct),
    controllable_cap_rate: cappedRule?.is_controllable ? asNumber(cappedRule?.cap_value) : null,
    non_cumulative_cap_base_year: cappedRule?.cap_type === "non_cumulative" ? asNumber(lease?.base_year_amount) : null,
    admin_fee_pct: asNumber(adminRule?.admin_fee_percent ?? lease?.admin_fee_pct),
  };
}

async function resolveWorkflowOrgId(lease) {
  return resolveWritableOrgId(lease?.org_id || await getCurrentOrgId());
}

async function loadRuleDependencies(ruleSetId) {
  if (!ruleSetId) return { rules: [], valuesByRuleId: new Map(), clausesByRuleId: new Map() };

  const { data: rules, error: rulesError } = await supabase
    .from("lease_expense_rules")
    .select("*")
    .eq("rule_set_id", ruleSetId);
  if (rulesError) throw rulesError;

  const ruleIds = (rules || []).map((rule) => rule.id).filter(Boolean);
  const [{ data: values, error: valuesError }, { data: clauses, error: clausesError }] = await Promise.all([
    ruleIds.length > 0
      ? supabase.from("lease_expense_values").select("*").in("rule_id", ruleIds)
      : Promise.resolve({ data: [], error: null }),
    ruleIds.length > 0
      ? supabase.from("lease_expense_rule_clauses").select("*").in("lease_expense_rule_id", ruleIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (valuesError) throw valuesError;
  if (clausesError) throw clausesError;

  const valuesByRuleId = new Map();
  (values || []).forEach((value) => valuesByRuleId.set(value.rule_id, value));

  const clausesByRuleId = new Map();
  (clauses || []).forEach((clause) => {
    const existing = clausesByRuleId.get(clause.lease_expense_rule_id) || [];
    existing.push(clause);
    clausesByRuleId.set(clause.lease_expense_rule_id, existing);
  });

  return {
    rules: rules || [],
    valuesByRuleId,
    clausesByRuleId,
  };
}

function mergeRulesWithRelations(rules = [], valuesByRuleId = new Map(), clausesByRuleId = new Map()) {
  return (rules || []).map((rule) => {
    const valueRow = valuesByRuleId.get(rule.id) || null;
    return {
      ...rule,
      ...valueRow,
      clauses: clausesByRuleId.get(rule.id) || [],
    };
  });
}

function getLeaseExtractedValue(lease, fieldName) {
  if (!lease || !fieldName) return null;
  if (lease[fieldName] != null && lease[fieldName] !== "") return lease[fieldName];

  const extractedFields = lease?.extracted_fields && typeof lease.extracted_fields === "object"
    ? lease.extracted_fields
    : lease?.extraction_data?.extracted_fields && typeof lease.extraction_data.extracted_fields === "object"
      ? lease.extraction_data.extracted_fields
      : null;

  if (extractedFields && extractedFields[fieldName] != null && extractedFields[fieldName] !== "") {
    return extractedFields[fieldName];
  }

  const customField = asArray(lease?.extraction_data?.custom_fields)
    .find((field) => field?.field_key === fieldName && field?.value != null && field?.value !== "");

  return customField?.value ?? null;
}

function getLeaseWorkflowOutput(lease) {
  const workflow = lease?.extraction_data?.workflow_output;
  if (!workflow || typeof workflow !== "object") return null;
  if (Array.isArray(workflow?.records) && workflow.records[0]) return workflow.records[0];
  return workflow;
}

function findCategoryByKeywords(categories = [], keywords = []) {
  const normalizedKeywords = keywords.map(normalizeCategoryToken).filter(Boolean);
  return categories.find((category) => {
    const haystack = [
      category?.category_name,
      category?.subcategory_name,
      category?.normalized_key,
    ]
      .map(normalizeCategoryToken)
      .filter(Boolean)
      .join(" ");

    return normalizedKeywords.some((keyword) => haystack.includes(keyword) || keyword.includes(haystack));
  }) || null;
}

function extractSnippet(text, pattern) {
  const match = String(text || "").match(pattern);
  return match?.[0] ? match[0].trim() : null;
}

function buildDeterministicDraftRules({ lease, categories = [], sourceText = "", existingRules = [] }) {
  const draftRules = [];
  const existingByCategoryId = new Map(
    (existingRules || [])
      .filter((rule) => rule?.expense_category_id)
      .map((rule) => [rule.expense_category_id, rule]),
  );
  const workflowOutput = getLeaseWorkflowOutput(lease);
  const workflowRules = asArray(workflowOutput?.expense_rules);

  for (const workflowRule of workflowRules) {
    const category = findCategoryByKeywords(categories, [
      workflowRule?.expense_category,
      workflowRule?.expense_subcategory,
      String(workflowRule?.expense_category || "").replace(/_/g, " "),
    ].filter(Boolean));
    if (!category?.id) continue;

    const existing = existingByCategoryId.get(category.id) || {};
    const explicitValue = asNumber(workflowRule?.explicit_charge_amount);
    const recoveryClass = String(workflowRule?.rule_classification || "").trim().toLowerCase();
    const rowStatus =
      workflowRule?.status === "manual_required"
        ? "needs_review"
        : explicitValue != null || ["recoverable", "non_recoverable", "conditional", "excluded"].includes(recoveryClass)
          ? "mapped"
          : "needs_review";

    draftRules.push({
      ...existing,
      expense_category_id: category.id,
      category_name: category.category_name,
      subcategory_name: category.subcategory_name || null,
      row_status: rowStatus,
      mentioned_in_lease: true,
      is_recoverable: workflowRule?.recoverable_flag === true,
      is_excluded: recoveryClass === "excluded",
      is_controllable: true,
      is_subject_to_cap: false,
      has_base_year: false,
      gross_up_applicable: false,
      admin_fee_applicable: false,
      extracted_value: explicitValue,
      final_value: explicitValue,
      frequency: normalizeFrequency(workflowRule?.billing_frequency),
      confidence: asNumber(workflowRule?.confidence_score) ?? 0.74,
      notes: workflowRule?.notes || null,
      source: workflowRule?.source_clause || workflowRule?.lease_treatment || null,
      clauses: workflowRule?.source_clause
        ? [{
            clause_type: "supporting_text",
            clause_text: workflowRule.source_clause,
            page_number: workflowRule?.source_page ?? null,
            confidence: asNumber(workflowRule?.confidence_score) ?? 0.74,
          }]
        : [],
    });
  }

  const candidates = [
    {
      field: "cam_amount",
      keywords: ["cam", "common area maintenance"],
      notes: "Derived from extracted CAM amount",
    },
    {
      field: "nnn_amount",
      keywords: ["nnn", "triple net", "operating expenses"],
      notes: "Derived from extracted NNN amount",
    },
    {
      field: "insurance_reimbursement_amount",
      keywords: ["insurance"],
      notes: "Derived from extracted insurance reimbursement amount",
    },
    {
      field: "tax_reimbursement_amount",
      keywords: ["tax", "real estate tax"],
      notes: "Derived from extracted tax reimbursement amount",
    },
    {
      field: "utility_reimbursement_amount",
      keywords: ["utility", "utilities"],
      notes: "Derived from extracted utility reimbursement amount",
    },
    {
      field: "water_sewer_reimbursement_amount",
      keywords: ["water", "sewer", "utilities"],
      notes: "Derived from extracted water/sewer reimbursement amount",
    },
  ];
  const extractedUtilityAmount = asNumber(getLeaseExtractedValue(lease, "utility_reimbursement_amount"));
  const extractedWaterSewerAmount = asNumber(getLeaseExtractedValue(lease, "water_sewer_reimbursement_amount"));

  for (const candidate of candidates) {
    if (
      candidate.field === "utility_reimbursement_amount" &&
      extractedUtilityAmount != null &&
      extractedUtilityAmount > 0 &&
      extractedUtilityAmount === extractedWaterSewerAmount
    ) {
      continue;
    }

    const category = findCategoryByKeywords(categories, candidate.keywords);
    if (!category?.id) continue;

    const extractedValue = asNumber(getLeaseExtractedValue(lease, candidate.field));
    if (extractedValue == null || extractedValue <= 0) continue;

    const snippet = extractSnippet(
      sourceText,
      new RegExp(`${candidate.keywords.join("|")}[\\s\\S]{0,120}?\\$[\\d,]+(?:\\.\\d{2})?`, "i"),
    );
    const existing = existingByCategoryId.get(category.id) || {};

    draftRules.push({
      ...existing,
      expense_category_id: category.id,
      category_name: category.category_name,
      subcategory_name: category.subcategory_name || null,
      row_status: "mapped",
      mentioned_in_lease: true,
      is_recoverable: true,
      is_excluded: false,
      is_controllable: true,
      is_subject_to_cap: false,
      has_base_year: false,
      gross_up_applicable: false,
      admin_fee_applicable: false,
      extracted_value: extractedValue,
      final_value: extractedValue,
      frequency: /monthly|per month/i.test(snippet || sourceText) ? "monthly" : "yearly",
      confidence: 0.78,
      notes: candidate.notes,
      source: snippet || candidate.notes,
    });
  }

  const utilitiesCategory = findCategoryByKeywords(categories, ["utility", "utilities", "electric", "water", "sewer"]);
  const electricResponsibility = String(getLeaseExtractedValue(lease, "electric_responsibility") || "");
  if (utilitiesCategory?.id && electricResponsibility && /tenant/i.test(electricResponsibility)) {
    const existing = existingByCategoryId.get(utilitiesCategory.id) || {};
    draftRules.push({
      ...existing,
      expense_category_id: utilitiesCategory.id,
      category_name: utilitiesCategory.category_name,
      subcategory_name: utilitiesCategory.subcategory_name || null,
      row_status: "mapped",
      mentioned_in_lease: true,
      is_recoverable: false,
      is_excluded: true,
      is_controllable: true,
      is_subject_to_cap: false,
      has_base_year: false,
      gross_up_applicable: false,
      admin_fee_applicable: false,
      extracted_value: null,
      final_value: null,
      frequency: "yearly",
      confidence: 0.72,
      notes: "Tenant pays electric directly per lease clause.",
      source: electricResponsibility,
    });
  }

  const deduped = new Map();
  for (const rule of draftRules) {
    if (!rule?.expense_category_id) continue;
    const existing = deduped.get(rule.expense_category_id);
    if (!existing) {
      deduped.set(rule.expense_category_id, rule);
      continue;
    }

    const existingScore = (asNumber(existing.final_value) != null ? 2 : 0) + (existing.is_recoverable ? 1 : 0);
    const nextScore = (asNumber(rule.final_value) != null ? 2 : 0) + (rule.is_recoverable ? 1 : 0);
    if (nextScore >= existingScore) {
      deduped.set(rule.expense_category_id, rule);
    }
  }

  return [...deduped.values()];
}

export const leaseExpenseRuleService = {
  async getLeaseSourceText(leaseId, sourceFileId = null) {
    if (!supabase || !leaseId) return "";

    let uploadedFile = null;

    if (sourceFileId) {
      const { data } = await supabase
        .from("uploaded_files")
        .select("normalized_output, parsed_data, docling_raw")
        .eq("id", sourceFileId)
        .maybeSingle();
      uploadedFile = data || null;
    }

    if (!uploadedFile) {
      const { data } = await supabase
        .from("document_links")
        .select("uploaded_files(normalized_output, parsed_data, docling_raw)")
        .eq("entity_id", leaseId)
        .eq("entity_type", "lease")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      uploadedFile = data?.uploaded_files || null;
    }

    return String(
      uploadedFile?.normalized_output?.raw_text ||
      uploadedFile?.parsed_data?.raw_text ||
      uploadedFile?.parsed_data?.text ||
      uploadedFile?.docling_raw?.markdown ||
      uploadedFile?.docling_raw?.text ||
      ""
    ).trim();
  },

  async loadRuleSet(leaseId) {
    if (!supabase || !leaseId) return { ruleSet: null, rules: [] };

    const { data: ruleSets, error } = await supabase
      .from("lease_expense_rule_sets")
      .select("*")
      .eq("lease_id", leaseId)
      .not("status", "eq", "archived")
      .order("version", { ascending: false })
      .limit(1);

    if (error) throw error;

    const ruleSet = ruleSets?.[0] || null;
    if (!ruleSet) return { ruleSet: null, rules: [] };

    const { rules, valuesByRuleId, clausesByRuleId } = await loadRuleDependencies(ruleSet.id);
    const mergedRules = mergeRulesWithRelations(rules, valuesByRuleId, clausesByRuleId);

    return { ruleSet, rules: mergedRules };
  },

  async loadRuleSets(leaseIds = []) {
    if (!supabase || !Array.isArray(leaseIds) || leaseIds.length === 0) return [];

    const { data: ruleSets, error } = await supabase
      .from("lease_expense_rule_sets")
      .select("*")
      .in("lease_id", leaseIds)
      .not("status", "eq", "archived")
      .order("version", { ascending: false });

    if (error) throw error;

    const latestRuleSetByLeaseId = new Map();
    for (const ruleSet of ruleSets || []) {
      if (!latestRuleSetByLeaseId.has(ruleSet.lease_id)) {
        latestRuleSetByLeaseId.set(ruleSet.lease_id, ruleSet);
      }
    }

    const latestRuleSets = [...latestRuleSetByLeaseId.values()];
    const ruleSetIds = latestRuleSets.map((ruleSet) => ruleSet.id);
    if (ruleSetIds.length === 0) return [];

    const { data: rules, error: rulesError } = await supabase
      .from("lease_expense_rules")
      .select("*")
      .in("rule_set_id", ruleSetIds);

    if (rulesError) throw rulesError;

    const ruleIds = (rules || []).map((rule) => rule.id).filter(Boolean);
    const [{ data: values, error: valuesError }, { data: clauses, error: clausesError }] = await Promise.all([
      ruleIds.length > 0
        ? supabase.from("lease_expense_values").select("*").in("rule_id", ruleIds)
        : Promise.resolve({ data: [], error: null }),
      ruleIds.length > 0
        ? supabase.from("lease_expense_rule_clauses").select("*").in("lease_expense_rule_id", ruleIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (valuesError) throw valuesError;
    if (clausesError) throw clausesError;

    const valuesByRuleId = new Map((values || []).map((value) => [value.rule_id, value]));
    const clausesByRuleId = new Map();
    (clauses || []).forEach((clause) => {
      const existing = clausesByRuleId.get(clause.lease_expense_rule_id) || [];
      existing.push(clause);
      clausesByRuleId.set(clause.lease_expense_rule_id, existing);
    });

    return latestRuleSets.map((ruleSet) => ({
      leaseId: ruleSet.lease_id,
      ruleSet,
      rules: mergeRulesWithRelations(
        (rules || []).filter((rule) => rule.rule_set_id === ruleSet.id),
        valuesByRuleId,
        clausesByRuleId
      ),
    }));
  },

  async extractDraftRuleSet({ lease, categories = [], existingRuleSetId = null, existingRules = [] }) {
    if (!supabase || !lease?.id) throw new Error("Lease is required to extract expense rules");

    const sourceText = await this.getLeaseSourceText(
      lease.id,
      lease?.extraction_data?.source_file_id || null
    );

    if (!sourceText) {
      throw new Error("No extracted lease text found to analyze.");
    }

    let mappedRules = [];

    try {
      const { data, error } = await supabase.functions.invoke("extract-lease-expense-rules", {
        body: {
          lease_id: lease.id,
          source_text: sourceText,
          categories: (categories || []).map((category) => ({
            id: category.id,
            category_name: category.category_name,
            subcategory_name: category.subcategory_name,
            normalized_key: category.normalized_key,
          })),
        },
      });

      if (error) throw error;
      mappedRules = mapExtractedRulesToCategories(data?.rules || [], categories, existingRules);
    } catch (error) {
      console.warn("[leaseExpenseRuleService] AI rule extraction fallback:", error);
      mappedRules = [];
    }

    if (mappedRules.length === 0) {
      mappedRules = buildDeterministicDraftRules({
        lease,
        categories,
        sourceText,
        existingRules,
      });
    }

    return this.saveRuleSet({
      lease,
      rules: mappedRules,
      status: "draft",
      existingRuleSetId,
      categories,
    });
  },

  async saveRuleSet({ lease, rules = [], status = "draft", existingRuleSetId = null, categories = [] }) {
    if (!supabase || !lease?.id) throw new Error("Lease is required to save expense rules");

    const orgId = await resolveWorkflowOrgId(lease);
    if (!orgId) {
      throw new Error("Unable to resolve organization for lease expense rules");
    }

    const categoriesById = new Map((categories || []).map((category) => [category.id, category]));
    const now = new Date().toISOString();
    let ruleSetId = existingRuleSetId;
    let currentVersion = 1;

    if (ruleSetId) {
      const { error: updateRuleSetError } = await supabase
        .from("lease_expense_rule_sets")
        .update({
          status,
          property_id: lease.property_id || null,
          approved_at: status === "approved" ? now : null,
        })
        .eq("id", ruleSetId)
        .eq("org_id", orgId);

      if (updateRuleSetError) throw updateRuleSetError;
    } else {
      const { data: existingSets } = await supabase
        .from("lease_expense_rule_sets")
        .select("version")
        .eq("lease_id", lease.id)
        .order("version", { ascending: false })
        .limit(1);

      currentVersion = Number(existingSets?.[0]?.version || 0) + 1;
      const { data: createdRuleSet, error: createRuleSetError } = await supabase
        .from("lease_expense_rule_sets")
        .insert({
          org_id: orgId,
          lease_id: lease.id,
          property_id: lease.property_id || null,
          version: currentVersion,
          status,
          approved_at: status === "approved" ? now : null,
        })
        .select("*")
        .single();

      if (createRuleSetError) throw createRuleSetError;
      ruleSetId = createdRuleSet.id;
    }

    const rulePayloads = rules.map((rule) => ({
      id: rule?.id && !String(rule.id).startsWith("temp-") ? rule.id : undefined,
      rule_set_id: ruleSetId,
      expense_category_id: rule.expense_category_id,
      row_status: normalizeRuleStatus(rule),
      mentioned_in_lease: Boolean(rule.mentioned_in_lease || normalizeRuleStatus(rule) !== "not_mentioned"),
      is_recoverable: Boolean(rule.is_recoverable),
      is_excluded: Boolean(rule.is_excluded),
      is_controllable: Boolean(rule.is_controllable),
      is_subject_to_cap: Boolean(rule.is_subject_to_cap),
      cap_type: rule.cap_type || null,
      cap_value: asNumber(rule.cap_value),
      has_base_year: Boolean(rule.has_base_year),
      base_year_type: rule.base_year_type || null,
      gross_up_applicable: Boolean(rule.gross_up_applicable),
      admin_fee_applicable: Boolean(rule.admin_fee_applicable),
      admin_fee_percent: asNumber(rule.admin_fee_percent),
      notes: rule.notes || null,
      confidence: asNumber(rule.confidence),
      source: normalizeRuleSource(rule.source),
    }));

    let savedRules = [];
    if (rulePayloads.length > 0) {
      const { data, error: ruleError } = await supabase
        .from("lease_expense_rules")
        .upsert(rulePayloads, { onConflict: "id" })
        .select("*");

      if (ruleError) throw ruleError;
      savedRules = data || [];
    }

    const rulesByCategoryId = new Map(savedRules.map((rule) => [rule.expense_category_id, rule]));
    const valuePayloads = [];
    const clausePayloads = [];

    for (const rule of rules) {
      const savedRule = rulesByCategoryId.get(rule.expense_category_id);
      if (!savedRule?.id) continue;

      const finalValue = extractRuleValue(rule);
      const hasValuePayload =
        finalValue != null ||
        asNumber(rule?.base_year_amount) != null ||
        rule?.frequency;

      if (hasValuePayload) {
        valuePayloads.push({
          rule_id: savedRule.id,
          base_year_amount: asNumber(rule.base_year_amount),
          extracted_value: asNumber(rule.extracted_value),
          manual_value: asNumber(rule.manual_value),
          final_value: finalValue,
          frequency: normalizeFrequency(rule.frequency),
          value_source: rule.manual_value != null ? "manual" : rule.extracted_value != null ? "extracted" : rule.value_source || null,
        });
      }

      clausePayloads.push(...extractRuleClauses(rule, lease.id, savedRule.id));
    }

    if (savedRules.length > 0) {
      const savedRuleIds = savedRules.map((rule) => rule.id);

      try {
        await supabase.from("lease_expense_values").delete().in("rule_id", savedRuleIds);
        if (valuePayloads.length > 0) {
          const { error: valuesError } = await supabase.from("lease_expense_values").insert(valuePayloads);
          if (valuesError) throw valuesError;
        }
      } catch (error) {
        console.warn("[leaseExpenseRuleService] value persistence warning:", error);
      }

      try {
        await supabase.from("lease_expense_rule_clauses").delete().in("lease_expense_rule_id", savedRuleIds);
        if (clausePayloads.length > 0) {
          const { error: clausesError } = await supabase.from("lease_expense_rule_clauses").insert(clausePayloads);
          if (clausesError) throw clausesError;
        }
      } catch (error) {
        console.warn("[leaseExpenseRuleService] clause persistence warning:", error);
      }
    }

    const persisted = await this.loadRuleSet(lease.id);
    if (status === "approved") {
      try {
        await saveLeaseConfig(lease.id, buildLeaseConfigFromRules(lease, persisted.rules, categoriesById));
      } catch (error) {
        console.warn("[leaseExpenseRuleService] lease config sync warning:", error);
      }
    }

    return {
      ...persisted,
      ruleSet: persisted.ruleSet || { id: ruleSetId, status, version: currentVersion },
    };
  },

  groupRulesByRecoveryStatus(rules = []) {
    const groups = {
      recoverable: [],
      nonRecoverable: [],
      conditional: [],
      needsReview: [],
    };

    for (const rule of rules || []) {
      const normalizedRecoveryStatus = normalizeRecoveryStatus(rule);
      if (normalizedRecoveryStatus === "recoverable") {
        groups.recoverable.push(rule);
        continue;
      }
      if (["non_recoverable", "excluded"].includes(normalizedRecoveryStatus)) {
        groups.nonRecoverable.push(rule);
        continue;
      }
      if (normalizedRecoveryStatus === "conditional") {
        groups.conditional.push(rule);
        continue;
      }
      groups.needsReview.push(rule);
    }

    return groups;
  },

  normalizeRecoveryStatus,
};

export default leaseExpenseRuleService;
