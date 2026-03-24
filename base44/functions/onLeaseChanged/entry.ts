import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { event, data, old_data } = await req.json();

    if (!data) {
      return Response.json({ ok: true, skipped: true });
    }

    const isCreate = event.type === 'create';
    const isUpdate = event.type === 'update';

    // On lease creation, create audit log
    await base44.asServiceRole.entities.AuditLog.create({
      org_id: data.org_id || 'default',
      entity_type: 'Lease',
      entity_id: event.entity_id,
      action: isCreate ? 'create' : 'update',
      field_changed: isUpdate && old_data?.status !== data.status ? 'status' : undefined,
      old_value: isUpdate && old_data?.status !== data.status ? old_data?.status : undefined,
      new_value: isUpdate && old_data?.status !== data.status ? data.status : undefined,
      user_email: data.created_by || 'system',
      timestamp: new Date().toISOString(),
    });

    // Check if lease is expiring within 180 days
    if (data.end_date) {
      const endDate = new Date(data.end_date);
      const now = new Date();
      const daysLeft = Math.floor((endDate - now) / (1000 * 60 * 60 * 24));

      if (daysLeft > 0 && daysLeft <= 180) {
        // Check if we already have an expiry notification for this lease
        const existing = await base44.asServiceRole.entities.Notification.filter({
          type: 'lease_expiry',
          link: event.entity_id,
        });

        if (existing.length === 0) {
          await base44.asServiceRole.entities.Notification.create({
            org_id: data.org_id || 'default',
            type: 'lease_expiry',
            title: 'Lease Expiration Alert',
            message: `${data.tenant_name}'s lease expires in ${daysLeft} days (${data.end_date}). Review renewal options.`,
            link: event.entity_id,
            priority: daysLeft <= 90 ? 'high' : 'medium',
            is_read: false,
          });
        }
      }
    }

    // If lease status changed to budget_ready, notify
    if (isUpdate && old_data?.status !== 'budget_ready' && data.status === 'budget_ready') {
      await base44.asServiceRole.entities.Notification.create({
        org_id: data.org_id || 'default',
        type: 'budget_approval',
        title: 'Lease Ready for Budget',
        message: `${data.tenant_name}'s lease has been validated and is now budget-ready. You can include it in budget generation.`,
        priority: 'medium',
        is_read: false,
      });
    }

    return Response.json({ ok: true, event: event.type });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});