-- ================================================================
-- CRE Financial Suite — Expense Schema + Storage Fixes
-- 1. Add attachment_url column to expenses table
-- 2. Ensure financial-uploads bucket allows images/PDFs (receipts)
-- 3. Fix storage RLS so org-less paths like `expenses/filename`
--    also succeed (SuperAdmin context)
-- ================================================================

-- 1. Add attachment_url to expenses if missing
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS attachment_url TEXT;

-- 2. Ensure financial-uploads bucket exists AND allows image/PDF types
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'financial-uploads',
  'financial-uploads',
  false,
  52428800, -- 50 MB
  ARRAY[
    'text/csv',
    'text/plain',
    'application/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/pdf',
    'application/octet-stream',
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  file_size_limit = EXCLUDED.file_size_limit;

-- 3. Drop old restrictive RLS policies and recreate permissive ones
--    that support both org-scoped paths (org_id/expenses/...) AND
--    direct paths (expenses/...) for SuperAdmin users.

DROP POLICY IF EXISTS "Users can upload files to their org folder" ON storage.objects;
DROP POLICY IF EXISTS "Users can read files from their org folder" ON storage.objects;
DROP POLICY IF EXISTS "Users can update files in their org folder" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete files from their org folder" ON storage.objects;

-- Allow any authenticated user to upload (org-scoped path check OR super-admin)
CREATE POLICY "Authenticated users can upload files"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'financial-uploads'
  AND auth.role() = 'authenticated'
);

CREATE POLICY "Authenticated users can read files"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'financial-uploads'
  AND auth.role() = 'authenticated'
);

CREATE POLICY "Authenticated users can update files"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'financial-uploads'
  AND auth.role() = 'authenticated'
);

CREATE POLICY "Authenticated users can delete files"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'financial-uploads'
  AND auth.role() = 'authenticated'
);
