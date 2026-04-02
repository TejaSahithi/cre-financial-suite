import React from "react";
import FileUploader from "@/components/FileUploader";

export default function PipelineUpload() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Upload Data Files</h1>
        <p className="text-sm text-slate-500 mt-1">Upload CSV or Excel files to import leases, expenses, properties, or revenue data</p>
      </div>
      <FileUploader />
    </div>
  );
}
