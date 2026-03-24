import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BookOpen } from "lucide-react";

const formulas = [
  {
    module: "Gross-Up",
    formula: "(Actual CAM / Actual Occupancy %) × Threshold % (e.g. 95%)",
    reference: "BOMA Standard — Controllable expenses only"
  },
  {
    module: "Base Year / Stop",
    formula: "Current Year CAM − Base Year CAM",
    reference: "Lease clause base year amount"
  },
  {
    module: "Management Fee (Holrob)",
    formula: "Percentage × Tenant Annual Rent",
    reference: "Lease mgmt fee clause — separate from CAM pool"
  },
  {
    module: "Management Fee (Standard)",
    formula: "Admin Fee % × CAM Pool × Tenant Share %",
    reference: "Lease admin fee clause"
  },
  {
    module: "Partial Year CAM",
    formula: "Annual CAM × (Months Occupied / 12)",
    reference: "Lease start/end date proration"
  },
  {
    module: "CPI Cap",
    formula: "Prior Year CAM × (1 + CPI Increase %)",
    reference: "BLS CPI-U or CPI-W index values"
  },
  {
    module: "Fixed Cap",
    formula: "Prior Year CAM × (1 + Cap %)",
    reference: "Lease cap clause"
  },
  {
    module: "Pro-Rata Share",
    formula: "Tenant SF / Total CAM-Eligible SF × 100",
    reference: "Excludes under-construction units"
  },
  {
    module: "Recon Adjustment",
    formula: "Actual Share − Estimated CAM Paid",
    reference: "Generates Refund Due or Tenant Owes flag"
  },
  {
    module: "Percentage Rent",
    formula: "Rate % × (Gross Sales − Breakpoint)",
    reference: "Tenant sales reports per frequency"
  },
  {
    module: "HVAC Excess",
    formula: "HVAC Cost (tenant share) − Landlord Limit",
    reference: "Lease HVAC responsibility clause"
  },
  {
    module: "Direct Expense",
    formula: "Sum of expenses tagged to specific tenant(s)",
    reference: "e.g. elevators shared by upper-floor tenants only"
  },
];

export default function CalculationReferenceGuide() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-slate-500" />
          Calculation Reference Guide
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="text-[10px] font-bold">MODULE</TableHead>
              <TableHead className="text-[10px] font-bold">CALCULATION / FORMULA</TableHead>
              <TableHead className="text-[10px] font-bold">SOURCE REFERENCE</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {formulas.map((f, i) => (
              <TableRow key={i}>
                <TableCell className="text-xs font-semibold text-slate-900">{f.module}</TableCell>
                <TableCell className="text-xs font-mono text-slate-600">{f.formula}</TableCell>
                <TableCell className="text-xs text-slate-400">{f.reference}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}