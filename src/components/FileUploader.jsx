import React, { useState, useCallback, useRef } from "react";
import { supabase } from "@/services/supabaseClient";
import useOrgId from "@/hooks/useOrgId";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Upload, FileText, Loader2, CheckCircle, XCircle } from "lucide-react";
import { toast } from "sonner";

const ALL_FILE_TYPES = [
  { value: "leases", label: "Leases" },
  { value: "expenses", label: "Expenses" },
  { value: "properties", label: "Properties" },
  { value: "revenue", label: "Revenue" },
];

const ACCEPTED_EXTENSIONS = [".csv", ".xls", ".xlsx", ".pdf", ".txt", ".tsv"];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileExtension(name) {
  const idx = name.lastIndexOf(".");
  return idx !== -1 ? name.slice(idx).toLowerCase() : "";
}

/**
 * Reusable file upload component that sends files to the upload-handler
 * Edge Function and auto-triggers parsing on success.
 *
 * @param {Object}   props
 * @param {Function} props.onUploadComplete  - called with the upload result object
 * @param {string}   [props.defaultFileType] - pre-selected file type
 * @param {string[]} [props.allowedFileTypes] - restrict dropdown options (default: all)
 */
export default function FileUploader({
  onUploadComplete,
  defaultFileType,
  allowedFileTypes,
}) {
  const { orgId } = useOrgId();
  const fileInputRef = useRef(null);

  // --- state ---
  const [file, setFile] = useState(null);
  const [fileType, setFileType] = useState(defaultFileType || "");
  const [dragOver, setDragOver] = useState(false);
  const [uploadState, setUploadState] = useState("idle"); // idle | uploading | success | error
  const [uploadResult, setUploadResult] = useState(null);
  const [uploadError, setUploadError] = useState(null);

  // Determine which file type options to show
  const typeOptions = allowedFileTypes
    ? ALL_FILE_TYPES.filter((ft) => allowedFileTypes.includes(ft.value))
    : ALL_FILE_TYPES;

  // --- file validation ---
  const validateFile = useCallback((f) => {
    const ext = getFileExtension(f.name);
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      return `Unsupported format "${ext}". Accepted: ${ACCEPTED_EXTENSIONS.join(", ")}`;
    }
    if (f.size > MAX_FILE_SIZE) {
      return `File exceeds 50 MB limit (${formatFileSize(f.size)}).`;
    }
    return null;
  }, []);

  const handleFileSelect = useCallback(
    (f) => {
      const error = validateFile(f);
      if (error) {
        toast.error(error);
        return;
      }
      setFile(f);
      setUploadState("idle");
      setUploadResult(null);
      setUploadError(null);
    },
    [validateFile]
  );

  // --- drag & drop handlers ---
  const onDragOver = useCallback((e) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      const dropped = e.dataTransfer.files?.[0];
      if (dropped) handleFileSelect(dropped);
    },
    [handleFileSelect]
  );

  const onInputChange = useCallback(
    (e) => {
      const selected = e.target.files?.[0];
      if (selected) handleFileSelect(selected);
      // reset so the same file can be selected again if needed
      e.target.value = "";
    },
    [handleFileSelect]
  );

  // --- upload ---
  const handleUpload = useCallback(async () => {
    if (!file) {
      toast.error("Please select a file first.");
      return;
    }
    if (!fileType) {
      toast.error("Please select a file type.");
      return;
    }
    if (!supabase) {
      toast.error("Supabase client is not available.");
      return;
    }

    setUploadState("uploading");
    setUploadError(null);
    setUploadResult(null);

    try {
      // Build FormData for Edge Function
      const formData = new FormData();
      formData.append("file", file);
      formData.append("file_type", fileType);
      if (orgId && orgId !== "__none__") {
        formData.append("org_id", orgId);
      }

      const { data, error } = await supabase.functions.invoke(
        "upload-handler",
        { body: formData }
      );

      if (error) throw error;

      setUploadResult(data);
      setUploadState("success");
      toast.success("File uploaded successfully.");

      // Auto-trigger ingestion (routes to correct parser based on file type)
      if (data?.file_id) {
        try {
          await supabase.functions.invoke("ingest-file", {
            body: { file_id: data.file_id, module_type: fileType },
          });
          toast.info("File processing started.");
        } catch (parseErr) {
          console.error("[FileUploader] ingest-file invocation failed:", parseErr);
          toast.warning("Upload succeeded but processing could not be started.");
        }
      }

      if (onUploadComplete) onUploadComplete(data);
    } catch (err) {
      console.error("[FileUploader] upload failed:", err);
      const message =
        err?.message || err?.context?.message || "Upload failed. Please try again.";
      setUploadError(message);
      setUploadState("error");
      toast.error(message);
    }
  }, [file, fileType, orgId, onUploadComplete]);

  // --- retry ---
  const handleRetry = useCallback(() => {
    setUploadState("idle");
    setUploadError(null);
    setUploadResult(null);
  }, []);

  // --- reset ---
  const handleReset = useCallback(() => {
    setFile(null);
    setFileType(defaultFileType || "");
    setUploadState("idle");
    setUploadResult(null);
    setUploadError(null);
  }, [defaultFileType]);

  // --- render ---
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Upload className="w-5 h-5" />
          Upload File
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Drop zone */}
        <div
          role="button"
          tabIndex={0}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
          }}
          className={`
            flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8
            cursor-pointer transition-colors
            ${
              dragOver
                ? "border-blue-500 bg-blue-50"
                : "border-slate-300 bg-slate-50 hover:border-slate-400 hover:bg-slate-100"
            }
          `}
        >
          <Upload
            className={`w-8 h-8 ${dragOver ? "text-blue-500" : "text-slate-400"}`}
          />
          <p className="text-sm font-medium text-slate-600">
            Drag and drop a file here, or click to select
          </p>
          <p className="text-xs text-slate-400">
            Accepted: .csv, .xls, .xlsx, .pdf, .txt &mdash; Max 50 MB
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xls,.xlsx,.pdf,.txt,.tsv"
            className="hidden"
            onChange={onInputChange}
          />
        </div>

        {/* Selected file info */}
        {file && (
          <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3">
            <FileText className="w-5 h-5 text-slate-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-800 truncate">
                {file.name}
              </p>
              <p className="text-xs text-slate-400">
                {formatFileSize(file.size)} &mdash;{" "}
                {getFileExtension(file.name).replace(".", "").toUpperCase()}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-slate-400 hover:text-slate-600"
              onClick={(e) => {
                e.stopPropagation();
                handleReset();
              }}
            >
              <XCircle className="w-4 h-4" />
            </Button>
          </div>
        )}

        {/* File type selector */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            File Type
          </label>
          <Select value={fileType} onValueChange={setFileType}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select file type..." />
            </SelectTrigger>
            <SelectContent>
              {typeOptions.map((ft) => (
                <SelectItem key={ft.value} value={ft.value}>
                  {ft.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Upload button */}
        {uploadState === "idle" && (
          <Button
            className="w-full"
            disabled={!file || !fileType}
            onClick={handleUpload}
          >
            <Upload className="w-4 h-4 mr-2" />
            Upload
          </Button>
        )}

        {/* Uploading spinner */}
        {uploadState === "uploading" && (
          <Button className="w-full" disabled>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Uploading...
          </Button>
        )}

        {/* Success state */}
        {uploadState === "success" && uploadResult && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-emerald-800">
                  Upload successful
                </p>
                {uploadResult.file_id && (
                  <p className="text-xs text-emerald-600 truncate">
                    File ID: {uploadResult.file_id}
                  </p>
                )}
                {uploadResult.status && (
                  <Badge variant="outline" className="mt-1 text-xs">
                    {uploadResult.status}
                  </Badge>
                )}
              </div>
            </div>
            <Button variant="outline" className="w-full" onClick={handleReset}>
              Upload Another File
            </Button>
          </div>
        )}

        {/* Error state */}
        {uploadState === "error" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
              <XCircle className="w-5 h-5 text-red-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-red-800">Upload failed</p>
                {uploadError && (
                  <p className="text-xs text-red-600">{uploadError}</p>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                className="flex-1"
                onClick={handleRetry}
              >
                Retry
              </Button>
              <Button variant="outline" className="flex-1" onClick={handleReset}>
                Reset
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
