import React, { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, Save, ArrowLeft, Wand2 } from "lucide-react";
import { toast } from "sonner";
import ExpenseClassificationTable from "@/components/ExpenseClassification/ExpenseClassificationTable";
import ExpenseValuePanel from "@/components/ExpenseClassification/ExpenseValuePanel";
import ClauseEvidenceDrawer from "@/components/ExpenseClassification/ClauseEvidenceDrawer";

export default function LeaseExpenseClassification() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [activeRuleSetId, setActiveRuleSetId] = useState(null);
  const [localRules, setLocalRules] = useState([]);

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
    queryFn: async () => {
      // Find the most recent active rule set (draft or approved)
      const { data: ruleSets, error: rsError } = await supabase
        .from('lease_expense_rule_sets')
        .select('*')
        .eq('lease_id', id)
        .not('status', 'eq', 'archived')
        .order('version', { ascending: false })
        .limit(1);

      if (rsError) throw rsError;

      const activeSet = ruleSets?.[0];
      if (!activeSet) return { ruleSet: null, rules: [] };

      const { data: rules, error: rError } = await supabase
        .from('lease_expense_rules')
        .select('*')
        .eq('rule_set_id', activeSet.id);

      if (rError) throw rError;

      return { ruleSet: activeSet, rules: rules || [] };
    },
    enabled: !!id,
    onSuccess: (data) => {
      if (data?.ruleSet) {
        setActiveRuleSetId(data.ruleSet.id);
        setLocalRules(data.rules || []);
      }
    }
  });

  const ruleSet = ruleSetData?.ruleSet;

  // Mutation: Extract with AI
  const extractRulesMutation = useMutation({
    mutationFn: async () => {
      // Find lease's uploaded file (simplification: find first document_link for this lease)
      const { data: docs } = await supabase
        .from('document_links')
        .select('file_id, uploaded_files(normalized_output)')
        .eq('entity_id', id)
        .eq('entity_type', 'lease')
        .limit(1);

      const file = docs?.[0]?.uploaded_files;
      if (!file || !file.normalized_output?.raw_text) {
        throw new Error("No extracted lease text found to analyze.");
      }

      const { data, error } = await supabase.functions.invoke("extract-lease-expense-rules", {
        body: {
          lease_id: id,
          source_text: file.normalized_output.raw_text,
          categories: categories.map(c => ({ id: c.id, category_name: c.category_name, subcategory_name: c.subcategory_name }))
        }
      });

      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      if (data?.rules) {
        // Merge AI rules into local state
        const aiRules = data.rules.map(ai => {
          const cat = categories.find(c => c.category_name === ai.category_name);
          if (!cat) return null;
          return {
            ...ai,
            expense_category_id: cat.id,
            rule_set_id: activeRuleSetId // Might be null if creating a new set
          };
        }).filter(Boolean);

        setLocalRules(aiRules);
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
      let currentRuleSetId = activeRuleSetId;

      // If approving, we might want to archive the old one and create a new version.
      // For MVP, we just upsert the current rule set with the new status.
      if (!currentRuleSetId) {
        const { data: newRs, error: newRsError } = await supabase
          .from('lease_expense_rule_sets')
          .insert({ lease_id: id, org_id: lease.org_id, status: status, version: 1 })
          .select()
          .single();
        if (newRsError) throw newRsError;
        currentRuleSetId = newRs.id;
      } else {
        const { error: updError } = await supabase
          .from('lease_expense_rule_sets')
          .update({ status })
          .eq('id', currentRuleSetId);
        if (updError) throw updError;
      }

      // Upsert rules
      const rulesToUpsert = localRules.map(r => {
        const { id: ruleId, ...rest } = r;
        return {
          ...rest,
          id: ruleId && !String(ruleId).startsWith('temp-') ? ruleId : undefined,
          rule_set_id: currentRuleSetId,
        };
      });

      if (rulesToUpsert.length > 0) {
        const { error: rulesErr } = await supabase
          .from('lease_expense_rules')
          .upsert(rulesToUpsert, { onConflict: 'id' });
        if (rulesErr) throw rulesErr;
      }

      return currentRuleSetId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['lease_expense_rule_sets', id]);
      toast.success("Expense rules saved successfully.");
    },
    onError: (err) => {
      toast.error(`Save failed: ${err.message}`);
    }
  });

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
            onClick={() => extractRulesMutation.mutate()}
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
            onClick={() => navigate('/cam-calculation')}
            disabled={isWorking}
          >
            Move to CAM
          </Button>
        </div>
      </PageHeader>

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
                <ExpenseClassificationTable
                  categories={categories}
                  rules={localRules}
                  frequency={frequency}
                  onEditRule={handleEditRule}
                  onViewEvidence={handleViewEvidence}
                />
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
                Approving this rule set will update the ledger configurations and impact future CAM calculations for this lease.
              </div>
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
