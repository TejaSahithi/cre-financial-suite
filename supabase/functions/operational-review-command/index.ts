// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { writeOperationalAudit, operationalStatus } from "../_shared/operational-audit.ts";
import { evaluatePercentageRent } from "../_shared/percentage-rent/percentage-rent-evaluator.ts";
import { evaluateCoiCompliance } from "../_shared/compliance/coi-compliance-evaluator.ts";
import { loadLeaseTermsSnapshot } from "../_shared/lease-terms/load-lease-terms-snapshot.ts";
import { resolveLeaseTerms } from "../_shared/lease-terms/resolve.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/not found/i.test(message)) return 404;
  if (/required|invalid|cannot|transition|allowed/i.test(message)) return 400;
  return 500;
}

function requireUuid(value: unknown, label: string) {
  const id = String(value || "").trim();
  if (!UUID_RE.test(id)) throw new Error(`${label} is required`);
  return id;
}

function requireDate(value: unknown, label: string) {
  const date = String(value || "").trim();
  if (!DATE_RE.test(date)) throw new Error(`${label} is required in YYYY-MM-DD format`);
  return date;
}

function requireText(value: unknown, label: string) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}


function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "yes", "required", "1"].includes(normalized)) return true;
  if (["false", "no", "not required", "0"].includes(normalized)) return false;
  return null;
}

function normalizeInsuranceRequirement(values: Record<string, unknown> | null | undefined) {
  const source = values && typeof values === "object" ? values : {};
  const minimumLimits: Record<string, number> = {};
  const generalLiability = asNumber(source.general_liability_min ?? source.general_liability_limit ?? source.commercial_general_liability);
  const umbrella = asNumber(source.umbrella_min ?? source.umbrella_limit ?? source.excess_liability_min);
  const auto = asNumber(source.auto_liability_min ?? source.automobile_liability_min);
  const workersComp = asNumber(source.workers_comp_min ?? source.workers_compensation_min);
  if (generalLiability != null) minimumLimits.general_liability = generalLiability;
  if (umbrella != null) minimumLimits.umbrella = umbrella;
  if (auto != null) minimumLimits.auto_liability = auto;
  if (workersComp != null) minimumLimits.workers_compensation = workersComp;
  return {
    minimumLimits,
    additionalInsuredRequired: asBoolean(source.additional_insureds_required ?? source.additionalInsuredRequired) === true,
    waiverOfSubrogationRequired: asBoolean(source.waiver_of_subrogation ?? source.waiverOfSubrogationRequired) === true,
    sourceValues: source,
  };
}

async function loadApprovedInsuranceRequirement(ctx: any, leaseId: string, asOfDate: string) {
  const snapshot = await loadLeaseTermsSnapshot(ctx.supabaseAdmin, { orgId: ctx.orgId, leaseId });
  if (!snapshot) return null;
  const resolved = resolveLeaseTerms(snapshot, asOfDate);
  if (!resolved.insurance) return null;
  return normalizeInsuranceRequirement(resolved.insurance);
}

async function loadVendor(ctx: any, vendorId: string) {
  const { data, error } = await ctx.supabaseAdmin
    .from("vendors")
    .select("*")
    .eq("org_id", ctx.orgId)
    .eq("id", vendorId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load vendor: ${error.message}`);
  if (!data?.id) throw new Error("Vendor not found");
  return data;
}
function assertTransition(row: Record<string, unknown>, allowed: string[], command: string) {
  const status = String(row.status || "").toLowerCase();
  if (!allowed.includes(status)) {
    throw new Error(`${command} cannot run from status ${status || "empty"}`);
  }
}

async function loadRow(supabaseAdmin: any, orgId: string, table: string, id: string, label: string) {
  const { data, error } = await supabaseAdmin
    .from(table)
    .select("*")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load ${label}: ${error.message}`);
  if (!data?.id) throw new Error(`${label} not found`);
  return data;
}

async function loadLease(supabaseAdmin: any, orgId: string, leaseId: string) {
  const { data, error } = await supabaseAdmin
    .from("leases")
    .select("id, property_id")
    .eq("org_id", orgId)
    .eq("id", leaseId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load lease: ${error.message}`);
  if (!data?.id) throw new Error("Lease not found");
  return data;
}

function effectiveOn(row: Record<string, unknown>, asOfDate: string) {
  const start = row.effective_start ? String(row.effective_start) : null;
  const end = row.effective_end ? String(row.effective_end) : null;
  return (!start || start <= asOfDate) && (!end || end >= asOfDate);
}

async function persistPercentageRentCalculation(supabaseAdmin: any, orgId: string, user: any, report: Record<string, unknown>) {
  const asOfDate = String(report.period_end);
  const { data: termRows, error: termError } = await supabaseAdmin
    .from("lease_percentage_rent_terms")
    .select("*")
    .eq("org_id", orgId)
    .eq("lease_id", report.lease_id)
    .eq("status", "approved")
    .order("effective_start", { ascending: false, nullsFirst: false })
    .limit(25);
  if (termError) throw new Error(`Failed to load percentage rent terms: ${termError.message}`);

  const term = (termRows ?? []).find((row: Record<string, unknown>) => effectiveOn(row, asOfDate)) ?? null;
  const result = evaluatePercentageRent({ term, salesReport: report, asOfDate });
  const row = {
    org_id: orgId,
    lease_id: report.lease_id,
    property_id: report.property_id ?? null,
    percentage_rent_term_id: term?.id ?? null,
    tenant_sales_report_id: report.id,
    period_start: report.period_start,
    period_end: report.period_end,
    approved_sales: result.inputs?.netSales ?? null,
    breakpoint_amount: result.inputs?.breakpoint ?? null,
    excess_sales: result.inputs?.excessSales ?? null,
    percentage_rate: result.inputs?.percentageRate ?? null,
    calculated_amount: result.amount,
    currency: result.currency || report.currency || "USD",
    status: operationalStatus(result.status),
    reason_codes: result.reasonCodes ?? [],
    calculation_lines: result.calculationLines ?? [],
    inputs: result.inputs ?? {},
    evidence: result.evidence ?? [],
    calculated_by: user.id,
  };
  const { data, error } = await supabaseAdmin
    .from("percentage_rent_calculations")
    .upsert(row, { onConflict: "org_id,lease_id,period_start,period_end" })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to persist percentage rent calculation: ${error.message}`);
  await writeOperationalAudit(supabaseAdmin, {
    orgId,
    entityType: "percentage_rent_calculation",
    entityId: data?.id ?? null,
    action: "PERCENTAGE_RENT_CALCULATED_FROM_SALES_APPROVAL",
    actorEmail: user.email || null,
    actorUserId: user.id,
    propertyId: report.property_id ?? null,
    newValue: data,
    source: "operational-review-command",
  });
  return { result, saved_calculation: data };
}

async function transitionRecord(ctx: any, config: {
  table: string;
  id: string;
  entityType: string;
  command: string;
  action: string;
  allowed: string[];
  patch: Record<string, unknown>;
  reason?: string | null;
}) {
  const row = await loadRow(ctx.supabaseAdmin, ctx.orgId, config.table, config.id, config.entityType);
  assertTransition(row, config.allowed, config.command);
  if (row.property_id) await assertPropertyAccess(ctx.req, row.property_id);
  const { data, error } = await ctx.supabaseAdmin
    .from(config.table)
    .update(config.patch)
    .eq("org_id", ctx.orgId)
    .eq("id", config.id)
    .select("*")
    .single();
  if (error) throw new Error(`${config.command} failed: ${error.message}`);
  await writeOperationalAudit(ctx.supabaseAdmin, {
    orgId: ctx.orgId,
    entityType: config.entityType,
    entityId: config.id,
    action: config.action,
    actorEmail: ctx.user.email || null,
    actorUserId: ctx.user.id,
    propertyId: data?.property_id ?? row.property_id ?? null,
    oldValue: row,
    newValue: data,
    reason: config.reason || null,
    source: "operational-review-command",
  });
  return data;
}

async function commandSales(ctx: any, command: string, body: Record<string, unknown>) {
  await assertPageAccess(ctx.req, ctx.orgId, ["RentProjection", "LeaseReview", "AutomationReadiness"], "write");
  if (command === "createSalesReport") {
    const leaseId = requireUuid(body.lease_id ?? body.leaseId, "lease_id");
    const lease = await loadLease(ctx.supabaseAdmin, ctx.orgId, leaseId);
    if (lease.property_id) await assertPropertyAccess(ctx.req, lease.property_id);
    const row = {
      org_id: ctx.orgId,
      lease_id: leaseId,
      property_id: body.property_id ?? body.propertyId ?? lease.property_id ?? null,
      period_start: requireDate(body.period_start ?? body.periodStart, "period_start"),
      period_end: requireDate(body.period_end ?? body.periodEnd, "period_end"),
      gross_sales_amount: Number(body.gross_sales_amount ?? body.grossSalesAmount ?? 0),
      exclusions_amount: Number(body.exclusions_amount ?? body.exclusionsAmount ?? 0),
      currency: String(body.currency || "USD"),
      status: "draft",
      source_document_id: body.source_document_id ?? body.sourceDocumentId ?? null,
      submitted_by: ctx.user.email || ctx.user.id,
      evidence: body.evidence && typeof body.evidence === "object" ? body.evidence : {},
    };
    if (!Number.isFinite(row.gross_sales_amount) || row.gross_sales_amount < 0) throw new Error("gross_sales_amount is invalid");
    if (!Number.isFinite(row.exclusions_amount) || row.exclusions_amount < 0) throw new Error("exclusions_amount is invalid");
    const { data, error } = await ctx.supabaseAdmin.from("tenant_sales_reports").insert(row).select("*").single();
    if (error) throw new Error(`createSalesReport failed: ${error.message}`);
    await writeOperationalAudit(ctx.supabaseAdmin, {
      orgId: ctx.orgId,
      entityType: "tenant_sales_report",
      entityId: data.id,
      action: "SALES_REPORT_CREATED",
      actorEmail: ctx.user.email || null,
      actorUserId: ctx.user.id,
      propertyId: data.property_id ?? null,
      newValue: data,
      source: "operational-review-command",
    });
    return { report: data };
  }

  const reportId = requireUuid(body.report_id ?? body.reportId, "report_id");
  if (command === "submitSalesReport") {
    const report = await transitionRecord(ctx, {
      table: "tenant_sales_reports",
      id: reportId,
      entityType: "tenant_sales_report",
      command,
      action: "SALES_REPORT_SUBMITTED",
      allowed: ["draft", "rejected", "needs_review"],
      patch: { status: "pending_review", submitted_at: new Date().toISOString(), submitted_by: ctx.user.email || ctx.user.id },
    });
    return { report };
  }
  if (command === "approveSalesReport") {
    const report = await transitionRecord(ctx, {
      table: "tenant_sales_reports",
      id: reportId,
      entityType: "tenant_sales_report",
      command,
      action: "SALES_REPORT_APPROVED",
      allowed: ["pending_review", "submitted"],
      patch: { status: "approved", approved_at: new Date().toISOString(), approved_by: ctx.user.id },
      reason: body.reason ? String(body.reason) : null,
    });
    const calculation = await persistPercentageRentCalculation(ctx.supabaseAdmin, ctx.orgId, ctx.user, report);
    return { report, percentage_rent_calculation: calculation };
  }
  if (command === "rejectSalesReport") {
    const reason = requireText(body.reason, "reason");
    const report = await transitionRecord(ctx, {
      table: "tenant_sales_reports",
      id: reportId,
      entityType: "tenant_sales_report",
      command,
      action: "SALES_REPORT_REJECTED",
      allowed: ["pending_review", "submitted"],
      patch: { status: "rejected", evidence: { rejection_reason: reason, rejected_at: new Date().toISOString(), rejected_by: ctx.user.id } },
      reason,
    });
    return { report };
  }
  throw new Error(`Unsupported sales command ${command}`);
}

async function commandFinancialFinding(ctx: any, command: string, body: Record<string, unknown>) {
  await assertPageAccess(ctx.req, ctx.orgId, ["BudgetDashboard", "CreateBudget", "AutomationReadiness"], "write");
  const findingId = requireUuid(body.finding_id ?? body.findingId, "finding_id");
  const common = {
    table: "financial_control_findings",
    id: findingId,
    entityType: "financial_control_finding",
    command,
  };
  if (command === "acknowledgeFinding") {
    const finding = await transitionRecord(ctx, {
      ...common,
      action: "FINANCIAL_FINDING_ACKNOWLEDGED",
      allowed: ["open", "blocked", "pending_review", "active"],
      patch: { status: "acknowledged", reason: body.reason ? String(body.reason) : null },
      reason: body.reason ? String(body.reason) : null,
    });
    return { finding };
  }
  if (command === "assignFinding") {
    const assignee = requireText(body.assignee, "assignee");
    const finding = await transitionRecord(ctx, {
      ...common,
      action: "FINANCIAL_FINDING_ASSIGNED",
      allowed: ["open", "acknowledged", "assigned", "blocked", "pending_review", "active"],
      patch: { status: "assigned", assignee, reason: body.reason ? String(body.reason) : null },
      reason: body.reason ? String(body.reason) : null,
    });
    return { finding };
  }
  if (command === "resolveFinding" || command === "dismissFinding") {
    const reason = requireText(body.reason, "reason");
    const terminalStatus = command === "resolveFinding" ? "resolved" : "dismissed";
    const finding = await transitionRecord(ctx, {
      ...common,
      action: command === "resolveFinding" ? "FINANCIAL_FINDING_RESOLVED" : "FINANCIAL_FINDING_DISMISSED",
      allowed: ["open", "acknowledged", "assigned", "blocked", "pending_review", "active"],
      patch: { status: terminalStatus, reason, resolved_at: new Date().toISOString(), resolved_by: ctx.user.id },
      reason,
    });
    return { finding };
  }
  throw new Error(`Unsupported financial finding command ${command}`);
}

async function commandFinancialControlOverride(ctx: any, command: string, body: Record<string, unknown>) {
  await assertPageAccess(ctx.req, ctx.orgId, ["BudgetDashboard", "CreateBudget", "BudgetReview", "AutomationReadiness"], "write");
  const findingId = requireUuid(body.finding_id ?? body.findingId, "finding_id");
  const reason = requireText(body.reason, "reason");
  const row = await loadRow(ctx.supabaseAdmin, ctx.orgId, "financial_control_findings", findingId, "financial_control_finding");
  if (row.property_id) await assertPropertyAccess(ctx.req, row.property_id);
  const override = {
    allowed: true,
    actor_user_id: ctx.user.id,
    actor_email: ctx.user.email || null,
    overridden_at: new Date().toISOString(),
    reason,
    prior_policy_action: row.policy_action || row.policy_decision_snapshot?.action || null,
    prior_policy_blocks: row.policy_blocks === true || row.policy_decision_snapshot?.blocks === true,
  };
  const nextSnapshot = {
    ...(row.policy_decision_snapshot || {}),
    override,
  };
  const { data, error } = await ctx.supabaseAdmin
    .from("financial_control_findings")
    .update({
      policy_blocks: false,
      policy_override: override,
      policy_decision_snapshot: nextSnapshot,
      overridden_at: override.overridden_at,
      overridden_by: ctx.user.id,
      override_reason: reason,
    })
    .eq("org_id", ctx.orgId)
    .eq("id", findingId)
    .select("*")
    .single();
  if (error) throw new Error(`${command} failed: ${error.message}`);
  await writeOperationalAudit(ctx.supabaseAdmin, {
    orgId: ctx.orgId,
    entityType: "financial_control_finding",
    entityId: findingId,
    action: "FINANCIAL_FINDING_POLICY_OVERRIDE",
    actorEmail: ctx.user.email || null,
    actorUserId: ctx.user.id,
    propertyId: data?.property_id ?? row.property_id ?? null,
    oldValue: row,
    newValue: data,
    reason,
    source: "operational-review-command",
  });
  return { finding: data };
}
async function commandCoi(ctx: any, command: string, body: Record<string, unknown>) {
  await assertPageAccess(ctx.req, ctx.orgId, ["Leases", "LeaseReview", "Vendors", "AutomationReadiness"], "write");
  const coiDocumentId = requireUuid(body.coi_document_id ?? body.coiDocumentId, "coi_document_id");
  if (command === "approveCoi") {
    const coi = await transitionRecord(ctx, {
      table: "coi_documents",
      id: coiDocumentId,
      entityType: "coi_document",
      command,
      action: "COI_APPROVED",
      allowed: ["draft", "pending_review", "needs_review", "rejected"],
      patch: { status: "approved", approved_at: new Date().toISOString(), approved_by: ctx.user.id },
      reason: body.reason ? String(body.reason) : null,
    });
    const leaseId = requireUuid(coi.lease_id, "lease_id");
    const lease = await loadLease(ctx.supabaseAdmin, ctx.orgId, leaseId);
    const asOfDate = requireDate(body.as_of_date ?? body.asOfDate ?? new Date().toISOString().slice(0, 10), "as_of_date");
    const providedRequirement = body.requirement && typeof body.requirement === "object" ? normalizeInsuranceRequirement(body.requirement as Record<string, unknown>) : null;
    const evidenceRequirement = coi.evidence?.insurance_requirement || coi.evidence?.lease_insurance_requirement || coi.evidence?.requirement || null;
    const requirement = providedRequirement ?? (evidenceRequirement ? normalizeInsuranceRequirement(evidenceRequirement) : await loadApprovedInsuranceRequirement(ctx, leaseId, asOfDate));
    const result = evaluateCoiCompliance({ requirement, coi, asOfDate });
    const { data: savedResult, error } = await ctx.supabaseAdmin
      .from("lease_insurance_compliance_results")
      .insert({
        org_id: ctx.orgId,
        lease_id: leaseId,
        coi_document_id: coi.id,
        status: result.status,
        reason_codes: result.reasonCodes,
        requirement_snapshot: requirement ?? {},
        coi_snapshot: coi,
        evaluated_by: ctx.user.id,
      })
      .select("*")
      .single();
    if (error) throw new Error(`Failed to save COI compliance result: ${error.message}`);

    let expirationObligation = null;
    if (coi.expiration_date) {
      const dueDate = String(coi.expiration_date).slice(0, 10);
      const { data } = await ctx.supabaseAdmin
        .from("lease_obligations")
        .upsert({
          org_id: ctx.orgId,
          lease_id: leaseId,
          property_id: lease.property_id ?? coi.property_id ?? null,
          obligation_type: "insurance_certificate",
          title: "COI Expiration",
          source_key: `coi_expiration:${coi.id}:${dueDate}`,
          cadence: "once",
          due_rule: { due_date: dueDate },
          effective_start: dueDate,
          effective_end: dueDate,
          responsible_party: "tenant",
          communication_policy: "external_requires_approval",
          status: "active",
          source: "coi_approval",
          evidence: { coi_document_id: coi.id, compliance_result_id: savedResult.id },
        }, { onConflict: "org_id,lease_id,source_key" })
        .select("*")
        .single();
      expirationObligation = data ?? null;
    }
    await writeOperationalAudit(ctx.supabaseAdmin, {
      orgId: ctx.orgId,
      entityType: "coi_compliance_result",
      entityId: savedResult.id,
      action: "COI_COMPLIANCE_EVALUATED_FROM_APPROVAL",
      actorEmail: ctx.user.email || null,
      actorUserId: ctx.user.id,
      propertyId: coi.property_id ?? lease.property_id ?? null,
      newValue: { saved_result: savedResult, expiration_obligation: expirationObligation },
      source: "operational-review-command",
    });
    return { coi, compliance_result: savedResult, expiration_obligation: expirationObligation };
  }
  if (command === "rejectCoi") {
    const reason = requireText(body.reason, "reason");
    const coi = await transitionRecord(ctx, {
      table: "coi_documents",
      id: coiDocumentId,
      entityType: "coi_document",
      command,
      action: "COI_REJECTED",
      allowed: ["draft", "pending_review", "needs_review", "approved"],
      patch: { status: "rejected", evidence: { rejection_reason: reason, rejected_at: new Date().toISOString(), rejected_by: ctx.user.id } },
      reason,
    });
    return { coi };
  }
  throw new Error(`Unsupported COI command ${command}`);
}

async function commandVendorCredential(ctx: any, command: string, body: Record<string, unknown>) {
  await assertPageAccess(ctx.req, ctx.orgId, ["Vendors", "AutomationReadiness"], "write");
  if (command === "createVendorCredential") {
    const vendorId = requireUuid(body.vendor_id ?? body.vendorId, "vendor_id");
    await loadVendor(ctx, vendorId);
    const row = {
      org_id: ctx.orgId,
      vendor_id: vendorId,
      service_type: requireText(body.service_type ?? body.serviceType, "service_type"),
      jurisdiction: body.jurisdiction ? String(body.jurisdiction).trim() : null,
      credential_type: requireText(body.credential_type ?? body.credentialType, "credential_type"),
      credential_number: body.credential_number ?? body.credentialNumber ?? null,
      effective_date: body.effective_date ?? body.effectiveDate ?? null,
      expiration_date: body.expiration_date ?? body.expirationDate ?? null,
      verification_source: body.verification_source ?? body.verificationSource ?? null,
      verification_url: body.verification_url ?? body.verificationUrl ?? null,
      status: "pending_review",
      evidence: body.evidence && typeof body.evidence === "object" ? body.evidence : {},
    };
    const { data, error } = await ctx.supabaseAdmin.from("vendor_credentials").insert(row).select("*").single();
    if (error) throw new Error(`createVendorCredential failed: ${error.message}`);
    await writeOperationalAudit(ctx.supabaseAdmin, {
      orgId: ctx.orgId,
      entityType: "vendor_credential",
      entityId: data.id,
      action: "VENDOR_CREDENTIAL_CREATED",
      actorEmail: ctx.user.email || null,
      actorUserId: ctx.user.id,
      newValue: data,
      source: "operational-review-command",
    });
    return { credential: data };
  }
  if (command === "editVendorCredential") {
    const credentialId = requireUuid(body.credential_id ?? body.credentialId, "credential_id");
    const current = await loadRow(ctx.supabaseAdmin, ctx.orgId, "vendor_credentials", credentialId, "vendor_credential");
    const patch = {
      service_type: body.service_type ?? body.serviceType ?? current.service_type,
      jurisdiction: body.jurisdiction === undefined ? current.jurisdiction : body.jurisdiction,
      credential_type: body.credential_type ?? body.credentialType ?? current.credential_type,
      credential_number: body.credential_number ?? body.credentialNumber ?? current.credential_number,
      effective_date: body.effective_date ?? body.effectiveDate ?? current.effective_date,
      expiration_date: body.expiration_date ?? body.expirationDate ?? current.expiration_date,
      verification_source: body.verification_source ?? body.verificationSource ?? current.verification_source,
      verification_url: body.verification_url ?? body.verificationUrl ?? current.verification_url,
      status: ["verified", "approved", "active"].includes(String(current.status || "").toLowerCase()) ? "pending_review" : current.status,
      evidence: body.evidence && typeof body.evidence === "object" ? body.evidence : current.evidence,
    };
    const { data, error } = await ctx.supabaseAdmin
      .from("vendor_credentials")
      .update(patch)
      .eq("org_id", ctx.orgId)
      .eq("id", credentialId)
      .select("*")
      .single();
    if (error) throw new Error(`editVendorCredential failed: ${error.message}`);
    await writeOperationalAudit(ctx.supabaseAdmin, {
      orgId: ctx.orgId,
      entityType: "vendor_credential",
      entityId: credentialId,
      action: "VENDOR_CREDENTIAL_EDITED",
      actorEmail: ctx.user.email || null,
      actorUserId: ctx.user.id,
      oldValue: current,
      newValue: data,
      source: "operational-review-command",
    });
    return { credential: data };
  }
  const credentialId = requireUuid(body.credential_id ?? body.credentialId, "credential_id");
  if (command === "verifyVendorCredential") {
    const credential = await transitionRecord(ctx, {
      table: "vendor_credentials",
      id: credentialId,
      entityType: "vendor_credential",
      command,
      action: "VENDOR_CREDENTIAL_VERIFIED",
      allowed: ["draft", "pending_review", "needs_review", "rejected", "expired"],
      patch: {
        status: "verified",
        verification_source: body.verification_source ?? body.verificationSource ?? undefined,
        verification_url: body.verification_url ?? body.verificationUrl ?? undefined,
        verified_at: new Date().toISOString(),
        verified_by: ctx.user.id,
      },
      reason: body.reason ? String(body.reason) : null,
    });
    return { credential };
  }
  if (command === "revokeVendorCredential") {
    const reason = requireText(body.reason, "reason");
    const credential = await transitionRecord(ctx, {
      table: "vendor_credentials",
      id: credentialId,
      entityType: "vendor_credential",
      command,
      action: "VENDOR_CREDENTIAL_REVOKED",
      allowed: ["verified", "approved", "active", "needs_review", "pending_review"],
      patch: { status: "rejected", evidence: { revoked_reason: reason, revoked_at: new Date().toISOString(), revoked_by: ctx.user.id } },
      reason,
    });
    return { credential };
  }
  throw new Error(`Unsupported vendor credential command ${command}`);
}
async function commandObligation(ctx: any, command: string, body: Record<string, unknown>) {
  await assertPageAccess(ctx.req, ctx.orgId, ["AutomationReadiness", "CriticalDates", "LeaseReview"], "write");
  const occurrenceId = requireUuid(body.occurrence_id ?? body.occurrenceId, "occurrence_id");
  const reason = command === "waiveObligation" ? requireText(body.reason, "reason") : (body.reason ? String(body.reason) : null);
  const status = command === "satisfyObligation" ? "satisfied" : "waived";
  const action = command === "satisfyObligation" ? "OBLIGATION_SATISFIED" : "OBLIGATION_WAIVED";
  const occurrence = await transitionRecord(ctx, {
    table: "lease_obligation_occurrences",
    id: occurrenceId,
    entityType: "lease_obligation_occurrence",
    command,
    action,
    allowed: ["open", "overdue", "active", "pending_review", "blocked"],
    patch: { status },
    reason,
  });
  return { occurrence };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { supabaseAdmin, user } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    const body = await req.json().catch(() => ({}));
    const command = requireText(body.command, "command");
    const ctx = { req, supabaseAdmin, user, orgId };

    let data;
    if (["createSalesReport", "submitSalesReport", "approveSalesReport", "rejectSalesReport"].includes(command)) {
      data = await commandSales(ctx, command, body);
    } else if (["acknowledgeFinding", "assignFinding", "resolveFinding", "dismissFinding"].includes(command)) {
      data = await commandFinancialFinding(ctx, command, body);
    } else if (["overrideFindingPolicyDecision"].includes(command)) {
      data = await commandFinancialControlOverride(ctx, command, body);
    } else if (["approveCoi", "rejectCoi"].includes(command)) {
      data = await commandCoi(ctx, command, body);
    } else if (["createVendorCredential", "editVendorCredential", "verifyVendorCredential", "revokeVendorCredential"].includes(command)) {
      data = await commandVendorCredential(ctx, command, body);
    } else if (["waiveObligation", "satisfyObligation"].includes(command)) {
      data = await commandObligation(ctx, command, body);
    } else {
      throw new Error(`Unsupported operational review command ${command}`);
    }

    return jsonResponse({ error: false, command, data });
  } catch (error) {
    const message = error?.message || "Operational review command failed";
    console.error("[operational-review-command]", message);
    return jsonResponse({ error: true, message, error_code: "OPERATIONAL_REVIEW_COMMAND_FAILED" }, errorStatus(message));
  }
});
