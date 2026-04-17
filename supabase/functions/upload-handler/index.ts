// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";

/**
 * Upload Handler Edge Function
 *
 * Single responsibility:
 *   1. Authenticate the user.
 *   2. Store the original file in the financial-uploads bucket.
 *   3. Register the file in uploaded_files with status='uploaded'.
 *
 * Parsing happens after this function returns.
 */

const MAX_FILE_SIZE = 50 * 1024 * 1024;

const ALLOWED_MIME_TYPES = [
  "text/csv",
  "application/csv",
  "text/plain",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "image/gif",
  "image/bmp",
  "application/octet-stream",
];

const ALLOWED_EXTENSIONS = [
  "csv",
  "xls",
  "xlsx",
  "pdf",
  "txt",
  "tsv",
  "doc",
  "docx",
  "jpg",
  "jpeg",
  "png",
  "tiff",
  "tif",
  "webp",
  "gif",
  "bmp",
];

const VALID_FILE_TYPES = [
  "leases",
  "expenses",
  "properties",
  "revenue",
  "cam",
  "budgets",
  "buildings",
  "units",
  "tenants",
  "invoices",
  "gl_accounts",
  "documents",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeOptionalUuid(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "all" || trimmed === "__none__" || trimmed === "undefined" || trimmed === "null") {
    return null;
  }
  return UUID_RE.test(trimmed) ? trimmed : null;
}

function getExtension(fileName: string): string {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const fileType = String(formData.get("file_type") || "");
    const propertyId = normalizeOptionalUuid(formData.get("property_id"));
    const buildingId = normalizeOptionalUuid(formData.get("building_id"));
    const unitId = normalizeOptionalUuid(formData.get("unit_id"));

    if (!file) {
      return jsonResponse({ error: true, message: "Missing file parameter" }, 400);
    }

    if (!fileType) {
      return jsonResponse({ error: true, message: "Missing file_type parameter" }, 400);
    }

    if (!VALID_FILE_TYPES.includes(fileType)) {
      return jsonResponse({
        error: true,
        message: `Invalid file_type. Must be one of: ${VALID_FILE_TYPES.join(", ")}`,
      }, 400);
    }

    if (file.size > MAX_FILE_SIZE) {
      return jsonResponse({
        error: true,
        message: `File size exceeds 50MB limit. File size: ${(file.size / 1024 / 1024).toFixed(2)}MB`,
      }, 413);
    }

    const ext = getExtension(file.name);
    const mimeAllowed = !file.type || ALLOWED_MIME_TYPES.includes(file.type);
    const extAllowed = ALLOWED_EXTENSIONS.includes(ext);

    if (!mimeAllowed && !extAllowed) {
      return jsonResponse({
        error: true,
        message: "Unsupported file format. Supported: CSV, Excel, PDF, Word (.doc/.docx), images (JPG/PNG/TIFF), plain text",
      }, 400);
    }

    const fileId = crypto.randomUUID();
    const storagePath = `${orgId}/${fileId}`;
    const fileBuffer = await file.arrayBuffer();
    const uploadContentType = file.type || "application/octet-stream";

    let { error: storageError } = await supabaseAdmin.storage
      .from("financial-uploads")
      .upload(storagePath, fileBuffer, {
        contentType: uploadContentType,
        upsert: false,
      });

    if (storageError && uploadContentType !== "application/octet-stream") {
      console.warn(
        `[upload-handler] Storage rejected ${uploadContentType}; retrying ${file.name} as application/octet-stream`,
        storageError,
      );

      const retry = await supabaseAdmin.storage
        .from("financial-uploads")
        .upload(storagePath, fileBuffer, {
          contentType: "application/octet-stream",
          upsert: false,
        });
      storageError = retry.error;
    }

    if (storageError) {
      console.error("[upload-handler] Storage error:", storageError);
      return jsonResponse({
        error: true,
        error_code: "STORAGE_UPLOAD_FAILED",
        message: `Failed to store file: ${storageError.message}`,
        details: storageError,
      }, 500);
    }

    const { data: urlData } = supabaseAdmin.storage
      .from("financial-uploads")
      .getPublicUrl(storagePath);

    const now = new Date().toISOString();
    const insertPayload = {
      id: fileId,
      org_id: orgId,
      module_type: fileType,
      file_name: file.name,
      file_url: urlData.publicUrl,
      file_size: file.size,
      mime_type: file.type || "application/octet-stream",
      uploaded_by: user.email,
      property_id: propertyId,
      building_id: buildingId,
      unit_id: unitId,
      status: "uploaded",
      created_at: now,
      updated_at: now,
    };

    let { data: uploadRecord, error: dbError } = await supabaseAdmin
      .from("uploaded_files")
      .insert(insertPayload)
      .select()
      .single();

    if (dbError && looksLikeMissingScopeColumn(dbError)) {
      console.warn(
        "[upload-handler] Upload scope columns are not migrated yet; retrying without building/unit scope",
        dbError,
      );

      const retryPayload = { ...insertPayload };
      delete retryPayload.building_id;
      delete retryPayload.unit_id;

      const retry = await supabaseAdmin
        .from("uploaded_files")
        .insert(retryPayload)
        .select()
        .single();

      uploadRecord = retry.data;
      dbError = retry.error;
    }

    if (dbError && propertyId) {
      console.warn(
        `[upload-handler] Insert failed with property_id=${propertyId}; retrying without optional property scope`,
        dbError,
      );

      const scopedFallback = { ...insertPayload, property_id: null };
      if (looksLikeMissingScopeColumn(dbError)) {
        delete scopedFallback.building_id;
        delete scopedFallback.unit_id;
      }

      const retry = await supabaseAdmin
        .from("uploaded_files")
        .insert(scopedFallback)
        .select()
        .single();

      uploadRecord = retry.data;
      dbError = retry.error;
    }

    if (dbError) {
      console.error("[upload-handler] Database error:", dbError);
      await supabaseAdmin.storage.from("financial-uploads").remove([storagePath]);

      return jsonResponse({
        error: true,
        error_code: "UPLOAD_RECORD_FAILED",
        message: `Failed to create upload record: ${dbError.message}`,
        details: dbError,
      }, 500);
    }

    return jsonResponse({
      error: false,
      file_id: fileId,
      storage_path: storagePath,
      file_name: file.name,
      file_size: file.size,
      property_id: uploadRecord.property_id,
      building_id: uploadRecord.building_id ?? null,
      unit_id: uploadRecord.unit_id ?? null,
      processing_status: "uploaded",
      created_at: uploadRecord.created_at,
    });
  } catch (err) {
    console.error("[upload-handler] Error:", err.message);
    return jsonResponse({
      error: true,
      error_code: "UPLOAD_HANDLER_ERROR",
      message: err.message,
    }, 400);
  }
});

function looksLikeMissingScopeColumn(error: any): boolean {
  const message = String(error?.message || error?.details || "");
  const code = String(error?.code || "");
  return code === "42703" || code === "PGRST204" || /uploaded_files\.(building_id|unit_id)|building_id|unit_id/i.test(message);
}
