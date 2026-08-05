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

function uuidOrNull(value: unknown): string | null {
  const text = cleanText(value);
  return UUID_RE.test(text) ? text : null;
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
  if (isObject(value.metadata?.workflow_output)) return value.metadata.workflow_output;
  if (Array.isArray(value.records) && isObject(value.records[0])) return value.records[0];
  return value;
}

function readFactLedgerDebug(value: any): any {
  if (!isObject(value)) return null;
  const debug =
    value?.openai_fact_ledger || value?.vertex_fact_ledger
      ? value
      : value?.metadata?.extractionDebug ??
        value?.metadata?.extraction_debug ??
        value?.extractionDebug ??
        value?.extraction_debug ??
        null;
  if (!isObject(debug)) return null;
  return debug.openai_fact_ledger ?? debug.vertex_fact_ledger ?? null;
}

function workflowFromFactLedgerDebug(value: any): any {
  const ledger = readFactLedgerDebug(value);
  if (!isObject(ledger)) return null;
  const expenseRules = asArray(ledger.expense_rule_candidates);
  const dynamicItems = asArray(ledger.dynamic_items);
  const leaseClauses = asArray(ledger.lease_clauses);
  if (expenseRules.length === 0 && dynamicItems.length === 0 && leaseClauses.length === 0) return null;
  return {
    expense_rule_source: expenseRules.length > 0
      ? "whole_document_llm_expense_obligations"
      : "whole_document_llm_debug_evidence",
    expense_rules: expenseRules,
    dynamic_items: dynamicItems,
    lease_clauses: leaseClauses,
    lease_fields: ledger.validated_field_values ?? ledger.merged_field_sources ?? {},
    cam_profile: ledger.cam_profile ?? null,
  };
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
    workflowFromFactLedgerDebug(lease?.extraction_data?.extraction_debug),
    workflowFromFactLedgerDebug(lease?.extraction_data),
    lease?.workflow_output,
    lease?.abstract_snapshot?.workflow_output,
    lease?.abstract_snapshot?.metadata?.workflow_output,
    workflowFromFactLedgerDebug(lease?.abstract_snapshot),
    fileRecord?.ui_review_payload?.metadata?.workflow_output,
    workflowFromFactLedgerDebug(fileRecord?.ui_review_payload),
    firstReviewRecord?.workflow_output,
    workflowFromFactLedgerDebug(firstReviewRecord),
    fileRecord?.normalized_output?.metadata?.workflow_output,
    fileRecord?.normalized_output?.workflow_output,
    workflowFromFactLedgerDebug(fileRecord?.normalized_output),
    firstNormalizedRecord?.workflow_output,
    workflowFromFactLedgerDebug(firstNormalizedRecord),
    firstParsedRecord?.workflow_output,
    workflowFromFactLedgerDebug(firstParsedRecord),
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

const FALLBACK_EXPENSE_CATEGORY_PATTERNS = [
  { category: "common_area_maintenance", patterns: [/\bcam\b/i, /common\s+area\s+maintenance/i] },
  { category: "operating_expenses", patterns: [/operating\s+expenses?/i] },
  { category: "real_estate_taxes", patterns: [/real\s+estate\s+tax(?:es)?/i, /property\s+tax(?:es)?/i, /\btaxes\b/i] },
  { category: "property_insurance", patterns: [/property\s+insurance/i, /insurance\s+premium/i, /\binsurance\b/i] },
  { category: "utilities", patterns: [/utilit/i, /electric(?:ity)?/i, /water/i, /sewer/i, /gas/i, /hvac/i] },
  { category: "janitorial", patterns: [/janitorial/i, /cleaning/i] },
  { category: "repairs_maintenance", patterns: [/repair/i, /maintenance/i] },
  { category: "management_fees", patterns: [/management\s+fee/i, /property\s+management/i] },
  { category: "administrative_fees", patterns: [/admin(?:istrative)?\s+fee/i] },
  { category: "trash_removal", patterns: [/trash/i, /refuse/i, /garbage/i] },
  { category: "security", patterns: [/security\s+(?:service|services|guard|patrol|monitoring)/i] },
  { category: "landscaping", patterns: [/landscap/i] },
  { category: "snow_removal", patterns: [/snow\s+removal/i, /snow\s+plowing/i] },
  { category: "parking", patterns: [/parking[\s\S]{0,120}(?:maintenance|repair|lighting|sweeping|striping|snow|operating\s+expense|cam)/i] },
  { category: "late_fees", patterns: [/late\s+(?:fee|charge)/i] },
];

function workflowEvidenceText(item: any): string | null {
  return cleanText(
    item?.exact_source_text ??
    item?.source_clause ??
    item?.clause_text ??
    item?.source_text ??
    item?.evidence_text ??
    item?.text ??
    item?.summary,
  ) || null;
}

function workflowEvidencePage(item: any): number | null {
  return numberOrNull(item?.source_page ?? item?.page_number ?? item?.page);
}

function explicitExpenseCategory(item: any): string | null {
  const token = normalizeToken(
    item?.expense_category ??
    item?.normalized_key ??
    item?.category ??
    item?.field_key ??
    item?.item_type ??
    item?.clause_type,
  );
  if (!token || BASE_RENT_KEYS.has(token)) return null;
  if (FALLBACK_EXPENSE_CATEGORY_PATTERNS.some((entry) => entry.category === token)) return token;
  if (token === "cam") return "common_area_maintenance";
  if (token === "insurance") return "property_insurance";
  if (token === "taxes") return "real_estate_taxes";
  if (token === "maintenance") return "repairs_maintenance";
  return null;
}

function categoriesFromEvidence(item: any, text: string): string[] {
  const categories = new Set<string>();
  const explicit = explicitExpenseCategory(item);
  if (explicit) categories.add(explicit);
  for (const entry of FALLBACK_EXPENSE_CATEGORY_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) categories.add(entry.category);
  }
  if (categories.has("common_area_maintenance") && /\b(?:cam|common\s+area\s+maintenance)\b/i.test(text)) {
    categories.delete("repairs_maintenance");
  }
  return [...categories];
}

function treatmentFromEvidence(text: string) {
  const lower = text.toLowerCase();
  const included = /(?:included|comprise|covers?|full[-\s]?service|gross\s+lease)[\s\S]{0,140}(?:base\s+rent|monthly\s+rent|rent|cam|tax(?:es)?|insurance|maintenance|utilit|janitorial)/i.test(text)
    || /(?:cam|tax(?:es)?|insurance|maintenance|utilit|janitorial)[\s\S]{0,140}(?:included\s+in|part\s+of)[\s\S]{0,80}(?:base\s+rent|monthly\s+rent|rent)/i.test(text);
  const tenantDirect = /tenant\s+(?:shall|must|will|agrees\s+to|is\s+responsible\s+for)[\s\S]{0,120}(?:pay|contract|maintain|provide|obtain).{0,80}(?:direct|directly|at\s+tenant'?s\s+(?:sole\s+)?(?:cost|expense))/i.test(text);
  const reimbursable = /(?:reimburse|reimbursement|additional\s+rent|pro\s*rata|proportionate\s+share|pass[-\s]?through|separately\s+billed|pay\s+landlord)/i.test(lower);
  if (included) {
    return {
      included_in_base_rent: true,
      recoverable_from_tenant: false,
      cam_eligible: false,
      payment_treatment: "included_in_base_rent",
      recovery_method: "included_in_base_rent",
      lease_treatment: "included_in_rent",
      recoverable_flag: false,
    };
  }
  if (tenantDirect) {
    return {
      included_in_base_rent: false,
      recoverable_from_tenant: false,
      cam_eligible: false,
      payment_treatment: "tenant_direct_contract",
      recovery_method: "tenant_direct_contract",
      lease_treatment: "tenant_direct",
      recoverable_flag: false,
    };
  }
  if (reimbursable) {
    return {
      included_in_base_rent: false,
      recoverable_from_tenant: true,
      cam_eligible: true,
      payment_treatment: "reimbursable",
      recovery_method: /pro\s*rata|proportionate\s+share/i.test(text) ? "pro_rata_share" : "manual_review",
      lease_treatment: "tenant_recovery",
      recoverable_flag: true,
    };
  }
  return {
    recoverable_from_tenant: "conditional",
    cam_eligible: "conditional",
    payment_treatment: "reimbursable",
    recovery_method: "manual_review",
    lease_treatment: "manual_review",
    recoverable_flag: "conditional",
  };
}

function workflowEvidenceItems(workflow: any): any[] {
  return [
    ...asArray(workflow?.lease_clauses),
    ...asArray(workflow?.clause_records),
    ...asArray(workflow?.extracted_document_items),
    ...asArray(workflow?.dynamic_items),
  ];
}

function rawDocumentPayloads(fileRecord: any): any[] {
  return [fileRecord?.docling_raw, fileRecord?.azure_raw_response]
    .filter(isObject);
}

function rawDocumentItems(fileRecord: any): any[] {
  const items: any[] = [];
  const seen = new Set<string>();
  for (const raw of rawDocumentPayloads(fileRecord)) {
    for (const page of asArray(raw?.pages)) {
      const text = cleanText(page?.text ?? page?.content ?? page?.markdown);
      if (!text) continue;
      const pageNumber = numberOrNull(page?.page ?? page?.page_number ?? page?.pageNumber);
      const key = `page|${pageNumber ?? ""}|${stableHash(text)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ text, source_text: text, source_page: pageNumber, clause_type: "raw_document_page" });
    }

    for (const block of asArray(raw?.text_blocks)) {
      const text = cleanText(block?.text ?? block?.content);
      if (!text) continue;
      const pageNumber = numberOrNull(block?.page ?? block?.page_number ?? block?.pageNumber);
      const key = `block|${pageNumber ?? ""}|${stableHash(text)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ text, source_text: text, source_page: pageNumber, clause_type: cleanText(block?.type) || "raw_document_block" });
    }

    const fullText = cleanText(raw?.full_text ?? raw?.markdown);
    if (fullText && items.length === 0) {
      const key = `full|${stableHash(fullText)}`;
      if (!seen.has(key)) {
        seen.add(key);
        items.push({ text: fullText, source_text: fullText, source_page: null, clause_type: "raw_document_text" });
      }
    }
  }
  return items;
}

function snippetForCategory(text: string, category: string): string {
  const patterns = FALLBACK_EXPENSE_CATEGORY_PATTERNS.find((entry) => entry.category === category)?.patterns || [];
  const normalized = cleanText(text);
  if (!normalized) return "";
  const matches = patterns
    .map((pattern) => {
      const match = normalized.match(pattern);
      return match?.index ?? -1;
    })
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  const anchor = matches[0] ?? 0;
  const start = Math.max(0, anchor - 450);
  const end = Math.min(normalized.length, anchor + 1200);
  return cleanText(normalized.slice(start, end));
}

function fallbackExpenseRulesFromEvidenceItems(items: any[], generationSource: string, notes: string): any[] {
  const rows: any[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isObject(item)) continue;
    const sourceText = workflowEvidenceText(item);
    if (!sourceText) continue;
    const categories = categoriesFromEvidence(item, sourceText);
    if (categories.length === 0) continue;
    const page = workflowEvidencePage(item);
    for (const category of categories) {
      const snippet = snippetForCategory(sourceText, category) || sourceText;
      const treatment = treatmentFromEvidence(snippet);
      const key = [category, page ?? "no_page", stableHash(snippet)].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        expense_category: category,
        source_clause: snippet,
        exact_source_text: snippet,
        source_text: snippet,
        source_page: page,
        page_number: page,
        confidence_score: numberOrNull(item?.confidence_score ?? item?.confidence) ?? 0.66,
        extraction_status: page == null ? "missing_source_evidence" : "extracted",
        review_status: "needs_review",
        approval_status: "draft",
        generation_source: generationSource,
        notes,
        ...treatment,
      });
    }
  }
  return rows;
}

function fallbackExpenseRulesFromRawDocument(fileRecord: any): any[] {
  return fallbackExpenseRulesFromEvidenceItems(
    rawDocumentItems(fileRecord),
    "typescript_schema_raw_document_fallback",
    "Generated from stored raw document text because no canonical LLM expense_rules payload was available.",
  );
}
function fallbackExpenseRulesFromWorkflowEvidence(workflow: any): any[] {
  const rows: any[] = [];
  const seen = new Set<string>();
  for (const item of workflowEvidenceItems(workflow)) {
    if (!isObject(item)) continue;
    const sourceText = workflowEvidenceText(item);
    if (!sourceText) continue;
    const categories = categoriesFromEvidence(item, sourceText);
    if (categories.length === 0) continue;
    const page = workflowEvidencePage(item);
    const treatment = treatmentFromEvidence(sourceText);
    for (const category of categories) {
      const key = [category, page ?? "no_page", stableHash(sourceText)].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        expense_category: category,
        source_clause: sourceText,
        exact_source_text: sourceText,
        source_text: sourceText,
        source_page: page,
        page_number: page,
        confidence_score: numberOrNull(item?.confidence_score ?? item?.confidence) ?? 0.72,
        extraction_status: page == null ? "missing_source_evidence" : "extracted",
        review_status: "needs_review",
        approval_status: "draft",
        generation_source: "typescript_schema_workflow_evidence_fallback",
        notes: "Generated from source-backed workflow clause because no canonical expense_rules payload was available.",
        ...treatment,
      });
    }
  }
  return rows;
}

export function isLeaseApprovedForExpensePublication(lease: any): boolean {
  const abstractStatus = normalizeToken(lease?.abstract_status);
  const leaseStatus = normalizeToken(lease?.status);
  return abstractStatus === "approved" ||
    ["approved", "budget_ready"].includes(leaseStatus) ||
    Boolean(lease?.abstract_approved_at);
}

function sourceFileIdCandidates(lease: any): string[] {
  const sourceDocument = lease?.abstract_snapshot?.source_document ?? {};
  const candidates = [
    lease?.source_file_id,
    lease?.extraction_data?.source_file_id,
    lease?.extraction_data?.uploaded_file_id,
    sourceDocument?.file_id,
    sourceDocument?.uploaded_file_id,
    sourceDocument?.source_file_id,
    lease?.abstract_snapshot?.uploaded_file_id,
    lease?.abstract_snapshot?.source_file_id,
  ];
  return Array.from(new Set(
    candidates
      .map((value) => String(value ?? "").trim())
      .filter((value) => UUID_RE.test(value)),
  ));
}

async function findSourceFile(supabaseAdmin: any, orgId: string, lease: any) {
  let sourceFileId: string | null = null;

  const loadFile = async (fileId: unknown) => {
    if (!fileId || !UUID_RE.test(String(fileId))) return null;
    const baseSelect = "id, org_id, document_subtype, ui_review_payload, normalized_output, parsed_data, status";
    const withDoclingSelect = `${baseSelect}, docling_raw`;
    let { data: fileRecord, error: fileError } = await supabaseAdmin
      .from("uploaded_files")
      .select(withDoclingSelect)
      .eq("org_id", orgId)
      .eq("id", fileId)
      .maybeSingle();

    if (fileError && /docling_raw|schema cache|column/i.test(String(fileError.message || fileError.details || ""))) {
      const fallback = await supabaseAdmin
        .from("uploaded_files")
        .select(baseSelect)
        .eq("org_id", orgId)
        .eq("id", fileId)
        .maybeSingle();
      fileRecord = fallback.data;
      fileError = fallback.error;
    }

    if (fileError) throw new Error(`Could not load the approved lease source document: ${fileError.message}`);
    return fileRecord ?? null;
  };

  let fileRecord = null;
  for (const candidate of sourceFileIdCandidates(lease)) {
    fileRecord = await loadFile(candidate);
    if (fileRecord) {
      sourceFileId = candidate;
      break;
    }
  }

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

function hasLeaseSourcePage(rule: any): boolean {
  const page = numberOrNull(rule?.source_page ?? rule?.page_number);
  return page != null && page > 0;
}

function isApprovalReadyLeaseRule(rule: any, payment: string, recoverable: string, camEligible: string): boolean {
  const sourceText = exactSourceText(rule);
  if (!sourceText || !hasLeaseSourcePage(rule)) return false;
  if (payment === "tenant_direct_contract") return true;
  if (payment === "included_in_base_rent" || includedInBaseRent(rule)) return true;
  return recoverable === "yes" && ["yes", "no"].includes(camEligible);
}

function shouldPublishPreparedRuleToCam(rule: any, payment: string, recoverable: string, camEligible: string): boolean {
  if (!isApprovalReadyLeaseRule(rule, payment, recoverable, camEligible)) return false;
  if (payment === "included_in_base_rent" || payment === "tenant_direct_contract") return false;
  if (includedInBaseRent(rule) || rule?.is_excluded === true) return false;
  return recoverable === "yes" && camEligible === "yes";
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
  const approvalReady = isApprovalReadyLeaseRule(rule, payment, recoverable, camEligible);
  const publishToCam = shouldPublishPreparedRuleToCam(rule, payment, recoverable, camEligible);
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
      tenant_id: uuidOrNull(lease?.tenant_id),
      property_id: uuidOrNull(lease?.property_id),
      building_id: uuidOrNull(lease?.building_id),
      unit_id: uuidOrNull(lease?.unit_id),
      expense_category_id: null,
      expense_category: category,
      expense_subcategory: cleanText(rule?.expense_subcategory || rule?.subcategory_name) || null,
      row_status: approvalReady ? "mapped" : "needs_review",
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
      review_status: approvalReady ? "approved" : "needs_review",
      approval_status: approvalReady ? "approved" : "draft",
      published_to_cam: publishToCam,
      approved_by: approvalReady
        ? uuidOrNull(lease?.abstract_approved_by) ?? uuidOrNull(lease?.approved_by) ?? null
        : null,
      approved_at: approvalReady ? lease?.abstract_approved_at ?? lease?.approved_at ?? new Date().toISOString() : null,
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

// cam-legacy-scan-allow: retirement notice, not a live reference.
// Legacy CAM profile seed step — DEPRECATED / RETIRED. This used to upsert
// raw LLM extraction output (workflow.cam_profile) into the now-retired
// cam_profiles table as a draft starting point for manual CAM setup. There
// is no CAM V2 equivalent: recovery policies are materialized exclusively
// from approved lease_expense_rules (materialize_lease_recovery_policy),
// not from raw extraction output, and their step-based shape (RSF/pro-rata/
// cap/admin-fee/gross-up as separate lease_recovery_policy_steps rows) is
// not a mechanical translation target for this flat 19-field payload. This
// performs no write; callers still get a stable { persisted, error }-shaped
// result so publishApprovedLeaseExpenseArtifacts's response contract is
// unchanged.
async function promoteApprovedLeaseRuleRows(supabaseAdmin: any, orgId: string, lease: any, actorUserId: string | null) {
  const { data: rows, error } = await supabaseAdmin
    .from("lease_expense_rules")
    .select("*")
    .eq("org_id", orgId)
    .eq("lease_id", lease.id);
  if (error) throw new Error(`Could not load approved lease expense rules for promotion: ${error.message}`);

  let approved = 0;
  let publishedToCam = 0;
  let ruleSetsApproved = 0;
  const effectiveRows: any[] = [];

  for (const row of asArray(rows)) {
    const recoverable = recoverableDecision(row);
    const camEligible = camEligibleDecision(row, recoverable);
    const payment = paymentTreatment(row, recoverable);
    const approvalReady = isApprovalReadyLeaseRule(row, payment, recoverable, camEligible);
    if (!approvalReady) {
      effectiveRows.push(row);
      continue;
    }

    const publishToCam = shouldPublishPreparedRuleToCam(row, payment, recoverable, camEligible);
    const patch = {
      row_status: normalizeToken(row.row_status) === "needs_review" ? "mapped" : row.row_status,
      review_status: "approved",
      approval_status: "approved",
      published_to_cam: publishToCam || row.published_to_cam === true,
      approved_by: uuidOrNull(row.approved_by) ?? uuidOrNull(actorUserId) ?? null,
      approved_at: row.approved_at ?? lease?.abstract_approved_at ?? lease?.approved_at ?? new Date().toISOString(),
    };
    if (
      row.review_status !== patch.review_status ||
      row.approval_status !== patch.approval_status ||
      row.published_to_cam !== patch.published_to_cam ||
      row.row_status !== patch.row_status ||
      row.approved_by !== patch.approved_by ||
      row.approved_at !== patch.approved_at
    ) {
      const { error: updateError } = await supabaseAdmin
        .from("lease_expense_rules")
        .update(patch)
        .eq("id", row.id)
        .eq("org_id", orgId);
      if (updateError) throw new Error(`Could not promote approved lease expense rule ${row.id}: ${updateError.message}`);
    }
    approved += 1;
    if (patch.published_to_cam) publishedToCam += 1;
    effectiveRows.push({ ...row, ...patch });
  }

  const rowsBySet = new Map<string, any[]>();
  for (const row of effectiveRows) {
    const ruleSetId = cleanText(row?.rule_set_id);
    if (!ruleSetId) continue;
    if (!rowsBySet.has(ruleSetId)) rowsBySet.set(ruleSetId, []);
    rowsBySet.get(ruleSetId)!.push(row);
  }

  for (const [ruleSetId, setRows] of rowsBySet.entries()) {
    const activeRows = setRows.filter((row) => normalizeToken(row?.approval_status) !== "superseded");
    if (activeRows.length === 0) continue;
    const allApproved = activeRows.every((row) => normalizeToken(row?.approval_status) === "approved");
    if (!allApproved) continue;
    const { error: setUpdateError } = await supabaseAdmin
      .from("lease_expense_rule_sets")
      .update({
        status: "approved",
        approved_by: uuidOrNull(actorUserId) ?? uuidOrNull(lease?.abstract_approved_by) ?? uuidOrNull(lease?.approved_by) ?? null,
        approved_at: lease?.abstract_approved_at ?? lease?.approved_at ?? new Date().toISOString(),
      })
      .eq("id", ruleSetId)
      .eq("org_id", orgId)
      .eq("lease_id", lease.id);
    if (setUpdateError) throw new Error(`Could not promote approved lease expense rule set ${ruleSetId}: ${setUpdateError.message}`);
    ruleSetsApproved += 1;
  }

  return { approved, published_to_cam: publishedToCam, rule_sets_approved: ruleSetsApproved };
}
async function materializeApprovedLeaseRecoveryPolicies(
  supabaseAdmin: any,
  orgId: string,
  lease: any,
  actorUserId: string | null,
  actorEmail: string | null,
) {
  const actorUuid = uuidOrNull(actorUserId);
  if (!actorUuid) {
    return {
      created: 0,
      reused: 0,
      blocked: 0,
      blocked_examples: [{ reason: "actor_user_id_required" }],
    };
  }

  const { data: rows, error } = await supabaseAdmin
    .from("lease_expense_rules")
    .select("id")
    .eq("org_id", orgId)
    .eq("lease_id", lease.id)
    .eq("approval_status", "approved");
  if (error) throw new Error(`Could not load approved rules for CAM policy materialization: ${error.message}`);

  let created = 0;
  let reused = 0;
  let blocked = 0;
  const blockedExamples: any[] = [];

  for (const row of asArray(rows)) {
    const ruleId = cleanText(row?.id);
    if (!UUID_RE.test(ruleId)) continue;
    const { data, error: materializeError } = await supabaseAdmin.rpc("materialize_lease_recovery_policy", {
      p_org_id: orgId,
      p_rule_id: ruleId,
      p_actor_user_id: actorUuid,
      p_actor_email: actorEmail,
    });
    if (materializeError) {
      blocked += 1;
      blockedExamples.push({ rule_id: ruleId, reason: materializeError.message || "materialization_failed" });
      continue;
    }
    if (data?.already_materialized === true) reused += 1;
    else created += 1;
  }

  return { created, reused, blocked, blocked_examples: blockedExamples };
}
async function persistCamProfile(_supabaseAdmin: any, _orgId: string, _lease: any, camProfile: any) {
  if (!isObject(camProfile)) return { persisted: false };
  // cam-legacy-scan-allow: retirement telemetry, not a live reference.
  console.warn("[LEGACY_CAM_API_INVOKED] persistCamProfile called with extraction cam_profile data; the legacy cam_profiles seed step is retired and performs no write.");
  return { persisted: false, retired: true };
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
  const actorUuid = uuidOrNull(actorUserId);
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
  const workflowExpenseRules = asArray(storedWorkflow?.expense_rules).filter(isSourceBackedExpenseRule);
  const fallbackExpenseRules = workflowExpenseRules.length > 0 ? [] : fallbackExpenseRulesFromWorkflowEvidence(storedWorkflow);
  const rawDocumentFallbackRules = workflowExpenseRules.length > 0 || fallbackExpenseRules.length > 0
    ? []
    : fallbackExpenseRulesFromRawDocument(fileRecord);
  const hasPublishableWorkflowExpenseRules = workflowExpenseRules.length > 0 ||
    fallbackExpenseRules.length > 0 ||
    rawDocumentFallbackRules.length > 0 ||
    shouldPublishWorkflowExpenseRules(storedWorkflow);
  if (!force && Number(existingRuleCount || 0) > 0) {
    const existingCamProfileResult = hasPublishableWorkflowExpenseRules
      ? await persistCamProfile(
        supabaseAdmin,
        orgId,
        lease,
        storedWorkflow?.cam_profile,
      )
      : { persisted: false, error: null };
    const promotion = await promoteApprovedLeaseRuleRows(supabaseAdmin, orgId, lease, actorUserId);
    const camPolicies = await materializeApprovedLeaseRecoveryPolicies(
      supabaseAdmin,
      orgId,
      lease,
      actorUserId,
      actorEmail,
    );
    return {
      status: "already_persisted",
      lease_id: lease.id,
      source_file_id: sourceFileId,
      source_file_found: Boolean(fileRecord),
      workflow_found: Boolean(storedWorkflow),
      rules_persisted: Number(existingRuleCount || 0),
      rules_generated: 0,
      rules_approved: promotion.approved,
      rules_published_to_cam: promotion.published_to_cam,
      rule_sets_approved: promotion.rule_sets_approved,
      cam_policies_materialized: camPolicies.created,
      cam_policies_reused: camPolicies.reused,
      cam_policies_blocked: camPolicies.blocked,
      cam_policy_blocked_examples: camPolicies.blocked_examples,
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
  const expenseRules = workflowExpenseRules.length > 0
    ? workflowExpenseRules
    : fallbackExpenseRules.length > 0
      ? fallbackExpenseRules
      : rawDocumentFallbackRules;
  const publicationExtractionVersion = expenseRuleSource === "whole_document_llm_expense_obligations"
    ? "whole_document_llm_expense_obligations_v1"
    : rawDocumentFallbackRules.length > 0
      ? "typescript_schema_raw_document_fallback_v1"
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
      fallback_rules_generated: fallbackExpenseRules.length,
      raw_document_fallback_rules_generated: rawDocumentFallbackRules.length,
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
    p_actor_user_id: actorUuid,
    p_actor_email: actorEmail,
    p_rule_set_id: existingSet?.id ?? null,
    p_version: existingSet?.version ?? 1,
    p_status: "draft",
    p_extraction_version: publicationExtractionVersion,
    p_property_id: uuidOrNull(lease?.property_id),
    p_rules: prepared.map((item) => item.rule),
    p_values: prepared.map((item) => item.value).filter(Boolean),
    p_clauses: prepared.map((item) => item.clause),
    p_superseded_rule_ids: null,
  });
  if (saveError) throw new Error(`Could not persist approved lease expense rules: ${saveError.message}`);

  const promotion = await promoteApprovedLeaseRuleRows(supabaseAdmin, orgId, lease, actorUserId);
  const camPolicies = await materializeApprovedLeaseRecoveryPolicies(
    supabaseAdmin,
    orgId,
    lease,
    actorUserId,
    actorEmail,
  );

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
    rules_approved: promotion.approved,
    rules_published_to_cam: promotion.published_to_cam,
    rule_sets_approved: promotion.rule_sets_approved,
    cam_policies_materialized: camPolicies.created,
    cam_policies_reused: camPolicies.reused,
    cam_policies_blocked: camPolicies.blocked,
    cam_policy_blocked_examples: camPolicies.blocked_examples,
    rule_set_id: saved?.rule_set_id ?? existingSet?.id ?? null,
    regenerated: false,
    expense_rule_source: expenseRuleSource || (rawDocumentFallbackRules.length > 0 ? "typescript_schema_raw_document_fallback" : null),
    cam_profile_persisted: camProfileResult.persisted,
    cam_profile_error: camProfileResult.error ?? null,
  };
}

export const __test__ = {
  cleanText,
  normalizeToken,
  uuidOrNull,
  exactSourceText,
  canonicalRuleKey,
  prepareRulePayload,
  dedupePreparedRules,
  resolveExpenseCategoryIds,
  materializeApprovedLeaseRecoveryPolicies,
  isSourceBackedExpenseRule,
  shouldPublishWorkflowExpenseRules,
  fallbackExpenseRulesFromWorkflowEvidence,
  fallbackExpenseRulesFromRawDocument,
  sourceFileIdCandidates,
  workflowFromFactLedgerDebug,
};
