import React from "react";
import FileHistory from "@/components/FileHistory";

export default function FileHistoryPage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">File Upload History</h1>
        <p className="text-sm text-slate-500 mt-1">Track the status of all uploaded data files</p>
      </div>
      <FileHistory />
    </div>
  );
}
