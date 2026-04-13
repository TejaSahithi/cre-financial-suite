// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";

/**
 * Upload Handler Edge Function
 * Receives file uploads, stores to Supabase Storage, creates uploaded_files record
 * 
 * Requirements: 1.1, 1.2, 1.4, 1.6
 * Task: 2.1
 */

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB in bytes
const ALLOWED_MIME_TYPES = [
  // Text / CSV
  'text/csv',
  'application/csv',
  'text/plain',
  // Excel
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // PDF
  'application/pdf',
  // Word
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Images (for scanned documents)
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
  'image/gif',
  'image/bmp',
  // browsers sometimes send octet-stream for unknown types
  'application/octet-stream',
];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);

    // Parse multipart form data
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const fileType = formData.get('file_type') as string;
    const propertyId = (formData.get('property_id') as string) || null;

    // Validate required parameters
    if (!file) {
      return new Response(
        JSON.stringify({ error: true, message: 'Missing file parameter' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!fileType) {
      return new Response(
        JSON.stringify({ error: true, message: 'Missing file_type parameter' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate file_type
    const validFileTypes = ['leases', 'expenses', 'properties', 'revenue', 'cam', 'budgets'];
    if (!validFileTypes.includes(fileType)) {
      return new Response(
        JSON.stringify({ 
          error: true, 
          message: `Invalid file_type. Must be one of: ${validFileTypes.join(', ')}` 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Enforce 50MB file size limit (Requirement 1.6)
    if (file.size > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({ 
          error: true, 
          message: `File size exceeds 50MB limit. File size: ${(file.size / 1024 / 1024).toFixed(2)}MB` 
        }),
        { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate file format — accept all formats Docling can handle
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const allowedExtensions = [
      'csv', 'xls', 'xlsx', 'pdf', 'txt', 'tsv',
      'doc', 'docx',
      'jpg', 'jpeg', 'png', 'tiff', 'tif', 'webp', 'gif', 'bmp',
    ];
    const mimeAllowed = ALLOWED_MIME_TYPES.includes(file.type);
    const extAllowed = allowedExtensions.includes(ext);

    if (!mimeAllowed && !extAllowed) {
      return new Response(
        JSON.stringify({ 
          error: true, 
          message: `Unsupported file format. Supported: CSV, Excel, PDF, Word (.doc/.docx), images (JPG/PNG/TIFF), plain text` 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Generate unique file ID
    const fileId = crypto.randomUUID();
    const storagePath = `financial-uploads/${orgId}/${fileId}`;

    // Store file in Supabase Storage (Requirement 1.1)
    const fileBuffer = await file.arrayBuffer();
    const { error: storageError } = await supabaseAdmin.storage
      .from('financial-uploads')
      .upload(storagePath, fileBuffer, {
        contentType: file.type,
        upsert: false
      });

    if (storageError) {
      console.error("[upload-handler] Storage error:", storageError);
      return new Response(
        JSON.stringify({ 
          error: true, 
          message: `Failed to store file: ${storageError.message}` 
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get the public URL for the file
    const { data: urlData } = supabaseAdmin.storage
      .from('financial-uploads')
      .getPublicUrl(storagePath);

    // Create uploaded_files record (Requirement 1.2)
    const { data: uploadRecord, error: dbError } = await supabaseAdmin
      .from('uploaded_files')
      .insert({
        id: fileId,
        org_id: orgId,
        module_type: fileType,
        file_name: file.name,
        file_url: urlData.publicUrl,
        file_size: file.size,
        mime_type: file.type,
        uploaded_by: user.email,
        property_id: propertyId,   // stored at upload time — used by compute pipeline
        status: 'uploaded',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (dbError) {
      console.error("[upload-handler] Database error:", dbError);
      
      // Clean up storage if database insert fails
      await supabaseAdmin.storage
        .from('financial-uploads')
        .remove([storagePath]);

      return new Response(
        JSON.stringify({ 
          error: true, 
          message: `Failed to create upload record: ${dbError.message}` 
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Return success response with file_id and storage_path
    return new Response(
      JSON.stringify({ 
        error: false,
        file_id: fileId,
        storage_path: storagePath,
        file_name: file.name,
        file_size: file.size,
        property_id: propertyId,
        processing_status: 'uploaded',
        created_at: uploadRecord.created_at
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error("[upload-handler] Error:", err.message);
    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
