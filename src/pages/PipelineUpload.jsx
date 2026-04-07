import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/services/supabaseClient";
import FileUploader from "@/components/FileUploader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

async function fetchProperties() {
  if (!supabase) return [];
  const { data } = await supabase.from("properties").select("id, name").order("name");
  return data ?? [];
}

export default function PipelineUpload() {
  const location = useLocation();
  const urlParams = new URLSearchParams(location.search);
  const [selectedPropertyId, setSelectedPropertyId] = useState(urlParams.get("property") || "");

  const { data: properties = [] } = useQuery({
    queryKey: ["properties-pipeline-upload"],
    queryFn: fetchProperties,
  });

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Upload Data Files</h1>
        <p className="text-sm text-slate-500 mt-1">
          Upload CSV or Excel files to import leases, expenses, properties, or revenue data
        </p>
      </div>

      {/* Optional property selector — pre-tags the file so compute pipeline knows which property to run */}
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
          Property (optional)
        </Label>
        <Select value={selectedPropertyId} onValueChange={setSelectedPropertyId}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a property..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">No specific property</SelectItem>
            {properties.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-slate-400">
          Selecting a property ensures compute engines run automatically after upload.
        </p>
      </div>

      <FileUploader propertyId={selectedPropertyId || undefined} />
    </div>
  );
}
