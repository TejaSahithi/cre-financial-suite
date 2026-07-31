// @ts-nocheck

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE_RENT_KEYS = new Set(["base_rent", "rent", "minimum_rent", "fixed_rent"]);

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeToken(value: unknown): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const token = normalizeToken(value);
  if (["true", "yes", "required", "included", "recoverable"].includes(token)) return true;
  if (["false", "no", "not_required", "excluded", "non_recoverable"].includes(token)) return false;
  return null;
}

function triState(value: unknown, fallback: "yes" | "no" | "conditional" | null = null) {
  if (typeof value === "boolean") return value ? "yes" : "no";
  const token = normalizeToken(value);
  if (["yes", "true", "recoverable", "tenant_recovery"].includes(token)) return "yes";
  if (["no", "false", "non_recoverable", "excluded", "included_in_rent"].includes(token)) return "no";
  if (["conditional", "depends", "manual_review", "needs_review"].includes(token)) return "conditional";
  return fallback;
}

function humanize(value: unknown): string | null {
  const token = normalizeToken(value);
  if (!token) return null;
  return token.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function unwrapWorkflowOutput(value: any): any {
  if (!isObject(value)) return null;
  if (isObject(value.workflow_output)) return value.workflow_output;
  if (Array.isArray(value.records) && isObject(value.records[0])) return value.records[0];
  return value;
}

export function getAuthoritativeWorkflowOutput(lease: any, fileRecord: any): any {
  const firstReviewRecord =
    fileRecord?.ui_review_payload?.records?.[0] ??
    fileRecord?.ui_review_payload?.rows?.[0] ??
    null;
  const firstNormalizedRecord =
    fileRecord?.normalized_output?.records?.[0] ??
    fileRecord?.normalized_output?.rows?.[0] ??
    null;
  const firstParsedRecord = Array.isArray(fileRecord?.parsed_data)
    ? fileRecord.parsed_data[0]
    : fileRecord?.parsed_data;
  const candidates = [
    lease?.extraction_data?.workflow_output,
    lease?.workflow_output,
    lease?.abstract_snapshot?.workflow_output,
    lease?.abstract_snapshot?.metadata?.workflow_output,
    fileRecord?.ui_review_payload?.metadata?.workflow_output,
    firstReviewRecord?.workflow_output,
    fileRecord?.normalized_output?.metadata?.workflow_output,
    fileRecord?.normalized_output?.workflow_output,
    firstNormalizedRecord?.workflow_output,
    firstParsedRecord?.workflow_output,
  ];
  const workflows = candidates.map(unwrapWorkflowOutput).filter(Boolean);
  if (workflows.length === 0) return null;
  return workflows
    .map((workflow, index) => ({
      workflow,
      index,
      score:
        (cleanText(workflow?.expense_rule_source) === "whole_document_llm_expense_obligations"
          ? 1_000_000
          : 0) +
        asArray(workflow?.expense_rules).length * 10000 +
        asArray(workflow?.lease_clauses).length * 100 +
        Object.keys(workflow?.lease_fields || {}).length,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0].workflow;
}

function isSourceBackedExpenseRule(rule: any): boolean {
  if (!isObject(rule)) return false;
  const ruleType = normalizeToken(rule?.rule_type || rule?.row_type);
  const generationSource = normalizeToken(rule?.generation_source);
  if (ruleType === "coverage_gap" || ["original_lease_required", "template_checklist", "coverage_gap"].includes(generationSource)) return false;
  const sourceText = exactSourceText(rule);
  const category = normalizeToken(rule?.expense_category || rule?.normalized_key || rule?.category);
  return Boolean(sourceText && category && !BASE_RENT_KEYS.has(category));
}

function shouldPublishWorkflowExpenseRules(workflow: any): boolean {
  const source = normalizeToken(workflow?.expense_rule_source);
  if (source === "whole_document_llm_expense_obligations") return true;
  const rules = asArray(workflow?.expense_rules);
  return rules.some(isSourceBackedExpenseRule);
}

export function isLeaseApprovedForExpensePublication(lease: any): boolean {
  const abstractStatus = normalizeToken(lease?.abstract_status);
  const leaseStatus = normalizeToken(lease?.status);
  return abstractStatus === "approved" ||
    ["approved", "budget_ready"].includes(leaseStatus) ||
    Boolean(lease?.abstract_approved_at);
}

async function findSourceFile(supabaseAdmin: any, orgId: string, lease: any) {
  let sourceFileId =
    lease?.source_file_id ??
    lease?.extraction_data?.source_file_id ??
    lease?.abstract_snapshot?.source_document?.file_id ??
    null;

  const loadFile = async (fileId: unknown) => {
    if (!fileId || !UUID_RE.test(String(fileId))) return null;
    const { data: fileRecord, error: fileError } = await supabaseAdmin
      .from("uploaded_files")
      .select("id, org_id, document_subtype, ui_review_payload, normalized_output, parsed_data, docling_raw, status")
      .eq("org_id", orgId)
      .eq("id", fileId)
      .maybeSingle();
    if (fileError) throw new Error(`Could not load the approved lease source document: ${fileError.message}`);
    return fileRecord ?? null;
  };

  let fileRecord = await loadFile(sourceFileId);
  if (!fileRecord) {
    const { data: links, error: linkError } = await supabaseAdmin
      .from("document_links")
      .select("file_id, link_role, created_at")
      .eq("org_id", orgId)
      .eq("entity_type", "lease")
      .eq("entity_id", lease.id)
      .order("created_at", { ascending: false })
      .limit(20);
    if (linkError) throw new Error(`Could not resolve the approved lease source document: ${linkError.message}`);
    const sourceLink =
      asArray(links).find((link) => normalizeToken(link?.link_role) === "source") ??
      asArray(links)[0] ??
      null;
    sourceFileId = sourceLink?.file_id ?? null;
    fileRecord = await loadFile(sourceFileId);
  }

  if (!sourceFileId || !UUID_RE.test(String(sourceFileId))) {
    return { sourceFileId: null, fileRecord: null };
  }
  return { sourceFileId, fileRecord };
}

function stableHash(value: unknown): string {
  const text = String(value ?? "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function includedInBaseRent(rule: any): boolean | null {
  const explicit = booleanOrNull(rule?.included_in_base_rent ?? rule?.included_in_rent);
  if (explicit != null) return explicit;
  return /included/.test(normalizeToken(rule?.lease_treatment)) ? true : null;
}

function recoverableDecision(rule: any): "yes" | "no" | "conditional" {
  const explicit = triState(rule?.recoverable_from_tenant ?? rule?.recoverable_flag);
  if (explicit) return explicit;
  if (includedInBaseRent(rule) || rule?.is_excluded) return "no";
  const classification = normalizeToken(rule?.rule_classification);
  if (classification === "recoverable") return "yes";
  if (classification === "conditional") return "conditional";
  if (["non_recoverable", "excluded"].includes(classification)) return "no";
  return "conditional";
}

function camEligibleDecision(rule: any, recoverable: string): "yes" | "no" | "conditional" {
  const explicit = triState(rule?.cam_eligible);
  if (explicit) return explicit;
  if (includedInBaseRent(rule)) return "no";
  const category = normalizeToken(rule?.expense_category || rule?.normalized_key);
  if ([
    "common_area_maintenance",
    "operating_expenses",
    "real_estate_taxes",
    "property_insurance",
    "repairs_maintenance",
    "utilities",
    "electricity",
    "water",
    "sewer",
    "gas",
    "hvac",
    "janitorial",
    "trash_removal",
    "security",
    "landscaping",
    "snow_removal",
    "management_fees",
    "administrative_fees",
    "capital_expenditures",
  ].includes(category)) {
    return recoverable === "no" ? "no" : recoverable as "yes" | "conditional";
  }
  return "conditional";
}

function operationalResponsibility(rule: any, recoverable: string): string {
  const explicit = normalizeToken(rule?.operational_responsibility || rule?.responsibility);
  if (["landlord", "tenant", "shared", "third_party"].includes(explicit)) return explicit;
  if (normalizeToken(rule?.recovery_method) === "tenant_direct_contract") return "tenant";
  if (includedInBaseRent(rule) || ["yes", "conditional"].includes(recoverable)) return "landlord";
  return "unknown";
}

function paymentTreatment(rule: any, recoverable: string): string {
  const explicit = normalizeToken(rule?.payment_treatment);
  if (["included_in_base_rent", "reimbursable", "tenant_direct_contract", "separately_billed", "not_applicable"].includes(explicit)) {
    return explicit;
  }
  if (includedInBaseRent(rule)) return "included_in_base_rent";
  if (normalizeToken(rule?.recovery_method) === "tenant_direct_contract") return "tenant_direct_contract";
  if (["yes", "conditional"].includes(recoverable)) return "reimbursable";
  return "not_applicable";
}

function billingTreatment(rule: any, payment: string): string {
  const explicit = normalizeToken(rule?.billing_treatment);
  if (["included", "direct_bill", "cam_estimate", "reconciliation", "none"].includes(explicit)) return explicit;
  const method = normalizeToken(rule?.recovery_method);
  if (payment === "included_in_base_rent") return "included";
  if (["tenant_direct_contract", "direct_bill", "actual_usage"].includes(method)) return "direct_bill";
  if (["base_year", "expense_stop", "pass_through", "reconciliation"].includes(method)) return "reconciliation";
  if (["fixed_monthly", "pro_rata_share", "monthly_reimbursement"].includes(method)) return "cam_estimate";
  return "none";
}

function exactSourceText(rule: any): string | null {
  return cleanText(
    rule?.exact_source_text ??
    rule?.source_clause ??
    rule?.clause_text ??
    rule?.source_text ??
    rule?.source,
  ) || null;
}

function canonicalRuleKey(leaseId: string, rule: any): string {
  const category = normalizeToken(rule?.expense_category || rule?.normalized_key || rule?.category || "uncategorized");
  const subcategory = normalizeToken(rule?.expense_subcategory || rule?.subcategory_name);
  const evidence = exactSourceText(rule) || "";
  const page = numberOrNull(rule?.source_page ?? rule?.page_number) ?? "no_page";
  return `${leaseId}_approved_lease_${category}_${subcategory || "general"}_${page}_${stableHash(evidence)}`;
}

function prepareRulePayload(lease: any, orgId: string, rule: any) {
  const category = normalizeToken(rule?.expense_category || rule?.normalized_key || rule?.category);
  if (!category || BASE_RENT_KEYS.has(category)) return null;

  const sourceText = exactSourceText(rule);
  if (!sourceText) return null;
  const sourcePage = numberOrNull(rule?.source_page ?? rule?.page_number);
  const recoverable = recoverableDecision(rule);
  const camEligible = camEligibleDecision(rule, recoverable);
  const payment = paymentTreatment(rule, recoverable);
  const recoveryMethod =
    normalizeToken(rule?.recovery_method) ||
    (payment === "included_in_base_rent" ? "included_in_base_rent" : "manual_review");
  const allocationBasis = cleanText(rule?.allocation_basis || rule?.allocation_method) || null;
  const confidence = numberOrNull(rule?.confidence_score ?? rule?.confidence);
  const missingPage = sourcePage == null || sourcePage <= 0;
  const extractionStatus = missingPage
    ? "inferred"
    : (normalizeToken(rule?.extraction_status || rule?.status) || "extracted");
  const notes = [
    cleanText(rule?.notes),
    missingPage ? "Source page missing; verify the clause citation before approving this rule." : "",
  ].filter(Boolean).join(" ");
  const ruleKey = canonicalRuleKey(lease.id, rule);
  const finalValue =
    numberOrNull(rule?.fixed_monthly_amount) ??
    numberOrNull(rule?.explicit_charge_amount) ??
    numberOrNull(rule?.cap_amount) ??
    numberOrNull(rule?.base_year_amount);

  return {
    ruleKey,
    rule: {
      rule_key: ruleKey,
      rule_type: "lease_derived",
      source_field_key: cleanText(rule?.source_field_key) || null,
      org_id: orgId,
      lease_id: lease.id,
      tenant_id: lease?.tenant_id ?? null,
      property_id: lease?.property_id ?? null,
      building_id: lease?.building_id ?? null,
      unit_id: lease?.unit_id ?? null,
      expense_category_id: null,
      expense_category: category,
      expense_subcategory: cleanText(rule?.expense_subcategory || rule?.subcategory_name) || null,
      row_status: "needs_review",
      mentioned_in_lease: true,
      included_in_base_rent: includedInBaseRent(rule),
      recoverable_from_tenant: recoverable,
      is_recoverable: ["yes", "conditional"].includes(recoverable),
      cam_eligible: camEligible,
      operational_responsibility: operationalResponsibility(rule, recoverable),
      payment_treatment: payment,
      billing_treatment: billingTreatment(rule, payment),
      recovery_method: recoveryMethod,
      allocation_basis: allocationBasis,
      is_excluded: Boolean(rule?.is_excluded),
      is_controllable: Boolean(rule?.is_controllable),
      is_subject_to_cap: Boolean(rule?.is_subject_to_cap || rule?.cap_type),
      cap_type: cleanText(rule?.cap_type) || null,
      cap_value: numberOrNull(rule?.cap_value ?? rule?.cap_amount),
      cap_amount: numberOrNull(rule?.cap_amount ?? rule?.cap_value),
      cap_percent: numberOrNull(rule?.cap_percent),
      has_base_year: Boolean(rule?.has_base_year || rule?.base_year || rule?.base_year_type),
      base_year_type: cleanText(rule?.base_year_type) || null,
      base_year: cleanText(rule?.base_year || rule?.base_year_type) || null,
      base_year_amount: numberOrNull(rule?.base_year_amount),
      expense_stop_amount: numberOrNull(rule?.expense_stop_amount),
      gross_up_applicable: Boolean(rule?.gross_up_applicable || numberOrNull(rule?.gross_up_percent) != null),
      gross_up_percent: numberOrNull(rule?.gross_up_percent),
      admin_fee_applicable: Boolean(rule?.admin_fee_applicable || numberOrNull(rule?.admin_fee_percent) != null),
      admin_fee_percent: numberOrNull(rule?.admin_fee_percent),
      billing_frequency: cleanText(rule?.billing_frequency || rule?.frequency) || null,
      reconciliation_required: Boolean(
        rule?.reconciliation_required ||
        ["base_year", "expense_stop", "pass_through"].includes(recoveryMethod),
      ),
      reconciliation_frequency: cleanText(rule?.reconciliation_frequency) ||
        (["base_year", "expense_stop", "pass_through"].includes(recoveryMethod) ? "annual" : null),
      exact_source_text: sourceText,
      confidence_score: confidence,
      confidence,
      extraction_status: extractionStatus,
      review_status: "needs_review",
      approval_status: "draft",
      published_to_cam: false,
      notes: notes || null,
      source: "lease_workflow",
      created_from: "approved_lease_expense_publication",
      generation_source: cleanText(rule?.generation_source) || "whole_document_llm_expense_obligation_v1",
      tenant_share_percent: numberOrNull(rule?.tenant_share_percent),
      estimated_monthly_amount: numberOrNull(rule?.fixed_monthly_amount ?? rule?.explicit_charge_amount),
      estimated_annual_amount: numberOrNull(rule?.estimated_annual_amount),
    },
    value: finalValue == null
      ? null
      : {
        rule_key: ruleKey,
        base_year_amount: numberOrNull(rule?.base_year_amount),
        extracted_value: finalValue,
        manual_value: null,
        final_value: finalValue,
        frequency: cleanText(rule?.billing_frequency || rule?.frequency) || null,
        value_source: "extracted",
      },
    clause: {
      rule_key: ruleKey,
      page_number: sourcePage,
      clause_type: cleanText(rule?.clause_type || rule?.clauses?.[0]?.clause_type) || "supporting_text",
      clause_text: sourceText.slice(0, 4000),
      confidence,
    },
  };
}

function dedupePreparedRules(prepared: any[]) {
  const byKey = new Map<string, any>();
  for (const item of prepared) {
    if (!item?.ruleKey) continue;
    const current = byKey.get(item.ruleKey);
    const score = (item.rule?.exact_source_text?.length || 0) +
      (item.clause?.page_number ? 1000 : 0) +
      Math.round((item.rule?.confidence_score || 0) * 100);
    const currentScore = current
      ? (current.rule?.exact_source_text?.length || 0) +
        (current.clause?.page_number ? 1000 : 0) +
        Math.round((current.rule?.confidence_score || 0) * 100)
      : -1;
    if (!current || score >= currentScore) byKey.set(item.ruleKey, item);
  }
  return [...byKey.values()];
}

async function resolveExpenseCategoryIds(
  supabaseAdmin: any,
  orgId: string,
  prepared: any[],
) {
  const categoryKeys = [...new Set(
    prepared
      .map((item) => normalizeToken(item?.rule?.expense_category))
      .filter(Boolean),
  )];
  if (categoryKeys.length === 0) return prepared;

  const { data: existingCategories, error: categoryError } = await supabaseAdmin
    .from("expense_categories")
    .select("id, org_id, normalized_key")
    .or(`org_id.eq.${orgId},org_id.is.null`)
    .in("normalized_key", categoryKeys);
  if (categoryError) {
    throw new Error(`Could not resolve expense categories: ${categoryError.message}`);
  }

  const categoryByKey = new Map<string, any>();
  for (const category of asArray(existingCategories)) {
    const key = normalizeToken(category?.normalized_key);
    if (!key) continue;
    const current = categoryByKey.get(key);
    if (!current || category?.org_id === orgId) categoryByKey.set(key, category);
  }

  const missingKeys = categoryKeys.filter((key) => !categoryByKey.has(key));
  if (missingKeys.length > 0) {
    const { data: insertedCategories, error: insertError } = await supabaseAdmin
      .from("expense_categories")
      .insert(missingKeys.map((key, index) => ({
        org_id: orgId,
        is_system_default: false,
        is_active: true,
        display_order: 1000 + index,
        normalized_key: key,
        category_name: humanize(key),
        subcategory_name: null,
      })))
      .select("id, org_id, normalized_key");
    if (insertError) {
      throw new Error(`Could not register LLM expense categories: ${insertError.message}`);
    }
    for (const category of asArray(insertedCategories)) {
      const key = normalizeToken(category?.normalized_key);
      if (key) categoryByKey.set(key, category);
    }
  }

  return prepared.map((item) => {
    const key = normalizeToken(item?.rule?.expense_category);
    const categoryId = categoryByKey.get(key)?.id ?? null;
    if (!categoryId) {
      throw new Error(`Could not resolve expense_category_id for "${key || "unknown"}"`);
    }
    return {
      ...item,
      rule: {
        ...item.rule,
        expense_category_id: categoryId,
      },
    };
  });
}

async function persistCamProfile(supabaseAdmin: any, orgId: string, lease: any, camProfile: any) {
  if (!isObject(camProfile)) return { persisted: false };
  const payload = {
    org_id: orgId,
    lease_id: lease.id,
    property_id: lease?.property_id ?? null,
    cam_structure: camProfile.cam_structure ?? null,
    recovery_status: camProfile.recovery_status ?? null,
    cam_start_date: camProfile.cam_start_date ?? null,
    cam_end_date: camProfile.cam_end_date ?? null,
    estimate_frequency: camProfile.estimate_frequency ?? null,
    reconciliation_frequency: camProfile.reconciliation_frequency ?? null,
    tenant_rsf: numberOrNull(camProfile.tenant_rsf),
    building_rsf: numberOrNull(camProfile.building_rsf),
    tenant_pro_rata_share: numberOrNull(camProfile.tenant_pro_rata_share),
    cam_cap_type: camProfile.cam_cap_type ?? null,
    cam_cap_percent: numberOrNull(camProfile.cam_cap_percent),
    admin_fee_percent: numberOrNull(camProfile.admin_fee_percent),
    gross_up_percent: numberOrNull(camProfile.gross_up_percent),
    included_expenses: asArray(camProfile.included_expenses),
    excluded_expenses: asArray(camProfile.excluded_expenses),
    actual_cam_expense: numberOrNull(camProfile.actual_cam_expense),
    estimated_cam_billed: numberOrNull(camProfile.estimated_cam_billed),
    reconciliation_amount: numberOrNull(camProfile.reconciliation_amount),
    tenant_balance_due_or_credit: numberOrNull(camProfile.tenant_balance_due_or_credit),
    status: "draft",
    source: "approved_lease_workflow",
  };
  const { error } = await supabaseAdmin.from("cam_profiles").upsert(payload, { onConflict: "lease_id" });
  if (error) {
    return {
      persisted: false,
      error: `Could not publish the approved lease CAM profile: ${error.message}`,
    };
  }
  return { persisted: true };
}

export async function publishApprovedLeaseExpenseArtifacts({
  supabaseAdmin,
  orgId,
  lease,
  actorUserId,
  actorEmail = null,
  force = false,
}: {
  supabaseAdmin: any;
  orgId: string;
  lease: any;
  actorUserId: string;
  actorEmail?: string | null;
  force?: boolean;
}) {
  if (!lease?.id) throw new Error("lease_id is required");
  if (!isLeaseApprovedForExpensePublication(lease)) {
    throw new Error("Lease abstract must be approved before expense/CAM rules can be published");
  }

  const { count: existingRuleCount, error: countError } = await supabaseAdmin
    .from("lease_expense_rules")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("lease_id", lease.id);
  if (countError) throw new Error(`Could not inspect existing lease expense rules: ${countError.message}`);

  const { sourceFileId, fileRecord } = await findSourceFile(supabaseAdmin, orgId, lease);
  const storedWorkflow = getAuthoritativeWorkflowOutput(lease, fileRecord);
  const expenseRuleSource = cleanText(storedWorkflow?.expense_rule_source);
  const hasPublishableWorkflowExpenseRules = shouldPublishWorkflowExpenseRules(storedWorkflow);
  if (!force && Number(existingRuleCount || 0) > 0) {
    const existingCamProfileResult = hasPublishableWorkflowExpenseRules
      ? await persistCamProfile(
        supabaseAdmin,
        orgId,
        lease,
        storedWorkflow?.cam_profile,
      )
      : { persisted: false, error: null };
    return {
      status: "already_persisted",
      lease_id: lease.id,
      source_file_id: sourceFileId,
      source_file_found: Boolean(fileRecord),
      workflow_found: Boolean(storedWorkflow),
      rules_persisted: Number(existingRuleCount || 0),
      rules_generated: 0,
      regenerated: false,
      expense_rule_source: expenseRuleSource || null,
      reason: hasPublishableWorkflowExpenseRules
        ? null
        : "legacy_rules_already_persisted_reextraction_recommended",
      cam_profile_persisted: existingCamProfileResult.persisted,
      cam_profile_error: existingCamProfileResult.error ?? null,
    };
  }

  const workflow = storedWorkflow;
  const expenseRules = hasPublishableWorkflowExpenseRules
    ? asArray(workflow?.expense_rules).filter(isSourceBackedExpenseRule)
    : [];
  const publicationExtractionVersion = expenseRuleSource === "whole_document_llm_expense_obligations"
    ? "whole_document_llm_expense_obligations_v1"
    : "typescript_schema_expense_rules_fallback_v1";

  const camProfileResult = hasPublishableWorkflowExpenseRules
    ? await persistCamProfile(
      supabaseAdmin,
      orgId,
      lease,
      workflow?.cam_profile ?? storedWorkflow?.cam_profile,
    )
    : { persisted: false, error: null };

  const preparedWithoutCategoryIds = dedupePreparedRules(
    expenseRules.map((rule) => prepareRulePayload(lease, orgId, rule)).filter(Boolean),
  );
  if (preparedWithoutCategoryIds.length === 0) {
    return {
      status: "no_rules_generated",
      lease_id: lease.id,
      source_file_id: sourceFileId,
      source_file_found: Boolean(fileRecord),
      workflow_found: Boolean(storedWorkflow),
      workflow_rules_found: asArray(storedWorkflow?.expense_rules).length,
      workflow_clauses_found: asArray(storedWorkflow?.lease_clauses).length,
      rules_generated: expenseRules.length,
      rules_persisted: 0,
      regenerated: false,
      expense_rule_source: expenseRuleSource || null,
      cam_profile_persisted: camProfileResult.persisted,
      cam_profile_error: camProfileResult.error ?? null,
      reason: !fileRecord && !storedWorkflow
        ? "approved_lease_source_not_found"
        : !hasPublishableWorkflowExpenseRules
          ? "approved_lease_reextraction_required"
          : "no_source_backed_expense_rules",
    };
  }
  const prepared = await resolveExpenseCategoryIds(
    supabaseAdmin,
    orgId,
    preparedWithoutCategoryIds,
  );

  const { data: existingSets, error: setError } = await supabaseAdmin
    .from("lease_expense_rule_sets")
    .select("id, version, status")
    .eq("org_id", orgId)
    .eq("lease_id", lease.id)
    .neq("status", "archived")
    .order("version", { ascending: false })
    .limit(1);
  if (setError) throw new Error(`Could not inspect the lease expense rule set: ${setError.message}`);
  const existingSet = asArray(existingSets)[0] ?? null;

  const { data: saved, error: saveError } = await supabaseAdmin.rpc("save_lease_expense_rule_set", {
    p_org_id: orgId,
    p_lease_id: lease.id,
    p_actor_user_id: actorUserId,
    p_actor_email: actorEmail,
    p_rule_set_id: existingSet?.id ?? null,
    p_version: existingSet?.version ?? 1,
    p_status: "draft",
    p_extraction_version: publicationExtractionVersion,
    p_property_id: lease?.property_id ?? null,
    p_rules: prepared.map((item) => item.rule),
    p_values: prepared.map((item) => item.value).filter(Boolean),
    p_clauses: prepared.map((item) => item.clause),
    p_superseded_rule_ids: null,
  });
  if (saveError) throw new Error(`Could not persist approved lease expense rules: ${saveError.message}`);

  return {
    status: "persisted",
    lease_id: lease.id,
    source_file_id: sourceFileId,
    source_file_found: Boolean(fileRecord),
    workflow_found: Boolean(storedWorkflow),
    workflow_rules_found: asArray(storedWorkflow?.expense_rules).length,
    workflow_clauses_found: asArray(storedWorkflow?.lease_clauses).length,
    rules_generated: expenseRules.length,
    rules_persisted: Number(saved?.rule_count ?? prepared.length),
    rule_set_id: saved?.rule_set_id ?? existingSet?.id ?? null,
    regenerated: false,
    expense_rule_source: expenseRuleSource,
    cam_profile_persisted: camProfileResult.persisted,
    cam_profile_error: camProfileResult.error ?? null,
  };
}

export const __test__ = {
  cleanText,
  normalizeToken,
  exactSourceText,
  canonicalRuleKey,
  prepareRulePayload,
  dedupePreparedRules,
  resolveExpenseCategoryIds,
  isSourceBackedExpenseRule,
  shouldPublishWorkflowExpenseRules,
};
