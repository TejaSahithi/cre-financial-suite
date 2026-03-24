import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { event, data, old_data } = await req.json();

    if (!data) {
      return Response.json({ ok: true, skipped: true });
    }

    // Audit log
    await base44.asServiceRole.entities.AuditLog.create({
      org_id: data.org_id || 'default',
      entity_type: 'Budget',
      entity_id: event.entity_id,
      action: event.type === 'create' ? 'create' : 'update',
      field_changed: old_data?.status !== data.status ? 'status' : undefined,
      old_value: old_data?.status !== data.status ? old_data?.status : undefined,
      new_value: old_data?.status !== data.status ? data.status : undefined,
      user_email: data.created_by || 'system',
      timestamp: new Date().toISOString(),
    });

    // Notify on status transitions
    if (event.type === 'update' && old_data?.status !== data.status) {
      const transitions = {
        'approved': { type: 'budget_approval', title: 'Budget Approved', msg: `Budget "${data.name}" (FY ${data.budget_year}) has been approved.`, priority: 'medium' },
        'locked': { type: 'budget_approval', title: 'Budget Locked', msg: `Budget "${data.name}" (FY ${data.budget_year}) is now locked. No further changes can be made.`, priority: 'low' },
        'under_review': { type: 'budget_approval', title: 'Budget Submitted for Review', msg: `Budget "${data.name}" (FY ${data.budget_year}) has been submitted for review.`, priority: 'medium' },
      };

      const t = transitions[data.status];
      if (t) {
        await base44.asServiceRole.entities.Notification.create({
          org_id: data.org_id || 'default',
          type: t.type,
          title: t.title,
          message: t.msg,
          priority: t.priority,
          is_read: false,
        });
      }
    }

    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});