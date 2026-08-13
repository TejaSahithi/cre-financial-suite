import React from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

import {
  PAYMENT_TREATMENT_OPTIONS,
  TRI_STATE_OPTIONS,
  RECOVERY_METHOD_OPTIONS,
  ALLOCATION_OPTIONS,
  INDEX_ADJUSTMENT_TYPE_OPTIONS,
  INDEX_ADJUSTMENT_FREQUENCY_OPTIONS,
  humanizeToken,
  getSourcePage,
  getExactSourceText,
} from "./utils/leaseExpenseRulesHelpers";

export default function EditRuleModal({
  context,
  form,
  setForm,
  isSaving,
  onClose,
  onSave,
}) {
  return (
    <Dialog open={!!context} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Rule Details</DialogTitle>
          <DialogDescription>
            Update the selected lease expense rule in place. This edits the specific row you clicked from the action menu.
          </DialogDescription>
        </DialogHeader>

        {context?.rule && form ? (
          <div className="space-y-5">
            <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm md:grid-cols-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tenant / Lease</p>
                <p className="mt-1 font-medium text-slate-900">{context.lease?.tenant_name || context.lease?.id || "-"}</p>
                <p className="text-xs text-slate-500">Rule set v{context.ruleSet?.version || "-"}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Property</p>
                <p className="mt-1 font-medium text-slate-900">{context.property?.name || "-"}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Review Status</p>
                <p className="mt-1 font-medium text-slate-900">{humanizeToken(context.rule.review_status || context.rule.row_status || "-")}</p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Category</Label>
                <Input
                  value={form.category_name}
                  onChange={(event) => setForm((current) => ({ ...current, category_name: event.target.value }))}
                  placeholder="Normalized category"
                />
              </div>
              <div className="space-y-2">
                <Label>Subcategory</Label>
                <Input
                  value={form.expense_subcategory}
                  onChange={(event) => setForm((current) => ({ ...current, expense_subcategory: event.target.value }))}
                  placeholder="Normalized subcategory"
                />
              </div>
              <div className="space-y-2">
                <Label>Included In Rent</Label>
                <Select value={form.included_in_base_rent} onValueChange={(value) => setForm((current) => ({ ...current, included_in_base_rent: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">Yes</SelectItem>
                    <SelectItem value="no">No</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Responsibility</Label>
                <Input
                  value={form.responsibility}
                  onChange={(event) => setForm((current) => ({ ...current, responsibility: event.target.value }))}
                  placeholder="Operational responsibility"
                />
              </div>
              <div className="space-y-2">
                <Label>Payment Treatment</Label>
                <Select value={form.payment_treatment} onValueChange={(value) => setForm((current) => ({ ...current, payment_treatment: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAYMENT_TREATMENT_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{humanizeToken(option)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Recoverable From Tenant</Label>
                <Select value={form.recoverable_from_tenant} onValueChange={(value) => setForm((current) => ({ ...current, recoverable_from_tenant: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TRI_STATE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{humanizeToken(option)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>CAM Eligible</Label>
                <Select value={form.cam_eligible} onValueChange={(value) => setForm((current) => ({ ...current, cam_eligible: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TRI_STATE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{humanizeToken(option)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Recovery Method</Label>
                <Select value={form.recovery_method} onValueChange={(value) => setForm((current) => ({ ...current, recovery_method: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {RECOVERY_METHOD_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{humanizeToken(option)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Allocation Basis</Label>
                <Select value={form.allocation_basis} onValueChange={(value) => setForm((current) => ({ ...current, allocation_basis: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ALLOCATION_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{humanizeToken(option)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Cap Type</Label>
                <Input
                  value={form.cap_type}
                  onChange={(event) => setForm((current) => ({ ...current, cap_type: event.target.value }))}
                  placeholder="Percent, amount, fixed..."
                />
              </div>
              <div className="space-y-2">
                <Label>Cap Percent</Label>
                <Input
                  type="number"
                  value={form.cap_percent}
                  onChange={(event) => setForm((current) => ({ ...current, cap_percent: event.target.value }))}
                  placeholder="0"
                />
              </div>
              <div className="space-y-2">
                <Label>Cap Amount</Label>
                <Input
                  type="number"
                  value={form.cap_amount}
                  onChange={(event) => setForm((current) => ({ ...current, cap_amount: event.target.value }))}
                  placeholder="0"
                />
              </div>
              <div className="space-y-2">
                <Label>Admin Fee Applies</Label>
                <Select value={form.admin_fee_applicable} onValueChange={(value) => setForm((current) => ({ ...current, admin_fee_applicable: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">Yes</SelectItem>
                    <SelectItem value="no">No</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Admin Fee Percent</Label>
                <Input
                  type="number"
                  value={form.admin_fee_percent}
                  onChange={(event) => setForm((current) => ({ ...current, admin_fee_percent: event.target.value }))}
                  placeholder="0"
                />
              </div>
              <div className="space-y-2">
                <Label>Gross-Up Applies</Label>
                <Select value={form.gross_up_applicable} onValueChange={(value) => setForm((current) => ({ ...current, gross_up_applicable: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">Yes</SelectItem>
                    <SelectItem value="no">No</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Gross-Up Percent</Label>
                <Input
                  type="number"
                  value={form.gross_up_percent}
                  onChange={(event) => setForm((current) => ({ ...current, gross_up_percent: event.target.value }))}
                  placeholder="0"
                />
              </div>
              <div className="space-y-2">
                <Label>Reconciliation Required</Label>
                <Select value={form.reconciliation_required} onValueChange={(value) => setForm((current) => ({ ...current, reconciliation_required: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">Yes</SelectItem>
                    <SelectItem value="no">No</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>CPI / Index Adjustment Applies</Label>
                <Select value={form.index_adjustment_applicable} onValueChange={(value) => setForm((current) => ({ ...current, index_adjustment_applicable: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">Yes</SelectItem>
                    <SelectItem value="no">No</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Adjustment Type</Label>
                <Select value={form.index_adjustment_type} onValueChange={(value) => setForm((current) => ({ ...current, index_adjustment_type: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {INDEX_ADJUSTMENT_TYPE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{humanizeToken(option)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Index Name</Label>
                <Input
                  value={form.index_name}
                  onChange={(event) => setForm((current) => ({ ...current, index_name: event.target.value }))}
                  placeholder="Published index name"
                />
              </div>
              <div className="space-y-2">
                <Label>Adjustment Frequency</Label>
                <Select value={form.index_adjustment_frequency} onValueChange={(value) => setForm((current) => ({ ...current, index_adjustment_frequency: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {INDEX_ADJUSTMENT_FREQUENCY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{humanizeToken(option)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Base Index Period</Label>
                <Input
                  value={form.index_base_period}
                  onChange={(event) => setForm((current) => ({ ...current, index_base_period: event.target.value }))}
                  placeholder="Base month or period"
                />
              </div>
              <div className="space-y-2">
                <Label>Current Index Period</Label>
                <Input
                  value={form.index_current_period}
                  onChange={(event) => setForm((current) => ({ ...current, index_current_period: event.target.value }))}
                  placeholder="Comparison month or period"
                />
              </div>
              <div className="space-y-2">
                <Label>Adjustment Percent</Label>
                <Input
                  type="number"
                  value={form.index_adjustment_percent}
                  onChange={(event) => setForm((current) => ({ ...current, index_adjustment_percent: event.target.value }))}
                  placeholder="Reviewed or assumed percent"
                />
              </div>
              <div className="space-y-2">
                <Label>Index Floor Percent</Label>
                <Input
                  type="number"
                  value={form.index_floor_percent}
                  onChange={(event) => setForm((current) => ({ ...current, index_floor_percent: event.target.value }))}
                  placeholder="Minimum adjustment"
                />
              </div>
              <div className="space-y-2">
                <Label>Index Cap Percent</Label>
                <Input
                  type="number"
                  value={form.index_cap_percent}
                  onChange={(event) => setForm((current) => ({ ...current, index_cap_percent: event.target.value }))}
                  placeholder="Maximum adjustment"
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Index Source / Assumption</Label>
                <Input
                  value={form.index_source}
                  onChange={(event) => setForm((current) => ({ ...current, index_source: event.target.value }))}
                  placeholder="Source for index values or approved assumption"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Source Evidence</Label>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <p><span className="font-medium text-slate-900">Source page:</span> {(() => {
                  const sp = getSourcePage(context.rule);
                  return sp != null && sp !== "" && Number(sp) > 0 ? `p. ${Number(sp)}` : "â€”";
                })()}</p>
                <p className="mt-2"><span className="font-medium text-slate-900">Exact source text:</span> {getExactSourceText(context.rule) || "-"}</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={form.notes}
                onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                placeholder="Add rule notes or override context..."
                rows={4}
              />
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={isSaving || !form} className="bg-blue-600 hover:bg-blue-700">
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
