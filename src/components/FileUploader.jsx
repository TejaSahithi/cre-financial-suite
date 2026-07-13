import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction, invokeEdgeFunctionFormData } from "@/services/edgeFunctions";
import useOrgId from "@/hooks/useOrgId";
import useFileStatus from "@/hooks/useFileStatus";
import { getStoredActingOrgId, setStoredActingOrgId } from "@/lib/actingOrg";
import { createPageUrl } from "@/utils";
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function normalizeOptionalUuid(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

const DETECTED_TYPE_LABELS = {
  pdf: "PDF document",
  image: "Image",
  office_document: "Word/Office document",
  csv: "CSV",
  spreadsheet: "Spreadsheet",
  text: "Plain text",
  unexpected_content: "Unrecognized content",
  unknown: "Unknown",
};

/**
 * Reusable file upload component that sends files to the upload-handler
 * Edge Function, then pauses for explicit user confirmation (Proceed/Cancel)
 * before extraction (ingest-file / parse-pdf-docling / Azure / normalize /
 * Vertex / lease-extraction-worker) is ever triggered.
 *
 * @param {Object}   props
 * @param {Function} props.onUploadComplete
 * @param {string}   [props.defaultFileType]
 * @param {string[]} [props.allowedFileTypes]
 * @param {string}   [props.propertyId]
 * @param {string}   [props.buildingId]
 * @param {string}   [props.unitId]
 * @param {string}   [props.orgId]
 * @param {boolean}  [props.multiple]
 * @param {string}   [props.accept]
 */
export default function FileUploader({
  onUploadComplete,
  defaultFileType,
  allowedFileTypes,
  propertyId,
  buildingId,
  unitId,
  orgId: orgIdOverride,
  multiple = false,
  accept = DEFAULT_ACCEPT,
}) {
  const { orgId, isAdmin } = useOrgId();
  const resolvedOrgId = orgIdOverride ?? orgId;
  const fileInputRef = useRef(null);

  const [adminOrgId, setAdminOrgId] = useState(() => getStoredActingOrgId() || "");

  const { data: adminOrgs = [] } = useQuery({
    queryKey: ["file-uploader-orgs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("organizations")
        .select("id, name")
        .order("name");
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
  });

  const handleAdminOrgChange = useCallback((value) => {
    setAdminOrgId(value);
    setStoredActingOrgId(value || null);
  }, []);

  const needsOrgSelection = isAdmin && (!resolvedOrgId || resolvedOrgId === "__none__");

  const [files, setFiles] = useState([]);
  const [fileType, setFileType] = useState(normalizeFileType(defaultFileType || ""));
  const [dragOver, setDragOver] = useState(false);
  const [uploadState, setUploadState] = useState("idle"); // idle | uploading | success | partial | error
  const [uploadResults, setUploadResults] = useState([]);
  const [uploadErrors, setUploadErrors] = useState([]);
  const [trackedFileIds, setTrackedFileIds] = useState([]);
  // Files stored by upload-handler but awaiting the user's Proceed/Cancel
  // decision. Extraction never starts for these until confirm-upload runs.
  const [pendingConfirmations, setPendingConfirmations] = useState([]);
  // file_id -> "confirming" | "cancelling", so a double-click on Proceed/
  // Cancel is a client-side no-op layered on top of the server-side atomic
  // idempotency guards in confirm-upload / cancel-upload.
  const [confirmationActionState, setConfirmationActionState] = useState({});

  const normalizedAllowedTypes = useMemo(
    () => (allowedFileTypes || []).map((type) => normalizeFileType(type)),
    [allowedFileTypes]
  );

  // Refresh recovery: pendingConfirmations is client-only React state, wiped
  // on page reload. The uploaded_files row itself is the durable session
  // (status='uploaded', confirmed_at IS NULL), so on mount we re-query for
  // any such rows belonging to this org/scope and re-show the Proceed/Cancel
  // prompt instead of silently losing track of an unconfirmed upload.
  useEffect(() => {
    if (!resolvedOrgId || resolvedOrgId === "__none__" || !supabase) return;
    let cancelledEffect = false;

    (async () => {
      let query = supabase
        .from("uploaded_files")
        .select("id, file_name, file_size, mime_type, module_type, created_at")
        .eq("org_id", resolvedOrgId)
        .is("confirmed_at", null)
        .eq("status", "uploaded")
        .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order("created_at", { ascending: false });

      if (normalizedAllowedTypes.length > 0) {
        query = query.in("module_type", normalizedAllowedTypes);
      }

      const { data, error } = await query;
      if (cancelledEffect || error || !Array.isArray(data) || data.length === 0) return;

      setPendingConfirmations((prev) => {
        const existingIds = new Set(prev.map((p) => p.file_id));
        const recovered = data
          .filter((row) => !existingIds.has(row.id))
          .map((row) => ({
            file_id: row.id,
            file_name: row.file_name,
            file_size: row.file_size ?? 0,
            detected_type: "unknown",
            possible_duplicate: false,
            module_type: row.module_type,
          }));
        return recovered.length > 0 ? [...prev, ...recovered] : prev;
      });
    })();

    return () => { cancelledEffect = true; };
    // Only re-run when the org scope changes (e.g. super-admin switching
    // org) — not on every pendingConfirmations update.
  }, [resolvedOrgId]); // eslint-disable-line react-hooks/exhaustive-deps

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

      if (isAdmin && (!resolvedOrgId || resolvedOrgId === "__none__")) {
        throw new Error("Super-admin must select an organization before uploading files.");
      }

      const formData = new FormData();
      formData.append("file", file);
      formData.append("file_type", normalizeFileType(fileType));

      if (resolvedOrgId && resolvedOrgId !== "__none__") {
        formData.append("org_id", resolvedOrgId);
      }

      const safePropertyId = normalizeOptionalUuid(propertyId);
      if (safePropertyId) {
        formData.append("property_id", safePropertyId);
      }
      const safeBuildingId = normalizeOptionalUuid(buildingId);
      if (safeBuildingId) {
        formData.append("building_id", safeBuildingId);
      }
      const safeUnitId = normalizeOptionalUuid(unitId);
      if (safeUnitId) {
        formData.append("unit_id", safeUnitId);
      }

      const data = await invokeEdgeFunctionFormData("upload-handler", formData);

      // Extraction does NOT start here. upload-handler only stores the file
      // and runs cheap preflight checks; the file now sits at
      // confirmation_required=true until the user clicks Proceed (which
      // calls confirm-upload -> ingest-file) or Cancel (which deletes the
      // temp row/object via cancel-upload). No parse-pdf-docling, Azure,
      // normalize-pdf-output, Vertex, or lease-extraction-worker call
      // happens as a side effect of this function.
      if (data?.file_id) {
        setPendingConfirmations((prev) => [
          ...prev,
          {
            file_id: data.file_id,
            file_name: data.file_name || file.name,
            file_size: data.file_size ?? file.size,
            detected_type: data.detected_type || "unknown",
            possible_duplicate: !!data.possible_duplicate,
            module_type: normalizeFileType(fileType),
          },
        ]);
      }

      return {
        ...data,
        processing_started: false,
        awaiting_confirmation: Boolean(data?.file_id),
      };
    },
    [buildingId, fileType, isAdmin, propertyId, resolvedOrgId, unitId]
  );

  const handleProceed = useCallback(async (fileId) => {
    setConfirmationActionState((prev) => ({ ...prev, [fileId]: "confirming" }));
    try {
      const pending = pendingConfirmations.find((p) => p.file_id === fileId);
      const result = await invokeEdgeFunction("confirm-upload", { file_id: fileId });
      if (result?.error) {
        throw new Error(result?.message || "Could not confirm upload");
      }
      setPendingConfirmations((prev) => prev.filter((p) => p.file_id !== fileId));
      setTrackedFileIds((prev) => [
        ...prev,
        { id: fileId, fileName: pending?.file_name, fileType: pending?.module_type },
      ]);
      toast.success(`${pending?.file_name || "File"}: extraction started.`);
      onUploadComplete?.({ file_id: fileId, processing_started: true });
    } catch (error) {
      console.error("[FileUploader] confirm-upload failed:", error);
      toast.error(error?.message || "Could not confirm upload. Please try again.");
    } finally {
      setConfirmationActionState((prev) => {
        const next = { ...prev };
        delete next[fileId];
        return next;
      });
    }
  }, [onUploadComplete, pendingConfirmations]);

  const handleCancelUpload = useCallback(async (fileId) => {
    setConfirmationActionState((prev) => ({ ...prev, [fileId]: "cancelling" }));
    try {
      const pending = pendingConfirmations.find((p) => p.file_id === fileId);
      const result = await invokeEdgeFunction("cancel-upload", { file_id: fileId });
      if (result?.error) {
        throw new Error(result?.message || "Could not cancel upload");
      }
      setPendingConfirmations((prev) => prev.filter((p) => p.file_id !== fileId));
      toast.info(`${pending?.file_name || "File"}: upload cancelled.`);
    } catch (error) {
      console.error("[FileUploader] cancel-upload failed:", error);
      toast.error(error?.message || "Could not cancel upload. Please try again.");
    } finally {
      setConfirmationActionState((prev) => {
        const next = { ...prev };
        delete next[fileId];
        return next;
      });
    }
  }, [pendingConfirmations]);

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
      toast.success(
        `${results.length} file${results.length === 1 ? "" : "s"} uploaded. ` +
        `Review and confirm below to start extraction.`,
      );
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
    setTrackedFileIds([]);
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
        {isAdmin && (
          <div className="flex items-center gap-3 rounded-lg border border-violet-200 bg-violet-50 p-3">
            <span className="text-xs font-semibold text-violet-700 whitespace-nowrap">Organization</span>
            <Select value={adminOrgId} onValueChange={handleAdminOrgChange}>
              <SelectTrigger className="flex-1 h-9 bg-white border-violet-200 text-sm">
                <SelectValue placeholder="Select organization..." />
              </SelectTrigger>
              <SelectContent>
                {adminOrgs.map((org) => (
                  <SelectItem key={org.id} value={org.id}>
                    {org.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {needsOrgSelection && (
              <span className="text-xs text-red-600 font-medium whitespace-nowrap">Required before upload</span>
            )}
          </div>
        )}

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
          {typeOptions.length === 1 ? (
            <div className="flex h-10 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700">
              {typeOptions[0].label}
            </div>
          ) : (
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
          )}
        </div>

        {uploadState === "idle" && (
          <div className="flex gap-2">
            <Button className="flex-1" disabled={!files.length || !fileType || needsOrgSelection} onClick={handleUpload}>
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
                    ? `Uploaded ${uploadResults.length} file${uploadResults.length === 1 ? "" : "s"}; confirm below to start extraction`
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

        {pendingConfirmations.length > 0 && (
          <div className="space-y-2 pt-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Confirm to Start Extraction
            </p>
            {pendingConfirmations.map((pending) => {
              const actionState = confirmationActionState[pending.file_id];
              const busy = !!actionState;
              return (
                <div
                  key={pending.file_id}
                  className="space-y-2 rounded-lg border border-blue-200 bg-blue-50/60 p-3"
                >
                  <div className="flex items-start gap-3">
                    <FileText className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800">{pending.file_name}</p>
                      <p className="text-xs text-slate-500">
                        {formatFileSize(pending.file_size)} &middot; {DETECTED_TYPE_LABELS[pending.detected_type] || "Unknown type"}
                      </p>
                      {pending.possible_duplicate && (
                        <p className="mt-1 text-xs font-medium text-amber-700">
                          A file with this name and size was uploaded recently — possible duplicate.
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1"
                      disabled={busy}
                      onClick={() => handleProceed(pending.file_id)}
                    >
                      {actionState === "confirming" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "Proceed"
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      disabled={busy}
                      onClick={() => handleCancelUpload(pending.file_id)}
                    >
                      {actionState === "cancelling" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "Cancel"
                      )}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {trackedFileIds.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Extraction Status</p>
            {trackedFileIds.map(f => (
              <ExtractionStatusRow key={f.id} fileId={f.id} fileName={f.fileName} fileType={f.fileType} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const EXTRACTION_STATUS_LABELS = {
  uploaded:        { label: "Queued for extraction",    color: "text-slate-500" },
  parsing:         { label: "Parsing document...",      color: "text-blue-600"  },
  pdf_parsed:      { label: "Extracting fields...",     color: "text-blue-600"  },
  validating:      { label: "Validating...",            color: "text-blue-600"  },
  validated:       { label: "Validated",                color: "text-blue-600"  },
  storing:         { label: "Storing data...",          color: "text-blue-600"  },
  stored:          { label: "Stored",                   color: "text-blue-600"  },
  computing:       { label: "Running calculations...",  color: "text-blue-600"  },
  review_required: { label: "Ready for Review",         color: "text-amber-700" },
  completed:       { label: "Complete",                 color: "text-emerald-700" },
  failed:          { label: "Extraction failed",        color: "text-red-700"   },
};

const ACTIVE_EXTRACTION_STATUSES = new Set([
  "uploaded", "parsing", "pdf_parsed", "validating", "validated", "storing", "computing",
]);

function ExtractionStatusRow({ fileId, fileName, fileType }) {
  const { status, isLoading, pollError } = useFileStatus(fileId);
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await invokeEdgeFunction("ingest-file", {
        file_id: fileId,
        force_reextract: true,
        module_type: fileType,
      });
    } catch {
      // next poll will surface the updated status
    } finally {
      setRetrying(false);
    }
  };

  const info = pollError
    ? { label: pollError, color: "text-amber-600" }
    : EXTRACTION_STATUS_LABELS[status] || { label: status ?? "Processing...", color: "text-slate-500" };
  const isActive = status && ACTIVE_EXTRACTION_STATUSES.has(status);
  const isFailed = status === "failed";
  const isReviewReady = status === "review_required";
  const isComplete = status === "completed";

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-slate-100 bg-slate-50/70 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {(isActive || (isLoading && !status)) && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
        )}
        {isReviewReady && <CheckCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
        {isComplete && <CheckCircle className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
        {isFailed && <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />}
        <span className="truncate text-xs text-slate-600">{fileName}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className={`text-xs font-medium ${info.color}`}>{info.label}</span>
        {isReviewReady && fileType === "leases" && (
          <Link
            to={createPageUrl("Leases", { view: "drafts" })}
            className="text-xs font-medium text-teal-600 hover:text-teal-700 hover:underline"
          >
            Open Review →
          </Link>
        )}
        {isFailed && (
          <Button
            size="sm"
            variant="outline"
            disabled={retrying}
            onClick={handleRetry}
            className="h-6 px-2 text-xs"
          >
            {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : "Retry"}
          </Button>
        )}
      </div>
    </div>
  );
}
