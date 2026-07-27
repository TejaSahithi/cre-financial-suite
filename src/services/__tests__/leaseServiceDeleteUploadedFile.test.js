import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deleteUploadedFile } from '@/services/leaseService';

// Feature: enterprise-readiness-hardening Phase HARD-2 / HARD-2B
// (delete_uploaded_file_workflow). deleteUploadedFile() is a thin
// pass-through to the delete-uploaded-file edge function -- the real
// validation/audit/RLS-lockdown behavior is covered by
// supabase/functions/_tests/delete-uploaded-file.property.test.ts. This is
// the SAME function both LeaseUpload.jsx's handleDeleteUpload and
// Documents.jsx's deleteUploadedFile(doc) call (confirmed by direct source
// inspection) -- these tests prove the shared call site sends the right
// shape and no longer performs any direct
// supabase.from("uploaded_files").delete() write.
const invokeEdgeFunctionMock = vi.fn();

vi.mock('@/services/edgeFunctions', () => ({
  invokeEdgeFunction: (...args) => invokeEdgeFunctionMock(...args),
}));

describe('leaseService.deleteUploadedFile', () => {
  beforeEach(() => {
    invokeEdgeFunctionMock.mockReset();
  });

  it('calls delete-uploaded-file with the file id', async () => {
    invokeEdgeFunctionMock.mockResolvedValue({
      error: false,
      deleted_id: 'file-1',
      deleted_count: 1,
    });

    const result = await deleteUploadedFile('file-1');

    expect(invokeEdgeFunctionMock).toHaveBeenCalledWith('delete-uploaded-file', {
      file_id: 'file-1',
    }, {}, { page: 'LeaseUpload', action: 'file_delete' });
    expect(result.deleted_id).toBe('file-1');
    expect(result.deleted_count).toBe(1);
  });

  it('rejects a missing file id without calling the edge function', async () => {
    await expect(deleteUploadedFile(null)).rejects.toThrow('File ID is required');
    expect(invokeEdgeFunctionMock).not.toHaveBeenCalled();
  });

  it('propagates edge function errors (e.g. cross-org, not-found, non-admin) to the caller', async () => {
    invokeEdgeFunctionMock.mockRejectedValue(new Error('Uploaded file not found for this organization'));
    await expect(deleteUploadedFile('missing-file')).rejects.toThrow('Uploaded file not found for this organization');
  });
});
