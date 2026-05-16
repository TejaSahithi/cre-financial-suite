/**
 * FieldMappingRules — Admin surface that documents the canonical field
 * mapping driving Lease Review. Reads from LEASE_REVIEW_FIELDS (the schema
 * that powers the review workspace) so the source of truth stays in one
 * place. Custom field overrides from custom_fields are also surfaced.
 *
 * Phase 11 ships this as read-only documentation. Editing the schema would
 * require regenerating the review workspace, so per-org overrides should
 * use the existing custom_fields mechanism rather than rewriting the
 * canonical map.
 */
import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Filter, Settings2 } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  LEASE_REVIEW_TABS,
  LEASE_REVIEW_FIELDS,
} from "@/lib/leaseReviewSchema";
import { supabase } from "@/services/supabaseClient";

export default function FieldMappingRules() {
  const [search, setSearch] = useState("");
  const [tabFilter, setTabFilter] = useState("all");

  const { data: customFields = [] } = useQuery({
    queryKey: ["custom-fields-admin"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("custom_fields")
        .select("id, entity_type, field_key, field_label, field_type, source, created_at");
      if (error) {
        console.warn("[FieldMappingRules] custom_fields query failed:", error.message);
        return [];
      }
      return data || [];
    },
  });

  const filtered = useMemo(() => {
    return LEASE_REVIEW_FIELDS.filter((f) => {
      if (tabFilter !== "all" && f.tab !== tabFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          f.key.toLowerCase().includes(q) ||
          f.label.toLowerCase().includes(q) ||
          (f.options || "").toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [search, tabFilter]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Settings2}
        title="Field Mapping Rules"
        subtitle={`${LEASE_REVIEW_FIELDS.length} canonical fields · ${customFields.length} org custom fields`}
        iconColor="from-indigo-500 to-violet-600"
      />

      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="p-4 text-sm text-blue-800">
          <p className="font-medium">Canonical schema drives Lease Review</p>
          <p className="text-xs">
            These mappings are read-only. The schema is shared between Lease Review (UI), Lease
            Detail (system of record), and the abstract snapshot. To extend per-organization, use
            Custom Fields (below) — they are persisted in <code>extraction_data.fields</code> and
            in the abstract snapshot at approval time without touching the canonical schema.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Filter className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search by key, label, options..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Tabs value={tabFilter} onValueChange={setTabFilter}>
          <TabsList className="bg-white border">
            <TabsTrigger value="all" className="text-xs">All ({LEASE_REVIEW_FIELDS.length})</TabsTrigger>
            {LEASE_REVIEW_TABS.filter((t) => t.key !== "summary" && t.key !== "documents_exhibits" && t.key !== "budget_preview").map((tab) => {
              const count = LEASE_REVIEW_FIELDS.filter((f) => f.tab === tab.key).length;
              return (
                <TabsTrigger key={tab.key} value={tab.key} className="text-xs">
                  {tab.label} ({count})
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="text-[11px] uppercase">Tab</TableHead>
                <TableHead className="text-[11px] uppercase">Field Key</TableHead>
                <TableHead className="text-[11px] uppercase">Label</TableHead>
                <TableHead className="text-[11px] uppercase">Type</TableHead>
                <TableHead className="text-[11px] uppercase">Options Source</TableHead>
                <TableHead className="text-[11px] uppercase">Required</TableHead>
                <TableHead className="text-[11px] uppercase">Allow N/A</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((field) => {
                const tab = LEASE_REVIEW_TABS.find((t) => t.key === field.tab);
                return (
                  <TableRow key={field.key} className="hover:bg-slate-50">
                    <TableCell className="text-xs text-slate-500">{tab?.label || field.tab}</TableCell>
                    <TableCell className="font-mono text-xs">{field.key}</TableCell>
                    <TableCell className="text-sm font-medium">{field.label}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">{field.type}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{field.options || "—"}</TableCell>
                    <TableCell>
                      {field.required ? (
                        <Badge className="bg-red-100 text-red-700 text-[10px]">Required</Badge>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {field.allowNA === false ? (
                        <Badge className="bg-slate-100 text-slate-600 text-[10px]">No</Badge>
                      ) : (
                        <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">Yes</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-slate-400">
                    No fields match the current filter.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <div>
        <h2 className="text-base font-semibold text-slate-900">Custom Fields (org-specific)</h2>
        <p className="mb-3 text-xs text-slate-500">
          Custom fields are extracted alongside the canonical schema and stored in
          extraction_data. They appear in Lease Review under the relevant tab and are included in
          the abstract snapshot when the lease is approved.
        </p>
        <Card>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="text-[11px] uppercase">Entity</TableHead>
                  <TableHead className="text-[11px] uppercase">Field Key</TableHead>
                  <TableHead className="text-[11px] uppercase">Label</TableHead>
                  <TableHead className="text-[11px] uppercase">Type</TableHead>
                  <TableHead className="text-[11px] uppercase">Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customFields.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-sm text-slate-400">
                      No custom fields registered. Custom fields appear automatically when the
                      extraction pipeline detects org-specific labels.
                    </TableCell>
                  </TableRow>
                ) : (
                  customFields.map((cf) => (
                    <TableRow key={cf.id}>
                      <TableCell className="text-xs text-slate-500">{cf.entity_type}</TableCell>
                      <TableCell className="font-mono text-xs">{cf.field_key}</TableCell>
                      <TableCell className="text-sm">{cf.field_label}</TableCell>
                      <TableCell><Badge variant="outline" className="text-[10px]">{cf.field_type}</Badge></TableCell>
                      <TableCell className="text-xs text-slate-500">{cf.source || "manual"}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>

      <Card className="border-slate-200 bg-slate-50">
        <CardContent className="flex items-center gap-2 p-4 text-sm text-slate-600">
          <FileText className="h-4 w-4" />
          The schema lives in <code>src/lib/leaseReviewSchema.js</code>. Adding a new field there
          makes it appear in Lease Review, Lease Detail, the abstract snapshot, and this admin view.
        </CardContent>
      </Card>
    </div>
  );
}
