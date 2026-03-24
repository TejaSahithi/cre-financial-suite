import React from "react";
import { budgetService } from "@/services/budgetService";
import { expenseService } from "@/services/expenseService";
import { leaseService } from "@/services/leaseService";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Layers, Target } from "lucide-react";
import ActualsTab from "@/components/financials/ActualsTab";
import VarianceTab from "@/components/financials/VarianceTab";

export default function ActualsVariance() {
  const { data: expenses = [] } = useQuery({ queryKey: ['expenses'], queryFn: () => expenseService.list() });
  const { data: leases = [] } = useQuery({ queryKey: ['leases'], queryFn: () => leaseService.list() });
  const { data: budgets = [] } = useQuery({ queryKey: ['budgets'], queryFn: () => budgetService.list() });

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Actuals & Variance</h1>
        <p className="text-sm text-slate-500">Actual financial performance and budget variance analysis</p>
      </div>

      <Tabs defaultValue="actuals" className="space-y-4">
        <TabsList>
          <TabsTrigger value="actuals" className="gap-1.5"><Layers className="w-3.5 h-3.5" />Actuals</TabsTrigger>
          <TabsTrigger value="variance" className="gap-1.5"><Target className="w-3.5 h-3.5" />Variance</TabsTrigger>
        </TabsList>

        <TabsContent value="actuals">
          <ActualsTab expenses={expenses} leases={leases} />
        </TabsContent>
        <TabsContent value="variance">
          <VarianceTab expenses={expenses} budgets={budgets} />
        </TabsContent>
      </Tabs>
    </div>
  );
}