import {
  deriveRuleExactSourceText,
  deriveRuleSourcePage,
  deriveRuleConfidence,
  extractRuleValue,
  extractRuleClauses,
  deriveRuleCategoryName,
  deriveRuleSubcategoryName,
  deriveRuleNormalizedKey,
  resolveCanonicalExpenseCategory,
  isRuleExcludedFromLeaseExpenses
} from "./utils/leaseExpenseRuleFormatting";

import {
  isRuleSuperseded,
  isRuleApproved,
  isProtectedHumanRule,
  deriveRuleSetStatusFromRules
} from "./utils/leaseExpenseRuleStatus";
import { extractDocumentTextCandidate } from "./utils/documentTextCandidate";

import {
  deriveRuleCamEligible,
  deriveRuleIncludedInBaseRent,
  deriveRuleOperationalResponsibility,
  deriveRulePaymentTreatment,
  deriveRuleRecoverableFromTenant,
  isRecoverableLike,
  normalizeTriStateDecision,
} from "./utils/leaseExpenseRuleDecisions";

import {
  asNumber,
  asArray,
  normalizeFrequency,
  normalizeRuleSource,
  normalizeCategoryKey,
  humanizeLabel,
  normalizeText,
  isUuid,
  firstPresent,
  isApprovedWorkflowStatus,
  isEvidenceAlignedVersion,
  EVIDENCE_ALIGNED_EXTRACTION_VERSION,
  LEGACY_EXTRACTION_VERSION
} from "./utils/leaseExpenseRuleParsers";

import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { getCurrentOrgId } from "@/services/api";
import { resolveWritableOrgId } from "@/lib/orgUtils";
import { saveLeaseConfig } from "@/services/camConfig";
import { devLog, devWarn } from "./utils/logger";
import { normalizeLeaseExpenseRule } from "./utils/leaseExpenseRuleTaxonomy";

import {
  derivePublishedToCam,
  deriveRuleAllocationBasis,
  deriveRuleApprovalStatus,
  deriveRuleBillingTreatment,
  deriveRuleExtractionStatus,
  deriveRuleRecoveryMethod,
  deriveRuleReconciliationFrequency,
  deriveRuleReconciliationRequired,
  deriveRuleReviewStatus,
  getRuleValidation,
  isRuleCamPublishable,
  isRuleResponsibilityKnown,
  resolveRuleWorkflowState,
} from "./utils/leaseExpenseRuleWorkflowState";
























function pickPreferredRuleSetWithApprovedChildren(ruleSets = [], rulesBySet = new Map()) {
  if (!Array.isArray(ruleSets) || ruleSets.length === 0) return null;
  const sorted = [...ruleSets].sort((a, b) => {
    const aVersion = Number(a?.version) || 0;
    const bVersion = Number(b?.version) || 0;
    if (aVersion !== bVersion) return bVersion - aVersion;
    return Date.parse(b?.updated_at || b?.created_at || "") - Date.parse(a?.updated_at || a?.created_at || "");
  });

  const latestV3WithEvidence = sorted.find((ruleSet) => {
    if (!isEvidenceAlignedVersion(ruleSet?.extraction_version)) return false;
    return (rulesBySet.get(ruleSet?.id) || []).some((rule) =>
      !isRuleSuperseded(rule) &&
      isEvidenceAlignedVersion(rule?.extraction_version) &&
      normalizeText(rule?.generation_source) !== "template_checklist" &&
      Boolean(String(firstPresent(rule?.exact_source_text, rule?.source) || "").trim())
    );
  });
  if (latestV3WithEvidence) return latestV3WithEvidence;

  const v3ApprovedOrPublished = sorted.find((ruleSet) =>
    isEvidenceAlignedVersion(ruleSet?.extraction_version) &&
    (
      isApprovedWorkflowStatus(ruleSet?.status) ||
      (rulesBySet.get(ruleSet?.id) || []).some((rule) =>
        !isRuleSuperseded(rule) && (isRuleApproved(rule) || Boolean(rule?.published_to_cam))
      )
    )
  );
  if (v3ApprovedOrPublished) return v3ApprovedOrPublished;

  const latestNonSuperseded = sorted.find((ruleSet) =>
    (rulesBySet.get(ruleSet?.id) || []).some((rule) => !isRuleSuperseded(rule))
  );
  if (latestNonSuperseded) return latestNonSuperseded;

  const olderApprovedRuleSet = sorted.find((ruleSet) =>
    isApprovedWorkflowStatus(ruleSet?.status) ||
    isApprovedWorkflowStatus(ruleSet?.approval_status) ||
    isApprovedWorkflowStatus(ruleSet?.review_status) ||
    (rulesBySet.get(ruleSet?.id) || []).some(isRuleApproved)
  );
  return olderApprovedRuleSet || sorted[0] || null;
}

function selectPreferredRuleSet(ruleSets = [], rulesBySet = new Map()) {
  return pickPreferredRuleSetWithApprovedChildren(ruleSets, rulesBySet);
}

export {
  deriveRuleCamEligible,
  deriveRuleRecoverableFromTenant,
};

function buildCamRuleLineItem(rule, lease, categoriesById = new Map()) {
  const category = categoriesById.get(rule?.expense_category_id);
  const validation = getRuleValidation(rule);
  return {
    lease_expense_rule_id: rule.id,
    rule_key: rule.rule_key || null,
    category: firstPresent(rule?.expense_category, rule?.category_name, category?.category_name, deriveRuleCategoryName(rule)),
    subcategory: firstPresent(rule?.expense_subcategory, rule?.subcategory_name, category?.subcategory_name, deriveRuleSubcategoryName(rule)),
    recovery_method: validation.recoveryMethod,
    allocation_basis: validation.allocationBasis,
    cap_amount: asNumber(firstPresent(rule?.cap_amount, rule?.cap_value)),
    cap_percent: asNumber(rule?.cap_percent),
    admin_fee_percent: asNumber(rule?.admin_fee_percent),
    gross_up_percent: asNumber(rule?.gross_up_percent),
    reconciliation_required: Boolean(rule?.reconciliation_required ?? deriveRuleReconciliationRequired(rule)),
    lease_id: lease?.id || rule?.lease_id || null,
    tenant_id: lease?.tenant_id || rule?.tenant_id || null,
    property_id: lease?.property_id || rule?.property_id || null,
    building_id: lease?.building_id || rule?.building_id || null,
    unit_id: lease?.unit_id || rule?.unit_id || null,
    
    exact_source_text: validation.exactSourceText,
    published_scope: {
      property_id: lease?.property_id || rule?.property_id || null,
      building_id: lease?.building_id || rule?.building_id || null,
      unit_id: lease?.unit_id || rule?.unit_id || null,
    },
  };
}

function canonicalRuleDedupKey(rule, index = 0) {
  const category = resolveCanonicalExpenseCategory(rule, index);
  return `${category.normalizedKey}::${normalizeCategoryKey(category.subcategoryName) || ""}`;
}

function scoreRuleForDedup(rule) {
  const state = resolveRuleWorkflowState(rule, normalizeText(rule?.approval_status) === "approved" ? "approved" : "draft");
  return [
    state.approvalStatus === "approved" ? 500 : 0,
    state.reviewStatus === "approved" ? 250 : 0,
    state.strongEvidence ? 200 : 0,
    Number.isFinite(Number(rule?.source_page)) ? 120 : 0,
    state.confidence != null ? Math.round(state.confidence * 100) : 0,
    deriveRuleExactSourceText(rule) ? 40 : 0,
    extractRuleValue(rule) != null ? 25 : 0,
  ].reduce((sum, score) => sum + score, 0);
}

function finalizeLeaseExpenseRules(rules = [], ruleSetStatus = "draft") {
  const deduped = new Map();

  (rules || []).forEach((rule, index) => {
    const category = resolveCanonicalExpenseCategory(rule, index);
    if (isRuleExcludedFromLeaseExpenses(rule, category.canonicalKey)) return;

    const workflowState = resolveRuleWorkflowState(rule, ruleSetStatus);
    const recoverableFromTenant = deriveRuleRecoverableFromTenant(rule);
    const operationalResponsibility = deriveRuleOperationalResponsibility(rule);
    const paymentTreatment = deriveRulePaymentTreatment(rule);
    const camEligible = deriveRuleCamEligible(rule);
    const billingTreatment = deriveRuleBillingTreatment(rule);
    const normalizedRule = {
      ...rule,
      normalized_key: category.normalizedKey,
      fallback_category_key: category.normalizedKey,
      category_name: category.categoryName,
      subcategory_name: category.subcategoryName || null,
      expense_category: category.categoryName,
      expense_subcategory: category.subcategoryName || null,
      operational_responsibility: isRuleResponsibilityKnown(rule) ? operationalResponsibility : "unknown",
      responsibility: isRuleResponsibilityKnown(rule) ? operationalResponsibility : "unknown",
      payment_treatment: paymentTreatment,
      included_in_base_rent: deriveRuleIncludedInBaseRent(rule),
      recoverable_from_tenant: recoverableFromTenant,
      cam_eligible: camEligible,
      billing_treatment: billingTreatment,
      recovery_method: firstPresent(rule?.recovery_method, deriveRuleRecoveryMethod(rule), "manual_review"),
      allocation_basis: firstPresent(rule?.allocation_basis, deriveRuleAllocationBasis(rule)),
      exact_source_text: workflowState.exactSourceText,
      
      confidence: workflowState.confidence ?? deriveRuleConfidence(rule),
      confidence_score: workflowState.confidence ?? deriveRuleConfidence(rule),
      extraction_status: workflowState.extractionStatus,
      review_status: workflowState.reviewStatus,
      approval_status: workflowState.approvalStatus,
      published_to_cam: workflowState.publishedToCam,
      row_status: workflowState.rowStatus,
      source: firstPresent(rule?.source, workflowState.exactSourceText),
      is_recoverable: ["yes", "conditional"].includes(recoverableFromTenant),
      is_fallback: rule?.is_fallback || workflowState.extractionStatus === "inferred",
    };

    const dedupKey = canonicalRuleDedupKey(normalizedRule, index);
    const existing = deduped.get(dedupKey);
    if (!existing || scoreRuleForDedup(normalizedRule) >= scoreRuleForDedup(existing)) {
      deduped.set(dedupKey, normalizedRule);
    }
  });

  return [...deduped.values()];
}

function normalizeRuleStatus(rule) {
  const raw = String(rule?.row_status || "").trim().toLowerCase();
  return raw || "needs_review";
}

function canonicalRulePersistenceKey(rule) {
  const category = normalizeCategoryKey(firstPresent(
    rule?.normalized_key,
    rule?.fallback_category_key,
    rule?.expense_category,
    rule?.category_name,
    rule?.category,
  ));
  const subcategory = normalizeCategoryKey(firstPresent(rule?.expense_subcategory, rule?.subcategory_name));
  const paymentTreatment = normalizeCategoryKey(firstPresent(rule?.payment_treatment, deriveRulePaymentTreatment(rule)));
  const recoveryMethod = normalizeCategoryKey(firstPresent(rule?.recovery_method, deriveRuleRecoveryMethod(rule)));
  return [category, subcategory, paymentTreatment, recoveryMethod].join("::");
}

function scorePersistedRuleForMerge(rule) {
  return [
    isProtectedHumanRule(rule) ? 1000 : 0,
    isRuleApproved(rule) ? 500 : 0,
    Boolean(rule?.published_to_cam) ? 300 : 0,
    isEvidenceAlignedVersion(rule?.extraction_version) ? 200 : 0,
    normalizeText(rule?.generation_source) === "template_checklist" ? -100 : 0,
    deriveRuleExactSourceText(rule) ? 80 : 0,
    Number.isFinite(Number(rule?.confidence_score || rule?.confidence))
      ? Math.round(Number(rule?.confidence_score || rule?.confidence) * 100)
      : 0,
  ].reduce((sum, score) => sum + score, 0);
}

// Read + filter only -- computes which existing rule ids are stale/unresolved
// (per isProtectedHumanRule's decision, unchanged) and therefore safe to
// supersede. Does NOT delete or update anything itself: the mechanical
// delete now happens server-side, folded into save_lease_expense_rule_set's
// own transaction via its p_superseded_rule_ids param (Phase 6R-2) -- this
// closes a real atomicity gap that existed when the delete was a separate,
// unguarded call before the RPC ever ran. SECURITY DEFINER bypasses RLS, so
// the RLS-denial marker-update fallback this function used to have is no
// longer needed.
async function computeSupersededRuleIds({ leaseId, ruleSetId }) {
  if (!leaseId || !ruleSetId) return [];

  const { data: existingRows, error: existingError } = await supabase
    .from("lease_expense_rules")
    .select("*")
    .eq("lease_id", leaseId)
    .eq("rule_set_id", ruleSetId);
  if (existingError) throw existingError;

  return (existingRows || [])
    .filter((rule) => !isProtectedHumanRule(rule))
    .map((rule) => rule.id)
    .filter(Boolean);
}

function normalizeRecoveryStatus(rule) {
  if (rule?.is_excluded) return "excluded";
  if (normalizeTriStateDecision(rule?.recoverable_from_tenant) === "conditional") return "conditional";
  if (normalizeRuleStatus(rule) === "uncertain") return "conditional";
  if (normalizeRuleStatus(rule) === "missing_value") return "needs_review";
  if (isRecoverableLike(rule) || ["yes", "conditional"].includes(deriveRuleRecoverableFromTenant(rule))) return "recoverable";
  if (rule?.mentioned_in_lease || deriveRuleExtractionStatus(rule) === "extracted") return "non_recoverable";
  return "needs_review";
}



function buildRuleCategorySeed(rule, index = 0) {
  return {
    category_name: deriveRuleCategoryName(rule),
    subcategory_name: deriveRuleSubcategoryName(rule),
    normalized_key: deriveRuleNormalizedKey(rule, index),
  };
}

async function ensurePersistentCategories({ orgId, categories = [], rules = [] }) {
  const seededByKey = new Map();
  const allCategories = Array.isArray(categories) ? [...categories] : [];

  for (const category of allCategories) {
    const normalizedKey = normalizeCategoryKey(category?.normalized_key || category?.subcategory_name || category?.category_name);
    if (!normalizedKey) continue;
    seededByKey.set(normalizedKey, {
      ...category,
      normalized_key: normalizedKey,
      category_name: category?.category_name || humanizeLabel(normalizedKey),
      subcategory_name: category?.subcategory_name || null,
    });
  }

  rules.forEach((rule, index) => {
    const seed = buildRuleCategorySeed(rule, index);
    if (!seed.normalized_key || seededByKey.has(seed.normalized_key)) return;
    seededByKey.set(seed.normalized_key, seed);
  });

  const normalizedKeys = [...seededByKey.keys()];
  if (!orgId || normalizedKeys.length === 0) {
    return { categories: allCategories, rules };
  }

  try {
    const { data: existingCategories, error: existingError } = await supabase
      .from("expense_categories")
      .select("id, category_name, subcategory_name, normalized_key, display_order")
      .or(`org_id.eq.${orgId},org_id.is.null`)
      .in("normalized_key", normalizedKeys);

    if (existingError) throw existingError;

    const categoryByKey = new Map();
    for (const category of existingCategories || []) {
      if (!category?.normalized_key || categoryByKey.has(category.normalized_key)) continue;
      categoryByKey.set(category.normalized_key, category);
    }

    const missingKeys = normalizedKeys.filter((key) => !categoryByKey.has(key));
    if (missingKeys.length > 0) {
      const insertPayload = missingKeys.map((key, index) => {
        const seed = seededByKey.get(key);
        return {
          org_id: orgId,
          is_system_default: false,
          is_active: true,
          display_order: 1000 + index,
          normalized_key: key,
          category_name: seed?.category_name || humanizeLabel(key),
          subcategory_name: seed?.subcategory_name || null,
        };
      });

      const { data: insertedCategories, error: insertError } = await supabase
        .from("expense_categories")
        .insert(insertPayload)
        .select("id, category_name, subcategory_name, normalized_key, display_order");

      if (insertError) {
        // RLS denies the insert when the current user/role isn't permitted to
        // create org-scoped categories (e.g. anon key, restricted member).
        // Don't fail the whole rule-save — continue with whatever categories
        // already exist (the seeded system defaults). Rules for the missing
        // keys will fall through to the text-only path with expense_category
        // populated but expense_category_id NULL, which we now allow.
        const code = String(insertError.code || "");
        const message = `${insertError.message || ""} ${insertError.details || ""}`;
        const isRlsDenial =
          code === "42501" ||
          /row-level security/i.test(message) ||
          /permission denied/i.test(message);
        if (isRlsDenial) {
          devWarn(
            `[leaseExpenseRuleService] expense_categories INSERT denied by RLS for ${insertPayload.length} key(s) — using existing seeded categories. Missing keys:`,
            insertPayload.map((p) => p.normalized_key),
          );
        } else {
          throw insertError;
        }
      } else {
        for (const category of insertedCategories || []) {
          if (!category?.normalized_key) continue;
          categoryByKey.set(category.normalized_key, category);
        }
      }
    }

    const mergedCategories = [
      ...allCategories.filter((category) => isUuid(category?.id)),
      ...[...categoryByKey.values()].filter((category) =>
        !allCategories.some((existing) => existing?.id === category.id)
      ),
    ];

    const resolvedRules = (rules || []).map((rule, index) => {
      const resolvedCategory =
        (isUuid(rule?.expense_category_id) && mergedCategories.find((category) => category.id === rule.expense_category_id)) ||
        categoryByKey.get(deriveRuleNormalizedKey(rule, index)) ||
        null;

      if (!resolvedCategory?.id) {
        return {
          ...rule,
          category_name: firstPresent(rule?.category_name, deriveRuleCategoryName(rule)),
          subcategory_name: firstPresent(rule?.subcategory_name, deriveRuleSubcategoryName(rule)),
          normalized_key: firstPresent(rule?.normalized_key, deriveRuleNormalizedKey(rule, index)),
        };
      }

      return {
        ...rule,
        expense_category_id: resolvedCategory.id,
        category_name: firstPresent(rule?.category_name, resolvedCategory.category_name, deriveRuleCategoryName(rule)),
        subcategory_name: firstPresent(rule?.subcategory_name, resolvedCategory.subcategory_name, deriveRuleSubcategoryName(rule)),
        normalized_key: resolvedCategory.normalized_key || deriveRuleNormalizedKey(rule, index),
      };
    });

    return { categories: mergedCategories, rules: resolvedRules };
  } catch (error) {
    if (!isMissingExpenseRuleTable(error)) throw error;
    return { categories: allCategories, rules };
  }
}

function buildLeaseConfigFromRules(lease, rules = [], categoriesById = new Map()) {
  const approvedRules = rules.filter(isRuleApproved);
  const camPublishedRules = approvedRules.filter((rule) =>
    Boolean(getRuleValidation(rule).publishedToCam)
  );
  const excludedExpenses = approvedRules
    .filter((rule) => rule.is_excluded || deriveRuleRecoverableFromTenant(rule) === "no" || deriveRuleCamEligible(rule) === "no")
    .map((rule) => {
      const category = categoriesById.get(rule.expense_category_id);
      return category?.normalized_key || category?.subcategory_name || category?.category_name || null;
    })
    .filter(Boolean);

  const cappedRule = camPublishedRules.find((rule) => rule.is_subject_to_cap);
  const baseYearRule = camPublishedRules.find((rule) => rule.has_base_year);
  const adminRule = camPublishedRules.find((rule) => rule.admin_fee_applicable && asNumber(rule.admin_fee_percent) != null);

  return {
    cam_applicable: camPublishedRules.length > 0,
    cam_cap_type: cappedRule?.cap_type || lease?.cam_cap_type || "none",
    cam_cap_rate: cappedRule?.cap_type !== "fixed" ? asNumber(cappedRule?.cap_value ?? lease?.cam_cap_rate) : asNumber(lease?.cam_cap_rate),
    cam_cap: cappedRule?.cap_type === "fixed" ? asNumber(cappedRule?.cap_value ?? lease?.cam_cap) : asNumber(lease?.cam_cap),
    base_year: baseYearRule?.base_year_type || null,
    base_year_amount: asNumber(baseYearRule?.base_year_amount ?? lease?.base_year_amount),
    expense_stop_amount: asNumber(lease?.expense_stop_amount),
    gross_up_clause: camPublishedRules.some((rule) => rule.gross_up_applicable) || Boolean(lease?.gross_up_clause),
    allocation_method: lease?.allocation_method || "",
    weight_factor: asNumber(lease?.weight_factor),
    excluded_expenses: [...new Set(excludedExpenses)],
    management_fee_pct: asNumber(lease?.management_fee_pct),
    controllable_cap_rate: cappedRule?.is_controllable ? asNumber(cappedRule?.cap_value) : null,
    non_cumulative_cap_base_year: cappedRule?.cap_type === "non_cumulative" ? asNumber(lease?.base_year_amount) : null,
    admin_fee_pct: asNumber(adminRule?.admin_fee_percent ?? lease?.admin_fee_pct),
    cam_rule_lines: camPublishedRules.map((rule) => buildCamRuleLineItem(rule, lease, categoriesById)),
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

function getLeaseWorkflowOutput(lease) {
  const workflow = lease?.extraction_data?.workflow_output;
  if (!workflow || typeof workflow !== "object") return null;
  if (Array.isArray(workflow?.records) && workflow.records[0]) return workflow.records[0];
  return workflow;
}

function getLeaseWorkflowExpenseRules(lease) {
  return asArray(getLeaseWorkflowOutput(lease)?.expense_rules);
}

function hasWorkflowExpenseRules(lease) {
  return getLeaseWorkflowExpenseRules(lease).length > 0;
}

function isMissingExpenseRuleTable(error) {
  if (!error) return false;
  const code = String(error.code || "").toUpperCase();
  if (code === "PGRST205" || code === "42P01") return true;
  const text = String(error.message || error.details || error.hint || "").toLowerCase();
  return /expense_categories|scope_expense_categories|lease_expense_rule_sets|lease_expense_rules|lease_expense_values|lease_expense_rule_clauses/.test(text)
    && /does not exist|could not find/.test(text);
}

export const leaseExpenseRuleService = {
  async loadRuleSet(leaseId) {
    if (!supabase || !leaseId) return { ruleSet: null, rules: [] };

    try {
      const { data: ruleSets, error } = await supabase
        .from("lease_expense_rule_sets")
        .select("*")
        .eq("lease_id", leaseId)
        .not("status", "eq", "archived")
        .order("version", { ascending: false });

      if (error) throw error;

      const setIds = (ruleSets || []).map((ruleSet) => ruleSet.id).filter(Boolean);
      const { data: ruleRows, error: ruleRowsError } = setIds.length > 0
        ? await supabase
          .from("lease_expense_rules")
          .select("*")
          .in("rule_set_id", setIds)
        : { data: [], error: null };
      if (ruleRowsError) throw ruleRowsError;

      const rulesBySet = new Map();
      for (const rule of ruleRows || []) {
        const existing = rulesBySet.get(rule.rule_set_id) || [];
        existing.push(rule);
        rulesBySet.set(rule.rule_set_id, existing);
      }

      const ruleSet = selectPreferredRuleSet(ruleSets || [], rulesBySet);
      if (!ruleSet) {
        return { ruleSet: null, rules: [] };
      }

      const { rules, valuesByRuleId, clausesByRuleId } = await loadRuleDependencies(ruleSet.id);
      const mergedRules = mergeRulesWithRelations(rules, valuesByRuleId, clausesByRuleId);
      const finalizedRules = finalizeLeaseExpenseRules(mergedRules, ruleSet?.status || "draft")
        .map(normalizeLeaseExpenseRule);

      return { ruleSet, rules: finalizedRules };
    } catch (error) {
      if (!isMissingExpenseRuleTable(error)) throw error;
      return { ruleSet: null, rules: [] };
    }
  },

  async loadRuleSets(leaseIds = []) {
    const tag = `[loadRuleSets leaseIds=${leaseIds?.length || 0}]`;
    if (!supabase || !Array.isArray(leaseIds) || leaseIds.length === 0) {
      devLog(`${tag} early return — no leaseIds`);
      return [];
    }

    try {
      const { data: ruleSets, error } = await supabase
        .from("lease_expense_rule_sets")
        .select("*")
        .in("lease_id", leaseIds)
        .not("status", "eq", "archived")
        .order("version", { ascending: false });

      if (error) {
        console.error(`${tag} rule_sets query failed:`, error);
        throw error;
      }
      devLog(`${tag} rule_sets read: ${ruleSets?.length || 0}`, ruleSets?.map((s) => ({ id: s.id?.slice(0, 8), lease: s.lease_id?.slice(0, 8), v: s.version, status: s.status })));

      const ruleSetsByLeaseId = new Map();
      for (const ruleSet of ruleSets || []) {
        const existing = ruleSetsByLeaseId.get(ruleSet.lease_id) || [];
        existing.push(ruleSet);
        ruleSetsByLeaseId.set(ruleSet.lease_id, existing);
      }

      const allRuleSetIds = (ruleSets || []).map((ruleSet) => ruleSet.id).filter(Boolean);
      if (allRuleSetIds.length === 0) {
        return [];
      }

      const { data: allRules, error: rulesError } = await supabase
        .from("lease_expense_rules")
        .select("*")
        .in("rule_set_id", allRuleSetIds);

      if (rulesError) {
        console.error(`${tag} rules query failed:`, rulesError);
        throw rulesError;
      }
      devLog(`${tag} rules read: ${allRules?.length || 0} for ${allRuleSetIds.length} rule_set(s)`);

      const rulesBySet = new Map();
      for (const rule of allRules || []) {
        const existing = rulesBySet.get(rule.rule_set_id) || [];
        existing.push(rule);
        rulesBySet.set(rule.rule_set_id, existing);
      }

      const latestRuleSets = [...ruleSetsByLeaseId.values()]
        .map((leaseRuleSets) => selectPreferredRuleSet(leaseRuleSets, rulesBySet))
        .filter(Boolean);
      const ruleSetIds = latestRuleSets.map((ruleSet) => ruleSet.id);
      if (ruleSetIds.length === 0) {
        return [];
      }

      const selectedRuleSetIdLookup = new Set(ruleSetIds);
      const rules = (allRules || []).filter((rule) => selectedRuleSetIdLookup.has(rule.rule_set_id));

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

      const persistedEntries = latestRuleSets.map((ruleSet) => {
        const rulesForSet = (rules || []).filter((rule) => rule.rule_set_id === ruleSet.id);
        const mergedRules = mergeRulesWithRelations(rulesForSet, valuesByRuleId, clausesByRuleId);
        const finalizedRules = finalizeLeaseExpenseRules(mergedRules, ruleSet.status || "draft")
          .map(normalizeLeaseExpenseRule);
        devLog(`${tag} lease ${ruleSet.lease_id?.slice(0, 8)} → ${rulesForSet.length} raw → ${finalizedRules.length} finalized (after dedup/exclude)`);
        return {
          leaseId: ruleSet.lease_id,
          ruleSet,
          rules: finalizedRules,
        };
      });
      devLog(`${tag} returning ${persistedEntries.length} entries`);

      return persistedEntries;
    } catch (error) {
      console.error(`${tag} FAILED`, error);
      return [];
    }
  },

  async recalculateRuleSetStatus(ruleSetId) {
    if (!supabase || !ruleSetId) return null;

    const { data: rules, error: rulesError } = await supabase
      .from("lease_expense_rules")
      .select("*")
      .eq("rule_set_id", ruleSetId);
    if (rulesError) throw rulesError;

    const { data: ruleSet, error: ruleSetError } = await supabase
      .from("lease_expense_rule_sets")
      .select("id, lease_id")
      .eq("id", ruleSetId)
      .single();
    if (ruleSetError) throw ruleSetError;

    // Status derivation (deriveRuleSetStatusFromRules) stays client-side --
    // only the mechanical persistence moves server-side.
    const nextStatus = deriveRuleSetStatusFromRules(rules || []);

    const result = await invokeEdgeFunction("update-lease-expense-rule-set-status", {
      rule_set_id: ruleSetId,
      lease_id: ruleSet.lease_id,
      status: nextStatus,
    });

    return {
      id: result.rule_set_id,
      status: result.status,
      approved_at: result.approved_at,
    };
  },

  // Diagnostic: dump the full state of the lease expense-rule pipeline for
  // a single lease. Used by the backfill UI before each persist attempt so
  // we can see EXACTLY where rules come from (or fail to come from). Pure
  // read-only — does not write anything.
  async diagnoseExpenseRulePipeline(lease) {
    if (!lease?.id) return { error: "no_lease_id" };
    const extraction = lease.extraction_data || {};
    const workflow = extraction.workflow_output || null;
    const wfRecord = Array.isArray(workflow?.records) ? workflow.records[0] : workflow;
    const expenseRules = asArray(wfRecord?.expense_rules);
    const camProfile = wfRecord?.cam_profile || null;
    const clauses = asArray(wfRecord?.lease_clauses);
    const sourceFileId = lease.source_file_id ?? extraction.source_file_id ?? null;

    let sourceTextLength = 0;
    let sourceTextField = null;
    let uploadedFile = null;
    if (sourceFileId) {
      try {
        const { data } = await supabase
          .from("uploaded_files")
          .select("id, normalized_output, parsed_data, docling_raw, ui_review_payload, status")
          .eq("id", sourceFileId)
          .maybeSingle();
        uploadedFile = data || null;
        if (uploadedFile) {
          const candidates = [
            ...(uploadedFile?.docling_raw?._whole_document_llm_compact
              ? [["docling_raw._whole_document_llm_compact", uploadedFile.docling_raw]]
              : []),
            ["normalized_output.raw_text", uploadedFile?.normalized_output?.raw_text],
            ["normalized_output.text", uploadedFile?.normalized_output?.text],
            ["parsed_data.raw_text", uploadedFile?.parsed_data?.raw_text],
            ["parsed_data.text", uploadedFile?.parsed_data?.text],
            ["parsed_data.full_text", uploadedFile?.parsed_data?.full_text],
            ["docling_raw.full_text", uploadedFile?.docling_raw?.full_text],
            ["docling_raw.markdown", uploadedFile?.docling_raw?.markdown],
            ["docling_raw.text", uploadedFile?.docling_raw?.text],
            ["docling_raw.body", uploadedFile?.docling_raw?.body],
          ];
          for (const [field, value] of candidates) {
            const trimmed = extractDocumentTextCandidate(value);
            if (trimmed) {
              sourceTextLength = trimmed.length;
              sourceTextField = field;
              break;
            }
          }
        }
      } catch (err) {
        devWarn("[diagnose] uploaded_files lookup failed:", err?.message || err);
      }
    }

    // Existing persisted rules for this lease
    let existingRuleSets = [];
    let existingRules = [];
    try {
      const sets = await supabase
        .from("lease_expense_rule_sets")
        .select("id, status, version, created_at")
        .eq("lease_id", lease.id)
        .order("version", { ascending: false });
      existingRuleSets = sets.data || [];
      if (existingRuleSets.length > 0) {
        const setIds = existingRuleSets.map((s) => s.id);
        const rules = await supabase
          .from("lease_expense_rules")
          .select("id, rule_set_id, expense_category, review_status")
          .in("rule_set_id", setIds);
        existingRules = rules.data || [];
      }
    } catch (err) {
      devWarn("[diagnose] rule lookup failed:", err?.message || err);
    }

    return {
      lease_id: lease.id,
      tenant_name: lease.tenant_name,
      approved_lease_abstract_id: lease.approved_lease_abstract_id || lease.abstract_snapshot?.id || null,
      org_id: lease.org_id,
      property_id: lease.property_id,
      building_id: lease.building_id,
      unit_id: lease.unit_id,
      tenant_id: lease.tenant_id,
      abstract_status: lease.abstract_status,
      // Workflow payload state
      has_workflow_output: !!workflow,
      workflow_record_count: Array.isArray(workflow?.records) ? workflow.records.length : (workflow ? 1 : 0),
      expense_rules_count: expenseRules.length,
      expense_rule_categories: expenseRules.map((r) => r?.expense_category).filter(Boolean),
      cam_profile_present: !!camProfile,
      clause_records_count: clauses.length,
      // Source text state
      source_file_id: sourceFileId,
      source_file_found: !!uploadedFile,
      source_file_status: uploadedFile?.status || null,
      source_text_length: sourceTextLength,
      source_text_field: sourceTextField,
      // Persisted state
      existing_rule_sets_count: existingRuleSets.length,
      existing_rule_sets: existingRuleSets,
      existing_rules_count: existingRules.length,
    };
  },

  // Fast path used during Lease Approval. Reads the expense_rules array
  // the workflow extractor already produced (lives on
  // `lease.extraction_data.workflow_output.expense_rules`) and persists it
  // to `lease_expense_rule_sets` + `lease_expense_rules` without re-running
  // the LLM. Idempotent: if an existing rule set is provided, the rules are
  // upserted onto it; otherwise a new versioned set is created.
  //
  // Filters out anything that maps to base rent — base rent is a rent
  // schedule concept, not a lease expense rule (per product spec).
  // Returns whatever saveRuleSet returns ({ ruleSet, rules }).
  async persistExpenseRulesFromWorkflow({
    lease,
    categories = [],
    status = "draft",
    existingRuleSetId = null,
    createdFrom = "workflow",
    approver = null,
    suppressHttpError = false,
  } = {}) {
    const tag = `[persistExpenseRulesFromWorkflow lease=${lease?.id}]`;
    if (!supabase || !lease?.id) {
      devWarn(`${tag} skipped: no supabase or no lease.id`);
      return { ruleSet: null, rules: [] };
    }
    const workflowRules = getLeaseWorkflowExpenseRules(lease);
    devLog(`${tag} workflow_rules received: ${workflowRules.length}`);
    if (workflowRules.length === 0) {
      const wfOut = lease?.extraction_data?.workflow_output;
      devWarn(`${tag} no workflow expense_rules. extraction_data keys=`, Object.keys(lease?.extraction_data || {}), "workflow_output keys=", wfOut ? Object.keys(wfOut) : null);
      return { ruleSet: null, rules: [] };
    }

    // Strip base_rent / base rent / rent rules. saveRuleSet's resolver will
    // also drop unmappable rules but skipping here keeps the audit log clean.
    const BASE_RENT_KEYS = new Set(["base_rent", "rent", "minimum_rent", "fixed_rent"]);
    const filtered = workflowRules.filter((r) => {
      const key = String(r?.expense_category || r?.normalized_key || "").toLowerCase();
      return !BASE_RENT_KEYS.has(key);
    });
    devLog(`${tag} after base-rent strip: ${filtered.length} rules; categories=`, filtered.map((r) => r?.expense_category));

    // Reshape workflow rule → the shape saveRuleSet expects. Most fields
    // are passed through; we just bridge a few aliases the persister reads.
    const rules = filtered.map((r) => ({
      ...r,
      normalized_key: r.expense_category || r.normalized_key,
      category_name: r.category_name || r.expense_subcategory || null,
      confidence: r.confidence_score ?? r.confidence ?? null,
      source: r.exact_source_text || r.source_clause || r.notes || null,
      frequency: r.billing_frequency || null,
      mentioned_in_lease: r.extraction_status !== "not_found",
    }));

    // Idempotency: reuse the most-recent non-archived rule_set for this
    // lease as the target so we don't pile up phantom versions per click.
    //
    // Rule:
    //   - If latest rule_set is APPROVED and extraction_version matches,
    //     reuse it. The upsert by (rule_set_id, rule_key) guarantees
    //     approved rules with user-reviewed fields are NOT overwritten
    //     because they share the same rule_key and the persistence layer
    //     keeps the existing approved review_status/approval_status.
    //   - If latest is APPROVED and extraction_version is different, leave
    //     it frozen and create a NEW draft set for the new extraction.
    //   - If latest is DRAFT, reuse it regardless of version.
    let targetRuleSetId = existingRuleSetId;
    const EXTRACTION_VERSION_FOR_LOOKUP = "v1.2026.05.19";
    if (!targetRuleSetId) {
      try {
        const { data: existingSets } = await supabase
          .from("lease_expense_rule_sets")
          .select("id, status, version, extraction_version")
          .eq("lease_id", lease.id)
          .not("status", "eq", "archived")
          .order("version", { ascending: false })
          .limit(1);
        const latest = existingSets?.[0];
        if (latest?.id) {
          const sameExtractionVersion =
            !latest.extraction_version || latest.extraction_version === EXTRACTION_VERSION_FOR_LOOKUP;
          if (latest.status !== "approved" || sameExtractionVersion) {
            targetRuleSetId = latest.id;
            devLog(
              `${tag} reusing existing rule_set ${latest.id} (v${latest.version}, status=${latest.status}, ev=${latest.extraction_version || "—"})`,
            );
          } else {
            devLog(
              `${tag} latest rule_set is approved with different extraction_version (${latest.extraction_version}) — creating a new draft for ${EXTRACTION_VERSION_FOR_LOOKUP}`,
            );
          }
        }
      } catch (err) {
        devWarn(`${tag} existing rule_set lookup failed:`, err?.message || err);
      }
    }

    let result = { ruleSet: null, rules: [] };
    try {
      result = await this.saveRuleSet({
        lease,
        rules,
        status,
        existingRuleSetId: targetRuleSetId,
        categories,
        createdFrom,
        approver,
        suppressHttpError,
      });
      devLog(`${tag} saveRuleSet returned ${result?.rules?.length || 0} persisted rules; ruleSet=`, result?.ruleSet?.id);
    } catch (err) {
      console.error(`${tag} saveRuleSet THREW:`, err?.message || err, err?.details || "", err?.code || "");
      throw err;
    }
    return result;
  },

  async saveRuleSet({ lease, rules = [], status = "draft", existingRuleSetId = null, categories = [], createdFrom = "workflow", approver = null, suppressHttpError = false }) {
    if (!supabase || !lease?.id) throw new Error("Lease is required to save expense rules");

    const tag = `[saveRuleSet lease=${lease?.id}]`;
    const orgId = await resolveWorkflowOrgId(lease);
    if (!orgId) {
      throw new Error("Unable to resolve organization for lease expense rules");
    }

    const incomingExtractionVersion = firstPresent(
      ...((rules || []).map((rule) => rule?.extraction_version)),
      normalizeText(createdFrom).includes("v3") ? EVIDENCE_ALIGNED_EXTRACTION_VERSION : null,
      normalizeText(createdFrom).includes("lease_rule_pipeline") ? EVIDENCE_ALIGNED_EXTRACTION_VERSION : null,
      LEGACY_EXTRACTION_VERSION,
    );
    const isEvidenceAlignedSave = isEvidenceAlignedVersion(incomingExtractionVersion);
    const normalizedRules = finalizeLeaseExpenseRules(rules, status);
    const { categories: persistedCategories, rules: resolvedRules } = await ensurePersistentCategories({
      orgId,
      categories,
      rules: normalizedRules,
    });
    const categoriesById = new Map((persistedCategories || []).map((category) => [category.id, category]));
    const now = new Date().toISOString();
    let ruleSetId = existingRuleSetId;
    let currentVersion = 1;

    // ── Version-management DECISION only ────────────────────────────────
    // This block decides which rule_set to target (reuse an existing id,
    // or create a new one at the next version) and what version number to
    // use. It no longer writes to lease_expense_rule_sets itself -- that
    // mechanical write now happens inside save_lease_expense_rule_set (one
    // transaction with the rules/values/clauses write + the audit row).
    // ruleSetId stays null through this block exactly when a new rule_set
    // row should be created (the RPC's p_rule_set_id contract).
    if (ruleSetId) {
      const { data: targetRuleSet } = await supabase
        .from("lease_expense_rule_sets")
        .select("version")
        .eq("id", ruleSetId)
        .eq("org_id", orgId)
        .maybeSingle();
      currentVersion = Number(targetRuleSet?.version) || currentVersion;
    } else {
      const { data: existingSets } = await supabase
        .from("lease_expense_rule_sets")
        .select("*")
        .eq("lease_id", lease.id)
        .not("status", "eq", "archived")
        .order("version", { ascending: false })
        .limit(5);

      if (existingSets && existingSets.length > 0) {
        const latestSet = existingSets[0];
        const latestVersion = Number(latestSet.version) || 1;
        currentVersion = latestVersion;
        let latestRows = [];
        try {
          const { data: rows, error: rowsError } = await supabase
            .from("lease_expense_rules")
            .select("*")
            .eq("rule_set_id", latestSet.id)
            .eq("lease_id", lease.id);
          if (rowsError) throw rowsError;
          latestRows = rows || [];
        } catch (error) {
          devWarn(`${tag} latest rule_set child lookup skipped:`, error?.message || error);
        }

        const latestHasProtectedRows = latestRows.some(isProtectedHumanRule);
        const latestVersionMatches = normalizeText(latestSet.extraction_version) === normalizeText(incomingExtractionVersion);
        const latestIsFrozen = isApprovedWorkflowStatus(latestSet.status) || latestHasProtectedRows;
        const shouldCreateNewVersion = isEvidenceAlignedSave && !latestVersionMatches && latestIsFrozen;

        if (shouldCreateNewVersion) {
          currentVersion = latestVersion + 1;
          devLog(`${tag} will create v${currentVersion} rule_set for ${incomingExtractionVersion}; preserving protected rows from prior set`);
        } else {
          ruleSetId = latestSet.id;
          currentVersion = latestVersion;
          devLog(`${tag} reusing rule_set ${ruleSetId} (v${currentVersion}) for ${incomingExtractionVersion}`);
        }
      } else {
        currentVersion = 1;
      }
    }

    // Save every rule we have a canonical category text for, even if the
    // expense_categories lookup failed (table missing, RLS denial, or org
    // hasn't seeded). The `expense_category` text column is now the source
    // of truth — the FK to expense_categories is nice-to-have for joins,
    // but losing it must not lose the rule. Previously this filter dropped
    // every rule whenever expense_categories was unavailable, which is why
    // the page showed 0 after approval.
    const finalized = finalizeLeaseExpenseRules(resolvedRules, status);
    const savableRules = finalized.filter((rule) => {
      if (isUuid(rule?.expense_category_id)) return true;
      const canonicalKey = rule?.normalized_key || rule?.fallback_category_key || rule?.expense_category;
      return Boolean(canonicalKey);
    });
    const unmappedCount = finalized.length - savableRules.length;
    if (unmappedCount > 0) {
      devWarn(`[leaseExpenseRuleService] saveRuleSet: ${unmappedCount} rules dropped (no canonical category)`);
    }
    const approvedAtIso = status === "approved" ? now : null;
    const computeRuleKey = (ruleObj) => {
      if (ruleObj.rule_key) return ruleObj.rule_key;
      const norm = (v) => String(v ?? "").toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
      const category = norm(firstPresent(ruleObj.expense_category, ruleObj.category_name, deriveRuleCategoryName(ruleObj)));
      const subcategory = norm(firstPresent(ruleObj.expense_subcategory, ruleObj.subcategory_name, deriveRuleSubcategoryName(ruleObj)));
      const type = norm(ruleObj.rule_type);
      const sourceKey = norm(ruleObj.source_field_key);
      return `${lease.id}_${type}_${category}_${subcategory}_${sourceKey}`;
    };
    // Maps rule_key -> original source rule object, captured before dedup
    // collapses rulePayloads, so the values/clauses builder below can still
    // look up extracted_value/manual_value/frequency/clauses/etc. for
    // whichever payload survives dedup.
    const ruleSourceByKey = new Map();
    let rulePayloads = savableRules.map((rule) => {
      // Only include `id` when the rule actually has a UUID — sending
      // `id: undefined` in a PostgREST upsert payload triggers a 400 on
      // some clients because PostgREST expects either a complete `id` per
      // row or none. The strip-missing-column retry was masking this with
      // an unnecessary round-trip.
      const exactSourceText = deriveRuleExactSourceText(rule);
      const ruleKey = computeRuleKey(rule);
      ruleSourceByKey.set(ruleKey, rule);
      const payload = {
        rule_set_id: ruleSetId,
        rule_key: ruleKey,
        rule_type: rule.rule_type || null,
        source_field_key: rule.source_field_key || null,
        tenant_share_percent: asNumber(rule.tenant_share_percent),
        estimated_annual_amount: asNumber(rule.estimated_annual_amount),
        estimated_monthly_amount: asNumber(rule.estimated_monthly_amount),
        extraction_version: rule.extraction_version || incomingExtractionVersion,
        source_hash: exactSourceText ? String(exactSourceText).toLowerCase().slice(0, 80) : null,
        generation_source: rule.generation_source || createdFrom || "workflow",
        expense_category_id: isUuid(rule?.expense_category_id) ? rule.expense_category_id : null,
        // Denormalized scope so the Lease Expense Rules page can filter
        // without joining lease_expense_rule_sets. The migration backfills
        // these for existing rows.
        org_id: orgId,
        lease_id: lease.id,
        tenant_id: rule.tenant_id || lease.tenant_id || null,
        property_id: lease.property_id || null,
        building_id: lease.building_id || null,
        unit_id: lease.unit_id || null,
        approved_lease_abstract_id: lease.approved_lease_abstract_id || lease.abstract_snapshot?.id || null,
        created_from: createdFrom,
        approved_by: deriveRuleReviewStatus(rule) === "approved" ? (isUuid(approver) ? approver : null) : null,
        approved_at: deriveRuleReviewStatus(rule) === "approved" ? approvedAtIso : null,
        expense_category: firstPresent(rule.expense_category, rule.category_name, deriveRuleCategoryName(rule)),
        expense_subcategory: firstPresent(rule.expense_subcategory, rule.subcategory_name, deriveRuleSubcategoryName(rule)),
        operational_responsibility: deriveRuleOperationalResponsibility(rule),
        payment_treatment: deriveRulePaymentTreatment(rule),
        included_in_base_rent: deriveRuleIncludedInBaseRent(rule),
        recoverable_from_tenant: deriveRuleRecoverableFromTenant(rule),
        cam_eligible: deriveRuleCamEligible(rule),
        billing_treatment: deriveRuleBillingTreatment(rule),
        recovery_method: deriveRuleRecoveryMethod(rule),
        allocation_basis: deriveRuleAllocationBasis(rule),
        row_status: normalizeRuleStatus(rule),
        mentioned_in_lease: Boolean(rule.mentioned_in_lease || normalizeRuleStatus(rule) !== "not_mentioned"),
        is_recoverable: ["yes", "conditional"].includes(deriveRuleRecoverableFromTenant(rule)),
        is_excluded: Boolean(rule.is_excluded),
        is_controllable: Boolean(rule.is_controllable),
        is_subject_to_cap: Boolean(rule.is_subject_to_cap),
        cap_type: rule.cap_type || null,
        cap_value: asNumber(rule.cap_value),
        cap_amount: asNumber(firstPresent(rule.cap_amount, rule.cap_value)),
        cap_percent: asNumber(rule.cap_percent),
        has_base_year: Boolean(rule.has_base_year),
        base_year_type: rule.base_year_type || null,
        base_year: firstPresent(rule.base_year, rule.base_year_type),
        base_year_amount: asNumber(rule.base_year_amount),
        expense_stop_amount: asNumber(rule.expense_stop_amount),
        gross_up_applicable: Boolean(rule.gross_up_applicable),
        gross_up_percent: asNumber(rule.gross_up_percent),
        admin_fee_applicable: Boolean(rule.admin_fee_applicable),
        admin_fee_percent: asNumber(rule.admin_fee_percent),
        billing_frequency: normalizeFrequency(rule.billing_frequency || rule.frequency),
        reconciliation_required: deriveRuleReconciliationRequired(rule),
        reconciliation_frequency: deriveRuleReconciliationFrequency(rule),
        
        exact_source_text: deriveRuleExactSourceText(rule),
        confidence_score: deriveRuleConfidence(rule),
        extraction_status: deriveRuleExtractionStatus(rule),
        review_status: deriveRuleReviewStatus(rule),
        approval_status: deriveRuleApprovalStatus(rule, status),
        published_to_cam: derivePublishedToCam({
          ...rule,
          review_status: deriveRuleReviewStatus(rule),
          approval_status: deriveRuleApprovalStatus(rule, status),
        }),
        notes: rule.notes || null,
        confidence: deriveRuleConfidence(rule),
        source: normalizeRuleSource(firstPresent(rule.source, deriveRuleExactSourceText(rule))),
      };
      if (isUuid(rule?.id)) payload.id = rule.id;
      return payload;
    });

    // ── Preserve user-approved fields on upsert ─────────────────────────
    // Per Part 1 spec idempotency rule:
    //   "If rule_key exists and review_status is approved, do not overwrite
    //    user-reviewed fields."
    //
    // We fetch existing rows for the target rule_set keyed by rule_key,
    // and for any row whose existing review_status is 'approved', we
    // override the new payload's review/approval/published fields with the
    // preserved values. Without this, an extract click that hits the same
    // rule_key UPSERTs the row back to 'needs_review' and silently undoes
    // the user's approval.
    let preservedByKey = new Map();
    let protectedByCanonicalKey = new Map();
    // Note: no longer gated on `ruleSetId` being already-known -- in the
    // original code ruleSetId was always truthy by this point (the rule_set
    // row was created synchronously above); now that creation is deferred
    // to the RPC, ruleSetId can still be null here for a brand-new version.
    // The query below is lease_id-scoped (not rule_set-scoped) anyway, so
    // this always ran in practice -- keeping it ungated preserves that.
    if (rulePayloads.length > 0) {
      try {
        const ruleKeys = rulePayloads.map((p) => p.rule_key).filter(Boolean);
        if (ruleKeys.length > 0) {
          const { data: existing } = await supabase
            .from("lease_expense_rules")
            .select("*")
            .eq("lease_id", lease.id)
            .in("rule_key", ruleKeys);
          for (const row of existing || []) {
            preservedByKey.set(row.rule_key, row);
          }
        }
        const { data: existingForLease, error: existingForLeaseError } = await supabase
          .from("lease_expense_rules")
          .select("*")
          .eq("lease_id", lease.id);
        if (existingForLeaseError) throw existingForLeaseError;
        for (const row of existingForLease || []) {
          if (isRuleSuperseded(row) || !isProtectedHumanRule(row)) continue;
          const canonicalKey = canonicalRulePersistenceKey(row);
          const current = protectedByCanonicalKey.get(canonicalKey);
          if (!current || scorePersistedRuleForMerge(row) > scorePersistedRuleForMerge(current)) {
            protectedByCanonicalKey.set(canonicalKey, row);
          }
        }
      } catch (err) {
        devWarn(`${tag} existing-rule pre-fetch skipped:`, err?.message || err);
      }
    }

    if (protectedByCanonicalKey.size > 0) {
      let canonicalMergedCount = 0;
      for (const payload of rulePayloads) {
        const protectedRow = protectedByCanonicalKey.get(canonicalRulePersistenceKey(payload));
        if (!protectedRow) continue;
        canonicalMergedCount += 1;
        payload.id = protectedRow.id || payload.id;
        payload.rule_key = protectedRow.rule_key || payload.rule_key;
        payload.review_status = normalizeText(protectedRow.review_status) === "reviewed" ? "approved" : (protectedRow.review_status || payload.review_status);
        payload.approval_status = protectedRow.approval_status || payload.approval_status;
        payload.approved_by = protectedRow.approved_by ?? payload.approved_by;
        payload.approved_at = protectedRow.approved_at ?? payload.approved_at;
        payload.published_to_cam = protectedRow.published_to_cam ?? payload.published_to_cam;
        if (protectedRow.notes && !payload.notes) payload.notes = protectedRow.notes;
      }
      if (canonicalMergedCount > 0) {
        devLog(`[leaseExpenseRuleService] saveRuleSet merged ${canonicalMergedCount} v3 candidate(s) into existing protected human rule(s)`);
      }
    }

    if (rulePayloads.length > 1) {
      const payloadsByCanonicalKey = new Map();
      for (const payload of rulePayloads) {
        const key = canonicalRulePersistenceKey(payload);
        const existing = payloadsByCanonicalKey.get(key);
        if (!existing || scorePersistedRuleForMerge(payload) >= scorePersistedRuleForMerge(existing)) {
          payloadsByCanonicalKey.set(key, payload);
        }
      }
      rulePayloads = [...payloadsByCanonicalKey.values()];
    }

    if (rulePayloads.length > 1) {
      const payloadsByRuleKey = new Map();
      for (const payload of rulePayloads) {
        const existing = payloadsByRuleKey.get(payload.rule_key);
        if (!existing || scorePersistedRuleForMerge(payload) >= scorePersistedRuleForMerge(existing)) {
          payloadsByRuleKey.set(payload.rule_key, payload);
        }
      }
      rulePayloads = [...payloadsByRuleKey.values()];
    }

    if (preservedByKey.size > 0) {
      let preservedApprovedCount = 0;
      for (const payload of rulePayloads) {
        const existing = preservedByKey.get(payload.rule_key);
        if (!existing) continue;
        const isFromAbstractSync = existing.created_from === "approved_lease_abstract" || existing.generation_source === "lease_review_acceptance";
        const existingReviewStatus = normalizeText(existing.review_status) === "reviewed" ? "approved" : normalizeText(existing.review_status);
        const shouldPreserveApproved = (existingReviewStatus === "approved" || normalizeText(existing.approval_status) === "approved");
        if (shouldPreserveApproved && !isFromAbstractSync) {
          preservedApprovedCount += 1;
          payload.review_status = existingReviewStatus || payload.review_status;
          payload.approval_status = "approved";
          payload.approved_by = existing.approved_by ?? payload.approved_by;
          payload.approved_at = existing.approved_at ?? payload.approved_at ?? approvedAtIso ?? now;
          payload.published_to_cam = derivePublishedToCam({
            ...payload,
            published_to_cam: existing.published_to_cam ?? payload.published_to_cam,
          });
          // Keep human-edited notes too if they exist
          if (existing.notes && !payload.notes) payload.notes = existing.notes;
        }
      }
      if (preservedApprovedCount > 0) {
        devLog(`[leaseExpenseRuleService] saveRuleSet preserved approval on ${preservedApprovedCount} existing rule(s)`);
      }
    }

    let supersededRuleIds = [];
    if (isEvidenceAlignedSave && ruleSetId) {
      try {
        supersededRuleIds = await computeSupersededRuleIds({ leaseId: lease.id, ruleSetId });
        if (supersededRuleIds.length > 0) {
          devLog(
            `[leaseExpenseRuleService] saveRuleSet will supersede ${supersededRuleIds.length} stale unresolved rule(s) as part of the v3 upsert`,
          );
        }
      } catch (error) {
        devWarn("[leaseExpenseRuleService] stale rule supersede computation warning:", error?.message || error);
      }
    }

    // ── Values/clauses source data, keyed by rule_key ──────────────────
    // The RPC hasn't run yet, so newly-created rules' DB ids aren't known
    // client-side -- values/clauses reference rules by rule_key instead
    // (a deliberate improvement over the prior expense_category_id-based
    // matching, which wasn't guaranteed unique when multiple rules shared
    // a category). ruleSourceByKey was captured above, before dedup.
    const valuePayloads = [];
    const clausePayloads = [];
    for (const payload of rulePayloads) {
      const rule = ruleSourceByKey.get(payload.rule_key) || {};
      const finalValue = extractRuleValue(rule);
      const hasValuePayload =
        finalValue != null ||
        asNumber(rule?.base_year_amount) != null ||
        rule?.frequency;

      if (hasValuePayload) {
        valuePayloads.push({
          rule_key: payload.rule_key,
          base_year_amount: asNumber(rule.base_year_amount),
          extracted_value: asNumber(rule.extracted_value),
          manual_value: asNumber(rule.manual_value),
          final_value: finalValue,
          frequency: normalizeFrequency(rule.frequency),
          value_source: rule.manual_value != null ? "manual" : rule.extracted_value != null ? "extracted" : rule.value_source || null,
        });
      }

      clausePayloads.push(
        ...extractRuleClauses(rule, lease.id, payload.rule_key).map((clause) => ({ ...clause, rule_key: payload.rule_key })),
      );
    }

    // ── Mechanical multi-table write, now server-owned ──────────────────
    // save_lease_expense_rule_set (edge function -> SECURITY DEFINER RPC)
    // upserts the rule_set row (creating one if ruleSetId is null), upserts
    // lease_expense_rules on (lease_id, rule_key), replaces
    // lease_expense_values/lease_expense_rule_clauses scoped to the saved
    // rules, and writes one canonical audit_logs row -- all in one
    // transaction. Everything above this point (derivation, versioning
    // decision, protected-row preservation/merge, rule-key computation)
    // is unchanged client-side logic; this call replaces only the mechanical
    // persistence step that used to be 3+ independent, unguarded Supabase
    // calls with zero audit logging.
    const suppressSaveHttpError = suppressHttpError || normalizeText(createdFrom) === "approve_abstract";
    const rpcResult = await invokeEdgeFunction("save-lease-expense-rule-set", {
      lease_id: lease.id,
      rule_set_id: ruleSetId,
      version: currentVersion,
      status,
      extraction_version: incomingExtractionVersion,
      property_id: lease.property_id || null,
      rules: rulePayloads,
      values: valuePayloads,
      clauses: clausePayloads,
      superseded_rule_ids: supersededRuleIds,
      suppress_http_error: suppressSaveHttpError,
    });
    if (rpcResult?.save_failed) {
      throw new Error(rpcResult.message || "Could not save lease expense rule set");
    }
    const resolvedRuleSetId = rpcResult?.rule_set_id || ruleSetId;

    // Status recalculation and the conditional lease-config sync stay
    // separate, unchanged client-side calls -- both depend on decision
    // logic (deriveRuleSetStatusFromRules / buildLeaseConfigFromRules) too
    // large/risky to port into the RPC per the confirmed narrow scope.
    try {
      await this.recalculateRuleSetStatus(resolvedRuleSetId);
    } catch (error) {
      devWarn("[leaseExpenseRuleService] rule set status recalculation warning:", error?.message || error);
    }

    const persisted = await this.loadRuleSet(lease.id);
    if (status === "approved") {
      try {
        await saveLeaseConfig(lease.id, buildLeaseConfigFromRules(lease, persisted.rules, categoriesById));
      } catch (error) {
        devWarn("[leaseExpenseRuleService] lease config sync warning:", error);
      }
    }

    return {
      ...persisted,
      ruleSet: persisted.ruleSet || { id: resolvedRuleSetId, status, version: currentVersion },
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

  async ensureApprovedRuleSet() {
    throw new Error("Expense rules must be persisted from primary workflow_output.expense_rules via persistExpenseRulesFromWorkflow().");
  },

  getOperationalResponsibility(rule) {
    return deriveRuleOperationalResponsibility(rule);
  },

  getPaymentTreatment(rule) {
    return deriveRulePaymentTreatment(rule);
  },

  getRecoverableDecision(rule) {
    return deriveRuleRecoverableFromTenant(rule);
  },

  getCamEligibleDecision(rule) {
    return deriveRuleCamEligible(rule);
  },

  getRecoveryMethod(rule) {
    return deriveRuleRecoveryMethod(rule);
  },

  getAllocationBasis(rule) {
    return deriveRuleAllocationBasis(rule);
  },

  getExactSourceText(rule) {
    return deriveRuleExactSourceText(rule);
  },

  getSourcePage(rule) {
    return deriveRuleSourcePage(rule);
  },

  getRuleValidation(rule) {
    return getRuleValidation(rule);
  },

  isRuleApproved(rule) {
    return isRuleApproved(rule);
  },

  isRuleCamPublishable(rule) {
    return isRuleCamPublishable(rule);
  },

  derivePublishedToCam(rule) {
    return derivePublishedToCam(rule);
  },

  deriveRuleSetStatusFromRules(rules = []) {
    return deriveRuleSetStatusFromRules(rules);
  },

  pickPreferredRuleSetWithApprovedChildren(ruleSets = [], rulesBySet = new Map()) {
    return pickPreferredRuleSetWithApprovedChildren(ruleSets, rulesBySet);
  },

  getBillingTreatment(rule) {
    return deriveRuleBillingTreatment(rule);
  },

  normalizeRecoveryStatus,
};

export default leaseExpenseRuleService;
