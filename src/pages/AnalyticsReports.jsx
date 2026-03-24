import React from "react";
import { CAMCalculationService, PropertyService, LeaseService, ExpenseService } from "@/services/api";
import { useQuery } from "@tanstack/react-query";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart3, Target, LineChart } from "lucide-react";
import OverviewTab from "@/components/analytics/OverviewTab";
import InsightsTab from "@/components/analytics/InsightsTab";
import AdvancedAnalyticsTab from "@/components/analytics/AdvancedAnalyticsTab";

export default function AnalyticsReports() {
  const { data: properties = [] } = useQuery({ queryKey: ['properties'], queryFn: () => PropertyService.list() });
  const { data: leases = [] } = useQuery({ queryKey: ['leases'], queryFn: () => LeaseService.list() });
  const { data: expenses = [] } = useQuery({ queryKey: ['expenses'], queryFn: () => ExpenseService.list() });
  const { data: camCalcs = [] } = useQuery({ queryKey: ['cam-calcs'], queryFn: () => CAMCalculationService.list() });

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Analytics & Reports</h1>
        <p className="text-sm text-slate-500">Financial performance metrics, portfolio insights, and advanced analytics</p>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview" className="gap-1.5"><BarChart3 className="w-3.5 h-3.5" />Overview & Reports</TabsTrigger>
          <TabsTrigger value="insights" className="gap-1.5"><Target className="w-3.5 h-3.5" />Portfolio Insights</TabsTrigger>
          <TabsTrigger value="analytics" className="gap-1.5"><LineChart className="w-3.5 h-3.5" />Advanced Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab properties={properties} leases={leases} expenses={expenses} />
        </TabsContent>
        <TabsContent value="insights">
          <InsightsTab properties={properties} leases={leases} expenses={expenses} camCalcs={camCalcs} />
        </TabsContent>
        <TabsContent value="analytics">
          <AdvancedAnalyticsTab properties={properties} leases={leases} expenses={expenses} camCalcs={camCalcs} />
        </TabsContent>
      </Tabs>
    </div>
  );
}