import React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check, X, FileSearch, HelpCircle, Edit2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";

export default function ExpenseClassificationTable({ categories, rules, onEditRule, onViewEvidence }) {
  const getStatusBadge = (status) => {
    switch (status) {
      case 'mapped': return <Badge className="bg-emerald-100 text-emerald-800">Mapped</Badge>;
      case 'unmapped': return <Badge variant="outline" className="text-slate-500">Unmapped</Badge>;
      case 'uncertain': return <Badge className="bg-amber-100 text-amber-800">Review Needed</Badge>;
      case 'not_mentioned': return <Badge variant="secondary" className="text-slate-500">Not Mentioned</Badge>;
      default: return <Badge variant="outline">Unknown</Badge>;
    }
  };

  const renderBooleanIcon = (value) => {
    if (value === true) return <Check className="w-4 h-4 text-emerald-600" />;
    if (value === false) return <X className="w-4 h-4 text-rose-600" />;
    return <span className="text-slate-300">-</span>;
  };

  return (
    <div className="border rounded-md overflow-hidden bg-white">
      <Table>
        <TableHeader className="bg-slate-50">
          <TableRow>
            <TableHead>Category</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-center">Recoverable</TableHead>
            <TableHead className="text-center">Excluded</TableHead>
            <TableHead>Cap / Base Year</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {categories.map(category => {
            const rule = rules.find(r => r.expense_category_id === category.id) || {};
            const {
              row_status = 'unmapped',
              is_recoverable,
              is_excluded,
              is_subject_to_cap,
              cap_value,
              cap_type,
              has_base_year,
              base_year_type,
              confidence
            } = rule;

            return (
              <TableRow key={category.id} className={row_status === 'uncertain' ? 'bg-amber-50/30' : ''}>
                <TableCell className="font-medium">
                  {category.category_name}
                  {category.subcategory_name && <span className="text-slate-500 text-sm ml-2">({category.subcategory_name})</span>}
                </TableCell>
                <TableCell>{getStatusBadge(row_status)}</TableCell>
                <TableCell className="text-center">{renderBooleanIcon(is_recoverable)}</TableCell>
                <TableCell className="text-center">{renderBooleanIcon(is_excluded)}</TableCell>
                <TableCell>
                  {is_subject_to_cap && cap_value && (
                    <Badge variant="outline" className="mr-2 border-blue-200 text-blue-700 bg-blue-50">
                      Cap: {cap_value}{cap_type === 'percentage' ? '%' : ''} {cap_type}
                    </Badge>
                  )}
                  {has_base_year && (
                    <Badge variant="outline" className="border-purple-200 text-purple-700 bg-purple-50">
                      Base Year: {base_year_type}
                    </Badge>
                  )}
                  {!is_subject_to_cap && !has_base_year && <span className="text-slate-300">-</span>}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-8 w-8 p-0"
                      onClick={() => onViewEvidence(category, rule)}
                      title="View AI Evidence"
                    >
                      <FileSearch className={`w-4 h-4 ${confidence < 0.7 ? 'text-amber-500' : 'text-slate-400 hover:text-blue-600'}`} />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-8 w-8 p-0"
                      onClick={() => onEditRule(category, rule)}
                      title="Edit Mapping"
                    >
                      <Edit2 className="w-4 h-4 text-slate-400 hover:text-blue-600" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
          {categories.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center py-8 text-slate-500">
                No expense categories found.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
