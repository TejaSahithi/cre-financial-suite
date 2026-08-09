import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { supabase } from "@/services/supabaseClient";
import {
  humanizeToken,
  getSimplifiedRuleView,
  getContractStatus,
  getPolicyStatus,
} from "./utils/leaseExpenseRulesHelpers";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Field({ label, value }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <div className="mt-0.5 text-sm text-slate-800">{value === "" || value === null || value === undefined ? "-" : value}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="border-t border-slate-100 pt-4 first:border-t-0 first:pt-0">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h4>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </div>
  );
}

const TONE_CLASS = {
  emerald: "bg-emerald-100 text-emerald-700",
  red: "bg-red-100 text-red-700",
  amber: "bg-amber-100 text-amber-800",
  slate: "bg-slate-100 text-slate-600",
};

function money(value) {
  return value === null || value === undefined || value === "" ? null : `$${Number(value).toLocaleString()}`;
}

/** Read-only technical-detail drawer for one lease expense rule — the fields RuleTableRow no longer shows inline. */
export default function RuleDetailDrawer({ context, onOpenChange }) {
  const open = Boolean(context);
  const { rule, ruleSet, lease, property, camPolicyStatus } = context || {};

  const ruleId = rule?.id;
  const { data: auditEntries = [], isLoading: isLoadingAudit } = useQuery({
    queryKey: ["lease-expense-rule-audit", ruleId],
    enabled: open && UUID_RE.test(String(ruleId || "")),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_logs")
        .select("id, action, actor_email, created_at, metadata")
        .eq("entity_type", "lease_expense_rules")
        .eq("entity_id", ruleId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) return [];
      return data || [];
    },
  });

  if (!rule) return null;

  const view = getSimplifiedRuleView(rule);
  const contractStatus = getContractStatus(rule);
  const policyStatus = camPolicyStatus !== undefined ? camPolicyStatus : getPolicyStatus(rule, [], false);
  const model = view.model;
  const capText = [
    rule.cap_type ? humanizeToken(rule.cap_type) : null,
    rule.cap_percent != null ? `${rule.cap_percent}%` : null,
    money(rule.cap_amount ?? model.cap),
  ].filter(Boolean).join(" · ") || null;

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onOpenChange?.(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{rule.category_name || rule.expense_category || "Lease expense rule"}</SheetTitle>
          <SheetDescription>
            {lease?.tenant_name || "Unassigned lease"}{property?.name ? ` · ${property.name}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex flex-wrap gap-1.5">
          <Badge className={`text-[10px] ${TONE_CLASS[contractStatus.tone]}`}>{contractStatus.label}</Badge>
          <Badge className="text-[10px] bg-slate-100 text-slate-600">{view.treatmentLabel}</Badge>
          <Badge className="text-[10px] bg-slate-100 text-slate-600">CAM: {view.camLabel}</Badge>
          <Badge className="text-[10px] bg-slate-100 text-slate-600">Actual expense: {view.actualExpenseLabel}</Badge>
        </div>

        <div className="mt-6 space-y-4">
          <Section title="Responsibility &amp; billing">
            <Field label="Responsibility / cost bearer" value={humanizeToken(model.cost_bearer)} />
            <Field label="Vendor payment party" value={humanizeToken(model.vendor_payment_party)} />
            <Field label="Allocation method" value={humanizeToken(model.allocation_method)} />
            <Field label="Billing frequency" value={humanizeToken(model.billing_frequency)} />
          </Section>

          <Section title="Recovery terms">
            <Field label="Cap" value={capText} />
            <Field label="Share" value={model.share != null ? `${model.share}%` : rule.tenant_share_percent != null ? `${rule.tenant_share_percent}%` : null} />
            <Field label="Base year" value={model.base_year} />
            <Field label="Expense stop" value={money(model.expense_stop)} />
            <Field label="Admin fee" value={rule.admin_fee_percent != null ? `${rule.admin_fee_percent}%` : rule.admin_fee_applicable ? "Yes" : null} />
            <Field label="Gross-up" value={rule.gross_up_percent != null ? `${rule.gross_up_percent}%` : rule.gross_up_applicable ? "Yes" : null} />
            <Field label="Reconciliation required" value={rule.reconciliation_required ? "Yes" : "No"} />
          </Section>

          <Section title="Scope &amp; term">
            <Field label="Scope" value={humanizeToken(model.scope)} />
            <Field label="Effective start" value={model.effective_start_date} />
            <Field label="Effective end" value={model.effective_end_date || "Ongoing"} />
          </Section>

          <Section title="CAM policy">
            <Field label="Policy status" value={policyStatus ? (
              <span className="inline-flex flex-col gap-1">
                <Badge className={`text-[10px] w-fit ${TONE_CLASS[policyStatus.tone] || TONE_CLASS.slate}`}>{policyStatus.label}</Badge>
                {policyStatus.reason && <span className="text-xs text-slate-500">{policyStatus.reason}</span>}
              </span>
            ) : "Not yet evaluated"} />
            <Field label="Rule set version" value={ruleSet ? `v${ruleSet.version} · ${humanizeToken(ruleSet.status)}` : null} />
          </Section>

          <Section title="Evidence">
            <div className="col-span-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {rule.source_page ? `Page ${rule.source_page}` : "Source clause"}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm italic text-slate-700">
                {model.source_evidence || rule.exact_source_text || rule.source_text || "No clause text on file."}
              </p>
            </div>
          </Section>

          <Section title="Audit history">
            <div className="col-span-2">
              {isLoadingAudit ? (
                <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
              ) : auditEntries.length === 0 ? (
                <p className="text-sm text-slate-400">No audit entries recorded yet.</p>
              ) : (
                <ul className="space-y-2">
                  {auditEntries.map((entry) => (
                    <li key={entry.id} className="text-xs text-slate-600">
                      <span className="font-medium text-slate-800">{humanizeToken(entry.action)}</span>
                      {entry.actor_email ? ` by ${entry.actor_email}` : ""}
                      {" — "}
                      {entry.created_at ? new Date(entry.created_at).toLocaleString() : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
