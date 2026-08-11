import { describe, expect, it } from "vitest";
import {
  buildTenantEmailEvent,
  buildTenantEmailEventsForContacts,
  tenantContactCanReceive,
} from "@/services/tenantEmailService";
import {
  resolveCriticalDateReminderPlan,
} from "@/services/criticalDateService";

describe("tenant email notifications", () => {
  it("builds tenant email event audit-ready payloads", () => {
    const payload = buildTenantEmailEvent({
      orgId: "org-1",
      tenantId: "tenant-1",
      leaseId: "lease-1",
      propertyId: "property-1",
      eventType: "rent_schedule",
      subject: "Rent schedule published",
      destinationEmail: "tenant@example.com",
    });

    expect(payload.status).toBe("queued");
    expect(payload.event_type).toBe("rent_schedule");
    expect(payload.destination_email).toBe("tenant@example.com");
  });

  it("filters tenant contacts by notification category and active state", () => {
    expect(tenantContactCanReceive({ is_active: true, notification_categories: ["cam_statement"] }, "cam_statement")).toBe(true);
    expect(tenantContactCanReceive({ is_active: true, notification_categories: ["rent_schedule"] }, "cam_statement")).toBe(false);
    expect(tenantContactCanReceive({ is_active: false, notification_categories: ["cam_statement"] }, "cam_statement")).toBe(false);
  });

  it("builds one tenant email event per eligible contact", () => {
    const events = buildTenantEmailEventsForContacts({
      eventType: "cam_statement",
      subject: "CAM statement available",
      lease: { id: "lease-1", org_id: "org-1", tenant_id: "tenant-1", property_id: "property-1" },
      tenant: { id: "tenant-1", name: "Acme" },
      contacts: [
        { id: "contact-1", tenant_id: "tenant-1", email: "a@example.com", notification_categories: ["cam_statement"] },
        { id: "contact-2", tenant_id: "tenant-1", email: "b@example.com", notification_categories: ["rent_schedule"] },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0].tenant_contact_id).toBe("contact-1");
    expect(events[0].metadata.tenant_name).toBe("Acme");
  });
});

describe("critical date notification planning", () => {
  function dateFromToday(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
  }

  it("plans reminders for upcoming configured thresholds", () => {
    const plan = resolveCriticalDateReminderPlan(
      { due_date: dateFromToday(89), status: "open" },
      { reminder_days: [180, 120, 90, 60, 30], recipient_roles: ["property_manager"], escalation_roles: ["org_admin"] }
    );

    expect(plan.state).toBe("due_soon");
    expect(plan.matchedReminderDay).toBe(90);
    expect(plan.recipients).toEqual(["property_manager"]);
  });

  it("adds escalation roles near deadline and when overdue", () => {
    const nearDeadline = resolveCriticalDateReminderPlan(
      { due_date: dateFromToday(20), status: "open" },
      { reminder_days: [180, 120, 90, 60, 30], recipient_roles: ["property_manager"], escalation_roles: ["org_owner"] }
    );
    const overdue = resolveCriticalDateReminderPlan(
      { due_date: dateFromToday(-2), status: "open" },
      { reminder_days: [180, 120, 90, 60, 30], recipient_roles: ["property_manager"], escalation_roles: ["org_owner"] }
    );

    expect(nearDeadline.escalationRoles).toEqual(["org_owner"]);
    expect(overdue.state).toBe("overdue");
    expect(overdue.escalationRoles).toEqual(["org_owner"]);
  });
});
