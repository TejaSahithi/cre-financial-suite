// @ts-nocheck
/**
 * Document Intelligence v3 - Profile Ensemble and Extraction Planner.
 *
 * Diagnostic-only. This module consolidates existing profile signals from
 * openai_fact_ledger, deterministic lease-workflow rules, layout signals,
 * and legacy payload hints. It does not decide which extraction calls run.
 */

import { detectDocumentProfileSignals } from "../lease-workflow.ts";
import { getProfilePolicy, normalizeProfileKey, resolvePolicyKey } from "./profile-policy.ts";

export const PROFILE_SOURCE_VALUES = [
  "openai_fact_ledger",
  "deterministic_rules",
  "canonical_layout_signals",
  "existing_payload",
  "manual_override",
  "fallback_unknown",
] as const;

export const ALLOWED_EXTRACTION_MODULE_KEYS = [
  "document_identity",
  "profile_discovery",
  "parties_and_roles",
  "premises",
  "dates_and_events",
  "rent_and_charges",
  "money_and_schedules",
  "assignment_terms",
  "amendment_terms",
  "renewal_terms",
  "termination_terms",
  "consent_terms",
  "expense_recovery",
  "cam_rules",
  "taxes",
  "insurance",
  "utilities",
  "repairs_maintenance",
  "legal_options",
  "notices",
  "signatures",
  "clauses",
  "references_and_missing_documents",
  "risk_signals",
  "unknown_document_discovery",
] as const;

function clampConfidence(value: unknown, fallback = 0.5): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function unique(values: any[]): string[] {
  return [...new Set((values || []).filter((v) => v != null && String(v).trim()).map((v) => String(v).trim()))];
}

function textFromUploadedFile(uploadedFile: Record<string, unknown> | null | undefined): string {
  const raw: any = uploadedFile?.docling_raw;
  return String(raw?.full_text ?? raw?.text ?? uploadedFile?.full_text ?? "");
}

function readOpenAIDebug(result: any) {
  const debug = result?.metadata?.extractionDebug;
  return debug?.openai_fact_ledger ?? debug?.vertex_fact_ledger ?? null;
}

function readExistingProfileHints(result: any, uploadedFile: any): string[] {
  return unique([
    uploadedFile?.document_profile,
    uploadedFile?.document_subtype,
    uploadedFile?.metadata?.document_profile,
    result?.document_profile,
    result?.selected_document_profile,
    result?.workflow_output?.document_profile,
    result?.workflow_output?.selected_document_profile,
    result?.metadata?.extractionDebug?.document_profile,
    result?.metadata?.extractionDebug?.selected_document_profile,
  ]);
}

function candidate(profileKey: string | null | undefined, confidence: number, source: string, signals: any = {}) {
  return {
    profile_key: normalizeProfileKey(profileKey),
    confidence: clampConfidence(confidence),
    signals: signals && typeof signals === "object" ? signals : { value: signals },
    source,
  };
}

export function buildProfileEnsemble(args: {
  uploadedFile?: Record<string, unknown> | null;
  result?: any;
  profileOverride?: string | null;
  layoutSummary?: Record<string, unknown> | null;
}) {
  const uploadedFile: any = args.uploadedFile ?? {};
  const result = args.result ?? {};
  const documentSubtype = uploadedFile?.document_subtype ?? uploadedFile?.metadata?.document_subtype ?? null;
  const fullText = textFromUploadedFile(uploadedFile);
  const layoutSummary = args.layoutSummary ?? {};
  const candidates: any[] = [];
  const signals: Record<string, unknown> = {
    document_subtype: documentSubtype,
    layout: {
      page_count: layoutSummary?.page_count ?? null,
      full_text_chars: layoutSummary?.full_text_chars ?? fullText.length,
      text_block_count: layoutSummary?.text_block_count ?? null,
    },
  };

  if (args.profileOverride) {
    candidates.push(candidate(args.profileOverride, 1, "manual_override", { reason: "profile_override" }));
  }

  const vfl = readOpenAIDebug(result);
  if (vfl?.document_profile) {
    candidates.push(candidate(vfl.document_profile, vfl.document_profile_confidence ?? 0.6, "openai_fact_ledger", {
      method: vfl.document_profile_method ?? null,
      reasoning: vfl.document_profile_reasoning ?? null,
    }));
  }

  if (fullText.trim().length > 0 || documentSubtype) {
    const deterministic = detectDocumentProfileSignals(fullText, documentSubtype);
    signals.deterministic = deterministic.profile_detection_signals;
    candidates.push(candidate(
      deterministic.selected_document_profile,
      deterministic.strong_full_lease_signals ? 0.72 : 0.58,
      "deterministic_rules",
      deterministic.profile_detection_signals,
    ));
  }

  for (const hint of readExistingProfileHints(result, uploadedFile)) {
    candidates.push(candidate(hint, 0.45, "existing_payload", { raw_profile_hint: hint }));
  }

  if (!candidates.length && fullText.trim().length < 20) {
    candidates.push(candidate("unknown_cre_document", 0.3, "canonical_layout_signals", {
      reason: "insufficient_text_for_profile_detection",
      full_text_chars: fullText.length,
    }));
  }

  const priority = ["manual_override", "openai_fact_ledger", "deterministic_rules", "existing_payload", "canonical_layout_signals"];
  const recognized = candidates.filter((c) => c.profile_key !== "unknown_cre_document");
  const pool = recognized.length ? recognized : candidates;
  const selected = [...pool].sort((a, b) => {
    const sourceDelta = priority.indexOf(a.source) - priority.indexOf(b.source);
    if (sourceDelta !== 0) return sourceDelta;
    return b.confidence - a.confidence;
  })[0] ?? candidate("unknown_cre_document", 0, "fallback_unknown", { reason: "no_profile_candidates" });

  const selectedPolicyKey = resolvePolicyKey(selected.profile_key);
  const policy = getProfilePolicy(selectedPolicyKey);
  const profileKeys = unique(candidates.map((c) => c.profile_key));
  const disagreements = profileKeys.length > 1
    ? [{ type: "candidate_profile_disagreement", profile_keys: profileKeys }]
    : [];
  const fallbackReason = selectedPolicyKey === "unknown_cre_document"
    ? (candidates.length ? "no_recognized_profile_candidate" : "no_profile_candidates")
    : null;

  return {
    selected_profile_key: selected.profile_key,
    selected_policy_key: selectedPolicyKey,
    confidence: selected.confidence,
    status: policy.profile_status === "not_applicable"
      ? "not_applicable"
      : selectedPolicyKey === "unknown_cre_document"
        ? "needs_review"
        : "auto_detected",
    candidates,
    signals,
    disagreements,
    fallback_reason: fallbackReason,
    profile_source: selected.source ?? "fallback_unknown",
  };
}

function moduleDef(moduleKey: string, reason: string, priority: number, expectedOutputs: string[], pageHints: string[] = [], status = "planned") {
  return {
    module_key: moduleKey,
    reason,
    priority,
    expected_outputs: expectedOutputs,
    page_hints: pageHints,
    status,
  };
}

function skipDef(moduleKey: string, reason: string, priority = 90) {
  return moduleDef(moduleKey, reason, priority, [], [], "skipped");
}

const BASE_LEASE_MODULES = [
  moduleDef("document_identity", "Identify lease document and source metadata.", 1, ["document_type", "original_lease_date"], ["first_pages"]),
  moduleDef("profile_discovery", "Confirm base lease profile.", 2, ["profile_key", "policy_key"], ["first_pages"]),
  moduleDef("parties_and_roles", "Extract landlord, tenant, guarantor, and role context.", 3, ["landlord_name", "tenant_name"], ["first_pages", "signature_pages"]),
  moduleDef("premises", "Extract premises and area context.", 4, ["property_address", "square_footage", "unit"], ["first_pages", "premises_clause"]),
  moduleDef("dates_and_events", "Extract lease commencement, expiration, and critical events.", 5, ["commencement_date", "expiration_date", "rent_commencement_date"], ["term_clause"]),
  moduleDef("rent_and_charges", "Extract rent obligations and charges.", 6, ["monthly_rent", "annual_rent", "rent_schedule"], ["rent_clause", "tables"]),
  moduleDef("money_and_schedules", "Extract schedules and monetary escalations.", 7, ["rent_schedule", "security_deposit"], ["tables", "exhibits"]),
  moduleDef("expense_recovery", "Extract operating expense recovery terms.", 8, ["expense_structure", "recoverable_expenses"], ["expense_clause"]),
  moduleDef("cam_rules", "Extract CAM methodology and caps.", 9, ["cam_amount", "cam_cap_pct", "cam_rules"], ["cam_clause"]),
  moduleDef("taxes", "Extract real estate tax obligations.", 10, ["tax_responsibility"], ["tax_clause"]),
  moduleDef("insurance", "Extract insurance obligations.", 11, ["responsibility_insurance", "general_liability_min"], ["insurance_clause"]),
  moduleDef("utilities", "Extract utility responsibilities.", 12, ["responsibility_utilities"], ["utilities_clause"]),
  moduleDef("repairs_maintenance", "Extract repair and maintenance responsibilities.", 13, ["responsibility_repairs"], ["maintenance_clause"]),
  moduleDef("legal_options", "Extract options and legal rights.", 14, ["renewal_options", "termination_options"], ["options_clause"]),
  moduleDef("notices", "Extract notice addresses and requirements.", 15, ["notice_address"], ["notice_clause"]),
  moduleDef("signatures", "Extract signature dates and parties.", 16, ["tenant_signature_date", "landlord_signature_date"], ["signature_pages"]),
  moduleDef("clauses", "Extract material clauses.", 17, ["clauses"], ["all_pages"]),
  moduleDef("risk_signals", "Identify risk or blocker signals.", 18, ["risk_flags"], ["all_pages"]),
];

function assignmentModules(includeAmendment: boolean) {
  return [
    moduleDef("document_identity", "Identify assignment document and source metadata.", 1, ["document_type", "original_lease_date"], ["first_pages"]),
    moduleDef("profile_discovery", "Confirm assignment profile.", 2, ["profile_key", "policy_key"], ["first_pages"]),
    moduleDef("parties_and_roles", "Extract landlord, assignor, assignee, and tenant roles.", 3, ["landlord_name", "assignor_name", "assignee_name"], ["first_pages", "signature_pages"]),
    moduleDef("dates_and_events", "Extract assignment effective date and referenced dates.", 4, ["assignment_effective_date", "original_lease_date"], ["first_pages"]),
    moduleDef("assignment_terms", "Extract assignment and assumption terms.", 5, ["assumption_scope", "assigned_interest"], ["assignment_clause"]),
    ...(includeAmendment ? [moduleDef("amendment_terms", "Extract amendment terms included with the assignment.", 6, ["all_other_terms_remain_same", "amended_terms"], ["amendment_clause"])] : []),
    moduleDef("consent_terms", "Extract consent and approval terms.", includeAmendment ? 7 : 6, ["landlord_consent"], ["consent_clause"]),
    moduleDef("notices", "Extract assignee and notice addresses.", includeAmendment ? 8 : 7, ["assignee_notice_address", "notice_address"], ["notice_clause"]),
    moduleDef("signatures", "Extract signature dates and parties.", includeAmendment ? 9 : 8, ["tenant_signature_date", "landlord_signature_date"], ["signature_pages"]),
    moduleDef("references_and_missing_documents", "Identify original lease and missing related documents.", includeAmendment ? 10 : 9, ["original_lease_reference"], ["first_pages", "recitals"]),
    moduleDef("risk_signals", "Identify assignment risk signals.", includeAmendment ? 11 : 10, ["risk_flags"], ["all_pages"]),
  ];
}

export function buildExtractionPlan(profileKey: string | null | undefined) {
  const policyKey = resolvePolicyKey(profileKey);
  const policy = getProfilePolicy(policyKey);
  let modulesToRun: any[] = [];
  let modulesSkipped: any[] = [];
  let status = policy.profile_status === "not_applicable" ? "not_applicable" : "planned";

  if (policyKey === "base_lease") {
    modulesToRun = BASE_LEASE_MODULES;
  } else if (policyKey === "assignment_assumption") {
    modulesToRun = assignmentModules(false);
    modulesSkipped = policy.skipped_modules.map((m) => skipDef(m.module_key, m.reason));
  } else if (policyKey === "assignment_assumption_amendment") {
    modulesToRun = assignmentModules(true);
    modulesSkipped = policy.skipped_modules.map((m) => skipDef(m.module_key, m.reason));
  } else if (policyKey === "lease_assignment") {
    modulesToRun = assignmentModules(false);
    modulesSkipped = policy.skipped_modules.map((m) => skipDef(m.module_key, m.reason));
  } else if (policyKey === "unknown_cre_document") {
    modulesToRun = [
      moduleDef("document_identity", "Identify document metadata before applying policy.", 1, ["document_type"], ["first_pages"]),
      moduleDef("profile_discovery", "Discover whether this is a CRE lease-related document.", 2, ["profile_candidates"], ["first_pages", "head_tail"]),
      moduleDef("unknown_document_discovery", "Capture safe discovery facts only.", 3, ["candidate_document_facts"], ["all_pages"]),
      moduleDef("risk_signals", "Flag potential risks without applying base lease blockers.", 4, ["risk_flags"], ["all_pages"]),
    ];
  } else if (policyKey === "non_cre_document") {
    status = "not_applicable";
    modulesToRun = [
      moduleDef("document_identity", "Record non-CRE document identity only.", 1, ["document_type"], ["first_pages"], "not_applicable"),
      moduleDef("profile_discovery", "Confirm non-CRE classification.", 2, ["profile_key"], ["first_pages"], "not_applicable"),
    ];
  } else {
    modulesToRun = [
      moduleDef("document_identity", `Identify ${policyKey} document metadata.`, 1, ["document_type"], ["first_pages"]),
      moduleDef("profile_discovery", `Confirm ${policyKey} profile.`, 2, ["profile_key", "policy_key"], ["first_pages"]),
      moduleDef("parties_and_roles", "Extract relevant parties and roles.", 3, ["parties"], ["first_pages", "signature_pages"]),
      moduleDef("dates_and_events", "Extract relevant dates and events.", 4, ["dates"], ["first_pages", "date_clauses"]),
      moduleDef("clauses", "Extract material clauses for this profile.", 5, ["clauses"], ["all_pages"]),
      moduleDef("references_and_missing_documents", "Identify related documents needed for interpretation.", 6, ["related_documents"], ["recitals", "references"]),
      moduleDef("risk_signals", "Identify risk or blocker signals.", 7, ["risk_flags"], ["all_pages"]),
    ];
    modulesSkipped = policy.skipped_modules.map((m) => skipDef(m.module_key, m.reason));
  }

  return {
    profile_key: policyKey,
    modules_to_run: modulesToRun,
    modules_skipped: modulesSkipped,
    related_documents_needed: policy.related_documents_needed,
    expected_information_profile: policy.expected_information_profile,
    planner_warnings: policy.planner_warnings,
    status,
    diagnostic_only: true,
  };
}

export function buildDiagnosticProfileAndPlan(args: {
  uploadedFile?: Record<string, unknown> | null;
  result?: any;
  profileOverride?: string | null;
  layoutSummary?: Record<string, unknown> | null;
}) {
  const profileEnsemble = buildProfileEnsemble(args);
  const extractionPlan = buildExtractionPlan(profileEnsemble.selected_policy_key);
  return { profileEnsemble, extractionPlan };
}
