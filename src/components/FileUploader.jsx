import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction, invokeEdgeFunctionFormData } from "@/services/edgeFunctions";
import useOrgId from "@/hooks/useOrgId";
import useFileStatus from "@/hooks/useFileStatus";
import { getStoredActingOrgId, setStoredActingOrgId } from "@/lib/actingOrg";
import { getFriendlyExtractionLabel, payloadHasMeaningfulFields } from "@/lib/extractionStatusLabels";
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
import { Upload, FileText, Image as ImageIcon, Loader2, CheckCircle, XCircle, Ban } from "lucide-react";
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

// Signed preview URLs — short-lived, never logged, never persisted past the
// component's own state. 15 minutes is enough to review a document before
// deciding Proceed/Cancel without leaving a long-lived credential around.
const PREVIEW_URL_TTL_SECONDS = 15 * 60;
// Above this size, don't auto-load an <iframe>/<img> preview — show file
// metadata and a manual "Open Preview" button instead.
const LARGE_PREVIEW_BYTES = 25 * 1024 * 1024;

async function getPreviewUrl(storagePath) {
  if (!supabase || !storagePath) return null;
  try {
    const { data, error } = await supabase.storage
      .from("financial-uploads")
      .createSignedUrl(storagePath, PREVIEW_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    // Never log the storage path/URL itself — only that signing failed.
    return null;
  }
}

// Re-exported for callers already importing these from FileUploader.jsx —
// the implementations themselves live in a dependency-free lib module so
// they can be unit tested without a browser/DOM environment.
export { getFriendlyExtractionLabel, payloadHasMeaningfulFields };

/**
 * Reusable file upload component that sends files to the upload-handler
 * Edge Function, then pauses for explicit user confirmation (Proceed/Cancel)
 * before extraction (ingest-file / lease-extraction-worker / Azure Document
 * Intelligence / normalize / OpenAI) is ever triggered.
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
 * @param {Function} [props.onOpenReview] Called with (fileId) when the user
 *   clicks "Open Lease Review" on a ready extraction. FileUploader has no
 *   lease-specific knowledge (find-or-create-lease, navigation) — that logic
 *   stays entirely in the caller (e.g. LeaseUpload.jsx) so this component
 *   remains generic and reusable across upload contexts.
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
  onOpenReview,
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
            mime_type: row.mime_type || "",
            storage_path: `${resolvedOrgId}/${row.id}`,
            detected_type: "unknown",
            possible_duplicate: false,
            module_type: row.module_type,
            previewUrl: null,
            previewState: "idle",
          }));
        // Refresh recovery only restores the pending-confirmation card itself
        // — it never auto-confirms or auto-extracts a recovered upload; the
        // user still has to click Proceed or Cancel explicitly.
        if (recovered.length === 0) return prev;
        const next = [...prev, ...recovered];
        for (const item of recovered) {
          if (item.file_size <= LARGE_PREVIEW_BYTES) {
            getPreviewUrl(item.storage_path).then((url) => {
              setPendingConfirmations((cur) =>
                cur.map((p) =>
                  p.file_id === item.file_id
                    ? { ...p, previewUrl: url, previewState: url ? "ready" : "unavailable" }
                    : p,
                ),
              );
            });
          }
        }
        return next;
      });
    })();

    return () => { cancelledEffect = true; };
    // Only re-run when the org scope changes (e.g. super-admin switching
    // org) — not on every pendingConfirmations update.
  }, [resolvedOrgId]);

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

      const data = await invokeEdgeFunctionFormData("upload-handler", formData, {}, {
        page: "LeaseUpload",
        action: "file_upload",
      });

      // Extraction does NOT start here. upload-handler only stores the file
      // and runs cheap preflight checks; the file now sits at
      // confirmation_required=true until the user clicks Proceed (which
      // calls confirm-upload -> ingest-file) or Cancel (which deletes the
      // temp row/object via cancel-upload). No parse-document-azure, Azure,
      // normalize-pdf-output, OpenAI, or lease-extraction-worker call
      // happens as a side effect of this function.
      if (data?.file_id) {
        const storagePath = data.storage_path || `${resolvedOrgId}/${data.file_id}`;
        const mimeType = data.mime_type || file.type || "";
        setPendingConfirmations((prev) => [
          ...prev,
          {
            file_id: data.file_id,
            file_name: data.file_name || file.name,
            file_size: data.file_size ?? file.size,
            mime_type: mimeType,
            storage_path: storagePath,
            detected_type: data.detected_type || "unknown",
            possible_duplicate: !!data.possible_duplicate,
            module_type: normalizeFileType(fileType),
            previewUrl: null,
            previewState: "idle", // idle | loading | ready | unavailable
          },
        ]);
        // Fire-and-forget: sign a preview URL for small files immediately;
        // large files wait for an explicit "Open Preview" click instead.
        if ((data.file_size ?? file.size ?? 0) <= LARGE_PREVIEW_BYTES) {
          getPreviewUrl(storagePath).then((url) => {
            setPendingConfirmations((prev) =>
              prev.map((p) =>
                p.file_id === data.file_id
                  ? { ...p, previewUrl: url, previewState: url ? "ready" : "unavailable" }
                  : p,
              ),
            );
          });
        }
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
      const result = await invokeEdgeFunction("confirm-upload", { file_id: fileId }, {}, {
        page: "LeaseUpload",
        action: "upload_confirm",
      });
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

  const handleOpenPreview = useCallback(async (fileId) => {
    setPendingConfirmations((prev) =>
      prev.map((p) => (p.file_id === fileId ? { ...p, previewState: "loading" } : p)),
    );
    const pending = pendingConfirmations.find((p) => p.file_id === fileId);
    const url = pending ? await getPreviewUrl(pending.storage_path) : null;
    setPendingConfirmations((prev) =>
      prev.map((p) =>
        p.file_id === fileId ? { ...p, previewUrl: url, previewState: url ? "ready" : "unavailable" } : p,
      ),
    );
  }, [pendingConfirmations]);

  const handleCancelUpload = useCallback(async (fileId) => {
    setConfirmationActionState((prev) => ({ ...prev, [fileId]: "cancelling" }));
    try {
      const pending = pendingConfirmations.find((p) => p.file_id === fileId);
      const result = await invokeEdgeFunction("cancel-upload", { file_id: fileId }, {}, {
        page: "LeaseUpload",
        action: "upload_cancel",
      });
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
          <div className="space-y-3 pt-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Confirm to Start Extraction
            </p>
            {pendingConfirmations.map((pending) => {
              const actionState = confirmationActionState[pending.file_id];
              const busy = !!actionState;
              const isPdf = pending.detected_type === "pdf" || pending.mime_type === "application/pdf";
              const isImage =
                pending.detected_type === "image" || (pending.mime_type || "").startsWith("image/");
              const isLarge = (pending.file_size || 0) > LARGE_PREVIEW_BYTES;
              const canEmbedPreview = (isPdf || isImage) && !isLarge;

              return (
                <div
                  key={pending.file_id}
                  className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/60 p-3"
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

                  <div className="rounded-md border border-blue-100 bg-white p-2">
                    {canEmbedPreview && pending.previewState === "ready" && pending.previewUrl && isPdf && (
                      <iframe
                        src={pending.previewUrl}
                        className="h-64 w-full rounded border-0"
                        title={`Preview of ${pending.file_name}`}
                      />
                    )}
                    {canEmbedPreview && pending.previewState === "ready" && pending.previewUrl && isImage && (
                      <img
                        src={pending.previewUrl}
                        className="max-h-64 w-full rounded border border-slate-100 object-contain"
                        alt={pending.file_name}
                      />
                    )}
                    {canEmbedPreview && pending.previewState === "loading" && (
                      <div className="flex h-32 items-center justify-center text-slate-400">
                        <Loader2 className="h-5 w-5 animate-spin" />
                      </div>
                    )}
                    {canEmbedPreview && pending.previewState === "unavailable" && (
                      <div className="flex h-24 flex-col items-center justify-center gap-1 text-center">
                        {isImage ? (
                          <ImageIcon className="h-6 w-6 text-slate-300" />
                        ) : (
                          <FileText className="h-6 w-6 text-slate-300" />
                        )}
                        <p className="text-xs text-slate-500">Preview unavailable.</p>
                      </div>
                    )}
                    {isLarge && (isPdf || isImage) && (
                      <div className="flex h-24 flex-col items-center justify-center gap-2 text-center">
                        <p className="text-xs text-slate-500">
                          This file is large — preview isn't loaded automatically.
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending.previewState === "loading"}
                          onClick={() => handleOpenPreview(pending.file_id)}
                        >
                          {pending.previewState === "loading" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            "Open Preview"
                          )}
                        </Button>
                        {pending.previewState === "unavailable" && (
                          <p className="text-xs text-slate-500">Preview unavailable.</p>
                        )}
                        {pending.previewState === "ready" && pending.previewUrl && isPdf && (
                          <iframe
                            src={pending.previewUrl}
                            className="h-64 w-full rounded border-0"
                            title={`Preview of ${pending.file_name}`}
                          />
                        )}
                        {pending.previewState === "ready" && pending.previewUrl && isImage && (
                          <img
                            src={pending.previewUrl}
                            className="max-h-64 w-full rounded border border-slate-100 object-contain"
                            alt={pending.file_name}
                          />
                        )}
                      </div>
                    )}
                    {!isPdf && !isImage && (
                      <div className="flex h-24 flex-col items-center justify-center gap-1 text-center">
                        <FileText className="h-6 w-6 text-slate-300" />
                        <p className="text-xs text-slate-500">Preview not available.</p>
                      </div>
                    )}
                  </div>

                  <p className="text-sm font-medium text-slate-700">
                    Is this the correct document to process?
                  </p>

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
                        "Proceed with Extraction"
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
                        "Cancel / Re-upload"
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
              <ExtractionStatusRow
                key={f.id}
                fileId={f.id}
                fileName={f.fileName}
                fileType={f.fileType}
                onOpenReview={onOpenReview}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const ACTIVE_EXTRACTION_STATUSES = new Set([
  "uploaded", "parsing", "pdf_parsed", "validating", "validated", "storing", "computing",
]);

const STATUS_COLORS = {
  review_required: "text-amber-700",
  completed: "text-emerald-700",
  failed: "text-red-700",
  cancelled: "text-slate-500",
};

const SUMMARY_FIELD_KEYS = [
  { key: "tenant_name", label: "Tenant" },
  { key: "monthly_rent", label: "Rent" },
  { key: "commencement_date", label: "Start" },
  { key: "expiration_date", label: "End" },
];

/** Best-effort tenant/rent/dates/confidence summary from a saved review payload. */
function buildFieldSummary(uiReviewPayload) {
  const record = uiReviewPayload?.records?.[0];
  if (!record) return null;
  const fields = Array.isArray(record.standard_fields) ? record.standard_fields : [];
  const byKey = new Map(fields.map((f) => [f.field_key, f]));

  const items = SUMMARY_FIELD_KEYS
    .map(({ key, label }) => {
      const field = byKey.get(key);
      const value = field?.value;
      if (value == null || String(value).trim() === "") return null;
      return { label, value: String(value) };
    })
    .filter(Boolean);

  const confidences = fields.map((f) => f?.confidence).filter((c) => typeof c === "number");
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
    : null;

  if (items.length === 0 && avgConfidence == null) return null;
  return { items, avgConfidence };
}

function ExtractionStatusRow({ fileId, fileName, fileType, onOpenReview }) {
  const { status, isLoading, pollError, processingStatus, failedStep, errorMessage, latestJob } = useFileStatus(fileId, { include_details: true });
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reviewPayload, setReviewPayload] = useState(null);
  const payloadFetchedRef = useRef(false);

  // One-shot fetch of ui_review_payload once the pipeline parks for review —
  // never polled, never re-fetched for the same file. pipeline-status only
  // includes this (heavy) column when include_details=true is requested on
  // every poll, so a single direct query here avoids dragging docling_raw
  // into the 3-second polling loop.
  useEffect(() => {
    if (status !== "review_required" || payloadFetchedRef.current || !fileId || !supabase) return;
    payloadFetchedRef.current = true;
    (async () => {
      const { data } = await supabase
        .from("uploaded_files")
        .select("ui_review_payload")
        .eq("id", fileId)
        .maybeSingle();
      if (data?.ui_review_payload) setReviewPayload(data.ui_review_payload);
    })();
  }, [status, fileId]);

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

  const handleCancelExtraction = async () => {
    setCancelling(true);
    try {
      const result = await invokeEdgeFunction("cancel-upload", { file_id: fileId }, {}, {
        page: "LeaseUpload",
        action: "extraction_cancel",
      });
      if (result?.error) throw new Error(result?.message || "Could not cancel extraction");
      toast.success(`${fileName || "File"}: extraction cancelled.`);
    } catch (error) {
      console.error("[FileUploader] cancel extraction failed:", error);
      toast.error(error?.message || "Could not cancel extraction. Please try again.");
    } finally {
      setCancelling(false);
    }
  };

  const isActive = status && ACTIVE_EXTRACTION_STATUSES.has(status);
  const isFailed = status === "failed";
  const isCancelled = status === "cancelled";
  const isComplete = status === "completed";
  const hasActiveExtractionJob = ["queued", "running"].includes(String(latestJob?.status || "")) && (!latestJob?.job_type || latestJob.job_type === "lease_extraction");
  const hasFields = payloadHasMeaningfulFields(reviewPayload);
  const isReviewReady = status === "review_required" && hasFields && !hasActiveExtractionJob;
  const isPreparingReview = status === "review_required" && !hasFields;
  // Once a record has valid extracted fields (or is otherwise terminal),
  // never offer to cancel it from this generic upload row — only Lease
  // Review's own flows may affect a record past this point.
  const canCancelExtraction = isActive && !isReviewReady;

  const label = pollError
    ? pollError
    : hasActiveExtractionJob
      ? getFriendlyExtractionLabel(latestJob?.stage || processingStatus || "parsing")
      : isReviewReady
        ? "Extraction ready"
        : getFriendlyExtractionLabel(status);
  const color = pollError
    ? "text-amber-600"
    : STATUS_COLORS[status] || (isActive ? "text-blue-600" : "text-slate-500");

  const summary = isReviewReady ? buildFieldSummary(reviewPayload) : null;
  // The Open Lease Review handoff is lease-specific; other FileUploader
  // callers (budgets, generic uploads) have no onOpenReview handler and no
  // lease draft to open, so only show the ready-card CTA when both line up.
  const showReadyCard = isReviewReady && fileType === "leases" && !!onOpenReview;

  return (
    <div className="space-y-1.5 rounded-md border border-slate-100 bg-slate-50/70 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {(isActive || isPreparingReview || (isLoading && !status)) && (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
          )}
          {isReviewReady && <CheckCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
          {isComplete && <CheckCircle className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
          {isFailed && <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />}
          {isCancelled && <Ban className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
          <span className="truncate text-xs text-slate-600">{fileName}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`text-xs font-medium ${color}`}>{label}</span>
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
          {canCancelExtraction && (
            <Button
              size="sm"
              variant="outline"
              disabled={cancelling}
              onClick={handleCancelExtraction}
              className="h-6 px-2 text-xs"
            >
              {cancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : "Cancel Extraction"}
            </Button>
          )}
        </div>
      </div>

      {showReadyCard && (
        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50/60 p-2.5">
          <div>
            <p className="text-sm font-medium text-amber-900">Extraction ready</p>
            <p className="text-xs text-amber-700">Your lease fields are ready for review.</p>
          </div>
          {summary && summary.items.length > 0 && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-600">
              {summary.items.map((item) => (
                <div key={item.label} className="truncate">
                  <span className="text-slate-400">{item.label}:</span> {item.value}
                </div>
              ))}
            </div>
          )}
          {summary && typeof summary.avgConfidence === "number" && (
            <p className="text-xs text-slate-500">
              Confidence: {Math.round(summary.avgConfidence * 100)}%
            </p>
          )}
          <Button size="sm" className="h-7 text-xs" onClick={() => onOpenReview(fileId)}>
            Open Lease Review
          </Button>
        </div>
      )}

      <details className="text-xs text-slate-400">
        <summary className="cursor-pointer select-none">Advanced</summary>
        <div className="mt-1 space-y-0.5 pl-2">
          <p>status: {status ?? "—"}</p>
          <p>processing_status: {processingStatus ?? "—"}</p>
          <p>failed_step: {failedStep ?? "—"}</p>
          <p>error_message: {errorMessage ?? "—"}</p>
        </div>
      </details>
    </div>
  );
}
