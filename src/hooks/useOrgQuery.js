import { useQuery } from "@tanstack/react-query";
import { createEntityService } from "@/services/api";
import useOrgId from "./useOrgId";

/**
 * Hook that fetches entity data filtered by the current user's org_id.
 * SuperAdmins see all data; regular users only see their org's data.
 *
 * @param {string} entityName - e.g. "Property", "Lease"
 * @param {object} extraFilter - additional filter fields (optional)
 * @param {object} options - { queryKey, sort, limit, enabled }
 */
export default function useOrgQuery(entityName, extraFilter = {}, options = {}) {
  const { orgId, orgName, isAdmin, loading: orgLoading } = useOrgId({
    allowSuperAdminGlobal: options.allowSuperAdminGlobal === true,
  });

  const queryKey = options.queryKey || [
    entityName,
    orgId,
    options.allowSuperAdminGlobal === true ? "global" : "scoped",
    JSON.stringify(extraFilter),
  ];

  const result = useQuery({
    queryKey,
    queryFn: async () => {
      if (orgId === "__none__") return [];
      const entity = createEntityService(entityName);
      if (!entity) return [];

      // Only callers that explicitly opt in should perform cross-org reads.
      if (orgId === null) {
        if (Object.keys(extraFilter).length > 0) {
          return entity.filter(extraFilter);
        }
        return entity.list();
      }

      // Regular user: filter by org_id
      return entity.filter({ org_id: orgId, ...extraFilter });
    },
    enabled: !orgLoading && (options.enabled !== false),
    initialData: [],
  });

  return { ...result, orgId, orgName, isAdmin, orgLoading };
}
