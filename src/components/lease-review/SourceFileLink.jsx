import React from 'react';
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { supabase } from "@/services/supabaseClient";

export function SourceFileLink({ lease }) {
  const { data } = useQuery({
    queryKey: ["uploaded-file-url", lease?.id, lease?.extraction_data?.source_file_id],
    queryFn: async () => {
      if (!lease) return null;
      const row = await findUploadedFileForLease(lease);
      if (!row) return null;
      const resolvedUrl = await resolveUploadedFileUrl(row);
      return { ...row, file_url: resolvedUrl || row.file_url };
    },
    enabled: !!lease,
  });
  if (!lease) return <p className="text-xs text-slate-500">No source file linked.</p>;
  if (!data?.file_url) return <p className="text-xs text-slate-500">Source file URL is unavailable.</p>;
  return (
    <a
      href={data.file_url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700"
    >
      <FileText className="h-4 w-4" />
      {data.file_name || "Original upload"}
    </a>
  );
}

export async function findUploadedFileForLease(lease) {
  if (!lease || !supabase) return null;

  const sourceFileId = lease.extraction_data?.source_file_id || null;
  if (sourceFileId) {
    const { data } = await supabase
      .from("uploaded_files")
      .select("id, org_id, file_url, file_name")
      .eq("id", sourceFileId)
      .maybeSingle();
    if (data) return data;
  }

  if (!lease.id) return null;

  let query = supabase
    .from("uploaded_files")
    .select("id, org_id, file_url, file_name")
    .contains("reviewed_output", { lease_review_ids: [lease.id] })
    .order("updated_at", { ascending: false })
    .limit(1);

  if (lease.org_id) {
    query = query.eq("org_id", lease.org_id);
  }

  const { data } = await query.maybeSingle();
  return data || null;
}

export async function resolveUploadedFileUrl(fileRecord) {
  if (!fileRecord) return null;

  const storagePath = deriveFinancialUploadPath(fileRecord);
  if (storagePath) {
    const { data, error } = await supabase.storage
      .from("financial-uploads")
      .createSignedUrl(storagePath, 60 * 60);

    if (!error && data?.signedUrl) {
      return data.signedUrl;
    }
  }

  return fileRecord.file_url || null;
}

export function deriveFinancialUploadPath(fileRecord) {
  const rawUrl = String(fileRecord?.file_url || "");
  const publicPrefix = "/storage/v1/object/public/financial-uploads/";
  const signPrefix = "/storage/v1/object/sign/financial-uploads/";

  const publicIndex = rawUrl.indexOf(publicPrefix);
  if (publicIndex >= 0) {
    return rawUrl.slice(publicIndex + publicPrefix.length).split("?")[0];
  }

  const signIndex = rawUrl.indexOf(signPrefix);
  if (signIndex >= 0) {
    return rawUrl.slice(signIndex + signPrefix.length).split("?")[0];
  }

  if (fileRecord?.org_id && fileRecord?.id) {
    return `${fileRecord.org_id}/${fileRecord.id}`;
  }

  return null;
}
