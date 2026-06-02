export function buildPostApprovalPayloads({
  lease,
  approvedLease,
  approvalSignedBy,
  approvalSignedAt,
  approvalComments,
  resolvedDocumentUrl,
  reviewLink,
}) {
  const documentPayload = {
    org_id: lease.org_id,
    property_id: lease.property_id,
    lease_id: lease.id,
    type: "lease",
    name: `Lease — ${lease.tenant_name || "Unknown tenant"}`,
    status: "approved",
    signed_by: approvalSignedBy,
    signed_at: approvalSignedAt,
    comments: approvalComments,
    document_url: resolvedDocumentUrl,
  };

  const notificationPayload = {
    org_id: lease.org_id,
    type: "lease_approved",
    title: "Lease Abstract Approved",
    message: `Lease abstract v${approvedLease.abstract_version || 1} for ${lease.tenant_name || "tenant"} approved. Signed by ${approvalSignedBy}.`,
    link: reviewLink,
    priority: "normal",
  };

  const auditPayload = {
    entityType: "Lease",
    entityId: lease.id,
    action: "lease_abstract_approved",
    orgId: lease.org_id,
    newValue: {
      abstract_version: approvedLease.abstract_version || 1,
      signed_by: approvalSignedBy,
      signed_at: approvalSignedAt,
    },
    propertyId: lease.property_id || null,
  };

  return {
    documentPayload,
    notificationPayload,
    auditPayload,
  };
}
