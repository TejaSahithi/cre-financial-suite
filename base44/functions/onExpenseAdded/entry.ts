import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { event, data } = await req.json();

    if (!data || !data.fiscal_year || !data.property_id) {
      return Response.json({ ok: true, skipped: true, reason: 'Missing fiscal_year or property_id' });
    }

    // Recalculate variance for this property/year
    const expenses = await base44.asServiceRole.entities.Expense.filter({
      property_id: data.property_id,
      fiscal_year: data.fiscal_year
    });
    const budgets = await base44.asServiceRole.entities.Budget.filter({
      property_id: data.property_id,
      budget_year: data.fiscal_year
    });

    const totalActual = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const totalBudgeted = budgets.reduce((s, b) => s + (b.total_expenses || 0), 0);
    const variance = totalActual - totalBudgeted;
    const variancePct = totalBudgeted ? ((variance / totalBudgeted) * 100) : 0;

    // If variance exceeds 10%, create a notification
    if (Math.abs(variancePct) > 10 && totalBudgeted > 0) {
      await base44.asServiceRole.entities.Notification.create({
        org_id: data.org_id || 'default',
        type: 'cam_variance',
        title: 'Expense Variance Alert',
        message: `Expense category "${data.category}" added ($${data.amount?.toLocaleString()}). Total actual expenses ($${totalActual.toLocaleString()}) now ${variancePct.toFixed(1)}% ${variance > 0 ? 'over' : 'under'} budget ($${totalBudgeted.toLocaleString()}) for FY ${data.fiscal_year}.`,
        priority: Math.abs(variancePct) > 20 ? 'high' : 'medium',
        is_read: false,
      });
    }

    // Log to audit
    await base44.asServiceRole.entities.AuditLog.create({
      org_id: data.org_id || 'default',
      entity_type: 'Expense',
      entity_id: event.entity_id,
      action: 'create',
      property_id: data.property_id,
      user_email: data.created_by || 'system',
      timestamp: new Date().toISOString(),
    });

    return Response.json({ ok: true, variance: variancePct.toFixed(1) + '%' });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});