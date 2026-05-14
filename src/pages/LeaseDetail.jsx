/**
 * LeaseDetail — read-only system-of-record view for an approved lease.
 *
 * Reads from `leases.abstract_snapshot` when available (frozen at approval
 * time, immutable per abstract_version). Falls back to live lease columns
 * for legacy rows whose abstract was approved before the Phase 3 snapshot
 * was written. The page is intentionally read-only — corrections happen in
 * Lease Review, which produces a new abstract_version on the next approval.
 */
import React, { useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  FileText,
  FileX,
  Gavel,
  History,
  Home,
  Loader2,
  Pencil,
  Receipt,
  Shield,
  Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { leaseService } from "@/services/leaseService";
import { loadFieldReviewMap } from "@/services/leaseAbstractService";
import { getLeaseFieldLabel } from "@/lib/leaseFieldOptions";
import {
  LEASE_REVIEW_FIELDS,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_STYLES,
} from "@/lib/leaseReviewSchema";
import { createPageUrl } from "@/utils";
import { supabase } from "@/services/supabaseClient";

export default function LeaseDetail() {
  const location = useLocation();
  const urlParams = new URLSearchParams(location.search);
  const leaseId = urlParams.get("id");

  const { data: lease, isLoading } = useQuery({
    queryKey: ["lease", leaseId],
    queryFn: () => leaseService.filter({ id: leaseId }),
    enabled: !!leaseId,
    select: (data) => data?.[0],
  });

  const { data: fieldReviewMap = {} } = useQuery({
    queryKey: ["lease-field-reviews", leaseId],
    queryFn: () => loadFieldReviewMap(leaseId),
    enabled: !!leaseId,
  });

  const { data: documents = [] } = useQuery({
    queryKey: ["lease-documents", leaseId],
    queryFn: async () => {
      if (!leaseId) return [];
      const { data, error } = await supabase
        .from("documents")
        .select("id, name, type, status, signed_by, signed_at, document_url, created_at")
        .eq("lease_id", leaseId)
        .order("created_at", { ascending: false });
      if (error) {
        console.warn("[LeaseDetail] documents query failed:", error.message);
        return [];
      }
      return data || [];
    },
    enabled: !!leaseId,
  });

  // Snapshot read helper: prefer the frozen snapshot value; fall back to live
  // lease column so legacy rows still render.
  const snapshot = lease?.abstract_snapshot && Object.keys(lease.abstract_snapshot).length
    ? lease.abstract_snapshot
    : null;
  const get = useMemo(() => {
    return (key) => {
      const snapField = snapshot?.fields?.[key];
      if (snapField && snapField.value !== null && snapField.value !== undefined) return snapField.value;
      if (lease && lease[key] !== null && lease[key] !== undefined && lease[key] !== "") return lease[key];
      return null;
    };
  }, [snapshot, lease]);

  if (!leaseId) {
    return (
      <div className="flex h-96 flex-col items-center justify-center p-6">
        <FileX className="mb-4 h-12 w-12 text-slate-300" />
        <h2 className="mb-2 text-xl font-bold text-slate-900">No Lease Selected</h2>
        <Link to={createPageUrl("Leases")}>
          <Button>Go to Leases</Button>
        </Link>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }
  if (!lease) {
    return (
      <div className="flex h-96 flex-col items-center justify-center p-6">
        <FileX className="mb-4 h-12 w-12 text-slate-300" />
        <h2 className="mb-2 text-xl font-bold text-slate-900">Lease Not Found</h2>
        <Link to={createPageUrl("Leases")}>
          <Button>Go to Leases</Button>
        </Link>
      </div>
    );
  }

  const abstractStatus = String(lease.abstract_status || "").toLowerCase();
  const isApproved = abstractStatus === "approved";
  const reviewLink = createPageUrl("LeaseReview", { id: lease.id });

  return (
    <div className="space-y-6 p-6">
      <Link
        to={createPageUrl("Leases")}
        className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Leases
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Lease Detail</h1>
          <p className="text-sm text-slate-500">
            {lease.tenant_name || "Unknown tenant"} ·{" "}
            {getLeaseFieldLabel("lease_type", lease.lease_type) || "Unknown lease type"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge className={isApproved ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}>
              Abstract: {abstractStatus || "—"}
              {lease.abstract_version ? ` · v${lease.abstract_version}` : ""}
            </Badge>
            {lease.abstract_approved_at && (
              <Badge className="bg-slate-100 text-slate-700">
                Approved {new Date(lease.abstract_approved_at).toLocaleDateString()}
                {lease.abstract_approved_by ? ` by ${lease.abstract_approved_by}` : ""}
              </Badge>
            )}
            {!snapshot && isApproved && (
              <Badge className="bg-amber-100 text-amber-800">
                Legacy approval — no immutable snapshot
              </Badge>
            )}
          </div>
        </div>
        <Link to={reviewLink}>
          <Button variant="outline">
            <Pencil className="mr-1 h-4 w-4" />
            Open Lease Review
          </Button>
        </Link>
      </div>

      {!isApproved && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="flex items-start gap-2 p-4 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4" />
            <span>
              This lease abstract has not been approved yet. Use Lease Review to complete the
              field-by-field review and approve. Downstream modules only read from approved
              abstracts.
            </span>
          </CardContent>
        </Card>
      )}

      {/* Lease Summary */}
      <SectionCard icon={CheckCircle2} title="Lease Summary">
        <DetailGrid
          items={[
            ["Tenant", get("tenant_name")],
            ["Landlord", get("landlord_name")],
            ["Lease Type", getLeaseFieldLabel("lease_type", get("lease_type")) || get("lease_type")],
            ["Commencement", get("start_date") || get("commencement_date")],
            ["Expiration", get("end_date") || get("expiration_date")],
            ["Monthly Rent", formatCurrency(get("monthly_rent"))],
            ["Annual Rent", formatCurrency(get("annual_rent"))],
            ["Square Footage", formatNumber(get("square_footage") || get("total_sf"))],
          ]}
        />
      </SectionCard>

      {/* Parties */}
      <SectionCard icon={Users} title="Parties">
        <DetailGrid
          items={[
            ["Tenant Name", get("tenant_name")],
            ["Tenant Contact", get("tenant_contact_name")],
            ["Tenant Address", get("tenant_address")],
            ["Landlord Name", get("landlord_name")],
            ["Landlord Address", get("landlord_address")],
            ["Broker", get("broker_name")],
          ]}
        />
      </SectionCard>

      {/* Premises */}
      <SectionCard icon={Home} title="Premises">
        <DetailGrid
          items={[
            ["Property", get("property_name")],
            ["Property Address", get("property_address") || get("premises_address")],
            ["Suite Number", get("suite_number")],
            ["Square Footage (RSF)", formatNumber(get("square_footage") || get("total_sf") || get("rentable_area_sqft"))],
            ["Permitted Use", get("permitted_use") || get("premises_use")],
            ["Parking Rights", get("parking_rights")],
          ]}
        />
      </SectionCard>

      {/* Dates & Term */}
      <SectionCard icon={Calendar} title="Dates & Term">
        <DetailGrid
          items={[
            ["Lease Date", get("lease_date")],
            ["Commencement Date", get("start_date") || get("commencement_date")],
            ["Rent Commencement Date", get("rent_commencement_date")],
            ["Expiration Date", get("end_date") || get("expiration_date")],
            ["Term Length", get("lease_term")],
            ["Renewal Notice (months)", get("renewal_notice_months") || (get("renewal_notice_days") ? `${Math.round(Number(get("renewal_notice_days")) / 30)} (${get("renewal_notice_days")} days)` : null)],
            ["Termination Notice (months)", get("termination_notice_months")],
            ["Option Exercise Deadline", get("option_exercise_deadline")],
          ]}
        />
      </SectionCard>

      {/* Rent */}
      <SectionCard icon={Receipt} title="Rent">
        <DetailGrid
          items={[
            ["Monthly Rent", formatCurrency(get("monthly_rent") || get("base_rent_monthly"))],
            ["Annual Rent", formatCurrency(get("annual_rent"))],
            ["Base Rent ($/SF/yr)", formatNumber(get("rent_per_sf"), { fractionDigits: 2 })],
            ["Billing Frequency", getLeaseFieldLabel("billing_frequency", get("billing_frequency")) || get("rent_frequency")],
            ["Rent Due Day", get("rent_due_day")],
            ["Rent Payment Timing", get("rent_payment_timing")],
            ["Escalation Type", getLeaseFieldLabel("escalation_type", get("escalation_type"))],
            ["Escalation Rate (%)", get("escalation_rate")],
            ["Escalation Timing", getLeaseFieldLabel("escalation_timing", get("escalation_timing"))],
            ["Free Rent (months)", get("free_rent_months")],
            ["TI Allowance", formatCurrency(get("ti_allowance"))],
          ]}
        />
      </SectionCard>

      {/* Deposits */}
      <SectionCard icon={Receipt} title="Deposits">
        <DetailGrid
          items={[
            ["Security Deposit", formatCurrency(get("security_deposit"))],
            ["Late Fee Grace (days)", get("late_fee_grace_days")],
            ["Late Fee (%)", get("late_fee_percent")],
            ["Holdover Rent Multiplier", get("holdover_rent_multiplier")],
          ]}
        />
      </SectionCard>

      {/* Options */}
      <SectionCard icon={Gavel} title="Options">
        <DetailGrid
          items={[
            ["Renewal Type", getLeaseFieldLabel("renewal_type", get("renewal_type"))],
            ["Renewal Options", getLeaseFieldLabel("renewal_options", get("renewal_options"))],
            ["Right of First Refusal", formatBoolean(get("right_of_first_refusal"))],
            ["Early Termination Option", formatBoolean(get("early_termination_option"))],
            ["Assignment Provisions", get("assignment_provisions")],
            ["Default Cure Period (days)", get("default_cure_period")],
          ]}
        />
      </SectionCard>

      {/* Insurance */}
      <SectionCard icon={Shield} title="Insurance">
        <DetailGrid
          items={[
            ["Tenant Insurance Required", formatBoolean(get("tenant_insurance_required"))],
            ["General Liability Min ($)", formatCurrency(get("general_liability_min"))],
            ["Property Insurance Responsibility", getLeaseFieldLabel("hvac_responsibility", get("property_insurance_responsibility"))],
            ["Waiver of Subrogation", formatBoolean(get("waiver_of_subrogation"))],
            ["Additional Insureds Required", formatBoolean(get("additional_insureds_required"))],
          ]}
        />
      </SectionCard>

      {/* Defaults / Legal */}
      <SectionCard icon={Gavel} title="Defaults / Legal">
        <DetailGrid
          items={[
            ["Default Cure Period (days)", get("default_cure_period")],
            ["Default Interest Formula", get("default_interest_rate_formula")],
            ["Late Fee Grace (days)", get("late_fee_grace_days")],
            ["Late Fee (%)", get("late_fee_percent")],
          ]}
        />
      </SectionCard>

      {/* Documents */}
      <SectionCard icon={FileText} title="Documents">
        <div className="space-y-2 text-sm">
          {documents.length === 0 ? (
            <p className="text-slate-500">No documents stored for this lease yet.</p>
          ) : (
            documents.map((doc) => (
              <div
                key={doc.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3"
              >
                <div>
                  <p className="font-medium text-slate-900">{doc.name}</p>
                  <p className="text-xs text-slate-500">
                    {doc.type} · {doc.status}
                    {doc.signed_by ? ` · signed by ${doc.signed_by}` : ""}
                    {doc.signed_at ? ` on ${new Date(doc.signed_at).toLocaleDateString()}` : ""}
                  </p>
                </div>
                {doc.document_url && (
                  <a
                    href={doc.document_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:text-blue-700"
                  >
                    Open
                  </a>
                )}
              </div>
            ))
          )}
        </div>
      </SectionCard>

      {/* Audit History */}
      <SectionCard icon={History} title="Audit History">
        <AuditList fieldReviewMap={fieldReviewMap} />
      </SectionCard>
    </div>
  );
}

// --- helpers ------------------------------------------------------------

function SectionCard({ icon: Icon, title, children }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          {Icon && <Icon className="h-4 w-4 text-slate-500" />}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function DetailGrid({ items }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
          <dd className="mt-1 text-sm font-medium text-slate-900">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function AuditList({ fieldReviewMap }) {
  const entries = Object.values(fieldReviewMap || {})
    .filter((row) => row && row.reviewed_at)
    .sort((a, b) => new Date(b.reviewed_at) - new Date(a.reviewed_at));

  if (entries.length === 0) {
    return <p className="text-sm text-slate-500">No field-level review activity recorded yet.</p>;
  }

  return (
    <div className="space-y-2">
      {entries.slice(0, 50).map((row) => {
        const fieldDef = LEASE_REVIEW_FIELDS.find((f) => f.key === row.field_key);
        const label = fieldDef?.label || row.field_key;
        const style = REVIEW_STATUS_STYLES[row.status] || "bg-slate-100 text-slate-700";
        return (
          <div key={row.field_key} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3">
            <div>
              <p className="text-sm font-medium text-slate-900">{label}</p>
              <p className="text-xs text-slate-500">
                {row.reviewer ? `${row.reviewer} · ` : ""}
                {new Date(row.reviewed_at).toLocaleString()}
              </p>
              {row.note && <p className="mt-1 text-xs italic text-slate-600">"{row.note}"</p>}
            </div>
            <div className="flex flex-col items-end gap-1">
              <Badge className={`text-[10px] ${style}`}>{REVIEW_STATUS_LABELS[row.status] || row.status}</Badge>
              {row.normalized_value && (
                <p className="text-xs text-slate-700">{row.normalized_value}</p>
              )}
            </div>
          </div>
        );
      })}
      {entries.length > 50 && (
        <p className="text-xs text-slate-500">Showing 50 most recent of {entries.length} entries.</p>
      )}
    </div>
  );
}

function formatCurrency(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `$${n.toLocaleString()}`;
}

function formatNumber(value, { fractionDigits = 0 } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return fractionDigits > 0 ? n.toFixed(fractionDigits) : n.toLocaleString();
}

function formatBoolean(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value === true || value === "true" || value === "yes") return "Yes";
  if (value === false || value === "false" || value === "no") return "No";
  return String(value);
}
