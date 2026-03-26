/**
 * AwaitingRole.jsx
 * Shown when a user is authenticated but has no role assigned yet.
 * They may have just accepted the invite but admin hasn't assigned their role,
 * or they are in pending status waiting for org admin approval.
 */
import React from "react";
import { Clock, RefreshCw, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/AuthContext";

export default function AwaitingRole() {
  const { user, refreshProfile, logout } = useAuth();
  const email = user?.email || user?.profile?.email || "";

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center">
        {/* Icon */}
        <div className="relative w-20 h-20 mx-auto mb-6">
          <div className="absolute inset-0 bg-amber-100 rounded-full animate-ping opacity-30" />
          <div className="relative w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center">
            <Clock className="w-10 h-10 text-amber-500" />
          </div>
        </div>

        {/* Content */}
        <h1 className="text-2xl font-bold text-slate-900 mb-2">Awaiting Role Assignment</h1>
        <p className="text-slate-500 text-sm leading-relaxed mb-6 max-w-sm mx-auto">
          Your account is verified, but your administrator hasn't assigned your role yet. 
          You'll receive access once your role is configured.
        </p>

        {/* Info Box */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 mb-6 text-left shadow-sm">
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">Account Details</p>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Email</span>
              <span className="font-medium text-slate-800">{email}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Status</span>
              <span className="inline-flex items-center gap-1 text-amber-600 font-semibold">
                <Clock className="w-3 h-3" /> Awaiting role
              </span>
            </div>
          </div>
        </div>

        {/* What happens next */}
        <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 mb-6 text-left">
          <p className="text-xs font-bold text-blue-700 mb-2">What happens next?</p>
          <ul className="space-y-1.5">
            {[
              "Your administrator will assign your role and module access",
              "You'll receive an email notification when access is granted",
              "Click 'Check Status' below to refresh at any time",
            ].map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-blue-600">
                <span className="w-4 h-4 bg-blue-100 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5">{i + 1}</span>
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1 gap-2"
            onClick={() => refreshProfile(false)}
          >
            <RefreshCw className="w-4 h-4" /> Check Status
          </Button>
          <Button
            variant="outline"
            className="flex-1 gap-2 text-slate-500"
            onClick={() => logout(true)}
          >
            <LogOut className="w-4 h-4" /> Sign Out
          </Button>
        </div>

        <p className="text-xs text-slate-400 mt-6">
          Need help? Contact your organization administrator.
        </p>
      </div>
    </div>
  );
}
