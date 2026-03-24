/**
 * Billing Engine Service — Production-Ready
 *
 * Domain logic for tenant billing, invoice generation, and payment tracking.
 */

// ─── Constants ─────────────────────────────────────────────────────────
export const INVOICE_STATUS = {
  DRAFT: 'draft',
  ISSUED: 'issued',
  SENT: 'sent',
  PARTIALLY_PAID: 'partially_paid',
  PAID: 'paid',
  OVERDUE: 'overdue',
  VOID: 'void',
};

export const CHARGE_TYPES = {
  BASE_RENT: 'base_rent',
  CAM_CHARGE: 'cam_charge',
  UTILITY: 'utility',
  INSURANCE: 'insurance',
  TAX: 'tax',
  LATE_FEE: 'late_fee',
  OTHER: 'other',
};

// ─── Invoice Generation ────────────────────────────────────────────────

/**
 * Generate an invoice for a tenant.
 *
 * @param {object} params
 * @param {object} params.tenant     - Tenant record
 * @param {object} params.lease      - Active lease
 * @param {Array}  [params.charges]  - Additional charges { type, amount, description }
 * @param {string} [params.period]   - Billing period (e.g. "2026-03")
 * @param {number} [params.lateFee]  - Late fee to apply if overdue
 * @returns {object} Invoice object
 */
export function generateInvoice(params) {
  const {
    tenant,
    lease,
    charges = [],
    period,
    lateFee = 0,
  } = params;

  const now = new Date();
  const dueDate = new Date(now);
  dueDate.setDate(dueDate.getDate() + 30); // Net 30

  // Build line items
  const lineItems = [];

  // Base rent from lease
  if (lease?.monthly_rent) {
    lineItems.push({
      type: CHARGE_TYPES.BASE_RENT,
      description: `Base Rent — ${period || 'Monthly'}`,
      amount: lease.monthly_rent,
    });
  }

  // Additional charges
  charges.forEach(charge => {
    lineItems.push({
      type: charge.type || CHARGE_TYPES.OTHER,
      description: charge.description || charge.type || 'Charge',
      amount: charge.amount || 0,
    });
  });

  // Late fee
  if (lateFee > 0) {
    lineItems.push({
      type: CHARGE_TYPES.LATE_FEE,
      description: 'Late Fee',
      amount: lateFee,
    });
  }

  const subtotal = lineItems.reduce((s, li) => s + li.amount, 0);

  return {
    id: null, // Assigned on save
    tenant_id: tenant?.id,
    tenant_name: tenant?.name,
    property_id: lease?.property_id,
    lease_id: lease?.id,
    period: period || now.toISOString().slice(0, 7),
    status: INVOICE_STATUS.DRAFT,
    issued_date: now.toISOString(),
    due_date: dueDate.toISOString(),
    lineItems,
    subtotal: parseFloat(subtotal.toFixed(2)),
    amount: parseFloat(subtotal.toFixed(2)),
    amount_paid: 0,
    amount_due: parseFloat(subtotal.toFixed(2)),
  };
}

// ─── Billing Summary ───────────────────────────────────────────────────

/**
 * Calculate billing summary for a tenant.
 *
 * @param {object} tenant
 * @param {Array}  leases   - Tenant's active leases
 * @param {Array}  expenses - Recoverable expenses allocated to tenant
 * @param {Array}  [invoices] - Existing invoices for payment tracking
 * @returns {object} Billing summary
 */
export function calculateBillingSummary(tenant, leases = [], expenses = [], invoices = []) {
  const totalMonthlyRent = leases.reduce((s, l) => s + (l.monthly_rent || 0), 0);
  const totalAnnualRent = totalMonthlyRent * 12;

  const totalCAM = expenses
    .filter(e => e.classification === 'recoverable')
    .reduce((s, e) => s + (e.amount || 0), 0);
  const monthlyCAM = totalCAM / 12;

  const totalInvoiced = invoices.reduce((s, inv) => s + (inv.amount || 0), 0);
  const totalPaid = invoices.reduce((s, inv) => s + (inv.amount_paid || 0), 0);
  const totalOutstanding = totalInvoiced - totalPaid;

  const overdueInvoices = invoices.filter(
    inv => inv.status !== INVOICE_STATUS.PAID
      && inv.status !== INVOICE_STATUS.VOID
      && new Date(inv.due_date) < new Date()
  );

  return {
    tenantId: tenant?.id,
    tenantName: tenant?.name,
    totalMonthlyRent: parseFloat(totalMonthlyRent.toFixed(2)),
    totalAnnualRent: parseFloat(totalAnnualRent.toFixed(2)),
    monthlyCAM: parseFloat(monthlyCAM.toFixed(2)),
    totalMonthlyDue: parseFloat((totalMonthlyRent + monthlyCAM).toFixed(2)),
    totalInvoiced: parseFloat(totalInvoiced.toFixed(2)),
    totalPaid: parseFloat(totalPaid.toFixed(2)),
    totalOutstanding: parseFloat(totalOutstanding.toFixed(2)),
    overdueCount: overdueInvoices.length,
    overdueAmount: parseFloat(
      overdueInvoices.reduce((s, inv) => s + ((inv.amount || 0) - (inv.amount_paid || 0)), 0).toFixed(2)
    ),
    leaseCount: leases.length,
  };
}

// ─── Payment Processing ────────────────────────────────────────────────

/**
 * Process a payment against an invoice.
 *
 * @param {object} invoice - The invoice to apply payment to
 * @param {number} amount  - Payment amount
 * @returns {object} Updated invoice + transaction record
 */
export function processPayment(invoice, amount) {
  if (!invoice || amount <= 0) {
    return { success: false, error: 'Invalid invoice or payment amount' };
  }

  const amountDue = (invoice.amount || 0) - (invoice.amount_paid || 0);
  const applied = Math.min(amount, amountDue);
  const newAmountPaid = (invoice.amount_paid || 0) + applied;
  const remaining = (invoice.amount || 0) - newAmountPaid;

  let newStatus = invoice.status;
  if (remaining <= 0) {
    newStatus = INVOICE_STATUS.PAID;
  } else if (newAmountPaid > 0) {
    newStatus = INVOICE_STATUS.PARTIALLY_PAID;
  }

  return {
    success: true,
    transactionId: `txn-${Date.now()}`,
    applied: parseFloat(applied.toFixed(2)),
    overpayment: parseFloat(Math.max(0, amount - amountDue).toFixed(2)),
    updatedInvoice: {
      ...invoice,
      amount_paid: parseFloat(newAmountPaid.toFixed(2)),
      amount_due: parseFloat(Math.max(0, remaining).toFixed(2)),
      status: newStatus,
    },
  };
}

/**
 * Determine if an invoice is overdue.
 * @param {object} invoice
 * @returns {boolean}
 */
export function isOverdue(invoice) {
  if (!invoice?.due_date) return false;
  if (invoice.status === INVOICE_STATUS.PAID || invoice.status === INVOICE_STATUS.VOID) return false;
  return new Date(invoice.due_date) < new Date();
}
