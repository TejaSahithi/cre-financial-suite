// @ts-nocheck
/**
 * Document Intelligence v3 - Document Package Graph (Phase 11).
 *
 * Diagnostic-only package graph around uploaded files, v3 runs, and
 * related-document requirements. This never gates approval and never replaces
 * ui_review_payload/normalized_output; it is a server-owned read model for
 * admin diagnostics.
 */

import {
  buildRelatedDocumentRequirementInputs,
  normalizeRequiredDocumentType,
  relationshipTypeForRequiredDocument,
} from "./related-documents.ts";

function text(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return s.length ? s : null;
}

function unique(values: any[]): string[] {
  return [...new Set((values || []).filter((v) => v != null && String(v).trim()).map((v) => String(v).trim()))];
}

function fileName(uploadedFile: any): string | null {
  return text(uploadedFile?.file_name ?? uploadedFile?.name ?? uploadedFile?.metadata?.file_name);
}

function documentTypeFromProfile(profileKey: string | null | undefined): string | null {
  const key = text(profileKey);
  if (!key) return null;
  if (key.includes("assignment")) return "assignment";
  if (key.includes("base_lease") || key.includes("full_lease")) return "base_lease";
  if (key.includes("amendment")) return "amendment";
  return key;
}

export function buildPackageKey(args: {
  leaseId?: string | null;
  uploadedFileId?: string | null;
  contentHash?: string | null;
  profileKey?: string | null;
  uploadedFile?: Record<string, unknown> | null;
}) {
  if (text(args.leaseId)) return `lease:${text(args.leaseId)}`;
  if (text(args.uploadedFileId)) return `upload:${text(args.uploadedFileId)}`;
  if (text(args.contentHash)) return `content:${text(args.contentHash)}`;

  const entitySignal = text(args.uploadedFile?.property_id)
    ?? text(args.uploadedFile?.building_id)
    ?? text(args.uploadedFile?.unit_id)
    ?? text(args.uploadedFile?.metadata?.property_id);
  if (entitySignal) return `entity:${entitySignal}`;

  return `profile:${text(args.profileKey) ?? "unknown_cre_document"}`;
}

export function emptyPackageGraph(status = "not_available", error: string | null = null) {
  return {
    package_id: null,
    package_key: null,
    documents: [],
    relationships: [],
    related_document_requirements: [],
    candidates: [],
    graph_status: status,
    diagnostic_only: true,
    error,
  };
}

function candidateMatchesRequirement(candidate: any, requirementType: string): boolean {
  const type = normalizeRequiredDocumentType(requirementType);
  const profile = normalizeRequiredDocumentType(candidate.document_profile ?? candidate.document_type ?? "");
  if (type === "original_lease") {
    return profile === "base_lease" || profile === "full_lease" || profile.includes("lease");
  }
  return profile === type || profile.includes(type);
}

export function rankCandidateDocuments(args: {
  currentDocument?: any;
  existingDocuments?: any[];
  requiredDocumentTypes?: string[];
}) {
  const current = args.currentDocument ?? {};
  const existing = Array.isArray(args.existingDocuments) ? args.existingDocuments : [];
  const requiredTypes = (Array.isArray(args.requiredDocumentTypes) ? args.requiredDocumentTypes : []).map(normalizeRequiredDocumentType);
  const currentId = text(current.id);

  return existing
    .filter((candidate) => text(candidate?.id) && text(candidate.id) !== currentId)
    .map((candidate) => {
      const signals: string[] = [];
      let score = 0;
      if (text(current.content_hash) && text(current.content_hash) === text(candidate.content_hash)) {
        score += 95;
        signals.push("content_hash_duplicate");
      }
      if (text(current.lease_id) && text(current.lease_id) === text(candidate.lease_id)) {
        score += 85;
        signals.push("same_lease_id");
      }
      for (const requiredType of requiredTypes) {
        if (candidateMatchesRequirement(candidate, requiredType)) {
          score += requiredType === "original_lease" ? 35 : 25;
          signals.push(`profile_matches:${requiredType}`);
        }
      }
      if (text(current.file_name) && text(candidate.file_name) && text(current.file_name) === text(candidate.file_name)) {
        score += 20;
        signals.push("same_file_name");
      }
      if (!signals.length) return null;
      return {
        candidate_document_id: candidate.id,
        uploaded_file_id: candidate.uploaded_file_id ?? null,
        lease_id: candidate.lease_id ?? null,
        document_profile: candidate.document_profile ?? null,
        document_type: candidate.document_type ?? null,
        file_name: candidate.file_name ?? null,
        content_hash: candidate.content_hash ?? null,
        score: Math.min(100, score),
        matched_signals: signals,
        status: "candidate_found",
      };
    })
    .filter(Boolean)
    .filter((candidate) => candidate.score >= 60)
    .sort((a, b) => b.score - a.score);
}

export function buildRelatedDocumentCoverageFromPackageGraph(graph: any, fallbackNeeded: string[] = []) {
  const requirements = Array.isArray(graph?.related_document_requirements) ? graph.related_document_requirements : [];
  const fallback = Array.isArray(fallbackNeeded) ? fallbackNeeded.map(normalizeRequiredDocumentType) : [];
  const needed = unique([
    ...fallback,
    ...requirements.map((requirement) => requirement.required_document_type),
  ]);
  const present = unique(requirements
    .filter((requirement) => requirement.status === "linked")
    .map((requirement) => requirement.required_document_type));
  const candidateFound = unique(requirements
    .filter((requirement) => requirement.status === "candidate_found")
    .map((requirement) => requirement.required_document_type));
  const missing = unique(requirements.length
    ? requirements.filter((requirement) => requirement.status === "missing").map((requirement) => requirement.required_document_type)
    : needed);
  const reasons: Record<string, string[]> = {};
  for (const requirement of requirements) {
    reasons[requirement.required_document_type] = [
      requirement.reason,
      ...(Array.isArray(requirement.metadata?.candidate_signals) ? requirement.metadata.candidate_signals : []),
    ].filter(Boolean);
  }

  return {
    related_documents_needed: needed,
    related_documents_present: present,
    related_documents_missing: missing,
    related_documents_candidate_found: candidateFound,
    missing_related_document_reasons: reasons,
  };
}

function graphStatus(requirements: any[], candidates: any[]) {
  if (requirements.some((requirement) => requirement.status === "missing")) return "missing_related_documents";
  if (requirements.some((requirement) => requirement.status === "candidate_found") || candidates.length > 0) return "candidates_found";
  if (requirements.length === 0) return "ready";
  return "ready";
}

function mapPackageGraphRows(packageRow: any, documents: any[], relationships: any[], requirements: any[]) {
  const candidates = requirements.flatMap((requirement) => Array.isArray(requirement?.metadata?.candidates)
    ? requirement.metadata.candidates.map((candidate) => ({
      ...candidate,
      required_document_type: requirement.required_document_type,
      requirement_id: requirement.id,
    }))
    : []);
  return {
    package_id: packageRow?.id ?? null,
    package_key: packageRow?.package_key ?? null,
    documents: (documents ?? []).map((doc) => ({
      document_id: doc.id,
      uploaded_file_id: doc.uploaded_file_id ?? null,
      lease_id: doc.lease_id ?? null,
      run_id: doc.document_intelligence_run_id ?? null,
      document_profile: doc.document_profile ?? null,
      document_type: doc.document_type ?? null,
      content_hash: doc.content_hash ?? null,
      document_date: doc.document_date ?? null,
      effective_date: doc.effective_date ?? null,
      file_name: doc.file_name ?? null,
      is_primary: !!doc.is_primary,
      confidence: doc.confidence ?? null,
      metadata: doc.metadata ?? {},
      created_at: doc.created_at ?? null,
    })),
    relationships: (relationships ?? []).map((relationship) => ({
      relationship_id: relationship.id,
      source_document_id: relationship.source_document_id ?? null,
      target_document_id: relationship.target_document_id ?? null,
      target_document_requirement_id: relationship.target_document_requirement_id ?? null,
      relationship_type: relationship.relationship_type ?? null,
      confidence: relationship.confidence ?? null,
      status: relationship.status ?? null,
      evidence_claim_ids: relationship.evidence_claim_ids ?? [],
      evidence_summary: relationship.evidence_summary ?? {},
      metadata: relationship.metadata ?? {},
    })),
    related_document_requirements: (requirements ?? []).map((requirement) => ({
      requirement_id: requirement.id,
      source_document_id: requirement.source_document_id ?? null,
      required_document_type: requirement.required_document_type ?? null,
      reason: requirement.reason ?? null,
      required_for: requirement.required_for ?? [],
      importance_level: requirement.importance_level ?? "medium",
      status: requirement.status ?? "missing",
      candidate_document_ids: requirement.candidate_document_ids ?? [],
      evidence_claim_ids: requirement.evidence_claim_ids ?? [],
      metadata: requirement.metadata ?? {},
    })),
    candidates,
    graph_status: graphStatus(requirements ?? [], candidates),
    diagnostic_only: true,
  };
}

export async function fetchPackageGraphForRun(args: {
  supabaseAdmin: any;
  orgId: string;
  runId?: string | null;
  uploadedFileId?: string | null;
}) {
  const { supabaseAdmin, orgId, runId, uploadedFileId } = args;
  try {
    let documentQuery = supabaseAdmin
      .from("document_package_documents")
      .select("*")
      .eq("org_id", orgId);
    if (runId) documentQuery = documentQuery.eq("document_intelligence_run_id", runId);
    else if (uploadedFileId) documentQuery = documentQuery.eq("uploaded_file_id", uploadedFileId);
    else return emptyPackageGraph();

    const { data: documentRow, error: docError } = await documentQuery.maybeSingle();
    if (docError) throw new Error(docError.message);
    if (!documentRow?.package_id) return emptyPackageGraph("no_package");

    const [{ data: packageRow, error: packageError }, { data: documents, error: documentsError }, { data: relationships, error: relationshipsError }, { data: requirements, error: requirementsError }] = await Promise.all([
      supabaseAdmin.from("document_packages").select("*").eq("org_id", orgId).eq("id", documentRow.package_id).maybeSingle(),
      supabaseAdmin.from("document_package_documents").select("*").eq("org_id", orgId).eq("package_id", documentRow.package_id),
      supabaseAdmin.from("document_relationships").select("*").eq("org_id", orgId).eq("package_id", documentRow.package_id),
      supabaseAdmin.from("document_related_document_requirements").select("*").eq("org_id", orgId).eq("package_id", documentRow.package_id),
    ]);
    if (packageError) throw new Error(packageError.message);
    if (documentsError) throw new Error(documentsError.message);
    if (relationshipsError) throw new Error(relationshipsError.message);
    if (requirementsError) throw new Error(requirementsError.message);

    return mapPackageGraphRows(packageRow, documents ?? [], relationships ?? [], requirements ?? []);
  } catch (error: any) {
    return emptyPackageGraph("unavailable", error?.message ?? String(error));
  }
}

async function maybeUpsert(table: string, client: any, values: any, options: any, select = "*") {
  const query = client.from(table).upsert(values, options).select(select).single();
  const { data, error } = await query;
  if (error) throw new Error(`Failed to upsert ${table}: ${error.message}`);
  return data;
}

export async function upsertPackageGraphForRun(args: {
  supabaseAdmin: any;
  orgId: string;
  uploadedFileId: string;
  uploadedFile?: Record<string, unknown>;
  leaseId?: string | null;
  runId: string;
  profileKey?: string | null;
  profileConfidence?: number | null;
  contentHash?: string | null;
  extractionPlan?: any;
  claims?: any[];
  layoutSummary?: any;
}) {
  const {
    supabaseAdmin,
    orgId,
    uploadedFileId,
    uploadedFile = {},
    leaseId = null,
    runId,
    profileKey = null,
    profileConfidence = null,
    contentHash = null,
    extractionPlan = {},
    claims = [],
    layoutSummary = {},
  } = args;
  const packageKey = buildPackageKey({ leaseId, uploadedFileId, contentHash, profileKey, uploadedFile });
  const relatedDocumentsNeeded = Array.isArray(extractionPlan?.related_documents_needed)
    ? extractionPlan.related_documents_needed.map(normalizeRequiredDocumentType)
    : [];

  const packageRow = await maybeUpsert(
    "document_packages",
    supabaseAdmin,
    {
      org_id: orgId,
      package_key: packageKey,
      package_type: "lease_package",
      display_name: fileName(uploadedFile) ?? packageKey,
      primary_uploaded_file_id: uploadedFileId,
      primary_lease_id: leaseId,
      metadata: {
        diagnostic_only: true,
        package_key_priority: leaseId ? "lease_id" : uploadedFileId ? "uploaded_file_id" : contentHash ? "content_hash" : "profile_entity_signal",
        created_by_phase: "document_intelligence_v3.phase11",
      },
    },
    { onConflict: "org_id,package_key" },
  );

  const documentRow = await maybeUpsert(
    "document_package_documents",
    supabaseAdmin,
    {
      org_id: orgId,
      package_id: packageRow.id,
      uploaded_file_id: uploadedFileId,
      lease_id: leaseId,
      document_intelligence_run_id: runId,
      document_profile: profileKey,
      document_type: documentTypeFromProfile(profileKey),
      content_hash: contentHash,
      file_name: fileName(uploadedFile),
      is_primary: true,
      confidence: profileConfidence,
      metadata: {
        diagnostic_only: true,
        layout_summary: layoutSummary,
        profile_key: profileKey,
      },
    },
    { onConflict: "org_id,package_id,document_intelligence_run_id" },
  );

  const { data: existingDocuments, error: existingError } = await supabaseAdmin
    .from("document_package_documents")
    .select("*")
    .eq("org_id", orgId);
  if (existingError) throw new Error(`Failed to inspect existing package documents: ${existingError.message}`);

  const candidates = rankCandidateDocuments({
    currentDocument: documentRow,
    existingDocuments: existingDocuments ?? [],
    requiredDocumentTypes: relatedDocumentsNeeded,
  });
  const candidatesByType = Object.fromEntries(relatedDocumentsNeeded.map((type) => [
    type,
    candidates.filter((candidate) => candidateMatchesRequirement(candidate, type)),
  ]));

  const requirements = buildRelatedDocumentRequirementInputs({
    relatedDocumentsNeeded,
    plannerWarnings: extractionPlan?.planner_warnings ?? [],
    requiredFor: extractionPlan?.expected_information_profile ?? [],
    candidatesByType,
  });

  const claimIds = unique((claims ?? []).map((claim) => claim?.id));
  for (const requirement of requirements) {
    const requirementRow = await maybeUpsert(
      "document_related_document_requirements",
      supabaseAdmin,
      {
        org_id: orgId,
        package_id: packageRow.id,
        source_document_id: documentRow.id,
        required_document_type: requirement.required_document_type,
        reason: requirement.reason,
        required_for: requirement.required_for,
        importance_level: requirement.importance_level,
        status: requirement.status,
        candidate_document_ids: requirement.candidate_document_ids,
        evidence_claim_ids: [],
        metadata: {
          diagnostic_only: true,
          candidates: requirement.candidates,
          candidate_signals: unique(requirement.candidates.flatMap((candidate) => candidate.matched_signals ?? [])),
        },
      },
      { onConflict: "org_id,package_id,source_document_id,required_document_type,reason" },
    );

    const topCandidate = requirement.candidates[0] ?? null;
    await maybeUpsert(
      "document_relationships",
      supabaseAdmin,
      {
        org_id: orgId,
        package_id: packageRow.id,
        source_document_id: documentRow.id,
        target_document_id: topCandidate?.candidate_document_id ?? null,
        target_document_requirement_id: requirementRow.id,
        relationship_type: relationshipTypeForRequiredDocument(requirement.required_document_type),
        confidence: topCandidate ? topCandidate.score / 100 : 0.5,
        evidence_claim_ids: [],
        evidence_summary: { reason: requirement.reason },
        status: topCandidate ? "needs_review" : "missing_target",
        metadata: {
          diagnostic_only: true,
          candidate: topCandidate,
          auto_confirmed: false,
        },
      },
      { onConflict: "org_id,package_id,source_document_id,relationship_type,target_document_id,target_document_requirement_id" },
    );
  }

  const duplicateCandidates = candidates.filter((candidate) => candidate.matched_signals.includes("content_hash_duplicate"));
  for (const candidate of duplicateCandidates) {
    await maybeUpsert(
      "document_relationships",
      supabaseAdmin,
      {
        org_id: orgId,
        package_id: packageRow.id,
        source_document_id: documentRow.id,
        target_document_id: candidate.candidate_document_id,
        target_document_requirement_id: null,
        relationship_type: "duplicate_of",
        confidence: 0.95,
        evidence_claim_ids: claimIds,
        evidence_summary: { matched_signals: candidate.matched_signals },
        status: "needs_review",
        metadata: {
          diagnostic_only: true,
          candidate,
          auto_confirmed: false,
        },
      },
      { onConflict: "org_id,package_id,source_document_id,relationship_type,target_document_id,target_document_requirement_id" },
    );
  }

  return await fetchPackageGraphForRun({ supabaseAdmin, orgId, runId, uploadedFileId });
}
