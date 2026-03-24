import React, { useState, useEffect } from "react";
import { AccessRequestService } from "@/services/api";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Building2, Send, Loader2, CheckCircle2, ArrowRight,
  Shield, BarChart3, Zap, Video, Users, AlertCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createPageUrl } from "@/utils";
import { supabase } from "@/services/supabaseClient";
import { validateEmail, validatePhone } from "@/components/landing/ContactSection";

export default function RequestAccess() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [requestType, setRequestType] = useState("access"); // "access" | "demo"
  const [form, setForm] = useState({
    full_name: "", email: "", phone: "", company_name: "", role: "",
    portfolios: "", plan: "", notes: "",
  });
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);

  // Read tab from URL param
  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab === "demo" || tab === "access") setRequestType(tab);
  }, [searchParams]);

  const validate = () => {
    const errs = {};
    if (!form.full_name.trim()) errs.full_name = "Name is required";

    const emailResult = validateEmail(form.email);
    if (!emailResult.valid) { errs.email = emailResult.message; setEmailVerified(false); }

    const phoneResult = validatePhone(form.phone);
    if (!phoneResult.valid) { errs.phone = phoneResult.message; setPhoneVerified(false); }

    if (!form.company_name.trim()) errs.company_name = "Company name is required";
    if (!form.role) errs.role = "Please select a role";

    if (requestType === "access") {
      if (!form.portfolios) errs.portfolios = "Please select a range";
      if (!form.plan) errs.plan = "Please select a plan";
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleEmailBlur = () => {
    const result = validateEmail(form.email);
    if (result.valid) {
      setEmailVerified(true);
      setErrors(prev => ({ ...prev, email: undefined }));
    } else {
      setEmailVerified(false);
      setErrors(prev => ({ ...prev, email: result.message }));
    }
  };

  const handlePhoneBlur = () => {
    const result = validatePhone(form.phone);
    if (result.valid) {
      setPhoneVerified(true);
      setErrors(prev => ({ ...prev, phone: undefined }));
    } else {
      setPhoneVerified(false);
      setErrors(prev => ({ ...prev, phone: result.message }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    try {
      const { data: requestId, error } = await supabase.rpc('submit_access_request', {
        p_full_name: form.full_name,
        p_email: form.email,
        p_phone: form.phone || null,
        p_company_name: form.company_name,
        p_role: form.role,
        p_portfolios: form.portfolios || "N/A",
        p_plan: form.plan || "N/A",
        p_request_type: requestType
      });
      if (error) throw error;

      // Auto-reply email to user
      try {
        const { sendEmail } = await import("@/services/integrations");
        const isDemo = requestType === "demo";
        await sendEmail({
          to: form.email,
          subject: isDemo ? "CRE Suite - Demo Request Received" : "CRE Suite - Access Request Received",
          html: `
            <div style="font-family: sans-serif; max-w: 600px; margin: 0 auto;">
              <h2>Hi ${form.full_name.split(' ')[0]},</h2>
              <p>Thank you for requesting ${isDemo ? 'a demo of' : 'access to'} CRE Financial Suite!</p>
              <p>Our team has received your request and will review it shortly. We typically respond within 24-48 business hours.</p>
              <br/>
              <p>Best regards,<br/>The CRE Suite Team</p>
            </div>
          `
        });
      } catch (emailErr) {
        console.error("Auto-reply fail:", emailErr);
      }

      if (requestType === "demo") {
        navigate(createPageUrl("DemoExperience"), {
          state: {
            requestId,
            demoVideoUrl: "https://cjwdwuqqdokblakheyjb.supabase.co/storage/v1/object/public/Slide-deck/End-to-End_CRE_Budgeting_&_CAM.mp4",
            slideDeckUrl: "https://cjwdwuqqdokblakheyjb.supabase.co/storage/v1/object/public/Slide-deck/Automated_CRE_Financial_Intelligence.pptx"
          }
        });
        return;
      }

      setSubmitted(true);
    } catch (err) {
      console.error("Request failed:", err);
    }
    setLoading(false);
  };

  const setField = (key, value) => {
    setForm({ ...form, [key]: value });
    if (errors[key]) setErrors({ ...errors, [key]: undefined });
    if (key === "email") setEmailVerified(false);
    if (key === "phone") setPhoneVerified(false);
  };

  const FieldError = ({ field }) => errors[field] ? (
    <p className="text-red-500 text-xs mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{errors[field]}</p>
  ) : null;

  // ─── Success State (Access only) ───────────────────────
  if (submitted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center">
          <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-emerald-100 flex items-center justify-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-600" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Request Submitted!</h2>
          <p className="text-slate-500 text-sm mb-1">Thank you, {form.full_name.split(" ")[0]}!</p>
          <p className="text-slate-400 text-sm mb-8 max-w-sm mx-auto">
            Our team will review your request and reach out within 24–48 hours to get you set up.
          </p>
          <Link to={createPageUrl("Landing")}>
            <Button variant="outline" className="gap-2">Back to Home <ArrowRight className="w-4 h-4" /></Button>
          </Link>
        </div>
      </div>
    );
  }

  const isDemoMode = requestType === "demo";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex flex-col">
      {/* Top Bar */}
      <div className="px-6 py-5 flex items-center justify-between max-w-6xl mx-auto w-full">
        <Link to={createPageUrl("Landing")} className="flex items-center gap-2.5 group">
          <div className="w-8 h-8 bg-[#1a2744] rounded-lg flex items-center justify-center">
            <Building2 className="w-4.5 h-4.5 text-white" />
          </div>
          <span className="text-[#1a2744] font-bold text-lg tracking-tight">CRE Suite</span>
        </Link>
        <Link to={createPageUrl("Login")} className="text-sm text-slate-500 hover:text-slate-700 font-medium transition-colors">
          Already have an account? <span className="text-blue-600 hover:text-blue-700">Sign In</span>
        </Link>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex items-center justify-center px-4 pb-12">
        <div className="max-w-lg w-full">
          {/* Header */}
          <div className="text-center mb-6">
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight mb-2">
              {isDemoMode ? "Request a Demo" : "Request Access"}
            </h1>
            <p className="text-slate-500 text-sm max-w-md mx-auto">
              {isDemoMode
                ? "See CRE Suite in action. Watch our demo to understand how the platform works."
                : "Join leading CRE teams using our platform to manage budgets, CAM, and leases."}
            </p>
          </div>

          {/* Toggle: Access vs Demo */}
          <div className="flex bg-slate-100 rounded-xl p-1.5 mb-6">
            <button
              type="button"
              onClick={() => setRequestType("access")}
              className={`flex-1 flex items-center justify-center gap-2 text-sm font-semibold py-2.5 rounded-lg transition-all ${
                requestType === "access"
                  ? "bg-white text-[#1a2744] shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <Users className="w-4 h-4" />
              Request Access
            </button>
            <button
              type="button"
              onClick={() => setRequestType("demo")}
              className={`flex-1 flex items-center justify-center gap-2 text-sm font-semibold py-2.5 rounded-lg transition-all ${
                requestType === "demo"
                  ? "bg-white text-violet-700 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <Video className="w-4 h-4" />
              Request Demo
            </button>
          </div>

          {/* Form Card */}
          <div className={`bg-white rounded-2xl border shadow-sm p-8 transition-all ${isDemoMode ? "border-violet-200/60" : "border-slate-200/80"}`}>
            {isDemoMode && (
              <div className="bg-violet-50 border border-violet-100 rounded-xl p-3 mb-5 flex items-start gap-2">
                <Video className="w-4 h-4 text-violet-600 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-violet-700">
                  After submitting, you'll be redirected to our interactive demo experience with a full platform walkthrough.
                </p>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Full Name */}
              <div>
                <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Full Name <span className="text-red-400">*</span></Label>
                <Input value={form.full_name} onChange={(e) => setField("full_name", e.target.value)}
                  placeholder="Jane Smith" className={`mt-1.5 h-11 ${errors.full_name ? "border-red-500 ring-1 ring-red-500 bg-red-50" : ""}`} />
                <FieldError field="full_name" />
              </div>

              {/* Email */}
              <div>
                <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Work Email <span className="text-red-400">*</span></Label>
                <div className="relative mt-1.5">
                  <Input type="email" value={form.email} onChange={(e) => setField("email", e.target.value)}
                    onBlur={handleEmailBlur}
                    placeholder="jane@company.com" className={`h-11 pr-10 ${errors.email ? "border-red-500 ring-1 ring-red-500 bg-red-50" : emailVerified ? "border-emerald-400 ring-1 ring-emerald-400" : ""}`} />
                  {emailVerified && <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500" />}
                  {errors.email && <AlertCircle className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-red-500" />}
                </div>
                <FieldError field="email" />
              </div>

              {/* Phone */}
              <div>
                <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Phone Number <span className="text-red-400">*</span></Label>
                <div className="relative mt-1.5">
                  <Input value={form.phone} onChange={(e) => setField("phone", e.target.value)}
                    onBlur={handlePhoneBlur}
                    placeholder="+1 555 123 4567" className={`h-11 pr-10 ${errors.phone ? "border-red-500 ring-1 ring-red-500 bg-red-50" : phoneVerified ? "border-emerald-400 ring-1 ring-emerald-400" : ""}`} />
                  {phoneVerified && <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500" />}
                  {errors.phone && <AlertCircle className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-red-500" />}
                </div>
                <FieldError field="phone" />
              </div>

              {/* Company Name */}
              <div>
                <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Company Name <span className="text-red-400">*</span></Label>
                <Input value={form.company_name} onChange={(e) => setField("company_name", e.target.value)}
                  placeholder="Acme Real Estate Partners" className={`mt-1.5 h-11 ${errors.company_name ? "border-red-500 ring-1 ring-red-500 bg-red-50" : ""}`} />
                <FieldError field="company_name" />
              </div>

              {/* Role */}
              <div>
                <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Role <span className="text-red-400">*</span></Label>
                <Select value={form.role} onValueChange={(v) => setField("role", v)}>
                  <SelectTrigger className={`mt-1.5 h-11 ${errors.role ? "border-red-500 ring-1 ring-red-500 bg-red-50" : ""}`}>
                    <SelectValue placeholder="Select role..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="asset_manager">Asset Manager</SelectItem>
                    <SelectItem value="property_manager">Property Manager</SelectItem>
                    <SelectItem value="finance_director">Finance Director</SelectItem>
                    <SelectItem value="vp_operations">VP Operations</SelectItem>
                    <SelectItem value="controller">Controller</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
                <FieldError field="role" />
              </div>

              {/* Access-only fields */}
              {!isDemoMode && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Portfolios <span className="text-red-400">*</span></Label>
                    <Select value={form.portfolios} onValueChange={(v) => setField("portfolios", v)}>
                      <SelectTrigger className={`mt-1.5 h-11 ${errors.portfolios ? "border-red-300" : ""}`}>
                        <SelectValue placeholder="Select range..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1-5">1 – 5</SelectItem>
                        <SelectItem value="6-20">6 – 20</SelectItem>
                        <SelectItem value="21-50">21 – 50</SelectItem>
                        <SelectItem value="51-100">51 – 100</SelectItem>
                        <SelectItem value="100+">100+</SelectItem>
                      </SelectContent>
                    </Select>
                    <FieldError field="portfolios" />
                  </div>
                  <div>
                    <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Plan <span className="text-red-400">*</span></Label>
                    <Select value={form.plan} onValueChange={(v) => setField("plan", v)}>
                      <SelectTrigger className={`mt-1.5 h-11 ${errors.plan ? "border-red-300" : ""}`}>
                        <SelectValue placeholder="Select plan..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="monthly">Monthly</SelectItem>
                        <SelectItem value="yearly">Yearly</SelectItem>
                      </SelectContent>
                    </Select>
                    <FieldError field="plan" />
                  </div>
                </div>
              )}

              {/* Submit */}
              <Button
                type="submit"
                disabled={loading}
                className={`w-full h-12 text-white font-semibold rounded-xl shadow-sm gap-2 text-sm mt-2 ${
                  isDemoMode
                    ? "bg-violet-600 hover:bg-violet-700"
                    : "bg-[#1a2744] hover:bg-[#243b67]"
                }`}
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : isDemoMode ? <Video className="w-4 h-4" /> : <Send className="w-4 h-4" />}
                {loading ? "Submitting..." : isDemoMode ? "Watch Demo" : "Request Access"}
              </Button>

              <p className="text-[11px] text-slate-400 text-center pt-1">
                By submitting, you agree to our <a href="#" className="text-blue-500 hover:underline">Terms</a> and <a href="#" className="text-blue-500 hover:underline">Privacy Policy</a>.
              </p>
            </form>
          </div>

          {/* Trust indicators */}
          <div className="flex justify-center gap-8 mt-8">
            {[
              { icon: Shield, text: "SOC 2 Compliant" },
              { icon: BarChart3, text: "$12B+ Managed" },
              { icon: Zap, text: "5 Min Setup" },
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-1.5 text-slate-400">
                <item.icon className="w-3.5 h-3.5" />
                <span className="text-[11px] font-medium">{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
