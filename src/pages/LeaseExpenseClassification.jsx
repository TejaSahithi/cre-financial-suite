import React, { useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";
import { ExpenseService } from "@/services/api";
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import { expenseService } from "@/services/expenseService";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, Save, ArrowLeft, Wand2 } from "lucide-react";
import { toast } from "sonner";
import ExpenseClassificationTable from "@/components/ExpenseClassification/ExpenseClassificationTable";
import ExpenseValuePanel from "@/components/ExpenseClassification/ExpenseValuePanel";
import ClauseEvidenceDrawer from "@/components/ExpenseClassification/ClauseEvidenceDrawer";
import { createPageUrl } from "@/utils";

function getRuleForCategory(rules, categoryId) {
  return rules.find((rule) => rule.expense_category_id === categoryId) || null;
}

function categorizeCategory(category, rules) {
  const rule = getRuleForCategory(rules, category.id);
  if (!rule) return "needsReview";

  const recoveryStatus = leaseExpenseRuleService.normalizeRecoveryStatus(rule);
  if (recoveryStatus === "recoverable") return "recoverable";
  if (["non_recoverable", "excluded"].includes(recoveryStatus)) return "nonRecoverable";
  if (recoveryStatus === "conditional") return "conditional";
  return "needsReview";
}

export default function LeaseExpenseClassification() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [activeRuleSetId, setActiveRuleSetId] = useState(null);
  const [localRules, setLocalRules] = useState([]);
  const autoExtractedLeaseIds = useRef(new Set());

  // Filters State
  const [scopeType, setScopeType] = useState('property');
  const [frequency, setFrequency] = useState('yearly');

  // UI State
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [selectedRule, setSelectedRule] = useState(null);
  const [isEvidenceDrawerOpen, setIsEvidenceDrawerOpen] = useState(false);
  const [isValuePanelOpen, setIsValuePanelOpen] = useState(false);

  // Fetch Lease
  const { data: lease, isLoading: isLoadingLease } = useQuery({
    queryKey: ['lease', id],
    queryFn: async () => {
      const { data, error } = await supabase.from('leases').select('*').eq('id', id).single();
      if (error) throw error;
      return data;
    },
    enabled: !!id
  });

  // Fetch Taxonomies
  const { data: categories = [], isLoading: isLoadingCategories } = useQuery({
    queryKey: ['scope_expense_categories', scopeType, lease?.property_id, lease?.unit_id],
    queryFn: async () => {
      let scopeId = null;
      if (scopeType === 'property') scopeId = lease?.property_id;
      else if (scopeType === 'unit') scopeId = lease?.unit_id;

      if (scopeId) {
        const { data: scopeData, error: scopeErr } = await supabase
          .from('scope_expense_categories')
          .select('expense_category_id, is_applicable, expense_categories(*)')
          .eq('scope_type', scopeType)
          .eq('scope_id', scopeId)
          .eq('is_applicable', true);
        
        if (!scopeErr && scopeData && scopeData.length > 0) {
           return scopeData.map(s => s.expense_categories).filter(Boolean).sort((a,b) => a.display_order - b.display_order);
        }
      }

      // Fallback
      const { data, error } = await supabase.from('expense_categories')
        .select('*')
        .eq('is_active', true)
        .order('display_order', { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: !!lease
  });

  // Fetch Active Rule Set & Rules
  const { data: ruleSetData, isLoading: isLoadingRules } = useQuery({
    queryKey: ['lease_expense_rule_sets', id],
    queryFn: () => leaseExpenseRuleService.loadRuleSet(id),
    enabled: !!id,
  });

  const ruleSet = ruleSetData?.ruleSet;

  React.useEffect(() => {
    if (!ruleSetData) return;
    setActiveRuleSetId(ruleSetData.ruleSet?.id || null);
    setLocalRules(ruleSetData.rules || []);
  }, [ruleSetData]);

  // Mutation: Extract with AI
  const extractRulesMutation = useMutation({
    mutationFn: async ({ silent = false } = {}) => {
      const persisted = await leaseExpenseRuleService.extractDraftRuleSet({
        lease,
        categories,
        existingRuleSetId: activeRuleSetId,
        existingRules: localRules,
      });

      return { persisted, silent };
    },
    onSuccess: ({ persisted, silent }) => {
      setActiveRuleSetId(persisted?.ruleSet?.id || null);
      setLocalRules(persisted?.rules || []);
      queryClient.invalidateQueries(['lease_expense_rule_sets', id]);
      if (!silent) {
        toast.success("AI extraction complete. Please review the draft rules.");
      }
    },
    onError: (err) => {
      toast.error(`Extraction failed: ${err.message}`);
    }
  });

  // Mutation: Save / Approve
  const saveRuleSetMutation = useMutation({
    mutationFn: async (status) => {
      const persisted = await leaseExpenseRuleService.saveRuleSet({
        lease,
        rules: localRules,
        status,
        existingRuleSetId: activeRuleSetId,
        categories,
      });

      if (status === "approved") {
        await expenseService.syncLeaseDerivedExpenses({ leases: [lease] });
        const propertyExpenses = await ExpenseService.filter({ property_id: lease.property_id });
        await expenseService.classifyExpenses({ expenses: propertyExpenses, leases: [lease] });
      }

      return persisted;
    },
    onSuccess: (persisted) => {
      setActiveRuleSetId(persisted?.ruleSet?.id || null);
      setLocalRules(persisted?.rules || []);
      queryClient.invalidateQueries(['lease_expense_rule_sets', id]);
      queryClient.invalidateQueries({ queryKey: ["Expense"] });
      queryClient.invalidateQueries({ queryKey: ["Lease"] });
      toast.success("Expense rules saved successfully.");
    },
    onError: (err) => {
      toast.error(`Save failed: ${err.message}`);
    }
  });

  React.useEffect(() => {
    if (!lease?.id || categories.length === 0 || isLoadingRules) return;
    if (extractRulesMutation.isPending) return;
    if (autoExtractedLeaseIds.current.has(lease.id)) return;
    if ((localRules || []).length > 0) return;

    autoExtractedLeaseIds.current.add(lease.id);
    extractRulesMutation.mutate({ silent: true });
  }, [categories, extractRulesMutation, isLoadingRules, lease?.id, localRules]);

  const groupedCategories = useMemo(() => {
    return categories.reduce((groups, category) => {
      const key = categorizeCategory(category, localRules);
      groups[key].push(category);
      return groups;
    }, {
      recoverable: [],
      nonRecoverable: [],
      conditional: [],
      needsReview: [],
    });
  }, [categories, localRules]);

  const ruleGroups = useMemo(
    () => leaseExpenseRuleService.groupRulesByRecoveryStatus(localRules),
    [localRules]
  );

  const handleEditRule = (category, rule) => {
    setSelectedCategory(category);
    setSelectedRule(rule);
    setIsValuePanelOpen(true);
  };

  const handleViewEvidence = (category, rule) => {
    setSelectedCategory(category);
    setSelectedRule(rule);
    setIsEvidenceDrawerOpen(true);
  };

  const handleSaveRule = (updatedRule) => {
    setLocalRules(prev => {
      const existingIdx = prev.findIndex(r => r.expense_category_id === updatedRule.expense_category_id);
      if (existingIdx >= 0) {
        const newRules = [...prev];
        newRules[existingIdx] = updatedRule;
        return newRules;
      } else {
        return [...prev, updatedRule];
      }
    });
    setIsValuePanelOpen(false);
  };

  const isWorking = isLoadingLease || isLoadingCategories || isLoadingRules || extractRulesMutation.isPending || saveRuleSetMutation.isPending;

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <Button variant="ghost" onClick={() => navigate(-1)} className="mb-2">
        <ArrowLeft className="w-4 h-4 mr-2" /> Back
      </Button>

      <PageHeader
        icon={FileText}
        title="Expense Classification"
        subtitle={lease ? `Reviewing CAM & Expense Rules for: ${lease.tenant_name || 'Lease'}` : 'Loading...'}
        iconColor="from-blue-600 to-indigo-600"
      >
        <div className="flex gap-2">
          <select 
            className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm"
            value={scopeType}
            onChange={e => setScopeType(e.target.value)}
          >
            <option value="property">Property Scope</option>
            <option value="building">Building Scope</option>
            <option value="unit">Unit Scope</option>
          </select>
          <select 
            className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm"
            value={frequency}
            onChange={e => setFrequency(e.target.value)}
          >
            <option value="yearly">Yearly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
          </select>
          
          <Button variant="outline" onClick={() => toast.info("Add Expense Modal (Placeholder)")} disabled={isWorking}>
            Add Expense
          </Button>
          <Button variant="outline" onClick={() => toast.info("Bulk Import Modal (Placeholder)")} disabled={isWorking}>
            Bulk Import
          </Button>
          
          <Button
            variant="outline"
            onClick={() => extractRulesMutation.mutate({ silent: false })}
            disabled={isWorking}
          >
            <Wand2 className="w-4 h-4 mr-2 text-purple-600" />
            {extractRulesMutation.isPending ? 'Extracting...' : 'Extract with AI'}
          </Button>
          <Button
            variant="outline"
            onClick={() => saveRuleSetMutation.mutate('draft')}
            disabled={isWorking}
          >
            <Save className="w-4 h-4 mr-2" />
            Save Draft
          </Button>
          <Button
            className="bg-blue-600 hover:bg-blue-700"
            onClick={() => saveRuleSetMutation.mutate('approved')}
            disabled={isWorking}
          >
            Approve Rule Set
          </Button>
          <Button
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={() => navigate(`/LeaseReview?id=${id}`)}
            disabled={isWorking}
          >
            Back to Lease Review
          </Button>
        </div>
      </PageHeader>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="border-emerald-200 bg-emerald-50/70">
          <CardContent className="p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-600">Recoverable</div>
            <div className="mt-2 text-2xl font-bold text-emerald-800">{ruleGroups.recoverable.length}</div>
            <div className="mt-1 text-xs text-emerald-700">Lease rules that can flow into CAM recovery.</div>
          </CardContent>
        </Card>
        <Card className="border-rose-200 bg-rose-50/70">
          <CardContent className="p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-rose-600">Non-Recoverable</div>
            <div className="mt-2 text-2xl font-bold text-rose-800">{ruleGroups.nonRecoverable.length}</div>
            <div className="mt-1 text-xs text-rose-700">Explicit exclusions and landlord-borne costs.</div>
          </CardContent>
        </Card>
        <Card className="border-amber-200 bg-amber-50/80">
          <CardContent className="p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700">Conditional</div>
            <div className="mt-2 text-2xl font-bold text-amber-900">{ruleGroups.conditional.length}</div>
            <div className="mt-1 text-xs text-amber-700">Rules with caps, base years, or conditional recovery logic.</div>
          </CardContent>
        </Card>
        <Card className="border-slate-200 bg-slate-50/80">
          <CardContent className="p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Needs Review</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">{ruleGroups.needsReview.length}</div>
            <div className="mt-1 text-xs text-slate-600">Still missing values, evidence, or final yes/no decisions.</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Main Grid Area */}
        <div className="md:col-span-3 space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Expense Classification Grid</CardTitle>
                <p className="text-sm text-slate-500 mt-1">
                  Map lease clauses to standard expense categories. Edit recovery rules, caps, and base years.
                </p>
              </div>
              {ruleSet && (
                <Badge variant={ruleSet.status === 'approved' ? 'default' : 'secondary'} className="text-sm">
                  Status: {ruleSet.status.toUpperCase()}
                </Badge>
              )}
            </CardHeader>
            <CardContent>
              {isLoadingCategories ? (
                <div className="py-8 text-center text-slate-500">Loading taxonomy...</div>
              ) : (
                <div className="space-y-6">
                  <RuleGroupSection
                    title="Recoverable Rules"
                    description="These lease clauses allow the expense to be recovered from the tenant."
                    categories={groupedCategories.recoverable}
                    rules={localRules}
                    tone="emerald"
                    frequency={frequency}
                    onEditRule={handleEditRule}
                    onViewEvidence={handleViewEvidence}
                  />
                  <RuleGroupSection
                    title="Non-Recoverable Rules"
                    description="These costs stay with ownership or are explicitly excluded."
                    categories={groupedCategories.nonRecoverable}
                    rules={localRules}
                    tone="rose"
                    frequency={frequency}
                    onEditRule={handleEditRule}
                    onViewEvidence={handleViewEvidence}
                  />
                  <RuleGroupSection
                    title="Conditional Rules"
                    description="These clauses depend on caps, base years, gross-up logic, or other conditions."
                    categories={groupedCategories.conditional}
                    rules={localRules}
                    tone="amber"
                    frequency={frequency}
                    onEditRule={handleEditRule}
                    onViewEvidence={handleViewEvidence}
                  />
                  <RuleGroupSection
                    title="Needs Review / Unmapped"
                    description="Finish the yes/no mapping or add the value manually when the lease mentions the item but no numeric amount was found."
                    categories={groupedCategories.needsReview}
                    rules={localRules}
                    tone="slate"
                    frequency={frequency}
                    onEditRule={handleEditRule}
                    onViewEvidence={handleViewEvidence}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar Area */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Impact Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="p-4 bg-slate-50 rounded-lg border border-slate-100 space-y-4">
                <p className="text-sm text-slate-500 text-center mb-2">
                  Preview based on the current drafted rules.
                </p>

                <div className="flex justify-between items-center border-b pb-2">
                  <span className="text-sm font-medium text-slate-700">Categories Mapped</span>
                  <span className="font-bold text-slate-900">
                    {localRules.filter(r => r.row_status === 'mapped').length} / {categories.length}
                  </span>
                </div>

                <div className="flex justify-between items-center border-b pb-2">
                  <span className="text-sm font-medium text-slate-700">Explicitly Excluded</span>
                  <span className="font-bold text-rose-600">
                    {localRules.filter(r => r.is_excluded || r.is_recoverable === false).length}
                  </span>
                </div>

                <div className="flex justify-between items-center border-b pb-2">
                  <span className="text-sm font-medium text-slate-700">Subject to Cap</span>
                  <span className="font-bold text-blue-600">
                    {localRules.filter(r => r.is_subject_to_cap).length}
                  </span>
                </div>

                <div className="flex justify-between items-center pb-2">
                  <span className="text-sm font-medium text-slate-700">Needs Review</span>
                  <span className="font-bold text-amber-600">
                    {localRules.filter(r => r.row_status === 'uncertain').length}
                  </span>
                </div>
              </div>

              <div className="mt-4 p-3 bg-blue-50 border border-blue-100 rounded-md text-sm text-blue-800">
                Approving this rule set updates lease CAM config, persists clause evidence and values, creates explicit lease-derived charge rows when amounts exist, and refreshes expense classification readiness.
              </div>
              <Button
                className="mt-4 w-full bg-slate-900 hover:bg-slate-800"
                onClick={() =>
                  navigate(
                    createPageUrl("ExpenseReview", {
                      property: lease?.property_id,
                      building: lease?.building_id,
                      unit: lease?.unit_id,
                    })
                  )
                }
              >
                Continue to Expense Review
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <ClauseEvidenceDrawer
        isOpen={isEvidenceDrawerOpen}
        onClose={() => setIsEvidenceDrawerOpen(false)}
        category={selectedCategory}
        rule={selectedRule}
      />

      <ExpenseValuePanel
        isOpen={isValuePanelOpen}
        onClose={() => setIsValuePanelOpen(false)}
        category={selectedCategory}
        rule={selectedRule}
        onSave={handleSaveRule}
      />

    </div>
  );
}

function RuleGroupSection({
  title,
  description,
  categories,
  rules,
  tone,
  onEditRule,
  onViewEvidence,
}) {
  const toneClasses = {
    emerald: "border-emerald-200 bg-emerald-50/40",
    rose: "border-rose-200 bg-rose-50/40",
    amber: "border-amber-200 bg-amber-50/40",
    slate: "border-slate-200 bg-slate-50/70",
  };

  return (
    <div className={`rounded-xl border p-4 ${toneClasses[tone] || toneClasses.slate}`}>
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <p className="mt-1 text-xs text-slate-600">{description}</p>
      </div>
      {categories.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-white/80 px-4 py-6 text-center text-xs text-slate-500">
          No categories are in this bucket yet.
        </div>
      ) : (
        <ExpenseClassificationTable
          categories={categories}
          rules={rules}
          onEditRule={onEditRule}
          onViewEvidence={onViewEvidence}
        />
      )}
    </div>
  );
}
