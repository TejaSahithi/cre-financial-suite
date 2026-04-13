import React, { useCallback, useMemo, useRef, useState } from "react";
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
  { value: "budgets", label: "Budget" },
];

const ACCEPTED_EXTENSIONS = [".csv", ".xls", ".xlsx", ".pdf", ".txt", ".tsv", ".doc", ".docx", ".jpg", ".jpeg", ".png", ".tiff", ".tif", ".webp", ".gif", ".bmp"];
const DEFAULT_ACCEPT = ACCEPTED_EXTENSIONS.join(",");
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

function normalizeFileType(value) {
  return value === "budget" ? "budgets" : value;
}

/**
 * Reusable file upload component that sends files to the upload-handler
 * Edge Function and auto-triggers ingestion on success.
 *
 * @param {Object}   props
 * @param {Function} props.onUploadComplete
 * @param {string}   [props.defaultFileType]
 * @param {string[]} [props.allowedFileTypes]
 * @param {string}   [props.propertyId]
 * @param {string}   [props.orgId]
 * @param {boolean}  [props.multiple]
 * @param {string}   [props.accept]
 */
export default function FileUploader({
  onUploadComplete,
  defaultFileType,
  allowedFileTypes,
  propertyId,
  orgId: orgIdOverride,
  multiple = false,
  accept = DEFAULT_ACCEPT,
}) {
  const { orgId } = useOrgId();
  const resolvedOrgId = orgIdOverride ?? orgId;
  const fileInputRef = useRef(null);

  const [files, setFiles] = useState([]);
  const [fileType, setFileType] = useState(normalizeFileType(defaultFileType || ""));
  const [dragOver, setDragOver] = useState(false);
  const [uploadState, setUploadState] = useState("idle"); // idle | uploading | success | partial | error
  const [uploadResults, setUploadResults] = useState([]);
  const [uploadErrors, setUploadErrors] = useState([]);

  const normalizedAllowedTypes = useMemo(
    () => (allowedFileTypes || []).map((type) => normalizeFileType(type)),
    [allowedFileTypes]
  );

  const typeOptions = normalizedAllowedTypes.length > 0
    ? ALL_FILE_TYPES.filter((fileTypeOption) => normalizedAllowedTypes.includes(fileTypeOption.value))
    : ALL_FILE_TYPES;

  const validateFile = useCallback((file) => {
    const extension = getFileExtension(file.name);
    if (!ACCEPTED_EXTENSIONS.includes(extension)) {
      return `Unsupported format "${extension}". Accepted: ${ACCEPTED_EXTENSIONS.join(", ")}`;
    }
    if (file.size > MAX_FILE_SIZE) {
      return `File exceeds 50 MB limit (${formatFileSize(file.size)}).`;
    }
    return null;
  }, []);

  const resetUploadFeedback = useCallback(() => {
    setUploadState("idle");
    setUploadResults([]);
    setUploadErrors([]);
  }, []);

  const handleFileSelect = useCallback(
    (fileList) => {
      const nextFiles = Array.from(fileList || []);
      if (!nextFiles.length) return;

      const validFiles = [];
      const validationErrors = [];

      nextFiles.forEach((file) => {
        const error = validateFile(file);
        if (error) {
          validationErrors.push(`${file.name}: ${error}`);
          return;
        }
        validFiles.push(file);
      });

      if (!validFiles.length) {
        toast.error(validationErrors[0] || "No valid files selected.");
        return;
      }

      if (validationErrors.length > 0) {
        toast.warning(validationErrors[0]);
      }

      setFiles((currentFiles) => {
        if (!multiple) return [validFiles[0]];

        const mergedFiles = [...currentFiles];
        const seen = new Set(
          currentFiles.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
        );

        validFiles.forEach((file) => {
          const key = `${file.name}:${file.size}:${file.lastModified}`;
          if (!seen.has(key)) {
            mergedFiles.push(file);
            seen.add(key);
          }
        });

        return mergedFiles;
      });
      resetUploadFeedback();
    },
    [multiple, resetUploadFeedback, validateFile]
  );

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback((event) => {
    event.preventDefault();
    setDragOver(false);
  }, []);

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      setDragOver(false);
      handleFileSelect(event.dataTransfer.files);
    },
    [handleFileSelect]
  );

  const onInputChange = useCallback(
    (event) => {
      handleFileSelect(event.target.files);
      event.target.value = "";
    },
    [handleFileSelect]
  );

  const uploadSingleFile = useCallback(
    async (file) => {
      if (!supabase) {
        throw new Error("Supabase client is not available.");
      }

      const formData = new FormData();
      formData.append("file", file);
      formData.append("file_type", normalizeFileType(fileType));

      if (resolvedOrgId && resolvedOrgId !== "__none__") {
        formData.append("org_id", resolvedOrgId);
      }

      if (propertyId) {
        formData.append("property_id", propertyId);
      }

      const { data, error } = await supabase.functions.invoke("upload-handler", { body: formData });
      if (error) throw error;

      if (data?.file_id) {
        try {
          await supabase.functions.invoke("ingest-file", {
            body: { file_id: data.file_id, module_type: normalizeFileType(fileType) },
          });
        } catch (ingestError) {
          console.error("[FileUploader] ingest-file invocation failed:", ingestError);
          toast.warning(`"${file.name}" uploaded, but processing could not be started automatically.`);
        }
      }

      return data;
    },
    [fileType, propertyId, resolvedOrgId]
  );

  const handleUpload = useCallback(async () => {
    if (!files.length) {
      toast.error("Please select at least one file first.");
      return;
    }

    if (!fileType) {
      toast.error("Please select a file type.");
      return;
    }

    setUploadState("uploading");
    setUploadResults([]);
    setUploadErrors([]);

    const results = [];
    const errors = [];

    for (const file of files) {
      try {
        const result = await uploadSingleFile(file);
        results.push({ file_name: file.name, ...result });
      } catch (error) {
        console.error("[FileUploader] upload failed:", error);
        const message =
          error?.message || error?.context?.message || "Upload failed. Please try again.";
        errors.push({ file_name: file.name, message });
      }
    }

    setUploadResults(results);
    setUploadErrors(errors);

    if (results.length > 0 && errors.length === 0) {
      setUploadState("success");
      toast.success(`${results.length} file${results.length === 1 ? "" : "s"} uploaded successfully.`);
      if (onUploadComplete) onUploadComplete(multiple ? results : results[0]);
      return;
    }

    if (results.length > 0 && errors.length > 0) {
      setUploadState("partial");
      toast.warning(`${results.length} file${results.length === 1 ? "" : "s"} uploaded. ${errors.length} failed.`);
      if (onUploadComplete) onUploadComplete(multiple ? results : results[0]);
      return;
    }

    setUploadState("error");
    toast.error(errors[0]?.message || "Upload failed. Please try again.");
  }, [fileType, files, multiple, onUploadComplete, uploadSingleFile]);

  const handleReset = useCallback(() => {
    setFiles([]);
    setFileType(normalizeFileType(defaultFileType || ""));
    setUploadResults([]);
    setUploadErrors([]);
    setUploadState("idle");
  }, [defaultFileType]);

  const selectedFileLabel = multiple
    ? `${files.length} files selected`
    : files[0]?.name || "No file selected";

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Upload className="w-5 h-5" />
          Upload File
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div
          role="button"
          tabIndex={0}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") fileInputRef.current?.click();
          }}
          className={`
            flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8
            transition-colors
            ${
              dragOver
                ? "border-blue-500 bg-blue-50"
                : "border-slate-300 bg-slate-50 hover:border-slate-400 hover:bg-slate-100"
            }
          `}
        >
          <Upload className={`w-8 h-8 ${dragOver ? "text-blue-500" : "text-slate-400"}`} />
          <p className="text-sm font-medium text-slate-600">
            {multiple ? "Drag and drop files here, or click to select" : "Drag and drop a file here, or click to select"}
          </p>
          <p className="text-xs text-slate-400">
            CSV, Excel, PDF, Word, images (JPG/PNG/TIFF) &mdash; Max 50 MB
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept={accept}
            multiple={multiple}
            className="hidden"
            onChange={onInputChange}
          />
        </div>

        {files.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              {selectedFileLabel}
            </p>
            <div className="space-y-2">
              {files.map((file) => (
                <div key={`${file.name}-${file.size}-${file.lastModified}`} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3">
                  <FileText className="w-5 h-5 shrink-0 text-slate-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{file.name}</p>
                    <p className="text-xs text-slate-400">
                      {formatFileSize(file.size)} - {getFileExtension(file.name).replace(".", "").toUpperCase()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            File Type
          </label>
          <Select value={fileType} onValueChange={(value) => setFileType(normalizeFileType(value))}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select file type..." />
            </SelectTrigger>
            <SelectContent>
              {typeOptions.map((fileTypeOption) => (
                <SelectItem key={fileTypeOption.value} value={fileTypeOption.value}>
                  {fileTypeOption.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {uploadState === "idle" && (
          <div className="flex gap-2">
            <Button className="flex-1" disabled={!files.length || !fileType} onClick={handleUpload}>
              <Upload className="w-4 h-4 mr-2" />
              {multiple && files.length > 1 ? `Upload ${files.length} Files` : "Upload"}
            </Button>
            {files.length > 0 && (
              <Button variant="outline" onClick={handleReset}>
                Reset
              </Button>
            )}
          </div>
        )}

        {uploadState === "uploading" && (
          <Button className="w-full" disabled>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Uploading...
          </Button>
        )}

        {(uploadState === "success" || uploadState === "partial") && (
          <div className="space-y-3">
            <div className={`flex items-center gap-2 rounded-lg border p-3 ${
              uploadState === "success"
                ? "border-emerald-200 bg-emerald-50"
                : "border-amber-200 bg-amber-50"
            }`}>
              <CheckCircle className={`w-5 h-5 shrink-0 ${
                uploadState === "success" ? "text-emerald-600" : "text-amber-600"
              }`} />
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${
                  uploadState === "success" ? "text-emerald-800" : "text-amber-800"
                }`}>
                  {uploadState === "success"
                    ? `Uploaded ${uploadResults.length} file${uploadResults.length === 1 ? "" : "s"}`
                    : `Uploaded ${uploadResults.length} of ${files.length} files`}
                </p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {uploadResults.map((result) => (
                    <Badge key={`${result.file_id}-${result.file_name}`} variant="outline" className="text-xs">
                      {result.file_name}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>

            {uploadErrors.length > 0 && (
              <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-sm font-medium text-red-800">Files that need attention</p>
                {uploadErrors.map((error) => (
                  <p key={`${error.file_name}-${error.message}`} className="text-xs text-red-600">
                    {error.file_name}: {error.message}
                  </p>
                ))}
              </div>
            )}

            <Button variant="outline" className="w-full" onClick={handleReset}>
              Upload Another {multiple ? "Set of Files" : "File"}
            </Button>
          </div>
        )}

        {uploadState === "error" && (
          <div className="space-y-3">
            <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
              <div className="flex items-center gap-2">
                <XCircle className="w-5 h-5 shrink-0 text-red-600" />
                <p className="text-sm font-medium text-red-800">Upload failed</p>
              </div>
              {uploadErrors.map((error) => (
                <p key={`${error.file_name}-${error.message}`} className="text-xs text-red-600">
                  {error.file_name}: {error.message}
                </p>
              ))}
            </div>
            <div className="flex gap-2">
              <Button variant="destructive" className="flex-1" onClick={handleUpload}>
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
