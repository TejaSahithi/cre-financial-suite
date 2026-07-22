// @ts-nocheck

import type { DocumentFamilyClassification, DocumentFamilyMemberSummary } from "./types.ts";

export function buildDocumentFamilyMember(args: { uploadedFileId: string; classification: DocumentFamilyClassification; fallbackFamilyId?: string | null }): { documentFamilyId: string | null; member: DocumentFamilyMemberSummary; chronologyStatus: "resolved" | "ambiguous" | "unknown" } {
  const familyIds = args.classification.candidateFamilyIds ?? [];
  const documentFamilyId = familyIds.length === 1 ? familyIds[0] : args.fallbackFamilyId ?? null;
  const chronologyStatus = familyIds.length > 1 ? "ambiguous" : args.classification.documentRole === "unknown" ? "unknown" : "resolved";
  return {
    documentFamilyId,
    chronologyStatus,
    member: {
      uploadedFileId: args.uploadedFileId,
      role: args.classification.documentRole,
      effectiveDate: args.classification.effectiveDate,
      executionDate: args.classification.executionDate,
      sequenceNumber: args.classification.sequenceNumber,
      status: chronologyStatus === "ambiguous" ? "ambiguous" : "active",
      reasonCodes: args.classification.reasonCodes,
    },
  };
}

export function orderDocumentFamilyMembers(members: DocumentFamilyMemberSummary[]): DocumentFamilyMemberSummary[] {
  const roleRank = { base_lease: 0, amendment: 1, addendum: 2, commencement_certificate: 3, estoppel: 4, assignment: 5, guaranty: 6, exhibit: 7, schedule: 8, unknown: 9 };
  return [...members].sort((a, b) => {
    const ar = roleRank[a.role] ?? 99;
    const br = roleRank[b.role] ?? 99;
    if (ar !== br) return ar - br;
    if ((a.sequenceNumber ?? 9999) !== (b.sequenceNumber ?? 9999)) return (a.sequenceNumber ?? 9999) - (b.sequenceNumber ?? 9999);
    return String(a.effectiveDate ?? a.executionDate ?? "9999").localeCompare(String(b.effectiveDate ?? b.executionDate ?? "9999"));
  });
}

export async function persistDocumentFamilyMember(args: { supabaseAdmin: any; orgId: string; documentFamilyId: string; uploadedFileId: string; classification: DocumentFamilyClassification; parentUploadedFileId?: string | null; amendsUploadedFileId?: string | null }) {
  const row = {
    organization_id: args.orgId,
    document_family_id: args.documentFamilyId,
    uploaded_file_id: args.uploadedFileId,
    document_role: args.classification.documentRole,
    effective_date: args.classification.effectiveDate,
    execution_date: args.classification.executionDate,
    sequence_number: args.classification.sequenceNumber,
    parent_uploaded_file_id: args.parentUploadedFileId ?? null,
    amends_uploaded_file_id: args.amendsUploadedFileId ?? null,
    family_detection_source: "document-semantics-release6-v1",
    confidence: args.classification.confidence,
    reason_codes: args.classification.reasonCodes,
    is_active: true,
  };
  await args.supabaseAdmin.from("document_family_members")
    .update({ is_active: false, status: "inactive", updated_at: new Date().toISOString() })
    .eq("organization_id", args.orgId)
    .eq("uploaded_file_id", args.uploadedFileId)
    .eq("is_active", true);
  const { data, error } = await args.supabaseAdmin.from("document_family_members").insert(row).select("id").maybeSingle();
  return { id: data?.id ?? null, error: error?.message ?? null };
}