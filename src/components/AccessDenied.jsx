import React from "react";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

export default function AccessDenied() {
  return (
    <div className="flex flex-col items-center justify-center h-[70vh] text-center px-4">
      <div className="w-16 h-16 bg-red-100 rounded-2xl flex items-center justify-center mb-4">
        <Shield className="w-8 h-8 text-red-500" />
      </div>
      <h2 className="text-2xl font-bold text-slate-900 mb-2">Access Denied</h2>
      <p className="text-slate-500 max-w-md mb-6">
        You don't have permission to view this page. Contact your administrator if you believe this is an error.
      </p>
      <Link to="/Dashboard">
        <Button>Go to Dashboard</Button>
      </Link>
    </div>
  );
}