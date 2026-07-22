import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, ArrowRight } from "lucide-react";
import { searchDocumentIntelligenceV6Fields } from "@/services/documentIntelligenceV3Service";

export default function FieldSearchCommand({ document, uploadedFileId, onNavigateToField }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  if (!document?.searchCapabilities?.enabled) return null;

  const runSearch = async (event) => {
    event?.preventDefault?.();
    if (!query.trim()) return;
    setLoading(true);
    setMessage(null);
    const response = await searchDocumentIntelligenceV6Fields({
      uploadedFileId: uploadedFileId || document.uploadedFileId,
      documentFamilyId: document.documentFamily?.id ?? null,
      query,
      limit: 8,
    });
    setLoading(false);
    if (response.error) {
      setResults([]);
      setMessage(response.message);
      return;
    }
    setResults(response.results || []);
    setMessage((response.results || []).length ? null : "No matching semantic records found.");
  };

  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <form onSubmit={runSearch} className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search fields, definitions, sections" className="pl-9 text-sm" />
        </div>
        <Button type="submit" disabled={loading || !query.trim()} className="gap-1.5">
          <Search className="h-4 w-4" /> {loading ? "Searching" : "Search"}
        </Button>
      </form>
      {message && <div className="mt-2 text-xs text-slate-500">{message}</div>}
      {results.length > 0 && (
        <div className="mt-3 divide-y divide-slate-100 rounded-md border border-slate-100">
          {results.map((result) => (
            <button key={`${result.entityType}:${result.key}:${result.score}`} type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50" onClick={() => result.fieldKey && onNavigateToField?.(null, result.fieldKey)}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-[10px] capitalize">{String(result.entityType).replace(/_/g, " ")}</Badge>
                  <span className="truncate text-sm font-semibold text-slate-800">{result.label || result.key}</span>
                </div>
                {result.matchedText && <div className="mt-0.5 truncate text-xs text-slate-500">{result.matchedText}</div>}
              </div>
              <ArrowRight className="h-4 w-4 shrink-0 text-slate-400" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}