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

function ruleSemanticFingerprint(rule, index = 0) {
  const category = resolveCanonicalExpenseCategory(rule, index);
  return [
    category.normalizedKey,
    category.subcategoryName,
    deriveRuleOperationalResponsibility(rule),
    deriveRulePaymentTreatment(rule),
    deriveRuleRecoveryMethod(rule),
    deriveRuleAllocationBasis(rule),
    rule?.rule_type,
    rule?.cap_type,
    firstPresent(rule?.cap_amount, rule?.cap_value),
    rule?.cap_percent,
    rule?.tenant_share_percent,
    deriveRuleBillingTreatment(rule),
    firstPresent(rule?.billing_frequency, rule?.frequency),
    rule?.source_page,
    deriveRuleExactSourceText(rule),
  ].map((value) => normalizeText(value)).join("::");
}

function stableRuleFingerprintHash(value) {
  let hash = 2166136261;
  const input = String(value || "");
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function canonicalRuleDedupKey(rule, index = 0) {
  return ruleSemanticFingerprint(rule, index);
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
  return ruleSemanticFingerprint(rule);
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

function buildRuleSetEntriesFromServerPayload(payload = {}) {
  const ruleSets = Array.isArray(payload?.ruleSets) ? payload.ruleSets : [];
  const rules = Array.isArray(payload?.rules) ? payload.rules : [];
  const values = Array.isArray(payload?.values) ? payload.values : [];
  const clauses = Array.isArray(payload?.clauses) ? payload.clauses : [];

  const rulesBySet = new Map();
  for (const rule of rules) {
    const existing = rulesBySet.get(rule.rule_set_id) || [];
    existing.push(rule);
    rulesBySet.set(rule.rule_set_id, existing);
  }

  const valuesByRuleId = new Map((values || []).map((value) => [value.rule_id, value]));
  const clausesByRuleId = new Map();
  (clauses || []).forEach((clause) => {
    const existing = clausesByRuleId.get(clause.lease_expense_rule_id) || [];
    existing.push(clause);
    clausesByRuleId.set(clause.lease_expense_rule_id, existing);
  });

  const ruleSetsByLeaseId = new Map();
  for (const ruleSet of ruleSets) {
    const existing = ruleSetsByLeaseId.get(ruleSet.lease_id) || [];
    existing.push(ruleSet);
    ruleSetsByLeaseId.set(ruleSet.lease_id, existing);
  }

  return [...ruleSetsByLeaseId.values()]
    .map((leaseRuleSets) => selectPreferredRuleSet(leaseRuleSets, rulesBySet))
    .filter(Boolean)
    .map((ruleSet) => {
      const rulesForSet = rulesBySet.get(ruleSet.id) || [];
      const mergedRules = mergeRulesWithRelations(rulesForSet, valuesByRuleId, clausesByRuleId);
      const finalizedRules = finalizeLeaseExpenseRules(mergedRules, ruleSet?.status || "draft")
        .map(normalizeLeaseExpenseRule);
      return {
        leaseId: ruleSet.lease_id,
        ruleSet,
        rules: finalizedRules,
      };
    });
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
  async syncApprovedLeaseExpenseRules({ leaseId, force = false } = {}) {
    if (!leaseId) throw new Error("leaseId is required");
    return invokeEdgeFunction("sync-approved-lease-expense-rules", {
      lease_id: leaseId,
      force,
    });
  },

  async loadRuleSet(leaseId) {
    if (!leaseId) return { ruleSet: null, rules: [] };
    const entries = await this.loadRuleSets([leaseId]);
    return entries.find((entry) => entry.leaseId === leaseId) || { ruleSet: null, rules: [] };
  },

  async loadRuleSets(leaseIds = []) {
    const tag = `[loadRuleSets leaseIds=${leaseIds?.length || 0}]`;
    if (!Array.isArray(leaseIds) || leaseIds.length === 0) {
      devLog(`${tag} early return — no leaseIds`);
      return [];
    }

    try {
      const payload = await invokeEdgeFunction("list-lease-expense-rule-sets", { lease_ids: leaseIds });
      const persistedEntries = buildRuleSetEntriesFromServerPayload(payload);
      devLog(`${tag} returning ${persistedEntries.length} entries`);
      return persistedEntries;
    } catch (error) {
      console.error(`${tag} FAILED`, error);
      throw error;
    }
  },

  // Low-level compatibility writer retained for explicit rule-set editing.
  // Lease extraction and approval do not call this browser path; their sole
  // publisher is approved-lease-expense-rules.ts.
  async saveRuleSet({ lease, rules = [], status = "draft", existingRuleSetId = null, categories = [], createdFrom = "workflow", approver = null, suppressHttpError = false }) {
    if (!supabase || !lease?.id) throw new Error("Lease is required to save expense rules");

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

    // Browser code no longer queries lease_expense_rule_sets for version
    // decisions. That table is RLS-protected; the Edge Function/RPC owns the
    // mechanical write, and callers may pass an explicit existingRuleSetId
    // when they are intentionally editing a known set.
    if (!ruleSetId) {
      currentVersion = 1;
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
      const fingerprint = stableRuleFingerprintHash(ruleSemanticFingerprint(ruleObj));
      return `${lease.id}_${type}_${category}_${subcategory}_${sourceKey}_${fingerprint}`;
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

    let preservedByKey = new Map();
    let protectedByCanonicalKey = new Map();
    // Existing-rule preservation is now intentionally server-owned. Keeping
    // this browser-side prefetch caused direct protected-table reads and
    // repeated 403s in Lease Expense Rules.

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

    const supersededRuleIds = [];

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
