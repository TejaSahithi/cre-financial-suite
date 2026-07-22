-- uploaded_files.file_url is built via getPublicUrl(), which always formats
-- a "/object/public/financial-uploads/..." URL string regardless of whether
-- the bucket is actually public -- financial-uploads is a PRIVATE bucket
-- (confirmed: that URL returns 404 "Bucket not found" if ever fetched
-- directly), so downstream code has had to regex-strip this URL apart to
-- recover the real storage path (parse-document-azure/index.ts,
-- ingest-file/index.ts), a fragile pattern tied to file_url's exact string
-- shape. This adds the actual, unambiguous storage location as real
-- columns, populated directly by upload-handler from the same storagePath
-- variable it already uses to perform the upload -- no string parsing.
-- file_url is kept only for backward-compatible display.

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS storage_bucket TEXT NULL,
  ADD COLUMN IF NOT EXISTS storage_path TEXT NULL;

COMMENT ON COLUMN public.uploaded_files.storage_bucket IS
  'The actual Supabase Storage bucket this file''s bytes live in. Canonical location -- prefer this + storage_path over parsing file_url.';
COMMENT ON COLUMN public.uploaded_files.storage_path IS
  'The actual object path within storage_bucket (org_id/file_id). Canonical location -- prefer this over parsing file_url.';

-- Backfill existing rows from their file_url, using the same prefix this
-- repo's own code already assumes (parse-document-azure/index.ts,
-- ingest-file/index.ts) -- best-effort only; rows that don't match the
-- expected shape are left NULL rather than failing the migration.
UPDATE public.uploaded_files
SET storage_bucket = 'financial-uploads',
    storage_path = regexp_replace(file_url, '^.*/storage/v1/object/public/financial-uploads/', '')
WHERE storage_path IS NULL
  AND file_url ILIKE '%/storage/v1/object/public/financial-uploads/%';
