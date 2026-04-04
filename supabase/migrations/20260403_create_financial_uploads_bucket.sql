-- ============================================================
-- CRE Financial Suite — Storage: financial-uploads bucket
-- Creates storage bucket for file uploads in the pipeline
-- ============================================================

-- Create the financial-uploads bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'financial-uploads',
  'financial-uploads',
  false, -- Not public, requires authentication
  52428800, -- 50MB in bytes
  ARRAY[
    'text/csv',
    'text/plain',
    'application/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/pdf',
    'application/octet-stream'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  file_size_limit = EXCLUDED.file_size_limit;

-- Create RLS policies for the bucket
CREATE POLICY "Users can upload files to their org folder"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'financial-uploads' AND
  (storage.foldername(name))[1] IN (
    SELECT org_id::text FROM public.memberships WHERE user_id = auth.uid()
  )
);

CREATE POLICY "Users can read files from their org folder"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'financial-uploads' AND
  (storage.foldername(name))[1] IN (
    SELECT org_id::text FROM public.memberships WHERE user_id = auth.uid()
  )
);

CREATE POLICY "Users can update files in their org folder"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'financial-uploads' AND
  (storage.foldername(name))[1] IN (
    SELECT org_id::text FROM public.memberships WHERE user_id = auth.uid()
  )
);

CREATE POLICY "Users can delete files from their org folder"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'financial-uploads' AND
  (storage.foldername(name))[1] IN (
    SELECT org_id::text FROM public.memberships WHERE user_id = auth.uid()
  )
);
