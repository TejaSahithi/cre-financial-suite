import { logAudit } from "@/services/audit";
import { supabase } from "@/services/supabaseClient";

export const TENANT_EMAIL_CATEGORIES = Object.freeze([
  "lease_notice",
  "rent_schedule",
  "upcoming_rent",
  "cam_statement",
  "critical_date",
  "document",
  "notice",
  "request",
]);

function requireTenantEmailCategory(eventType) {
  if (!TENANT_EMAIL_CATEGORIES.includes(eventType)) {
    throw new Error(`Unsupported tenant email event type: ${eventType}`);
  }
}

export function buildTenantEmailEvent({
  orgId,
  tenantId,
  tenantContactId = null,
  leaseId = null,
  propertyId = null,
  unitId = null,
  eventType,
  subject,
  bodyTemplateKey = null,
  destinationEmail,
  metadata = {},
}) {
  requireTenantEmailCategory(eventType);
  if (!orgId) throw new Error("orgId is required");
  if (!tenantId) throw new Error("tenantId is required");
  if (!destinationEmail) throw new Error("destinationEmail is required");
  if (!subject) throw new Error("subject is required");

  return {
    org_id: orgId,
    tenant_id: tenantId,
    tenant_contact_id: tenantContactId,
    lease_id: leaseId,
    property_id: propertyId,
    unit_id: unitId,
    event_type: eventType,
    subject,
    body_template_key: bodyTemplateKey,
    destination_email: destinationEmail,
    status: "queued",
    attempts: 0,
    metadata,
  };
}

export function tenantContactCanReceive(contact = {}, eventType) {
  if (!contact?.is_active && contact?.is_active !== undefined) return false;
  const categories = Array.isArray(contact.notification_categories)
    ? contact.notification_categories
    : TENANT_EMAIL_CATEGORIES;
  return categories.includes(eventType);
}

export function buildTenantEmailEventsForContacts({
  contacts = [],
  eventType,
  subject,
  bodyTemplateKey = null,
  lease = {},
  tenant = {},
  metadata = {},
}) {
  requireTenantEmailCategory(eventType);
  return contacts
    .filter((contact) => tenantContactCanReceive(contact, eventType))
    .map((contact) => buildTenantEmailEvent({
      orgId: contact.org_id || lease.org_id || tenant.org_id,
      tenantId: contact.tenant_id || tenant.id || lease.tenant_id,
      tenantContactId: contact.id || null,
      leaseId: contact.lease_id || lease.id || null,
      propertyId: contact.property_id || lease.property_id || null,
      unitId: contact.unit_id || lease.unit_id || null,
      eventType,
      subject,
      bodyTemplateKey,
      destinationEmail: contact.email,
      metadata: {
        ...metadata,
        tenant_name: tenant.name || lease.tenant_name || null,
      },
    }));
}

export async function queueTenantEmailEvent(input) {
  const payload = buildTenantEmailEvent(input);
  if (!supabase) return payload;

  const { data, error } = await supabase
    .from("tenant_email_events")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;

  await logAudit({
    action: "tenant_email_queued",
    entityType: "TenantEmailEvent",
    entityId: data?.id,
    orgId: payload.org_id,
    details: {
      tenant_id: payload.tenant_id,
      lease_id: payload.lease_id,
      property_id: payload.property_id,
      event_type: payload.event_type,
      destination_email: payload.destination_email,
    },
  });

  return data;
}

export async function queueTenantEmailEventsForContacts(input) {
  const payloads = buildTenantEmailEventsForContacts(input);
  if (payloads.length === 0) return [];
  if (!supabase) return payloads;

  const { data, error } = await supabase
    .from("tenant_email_events")
    .insert(payloads)
    .select();
  if (error) throw error;

  await logAudit({
    action: "tenant_email_batch_queued",
    entityType: "TenantEmailEvent",
    orgId: payloads[0].org_id,
    details: {
      event_type: input.eventType,
      count: payloads.length,
      tenant_id: payloads[0].tenant_id,
      lease_id: payloads[0].lease_id,
    },
  });

  return data || [];
}
