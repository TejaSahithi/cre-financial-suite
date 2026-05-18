import React from "react";
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
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export default function ExpenseValuePanel({ isOpen, onClose, category, rule, onSave }) {
  const [formData, setFormData] = React.useState({});

  React.useEffect(() => {
    if (rule) {
      setFormData({
        row_status: rule.row_status === 'uncertain' ? 'mapped' : rule.row_status || 'mapped',
        review_status: rule.review_status || 'needs_review',
        approval_status: rule.approval_status || 'draft',
        operational_responsibility: rule.operational_responsibility || rule.responsibility || 'unknown',
        payment_treatment: rule.payment_treatment || 'not_applicable',
        recoverable_from_tenant: rule.recoverable_from_tenant || (rule.is_recoverable ? 'yes' : 'no'),
        cam_eligible: rule.cam_eligible || 'conditional',
        billing_treatment: rule.billing_treatment || 'none',
        included_in_base_rent: Boolean(rule.included_in_base_rent),
        is_recoverable: rule.is_recoverable || false,
        is_excluded: rule.is_excluded || false,
        is_controllable: rule.is_controllable || false,
        is_subject_to_cap: rule.is_subject_to_cap || false,
        cap_type: rule.cap_type || '',
        cap_value: rule.cap_value || '',
        has_base_year: rule.has_base_year || false,
        base_year_type: rule.base_year_type || '',
        gross_up_applicable: rule.gross_up_applicable || false,
        admin_fee_applicable: rule.admin_fee_applicable || false,
        admin_fee_percent: rule.admin_fee_percent || '',
        extracted_value: rule.extracted_value || '',
        manual_value: rule.manual_value || '',
        final_value: rule.final_value || '',
        frequency: rule.frequency || 'yearly',
        base_year_amount: rule.base_year_amount || '',
        notes: rule.notes || '',
      });
    }
  }, [rule]);

  if (!category) return null;

  const handleChange = (key, value) => {
    setFormData(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    const recoverableDecision = formData.recoverable_from_tenant || "no";
    onSave({
      ...rule,
      ...formData,
      responsibility: formData.operational_responsibility || rule?.responsibility,
      included_in_base_rent: Boolean(formData.included_in_base_rent || formData.payment_treatment === "included_in_base_rent"),
      is_recoverable: ["yes", "conditional"].includes(recoverableDecision),
      approval_status: formData.review_status === "approved" ? "approved" : formData.approval_status,
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Mapping: {category.category_name}</DialogTitle>
          <DialogDescription>
            Override the extracted rule parameters or manually map this expense.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4 py-4">
          <div className="col-span-2 flex items-center justify-between p-3 bg-slate-50 border rounded-md">
            <Label className="font-semibold text-slate-700">Mapping Status</Label>
            <Select 
              value={formData.row_status} 
              onValueChange={(val) => handleChange('row_status', val)}
            >
              <SelectTrigger className="w-[180px] bg-white">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mapped">Mapped</SelectItem>
                <SelectItem value="unmapped">Unmapped</SelectItem>
                <SelectItem value="not_mentioned">Not Mentioned</SelectItem>
                <SelectItem value="uncertain">Review Needed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="col-span-2 grid grid-cols-2 gap-4 border p-4 rounded-md bg-slate-50/50">
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">Operational Responsibility</Label>
              <Select value={formData.operational_responsibility || 'unknown'} onValueChange={(val) => handleChange('operational_responsibility', val)}>
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder="Select responsibility..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="landlord">Landlord</SelectItem>
                  <SelectItem value="tenant">Tenant</SelectItem>
                  <SelectItem value="shared">Shared</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">Payment Treatment</Label>
              <Select value={formData.payment_treatment || 'not_applicable'} onValueChange={(val) => handleChange('payment_treatment', val)}>
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder="Select payment treatment..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="included_in_base_rent">Included in Base Rent</SelectItem>
                  <SelectItem value="separately_billed">Separately Billed</SelectItem>
                  <SelectItem value="tenant_direct_contract">Tenant Direct Contract</SelectItem>
                  <SelectItem value="reimbursable">Reimbursable</SelectItem>
                  <SelectItem value="not_applicable">Not Applicable</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">Recoverable From Tenant</Label>
              <Select value={formData.recoverable_from_tenant || 'no'} onValueChange={(val) => handleChange('recoverable_from_tenant', val)}>
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder="Select recoverability..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="yes">Yes</SelectItem>
                  <SelectItem value="no">No</SelectItem>
                  <SelectItem value="conditional">Conditional</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">CAM Eligible</Label>
              <Select value={formData.cam_eligible || 'conditional'} onValueChange={(val) => handleChange('cam_eligible', val)}>
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder="Select CAM eligibility..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="yes">Yes</SelectItem>
                  <SelectItem value="no">No</SelectItem>
                  <SelectItem value="conditional">Conditional</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">Billing Treatment</Label>
              <Select value={formData.billing_treatment || 'none'} onValueChange={(val) => handleChange('billing_treatment', val)}>
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder="Select billing treatment..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="included">Included</SelectItem>
                  <SelectItem value="direct_bill">Direct Bill</SelectItem>
                  <SelectItem value="cam_estimate">CAM Estimate</SelectItem>
                  <SelectItem value="reconciliation">Reconciliation</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">Review Status</Label>
              <Select value={formData.review_status || 'needs_review'} onValueChange={(val) => handleChange('review_status', val)}>
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder="Select review status..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="needs_review">Needs Review</SelectItem>
                  <SelectItem value="not_found">Not Found</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center space-x-2 border p-3 rounded-md">
            <Switch 
              id="is_recoverable" 
              checked={formData.is_recoverable} 
              onCheckedChange={(val) => handleChange('is_recoverable', val)} 
            />
            <Label htmlFor="is_recoverable" className="flex-1 cursor-pointer">Is Recoverable?</Label>
          </div>

          <div className="flex items-center space-x-2 border p-3 rounded-md">
            <Switch 
              id="is_excluded" 
              checked={formData.is_excluded} 
              onCheckedChange={(val) => handleChange('is_excluded', val)} 
            />
            <Label htmlFor="is_excluded" className="flex-1 cursor-pointer">Explicitly Excluded?</Label>
          </div>

          <div className="flex items-center space-x-2 border p-3 rounded-md">
            <Switch 
              id="is_controllable" 
              checked={formData.is_controllable} 
              onCheckedChange={(val) => handleChange('is_controllable', val)} 
            />
            <Label htmlFor="is_controllable" className="flex-1 cursor-pointer">Is Controllable?</Label>
          </div>

           <div className="flex items-center space-x-2 border p-3 rounded-md">
            <Switch 
              id="gross_up_applicable" 
              checked={formData.gross_up_applicable} 
              onCheckedChange={(val) => handleChange('gross_up_applicable', val)} 
            />
            <Label htmlFor="gross_up_applicable" className="flex-1 cursor-pointer">Gross Up Applicable?</Label>
          </div>

          <div className="col-span-2 space-y-4 border p-4 rounded-md bg-slate-50/50">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-xs text-slate-500">Extracted Value</Label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={formData.extracted_value}
                  onChange={(e) => handleChange('extracted_value', e.target.value)}
                  className="bg-white"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-slate-500">Manual Override Value</Label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={formData.manual_value}
                  onChange={(e) => {
                    handleChange('manual_value', e.target.value);
                    handleChange('final_value', e.target.value);
                  }}
                  className="bg-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-xs text-slate-500">Final Value Used</Label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={formData.final_value}
                  onChange={(e) => handleChange('final_value', e.target.value)}
                  className="bg-white"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-slate-500">Frequency</Label>
                <Select
                  value={formData.frequency || 'yearly'}
                  onValueChange={(val) => handleChange('frequency', val)}
                >
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder="Select frequency..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center space-x-2 mb-2">
              <Switch 
                id="is_subject_to_cap" 
                checked={formData.is_subject_to_cap} 
                onCheckedChange={(val) => handleChange('is_subject_to_cap', val)} 
              />
              <Label htmlFor="is_subject_to_cap" className="font-medium cursor-pointer">Subject to Cap?</Label>
            </div>
            
            {formData.is_subject_to_cap && (
              <div className="grid grid-cols-2 gap-4 pl-10">
                <div className="space-y-1">
                  <Label className="text-xs text-slate-500">Cap Type</Label>
                  <Select 
                    value={formData.cap_type || ''} 
                    onValueChange={(val) => handleChange('cap_type', val)}
                  >
                    <SelectTrigger className="bg-white">
                      <SelectValue placeholder="Select type..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cumulative">Cumulative %</SelectItem>
                      <SelectItem value="non_cumulative">Non-Cumulative %</SelectItem>
                      <SelectItem value="fixed">Fixed Amount</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-slate-500">Cap Value</Label>
                  <Input 
                    type="number" 
                    placeholder="e.g. 5" 
                    value={formData.cap_value}
                    onChange={(e) => handleChange('cap_value', e.target.value)}
                    className="bg-white"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="col-span-2 space-y-4 border p-4 rounded-md bg-slate-50/50">
            <div className="flex items-center space-x-2 mb-2">
              <Switch 
                id="has_base_year" 
                checked={formData.has_base_year} 
                onCheckedChange={(val) => handleChange('has_base_year', val)} 
              />
              <Label htmlFor="has_base_year" className="font-medium cursor-pointer">Has Base Year?</Label>
            </div>
            
            {formData.has_base_year && (
              <div className="grid grid-cols-2 gap-4 pl-10">
                <div className="space-y-1 col-span-2">
                  <Label className="text-xs text-slate-500">Base Year Type</Label>
                  <Select 
                    value={formData.base_year_type || ''} 
                    onValueChange={(val) => handleChange('base_year_type', val)}
                  >
                    <SelectTrigger className="bg-white">
                      <SelectValue placeholder="Select type..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="calendar">Calendar Year</SelectItem>
                      <SelectItem value="fiscal">Fiscal Year</SelectItem>
                      <SelectItem value="expense">Expense Specific Year</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 col-span-2">
                  <Label className="text-xs text-slate-500">Base Year Amount</Label>
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={formData.base_year_amount}
                    onChange={(e) => handleChange('base_year_amount', e.target.value)}
                    className="bg-white"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="col-span-2 space-y-2">
            <Label>Notes / Override Reason</Label>
            <Textarea 
              placeholder="Add your own notes here..." 
              value={formData.notes}
              onChange={(e) => handleChange('notes', e.target.value)}
            />
          </div>

        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave}>Save Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
