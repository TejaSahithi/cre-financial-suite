export function updateLeaseQueryCache(queryClient, leaseId, updater) {
  queryClient.setQueryData(["lease", leaseId], (prev) => {
    const applyUpdate = (row) => {
      const next = typeof updater === "function" ? updater(row) : updater;
      return { ...(row || {}), ...(next || {}) };
    };

    if (Array.isArray(prev)) {
      return prev.map((row) => (row?.id === leaseId ? applyUpdate(row) : row));
    }
    if (prev?.id === leaseId) {
      return applyUpdate(prev);
    }
    return prev;
  });
}
