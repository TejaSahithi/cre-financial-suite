import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { supabase } from "@/services/supabaseClient";
import {
  LEASE_REVIEW_FIELDS,
  readFieldValue,
  readFieldConfidence,
  readFieldEvidence,
  resolveExtractionStatus,
} from "@/lib/leaseReviewSchema";

function prettyJson(value, limit = 4000) {
  try {
    const s = JSON.stringify(value, null, 2);
    if (!s) return "—";
    return s.length > limit ? `${s.slice(0, limit)}\n…[truncated, ${s.length - limit} more chars]` : s;
  } catch {
    return String(value);
  }
}

function Section({ title, count, children, badge }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <div className="flex items-center gap-2">
          {badge != null && <Badge className="bg-slate-100 text-slate-700">{badge}</Badge>}
          {count != null && <Badge className="bg-slate-100 text-slate-700">{count}</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">{children}</CardContent>
    </Card>
  );
}

/**
 * Extraction Debug Panel
 *
 * Shows everything a reviewer needs to diagnose a wrong extraction:
 *   1. Docling page text (from uploaded_files.docling_raw)
 *   2. Raw Gemini / pipeline JSON (workflow_output)
 *   3. Normalized mapped fields (extraction_data.fields)
 *   4. Review table rows (per LEASE_REVIEW_FIELDS — what the operator sees)
 *   5. Field mapping warnings (extraction_data.workflow_output.validations)
 *   6. Source matching results (per-field source_text + source_page)
 */
export default function ExtractionDebugPanel({ lease }) {
  const sourceFileId = lease?.extraction_data?.source_file_id || null;

  const { data: uploadedFile, isLoading: fileLoading } = useQuery({
    queryKey: ["debug-uploaded-file", sourceFileId],
    enabled: !!sourceFileId && !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("uploaded_files")
        .select("id, file_name, docling_raw, ui_review_payload, normalized_output, parsed_data, valid_data, extraction_method, status")
        .eq("id", sourceFileId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    retry: false,
  });

  const doclingRaw = uploadedFile?.docling_raw || null;
  const fullText = doclingRaw?.full_text || "";
  const textBlocks = Array.isArray(doclingRaw?.text_blocks) ? doclingRaw.text_blocks : [];
  const doclingFields = Array.isArray(doclingRaw?.fields) ? doclingRaw.fields : [];

  const workflowOutput = lease?.extraction_data?.workflow_output || null;
  const extractionFields = lease?.extraction_data?.fields || {};
  const fieldEvidence = lease?.extraction_data?.field_evidence || extractionFields;
  const confidenceScores = lease?.extraction_data?.confidence_scores || {};
  const validations = Array.isArray(workflowOutput?.validations) ? workflowOutput.validations : [];

  const reviewTableRows = useMemo(() => {
    return LEASE_REVIEW_FIELDS.map((field) => {
      const value = readFieldValue(lease, field.key);
      const confidence = readFieldConfidence(lease, field.key);
      const evidence = readFieldEvidence(lease, field.key);
      const status = resolveExtractionStatus(lease, field.key, { value, confidence, evidence });
      return {
        key: field.key,
        label: field.label,
        required: !!field.required,
        value,
        confidence,
        sourcePage: evidence.sourcePage,
        sourceText: evidence.sourceText,
        rawValue: evidence.rawValue,
        status,
      };
    });
  }, [lease]);

  const sourceMatching = reviewTableRows.filter((r) => r.value != null && r.value !== "");
  const missingEvidence = reviewTableRows.filter(
    (r) => r.value != null && r.value !== "" && !r.sourcePage && !r.sourceText,
  );

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
        For diagnosing extraction issues. Read-only view of every layer between the document and the review table.
      </div>

      <Section
        title="1. Docling page text"
        count={`${textBlocks.length} blocks`}
        badge={uploadedFile?.extraction_method || "docling"}
      >
        {fileLoading ? (
          <div className="flex items-center gap-2 text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading source file…
          </div>
        ) : !sourceFileId ? (
          <p className="text-slate-500">No source file linked to this lease.</p>
        ) : (
          <>
            <details>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">Full text ({fullText.length.toLocaleString()} chars)</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{fullText || "(empty)"}</pre>
            </details>
            <details>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">Text blocks ({textBlocks.length})</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(textBlocks.slice(0, 50))}</pre>
            </details>
            <details>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">Docling key/value fields ({doclingFields.length})</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(doclingFields)}</pre>
            </details>
          </>
        )}
      </Section>

      <Section
        title="2. Raw extraction / Gemini JSON"
        count={`${Object.keys(workflowOutput?.lease_fields || {}).length} lease_fields`}
      >
        {!workflowOutput ? (
          <p className="text-slate-500">No workflow_output captured on this lease yet.</p>
        ) : (
          <>
            <details open>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">workflow_output.lease_fields</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(workflowOutput.lease_fields)}</pre>
            </details>
            <details>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">workflow_output.expense_rules ({workflowOutput.expense_rules?.length || 0})</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(workflowOutput.expense_rules)}</pre>
            </details>
            <details>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">workflow_output.cam_profile</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(workflowOutput.cam_profile)}</pre>
            </details>
            <details>
              <summary className="cursor-pointer text-slate-700 hover:text-slate-900">workflow_output.lease_clauses ({workflowOutput.lease_clauses?.length || 0})</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(workflowOutput.lease_clauses)}</pre>
            </details>
          </>
        )}
      </Section>

      <Section
        title="3. Normalized mapped fields (lease.extraction_data.fields)"
        count={`${Object.keys(extractionFields).length} keys`}
      >
        <pre className="max-h-72 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(extractionFields)}</pre>
      </Section>

      <Section
        title="4. Review table rows (what the operator sees)"
        count={`${reviewTableRows.length} fields`}
      >
        <div className="max-h-72 overflow-auto rounded border border-slate-200">
          <table className="w-full text-[11px]">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-2 py-1 text-left">Field</th>
                <th className="px-2 py-1 text-left">Value</th>
                <th className="px-2 py-1 text-left">Conf</th>
                <th className="px-2 py-1 text-left">Page</th>
                <th className="px-2 py-1 text-left">Source Text</th>
                <th className="px-2 py-1 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {reviewTableRows.map((row) => (
                <tr key={row.key} className="border-t border-slate-100">
                  <td className="px-2 py-1 font-medium text-slate-700">{row.label}{row.required && <span className="ml-1 text-red-500">*</span>}</td>
                  <td className="px-2 py-1 text-slate-900">{row.value == null ? "—" : String(row.value)}</td>
                  <td className="px-2 py-1 text-slate-600">{typeof row.confidence === "number" ? `${Math.round(row.confidence)}%` : "—"}</td>
                  <td className="px-2 py-1 text-slate-600">{row.sourcePage ?? "—"}</td>
                  <td className="max-w-[260px] truncate px-2 py-1 italic text-slate-500" title={row.sourceText ?? ""}>{row.sourceText ?? "—"}</td>
                  <td className="px-2 py-1 text-slate-600">{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="5. Field mapping warnings"
        count={validations.filter((v) => v?.pass === false).length}
      >
        {validations.length === 0 ? (
          <p className="text-slate-500">No workflow validation results.</p>
        ) : (
          <ul className="space-y-1">
            {validations.map((v, i) => (
              <li key={i} className={`rounded px-2 py-1 ${v?.pass === false ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
                <span className="font-mono text-[10px]">{v?.rule || "rule"}</span>{" — "}
                {v?.message || ""}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="6. Source matching results"
        count={`${sourceMatching.length - missingEvidence.length} of ${sourceMatching.length} have evidence`}
        badge={missingEvidence.length > 0 ? `${missingEvidence.length} missing` : "ok"}
      >
        {sourceMatching.length === 0 ? (
          <p className="text-slate-500">No fields have a value to match yet.</p>
        ) : missingEvidence.length === 0 ? (
          <p className="text-emerald-700">Every populated field has source page or source text.</p>
        ) : (
          <div>
            <p className="mb-1 text-amber-800">Fields with a value but no source evidence — these cannot be auto-accepted:</p>
            <ul className="space-y-0.5">
              {missingEvidence.map((row) => (
                <li key={row.key} className="rounded bg-amber-50 px-2 py-1 text-amber-800">
                  <span className="font-medium">{row.label}</span>{" "}
                  <span className="text-amber-600">= {String(row.value)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title="confidence_scores" count={Object.keys(confidenceScores).length}>
        <pre className="max-h-48 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">{prettyJson(confidenceScores)}</pre>
      </Section>
    </div>
  );
}
