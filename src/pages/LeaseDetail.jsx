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
  Settings,
  Car,
  Zap,
  Wrench,
  DollarSign,
  Download,
  Printer
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { loadFieldReviewMap } from "@/services/leaseAbstractService";
import { resolveLeaseField } from "@/lib/leaseFieldResolver";
import { approvedLeaseFieldValue } from "@/lib/approvedLeaseSnapshot";
import { getLeaseFieldLabel } from "@/lib/leaseFieldOptions";
import {
  LEASE_REVIEW_FIELDS,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_STYLES,
} from "@/lib/leaseReviewSchema";
import { createPageUrl } from "@/utils";
import { supabase } from "@/services/supabaseClient";

const LEASE_DETAIL_FIELD_ALIASES = {
  tenant_name: ["tenant_name", "tenant"],
  landlord_name: ["landlord_name", "landlord"],
  lease_type: ["lease_type", "expense_structure", "lease_structure", "cam_structure"],
  monthly_rent: ["monthly_rent", "base_rent_monthly", "base_rent", "monthly_base_rent"],
  annual_rent: ["annual_rent", "base_rent_annual", "annual_base_rent", "yearly_rent"],
  rent_per_sf: ["rent_per_sf", "base_rent_psf", "tenant_rent_per_rsf"],
  square_footage: ["square_footage", "tenant_rsf", "rentable_area_sqft", "premises_rsf", "rsf", "total_sf"],
  premises_use: ["premises_use", "permitted_use", "use"],
  suite_number: ["suite_number", "unit_number", "unit", "premises_suite"],
  commencement_date: ["commencement_date", "start_date", "lease_start_date", "term_start_date"],
  expiration_date: ["expiration_date", "end_date", "lease_end_date", "term_end_date"],
  rent_commencement_date: ["rent_commencement_date", "rent_start_date", "commencement_date", "start_date"],
  initial_term: ["initial_term", "lease_term", "lease_term_months", "term_months"],
  expense_structure: ["expense_structure", "lease_type", "lease_structure", "cam_structure"],
  tenant_insurance_required: ["tenant_insurance_required", "insurance_required"],
  responsibility_taxes: ["responsibility_taxes", "tax_responsibility"],
  responsibility_utilities: ["responsibility_utilities", "utilities_responsibility"],
  responsibility_repairs: ["responsibility_repairs", "maintenance_responsibility"],
};

function hasDetailValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function firstDetailValue(...values) {
  for (const value of values) {
    if (hasDetailValue(value)) return value;
  }
  return null;
}

function reviewFieldForKey(fieldReviewMap, key) {
  const aliases = LEASE_DETAIL_FIELD_ALIASES[key] || [key];
  return aliases.map((alias) => fieldReviewMap?.[alias]).find(Boolean) || null;
}

function getLeaseSourceFileId(lease) {
  return (
    lease?.source_file_id ||
    lease?.uploaded_file_id ||
    lease?.file_id ||
    lease?.extraction_data?.source_file_id ||
    lease?.extraction_data?.uploaded_file_id ||
    null
  );
}

export default function LeaseDetail() {
  const location = useLocation();
  const urlParams = new URLSearchParams(location.search);
  const leaseId = urlParams.get("id");

  const { data: lease, isLoading } = useQuery({
    queryKey: ["leaseRich", leaseId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leases")
        .select("*")
        .eq("id", leaseId)
        .single();
      if (error) throw error;

      let fileMap = {};
      const sourceFileId = getLeaseSourceFileId(data);
      if (sourceFileId) {
        const { data: file } = await supabase
          .from("uploaded_files")
          .select("id, reviewed_output, ui_review_payload, normalized_output, parsed_data, active_generation_id")
          .eq("id", sourceFileId)
          .single();
        if (file) fileMap = file;
      }

      return {
        ...data,
        uploaded_files: fileMap,
        uploaded_file: fileMap
      };
    },
    enabled: !!leaseId,
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

  const { data: counts = {} } = useQuery({
    queryKey: ["lease-counts", leaseId],
    queryFn: async () => {
      const [{ count: rules }, { count: rent }, { count: dates }] = await Promise.all([
        supabase.from("lease_expense_rules").select("*", { count: "exact", head: true }).eq("lease_id", leaseId),
        supabase.from("rent_schedules").select("*", { count: "exact", head: true }).eq("lease_id", leaseId),
        supabase.from("lease_critical_dates").select("*", { count: "exact", head: true }).eq("lease_id", leaseId),
      ]);
      return {
        rules: rules || 0,
        rent: rent || 0,
        dates: dates || 0,
      };
    },
    enabled: !!leaseId,
  });

  const getFieldObj = useMemo(() => {
    return (key) => {
      const resolved = resolveLeaseField(lease, key, { mode: "canonical" });
      const review = reviewFieldForKey(fieldReviewMap, key);
      const reviewStatus = String(review?.status || "").toLowerCase();
      const approvedValue = approvedLeaseFieldValue(lease, key, LEASE_DETAIL_FIELD_ALIASES);
      const reviewerValue = ["accepted", "edited", "approved", "reviewed"].includes(reviewStatus)
        ? firstDetailValue(review?.normalized_value, review?.normalizedValue, review?.value, review?.raw_value)
        : null;
      const value = firstDetailValue(reviewerValue, approvedValue, resolved?.value);
      return {
        ...(resolved || {}),
        found: hasDetailValue(value) || resolved?.found,
        value,
        raw_value: firstDetailValue(review?.raw_value, resolved?.raw_value, value),
        source_page: firstDetailValue(review?.source_page, review?.sourcePage, resolved?.source_page, resolved?.sourcePage),
        source_text: firstDetailValue(
          review?.source_text,
          review?.exact_source_text,
          review?.exactSourceText,
          review?.source_clause,
          review?.sourceClause,
          resolved?.source_text,
          resolved?.exact_source_text,
          resolved?.exactSourceText,
          resolved?.source_clause,
          resolved?.sourceClause,
        ),
        review_status: review?.status || resolved?.review_status || resolved?.extraction_status || "n/a",
      };
    };
  }, [lease, fieldReviewMap]);

  const snapshot = lease?.abstract_snapshot || {};
  const completeFieldGroups = useMemo(() => {
    return LEASE_REVIEW_FIELDS.reduce((groups, field) => {
      if (field.tab === "extraction_debug" || field.tab === "extraction_timeline") return groups;
      const resolved = getFieldObj(field.key);
      const value = formatFieldValueForDetail(field, resolved?.value ?? resolved?.raw_value);
      const row = {
        ...resolved,
        label: field.label,
        key: field.key,
        value: value ?? resolved?.value ?? resolved?.raw_value ?? null,
      };
      const group = groups.get(field.tab) || [];
      group.push(row);
      groups.set(field.tab, group);
      return groups;
    }, new Map());
  }, [getFieldObj]);

  const handleOpenDocument = async (e, url) => {
    e.preventDefault();
    if (!url) return;

    // Check if it's a Supabase storage signed URL
    const match = url.match(/object\/sign\/([^\/]+)\/(.+?)(?:\?|$)/);
    if (match) {
      const bucket = match[1];
      const path = match[2];
      try {
        const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
        if (!error && data?.signedUrl) {
          window.open(data.signedUrl, '_blank');
          return;
        }
      } catch (err) {
        console.warn("[LeaseDetail] Failed to refresh signed URL", err);
      }
    }

    // Fallback: open original url
    window.open(url, '_blank');
  };

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
  const headerTenantName = getFieldObj("tenant_name")?.value || lease.tenant_name || "Unknown tenant";
  const headerLeaseType = getFieldObj("lease_type")?.value || lease.lease_type || null;

  return (
    <div className="lease-detail-print space-y-6 p-6">
      <Link
        to={createPageUrl("Leases")}
        className="no-print flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Leases
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold text-slate-900">Lease Detail</h1>
          <p className="text-sm text-slate-500">
            {headerTenantName} ·{" "}
            {getLeaseFieldLabel("lease_type", headerLeaseType) || "Unknown lease type"}
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
            {!lease?.abstract_snapshot && isApproved && (
              <Badge className="bg-amber-100 text-amber-800">
                Legacy approval — no immutable snapshot
              </Badge>
            )}
          </div>
        </div>
        <div className="no-print flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => window.print()}>
            <Printer className="mr-1 h-4 w-4" />
            Print
          </Button>
          <Button variant="outline" onClick={() => window.print()}>
            <Download className="mr-1 h-4 w-4" />
            Download PDF
          </Button>
          <Link to={reviewLink}>
            <Button variant="outline">
              <Pencil className="mr-1 h-4 w-4" />
              Open Lease Review
            </Button>
          </Link>
        </div>
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

      {/* Dev-Only Diagnostic Panel */}
      <Card className="no-print border-blue-200 bg-blue-50">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm text-blue-900">
            <Settings className="h-4 w-4" />
            Dev-Only Diagnostic Panel
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="text-xs text-blue-800 space-y-1">
            <li><strong>Lease ID:</strong> {lease.id}</li>
            <li><strong>Top-level populated fields:</strong> {Object.keys(lease).filter(k => lease[k] !== null && lease[k] !== "").length}</li>
            <li><strong>canonical snapshot found:</strong> {!!lease?.abstract_snapshot ? "yes" : "no"}</li>
            <li><strong>Lease expense rules count:</strong> {counts.rules}</li>
            <li><strong>Rent schedule lines count:</strong> {counts.rent}</li>
            <li><strong>Critical dates count:</strong> {counts.dates}</li>
          </ul>
        </CardContent>
      </Card>

      <SectionCard icon={CheckCircle2} title="Summary">
        <DetailGrid items={[
          ["Tenant", getFieldObj("tenant_name")],
          ["Landlord", getFieldObj("landlord_name")],
          ["Lease Type", { ...getFieldObj("lease_type"), value: getLeaseFieldLabel("lease_type", getFieldObj("lease_type")?.value) || getFieldObj("lease_type")?.value }],
          ["Monthly Rent", { ...getFieldObj("monthly_rent"), value: formatCurrency(getFieldObj("monthly_rent")?.value) }],
          ["Square Footage", { ...getFieldObj("square_footage"), value: formatNumber(getFieldObj("square_footage")?.value) }],
        ]} />
      </SectionCard>

      <SectionCard icon={Users} title="Parties">
        <DetailGrid items={[
          ["Tenant Name", getFieldObj("tenant_name")],
          ["Tenant Notice Address", getFieldObj("tenant_address")],
          ["Tenant Contact/Email", getFieldObj("tenant_contact_name")],
          ["Landlord Name", getFieldObj("landlord_name")],
          ["Landlord Notice Address", getFieldObj("landlord_address")],
          ["Landlord Contact/Email", getFieldObj("landlord_contact_name")],
          ["Property Manager", getFieldObj("property_manager")],
        ]} />
      </SectionCard>

      <SectionCard icon={Home} title="Premises">
        <DetailGrid items={[
          ["Property Name", getFieldObj("property_name")],
          ["Building RSF", { ...getFieldObj("building_rsf"), value: formatNumber(getFieldObj("building_rsf")?.value) }],
          ["Suite Number", getFieldObj("suite_number")],
          ["Floor", getFieldObj("floor")],
          ["Premises RSF", { ...getFieldObj("square_footage"), value: formatNumber(getFieldObj("square_footage")?.value) }],
          ["Tenant Pro Rata Share", { ...getFieldObj("tenant_pro_rata_share"), value: formatPercent(getFieldObj("tenant_pro_rata_share")?.value) }],
          ["Permitted Use", getFieldObj("premises_use")],
        ]} />
      </SectionCard>

      <SectionCard icon={Calendar} title="Dates & Term">
        <DetailGrid items={[
          ["Lease Date", getFieldObj("lease_date")],
          ["Commencement Date", getFieldObj("commencement_date")],
          ["Expiration Date", getFieldObj("expiration_date")],
          ["Initial Term", getFieldObj("initial_term")],
          ["Rent Commencement", getFieldObj("rent_commencement_date")],
        ]} />
      </SectionCard>

      <SectionCard icon={Receipt} title="Rent Schedule">
        <DetailGrid items={[
          ["Monthly Rent", { ...getFieldObj("monthly_rent"), value: formatCurrency(getFieldObj("monthly_rent")?.value) }],
          ["Annual Rent", { ...getFieldObj("annual_rent"), value: formatCurrency(getFieldObj("annual_rent")?.value) }],
          ["Base Rent ($/SF/yr)", { ...getFieldObj("rent_per_sf"), value: formatCurrency(getFieldObj("rent_per_sf")?.value) }],
          ["Escalation Type", getFieldObj("escalation_type")],
          ["Escalation Rate", { ...getFieldObj("escalation_rate"), value: formatPercent(getFieldObj("escalation_rate")?.value) }],
          ["Free Rent (months)", getFieldObj("free_rent_months")],
        ]} />
      </SectionCard>

      <SectionCard icon={DollarSign} title="Deposits & Additional Rent">
        <DetailGrid items={[
          ["Security Deposit", { ...getFieldObj("security_deposit"), value: formatCurrency(getFieldObj("security_deposit")?.value) }],
          ["TI Allowance", { ...getFieldObj("ti_allowance"), value: formatCurrency(getFieldObj("ti_allowance")?.value) }],
        ]} />
      </SectionCard>

      <SectionCard icon={Receipt} title="Expenses / Recoveries">
        <DetailGrid items={[
          ["Expense Structure", getFieldObj("expense_structure")],
          ["Base Year", getFieldObj("base_year")],
          ["Expense Stop", { ...getFieldObj("expense_stop"), value: formatCurrency(getFieldObj("expense_stop")?.value) }],
        ]} />
      </SectionCard>

      <SectionCard icon={Receipt} title="CAM Rules">
        <DetailGrid items={[
          ["Estimated Annual CAM", { ...getFieldObj("estimated_annual_cam"), value: formatCurrency(getFieldObj("estimated_annual_cam")?.value) }],
          ["Estimated Monthly CAM", { ...getFieldObj("estimated_monthly_cam"), value: formatCurrency(getFieldObj("estimated_monthly_cam")?.value) }],
          ["Admin Fee (%)", { ...getFieldObj("admin_fee_percent"), value: formatPercent(getFieldObj("admin_fee_percent")?.value) }],
          ["Gross-Up (%)", { ...getFieldObj("gross_up_percent"), value: formatPercent(getFieldObj("gross_up_percent")?.value) }],
          ["CAM Cap (%)", { ...getFieldObj("cam_cap_percent"), value: formatPercent(getFieldObj("cam_cap_percent")?.value) }],
        ]} />
      </SectionCard>

      <SectionCard icon={Shield} title="Insurance Requirements">
        <DetailGrid items={[
          ["Tenant Insurance Required", { ...getFieldObj("tenant_insurance_required"), value: formatBoolean(getFieldObj("tenant_insurance_required")?.value) }],
          ["CGL per occurrence", { ...getFieldObj("general_liability_min"), value: formatCurrency(getFieldObj("general_liability_min")?.value) }],
          ["General Aggregate", { ...getFieldObj("general_aggregate"), value: formatCurrency(getFieldObj("general_aggregate")?.value) }],
          ["Employer Liability", { ...getFieldObj("employer_liability"), value: formatCurrency(getFieldObj("employer_liability")?.value) }],
          ["Business Interruption", getFieldObj("business_interruption")],
          ["Property Insurance Responsibility", getFieldObj("property_insurance_responsibility")],
          ["Waiver of Subrogation", { ...getFieldObj("waiver_of_subrogation"), value: formatBoolean(getFieldObj("waiver_of_subrogation")?.value) }],
          ["Additional Insureds Required", { ...getFieldObj("additional_insureds_required"), value: formatBoolean(getFieldObj("additional_insureds_required")?.value) }],
        ]} />
      </SectionCard>

      <SectionCard icon={Zap} title="Utilities">
        <DetailGrid items={[
          ["Utilities Responsibility", getFieldObj("responsibility_utilities")],
        ]} />
      </SectionCard>

      <SectionCard icon={Wrench} title="Repairs & Maintenance">
        <DetailGrid items={[
          ["Repairs Responsibility", getFieldObj("responsibility_repairs")],
        ]} />
      </SectionCard>

      <SectionCard icon={DollarSign} title="Taxes">
        <DetailGrid items={[
          ["Tax Responsibility", getFieldObj("responsibility_taxes")],
        ]} />
      </SectionCard>

      <SectionCard icon={Car} title="Parking & Hours">
        <DetailGrid items={[
          ["Parking Rights / Spaces", getFieldObj("parking_rights")],
          ["Operating Hours", getFieldObj("operating_hours")],
        ]} />
      </SectionCard>

      <SectionCard icon={AlertTriangle} title="Defaults / Remedies">
        <DetailGrid items={[
          ["Late Fee Grace (days)", getFieldObj("default_cure_period")],
          ["Late Fee (%)", { ...getFieldObj("late_fee_percent"), value: formatPercent(getFieldObj("late_fee_percent")?.value) }],
          ["Default Interest Rate", { ...getFieldObj("default_interest_rate_formula"), value: formatPercent(getFieldObj("default_interest_rate_formula")?.value) }],
          ["Holdover Multiplier", { ...getFieldObj("holdover_rent_multiplier"), value: formatPercent(getFieldObj("holdover_rent_multiplier")?.value) }],
        ]} />
      </SectionCard>

      <SectionCard icon={Gavel} title="Options / Renewal / Termination">
        <DetailGrid items={[
          ["Renewal Options", getFieldObj("renewal_options")],
          ["Renewal Notice", getFieldObj("renewal_notice_months")],
          ["Termination Option", { ...getFieldObj("early_termination_option"), value: formatBoolean(getFieldObj("early_termination_option")?.value) }],
          ["ROFR", { ...getFieldObj("right_of_first_refusal"), value: formatBoolean(getFieldObj("right_of_first_refusal")?.value) }],
        ]} />
      </SectionCard>

      <SectionCard icon={FileText} title="Notices">
        <DetailGrid items={[
          ["Notice Requirements", getFieldObj("notices")],
        ]} />
      </SectionCard>

      <SectionCard icon={Users} title="Broker / Estoppel / Subordination / Surrender">
        <DetailGrid items={[
          ["Broker", getFieldObj("broker")],
          ["Estoppel", getFieldObj("estoppel")],
          ["Subordination", getFieldObj("subordination")],
          ["Surrender", getFieldObj("surrender")],
        ]} />
      </SectionCard>

      {/* Other Extracted Terms */}
      <SectionCard icon={CheckCircle2} title="Other Extracted Terms">
        {snapshot?.unmapped_terms && Object.keys(snapshot.unmapped_terms).length > 0 ? (
          <DetailGrid items={Object.entries(snapshot.unmapped_terms).map(([key, obj]) => [key, obj])} />
        ) : (
          <p className="text-sm text-slate-500">No additional terms extracted.</p>
        )}
      </SectionCard>

      <SectionCard icon={FileText} title="Complete Field Abstract">
        <div className="space-y-5">
          {[...completeFieldGroups.entries()].map(([tabKey, rows]) => (
            <div key={tabKey} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {tabKey.replace(/_/g, " ")}
              </h3>
              <DetailFieldTable rows={rows} />
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Documents */}
      <SectionCard icon={FileText} title="Documents & Exhibits">
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
                  <button
                    onClick={(e) => handleOpenDocument(e, doc.document_url)}
                    className="text-xs text-blue-600 hover:text-blue-700"
                  >
                    Open
                  </button>
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
    <Card data-print-section>
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
      {items.map(([label, obj]) => {
        const val = obj?.value ?? obj?.raw_value ?? null;
        const status = obj?.review_status || "n/a";
        let statusStyle = "bg-slate-100 text-slate-700";
        if (["approved", "accepted", "reviewed"].includes(status)) statusStyle = "bg-emerald-100 text-emerald-700";
        else if (status === "rejected") statusStyle = "bg-red-100 text-red-700";
        else if (status === "pending" || status === "needs review") statusStyle = "bg-amber-100 text-amber-800";
        else if (status === "not found") statusStyle = "bg-slate-100 text-slate-400";

        return (
          <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex justify-between items-start gap-2">
              <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
              <Badge className={`text-[9px] px-1 py-0 ${statusStyle}`}>{status}</Badge>
            </div>
            <dd className="mt-1 text-sm font-medium text-slate-900">{val ?? "—"}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function DetailFieldTable({ rows }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="bg-slate-100 text-[10px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="w-[22%] border-b border-slate-200 px-3 py-2 font-semibold">Field</th>
            <th className="w-[28%] border-b border-slate-200 px-3 py-2 font-semibold">Value</th>
            <th className="w-[16%] border-b border-slate-200 px-3 py-2 font-semibold">Status</th>
            <th className="w-[8%] border-b border-slate-200 px-3 py-2 font-semibold">Page</th>
            <th className="border-b border-slate-200 px-3 py-2 font-semibold">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status = row.review_status || row.extraction_status || (row.value ? "extracted" : "not found");
            return (
              <tr key={row.key} className="break-inside-avoid border-b border-slate-100 last:border-b-0">
                <td className="align-top px-3 py-2 font-medium text-slate-900">{row.label}</td>
                <td className="align-top px-3 py-2 text-slate-800">{row.value ?? "Not extracted"}</td>
                <td className="align-top px-3 py-2 text-slate-600">{status}</td>
                <td className="align-top px-3 py-2 text-slate-600">{row.source_page ?? row.sourcePage ?? "—"}</td>
                <td className="align-top px-3 py-2 text-slate-600">
                  {row.source_text || row.exact_source_text || row.exactSourceText || row.sourceClause || "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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

function parseDisplayNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = String(value).match(/[-+]?\d[\d,]*(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function formatCurrency(value) {
  const n = parseDisplayNumber(value);
  if (n === null) return null;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatNumber(value, { fractionDigits = 0 } = {}) {
  const n = parseDisplayNumber(value);
  if (n === null) return null;
  return fractionDigits > 0 ? n.toFixed(fractionDigits) : n.toLocaleString();
}

function formatBoolean(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value === true || String(value).toLowerCase() === "true" || String(value).toLowerCase() === "yes") return "Yes";
  if (value === false || String(value).toLowerCase() === "false" || String(value).toLowerCase() === "no") return "No";
  return String(value);
}

function formatPercent(value) {
  const n = parseDisplayNumber(value);
  if (n === null) return String(value ?? "") || null;
  return `${n}%`;
}

function formatFieldValueForDetail(field, value) {
  if (value === null || value === undefined || value === "") return null;
  if (field?.type === "currency") return formatCurrency(value) || String(value);
  if (field?.type === "number") return formatNumber(value, { fractionDigits: field.key?.includes("rate") || field.key?.includes("pct") || field.key?.includes("percent") ? 2 : 0 }) || String(value);
  if (field?.type === "boolean") return formatBoolean(value);
  if (field?.type === "select") return getLeaseFieldLabel(field.key, value) || String(value);
  return String(value);
}
