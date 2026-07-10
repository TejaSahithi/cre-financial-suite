-- Enterprise hardening Phase HARD-2D: uploaded_files DELETE RLS lockdown.
--
-- Production now routes every uploaded_files delete through
-- delete-uploaded-file -> delete_uploaded_file_workflow (HARD-2 through
-- HARD-2C, confirmed live on main@b596ee7): LeaseUpload.jsx and
-- Documents.jsx both call leaseService.deleteUploadedFile(), and a
-- repo-wide grep confirms zero remaining direct
-- supabase.from("uploaded_files").delete() call sites anywhere in src/.
--
-- Local and remote uploaded_files policies confirmed identical before this
-- migration (fresh queries against both):
--   uploaded_files_delete: DELETE USING (is_org_admin(org_id))
--   uploaded_files_insert: INSERT WITH CHECK (can_write_org_data(org_id))
--   uploaded_files_select: SELECT USING (is_super_admin() OR EXISTS(...))
--   uploaded_files_update: UPDATE USING (can_write_org_data(org_id))
-- No FOR ALL policy exists on either environment.
--
-- This migration locks DELETE only, replacing uploaded_files_delete by
-- exact name (not adding a new one) with USING (false). SELECT/INSERT/
-- UPDATE are untouched -- read access, uploads, and status/review-field
-- updates continue to work exactly as before. RLS stays enabled (already
-- was). delete_uploaded_file_workflow (SECURITY DEFINER, service_role
-- grant only) is unaffected -- RLS lockdown only blocks the anon/
-- authenticated roles a direct browser write would use, and service_role
-- always bypasses RLS (rolbypassrls = true, confirmed earlier this
-- session).

DROP POLICY IF EXISTS "uploaded_files_delete" ON public.uploaded_files;

CREATE POLICY "uploaded_files_delete" ON public.uploaded_files
  FOR DELETE USING (false);
