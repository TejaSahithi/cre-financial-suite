-- Allow every document type accepted by upload-handler to be stored in
-- the financial-uploads bucket. Without this, DOC/DOCX/TIFF/BMP uploads
-- fail before parsing ever starts.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'text/csv',
  'text/plain',
  'text/tab-separated-values',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/tiff',
  'image/webp',
  'image/gif',
  'image/bmp'
],
file_size_limit = 52428800
WHERE id = 'financial-uploads';
