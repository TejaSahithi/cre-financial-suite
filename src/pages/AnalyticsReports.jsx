import React, { useEffect } from "react";
import { PropertyService, LeaseService, ExpenseService } from "@/services/api";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart3, Target, LineChart, AlertCircle } from "lucide-react";
import OverviewTab from "@/components/analytics/OverviewTab";
import InsightsTab from "@/components/analytics/InsightsTab";
import AdvancedAnalyticsTab from "@/components/analytics/AdvancedAnalyticsTab";

export default function AnalyticsReports() {
  const { data: properties = [], error: propError, isLoading: propLoading } = useQuery({ queryKey: ['properties'], queryFn: () => PropertyService.list() });
  const { data: leases = [], error: leaseError, isLoading: leaseLoading } = useQuery({ queryKey: ['leases'], queryFn: () => LeaseService.list() });
  const { data: expenses = [], error: expenseError, isLoading: expenseLoading } = useQuery({ queryKey: ['expenses'], queryFn: () => ExpenseService.list() });
  const { data: camCalcs = [] } = useQuery({
    queryKey: ["cam-reports-runs"],
    queryFn: async () => {
      const { data, error } = await supabase.from("cam_runs").select("*, cam_run_lease_results(*)");
      if (error) return [];
      return data ?? [];
    },
  });

  const isLoading = propLoading || leaseLoading || expenseLoading || camLoading;
  const queryError = propError || leaseError || expenseError || camError;

  useEffect(() => {
    if (queryError) {
      toast.error("Failed to load analytics data. Please refresh the page.");
    }
  }, [queryError]);

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div>
        <h1 className="text-[28px] font-bold text-slate-900">Analytics & Reports</h1>
        <p className="text-sm text-slate-500">Financial performance metrics, portfolio insights, and advanced analytics</p>
      </div>

      {queryError && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>Some data failed to load. Charts may be incomplete. Try refreshing the page.</span>
        </div>
      )}

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview" className="gap-1.5"><BarChart3 className="w-3.5 h-3.5" />Overview & Reports</TabsTrigger>
          <TabsTrigger value="insights" className="gap-1.5"><Target className="w-3.5 h-3.5" />Portfolio Insights</TabsTrigger>
          <TabsTrigger value="analytics" className="gap-1.5"><LineChart className="w-3.5 h-3.5" />Advanced Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab properties={properties} leases={leases} expenses={expenses} isLoading={isLoading} />
        </TabsContent>
        <TabsContent value="insights">
          <InsightsTab properties={properties} leases={leases} expenses={expenses} camCalcs={camCalcs} isLoading={isLoading} />
        </TabsContent>
        <TabsContent value="analytics">
          <AdvancedAnalyticsTab properties={properties} leases={leases} expenses={expenses} camCalcs={camCalcs} isLoading={isLoading} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
