import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Building2, Loader2, CheckCircle2, ArrowRight, BarChart3, AlertCircle, Globe, Play
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createPageUrl } from "@/utils";
import { submitPublicAccessRequest } from "@/services/api";
import { sendEmail } from "@/services/integrations";
import { validateEmail, validatePhone } from "@/components/landing/ContactSection";

export default function RequestDemo() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    full_name: "", email: "", phone: "", company_name: "", role: "",
    customRole: "", portfolios_count: "", properties_count: "", plan: "professional", billing_cycle: "monthly", notes: "",
  });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);
  const isOtherRole = form.role?.toLowerCase() === "other";

  const validate = () => {
    const errs = {};
    if (!form.full_name.trim()) errs.full_name = "Name is required";

    const emailResult = validateEmail(form.email);
    const isEmailValid = emailResult.valid;
    if (!isEmailValid) { errs.email = emailResult.message; }

    const phoneResult = validatePhone(form.phone);
    const isPhoneValid = phoneResult.valid;
    if (!isPhoneValid) { errs.phone = phoneResult.message; }

    if (!form.company_name.trim()) errs.company_name = "Company name is required";
    if (!form.role) errs.role = "Role is required";
    if (isOtherRole && !form.customRole.trim()) errs.customRole = "Please specify your role";

    setEmailVerified(isEmailValid);
    setPhoneVerified(isPhoneValid);
    setErrors(errs);
    return Object.keys(errs).length === 0 && isEmailValid && isPhoneValid;
  };

  const handleEmailBlur = () => {
    const result = validateEmail(form.email);
    setEmailVerified(result.valid);
    if (!result.valid) setErrors(prev => ({ ...prev, email: result.message }));
    else setErrors(prev => ({ ...prev, email: undefined }));
  };

  const handlePhoneBlur = () => {
    const result = validatePhone(form.phone);
    setPhoneVerified(result.valid);
    if (!result.valid) setErrors(prev => ({ ...prev, phone: result.message }));
    else setErrors(prev => ({ ...prev, phone: undefined }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    try {
      const request = await submitPublicAccessRequest({
        full_name: form.full_name,
        email: form.email,
        phone: form.phone || null,
        company_name: form.company_name,
        role: isOtherRole ? form.customRole : form.role,
        portfolios: form.portfolios_count || "N/A",
        properties_count: form.properties_count || "N/A",
        property_count: form.properties_count || "N/A",
        plan: form.plan || "N/A",
        billing_cycle: form.billing_cycle || "monthly",
        request_type: "demo",
        notes: form.notes || null
      });

      // Notify internal team
      try {
        await sendEmail({
          to: "sales@cresuite.com",
          subject: `[New Request] Demo: ${form.full_name} (${form.company_name})`,
          body: `
            A new demo request has been submitted.
            
            Name: ${form.full_name}
            Email: ${form.email}
            Company: ${form.company_name}
            Role: ${isOtherRole ? form.customRole : form.role}
            Plan Interest: ${form.plan}
            Notes: ${form.notes || "None"}
          `
        });
      } catch (e) { console.error("Admin notification fail:", e); }

      // Send auto-reply to user
      try {
        await sendEmail({
          to: form.email,
          subject: "CRE Suite - Your Demo Access",
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #334155;">
              <h2 style="color: #1a2744;">Hi ${form.full_name.split(' ')[0]},</h2>
              <p>Thank you for requesting a demo of CRE Suite.</p>
              <p>You can now access our exclusive end-to-end platform demonstration and slide deck using the links below:</p>
              <ul>
                <li><strong>Demo Video:</strong> <a href="https://cjwdwuqqdokblakheyjb.supabase.co/storage/v1/object/public/Slide-deck/End-to-End_CRE_Budgeting_&_CAM.mp4">Watch Here</a></li>
                <li><strong>Slide Deck:</strong> <a href="https://cjwdwuqqdokblakheyjb.supabase.co/storage/v1/object/public/Slide-deck/Automated_CRE_Financial_Intelligence.pptx">Download Deck</a></li>
              </ul>
              <p>Someone from our sales team will also reach out shortly to discuss your specific needs.</p>
              <br/>
              <p>Best regards,<br/>The CRE Suite Team</p>
            </div>
          `
        });
      } catch (e) { console.error("Auto-reply fail:", e); }

      navigate(createPageUrl("DemoExperience"), {
        state: {
          requestId: request?.id,
          demoVideoUrl: "https://cjwdwuqqdokblakheyjb.supabase.co/storage/v1/object/public/Slide-deck/End-to-End_CRE_Budgeting_&_CAM.mp4",
          slideDeckUrl: "https://cjwdwuqqdokblakheyjb.supabase.co/storage/v1/object/public/Slide-deck/Automated_CRE_Financial_Intelligence.pptx"
        }
      });
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
    <motion.p initial={{ opacity:0, y:-5 }} animate={{ opacity:1, y:0 }} className="text-red-500 text-[10px] mt-1.5 flex items-center gap-1 font-medium italic">
      <AlertCircle className="w-3 h-3" />{errors[field]}
    </motion.p>
  ) : null;

  return (
    <div className="min-h-screen bg-slate-50 selection:bg-blue-100 selection:text-blue-900 font-inter">
      {/* Dynamic Background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] right-[-10%] w-[50%] h-[50%] bg-blue-100/40 rounded-full blur-[120px] mix-blend-multiply opacity-50" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[50%] h-[50%] bg-indigo-100/40 rounded-full blur-[120px] mix-blend-multiply opacity-50" />
      </div>

      <header className="fixed top-0 z-50 w-full px-6 py-5">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <Link to={createPageUrl("Landing")} className="flex items-center gap-3 transition-transform hover:scale-[1.02]">
            <div className="w-10 h-10 bg-slate-900 rounded-xl flex items-center justify-center shadow-lg shadow-slate-900/20">
              <Building2 className="w-6 h-6 text-white" />
            </div>
            <div className="hidden sm:block">
              <span className="text-slate-900 font-black text-sm tracking-tight block leading-tight uppercase">CRE Suite</span>
              <span className="text-slate-400 text-[10px] font-bold tracking-[0.2em] leading-tight uppercase">Platform</span>
            </div>
          </Link>
          <div className="flex items-center gap-8">
            <Link to={createPageUrl("Login")} className="text-sm font-bold text-slate-500 hover:text-slate-900 transition-colors">Sign In</Link>
            <Link to={createPageUrl("RequestAccess")}>
              <Button className="bg-slate-900 hover:bg-slate-800 text-white text-xs font-black uppercase tracking-widest px-6 h-11 rounded-2xl shadow-xl shadow-slate-900/10 transition-all active:scale-95">
                Request Access
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="relative pt-32 pb-24 px-6 md:px-12 flex items-center justify-center">
        <div className="max-w-6xl w-full grid grid-cols-1 lg:grid-cols-[1fr,1.4fr] gap-16 lg:gap-24 items-center">
          
          {/* Side Info Panel */}
          <div className="space-y-8 lg:pr-8">
            <div className="space-y-4">
              <motion.div initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-50 border border-blue-100 text-blue-600">
                <Play className="w-3.5 h-3.5" />
                <span className="text-[10px] font-black uppercase tracking-widest">Instant Video Demo</span>
              </motion.div>
              <motion.h1 initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.1 }} className="text-3xl lg:text-4xl font-black text-slate-900 tracking-tight leading-[1.1]">
                See the Platform <span className="text-blue-600">in Action.</span>
              </motion.h1>
              <motion.p initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.2 }} className="text-base text-slate-500 max-w-sm leading-relaxed">
                Step inside the ecosystem. Experience the power of automated CAM, real-time budgeting, and AI-driven portfolio insights.
              </motion.p>
            </div>

            <div className="space-y-5">
              {[
                { icon: BarChart3, title: "Deep Analytics", desc: "Interactive dashboards showing real-time property performance." },
                { icon: Building2, title: "Lease Management", desc: "Automated extraction and reconciliation for complex lease portfolios." },
                { icon: Globe, title: "Global Access", desc: "Secure platform access from any device, anywhere in the world." }
              ].map((item, i) => (
                <motion.div key={i} initial={{ opacity:0, x:-20 }} animate={{ opacity:1, x:0 }} transition={{ delay: 0.3 + (i*0.1) }} className="flex gap-4 group">
                  <div className="shrink-0 w-10 h-10 rounded-xl bg-white border border-slate-100 flex items-center justify-center shadow-sm group-hover:bg-blue-600 group-hover:border-blue-600 group-hover:rotate-3 transition-all duration-300">
                    <item.icon className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
                  </div>
                  <div className="space-y-0.5 pt-0.5">
                    <h3 className="text-[12px] font-black text-slate-900 tracking-tight uppercase">{item.title}</h3>
                    <p className="text-[11px] text-slate-400 leading-relaxed font-medium">{item.desc}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Form Card */}
          <motion.div initial={{ opacity:0, scale:0.98 }} animate={{ opacity:1, scale:1 }} className="relative bg-white rounded-[2rem] border border-slate-100 shadow-[0_24px_48px_-12px_rgba(0,0,0,0.06)] p-8 md:p-10 overflow-hidden">
            <div className="absolute top-0 right-0 w-24 h-24 bg-blue-50/50 rounded-bl-[80px] -mr-6 -mt-6" />
            
            <div className="relative z-10 space-y-8">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-black text-slate-900 tracking-tight">Request Platform Demo</h2>
                <div className="flex gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-600" />
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-600" />
                  <div className="w-1.5 h-1.5 rounded-full bg-slate-200" />
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
                  <div className="space-y-2">
                    <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest pl-1">Full Name</Label>
                    <Input 
                      value={form.full_name} onChange={(e) => setField("full_name", e.target.value)}
                      placeholder="Jane Cooper"
                      className="h-11 bg-slate-50/50 border-slate-100 rounded-xl px-4 text-[13px] font-semibold tracking-tight transition-all focus:bg-white focus:ring-0 focus:border-blue-600 shadow-sm"
                    />
                    <FieldError field="full_name" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest pl-1">Work Email</Label>
                    <div className="relative group">
                      <Input 
                        type="email" value={form.email} onChange={(e) => setField("email", e.target.value)} onBlur={handleEmailBlur}
                        placeholder="jane@crefirm.com"
                        className="h-11 bg-slate-50/50 border-slate-100 rounded-xl px-4 text-[13px] font-semibold tracking-tight transition-all focus:bg-white focus:ring-0 focus:border-blue-600 shadow-sm"
                      />
                      {emailVerified && <div className="absolute right-3 top-1/2 -translate-y-1/2"><CheckCircle2 className="w-4 h-4 text-emerald-500" /></div>}
                    </div>
                    <FieldError field="email" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest pl-1">Company</Label>
                    <Input 
                      value={form.company_name} onChange={(e) => setField("company_name", e.target.value)}
                      placeholder="Global RE Partners"
                      className="h-11 bg-slate-50/50 border-slate-100 rounded-xl px-4 text-[13px] font-semibold tracking-tight transition-all focus:bg-white focus:ring-0 focus:border-blue-600 shadow-sm"
                    />
                    <FieldError field="company_name" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest pl-1">Phone</Label>
                    <div className="relative">
                      <Input 
                        value={form.phone} onChange={(e) => setField("phone", e.target.value)} onBlur={handlePhoneBlur}
                        placeholder="+1 (555) 000-0000"
                        className="h-11 bg-slate-50/50 border-slate-100 rounded-xl px-4 text-[13px] font-semibold tracking-tight transition-all focus:bg-white focus:ring-0 focus:border-blue-600 shadow-sm"
                      />
                      {phoneVerified && <div className="absolute right-3 top-1/2 -translate-y-1/2"><CheckCircle2 className="w-4 h-4 text-emerald-500" /></div>}
                    </div>
                    <FieldError field="phone" />
                  </div>
                </div>

                <div className="space-y-5 pt-1">
                  <div className="space-y-2">
                    <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest pl-1">Subscription Interest</Label>
                    <div className="flex gap-1.5 p-1 bg-slate-50 border border-slate-100 rounded-xl">
                      {["starter", "professional", "enterprise"].map(p => (
                        <button 
                          key={p} type="button" onClick={() => setField("plan", p)}
                          className={`flex-1 h-8 rounded-lg text-[9px] font-black tracking-widest uppercase transition-all ${form.plan === p ? 'bg-white text-blue-600 shadow-sm border border-slate-100' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest pl-1">Job Title</Label>
                    <Select value={form.role} onValueChange={(v) => setField("role", v)}>
                      <SelectTrigger className="h-11 bg-slate-50/50 border-slate-100 rounded-xl px-4 text-[13px] font-semibold tracking-tight transition-all focus:bg-white focus:border-blue-600 shadow-sm">
                        <SelectValue placeholder="Select role..." />
                      </SelectTrigger>
                      <SelectContent className="rounded-xl border-slate-100 shadow-2xl">
                        {["Owner", "Landlord", "Finance", "Asset Manager", "Property Manager", "Portfolio Manager", "Finance Director", "CEO/Principal", "Analyst", "Other"].map(r => (
                          <SelectItem key={r} value={r} className="py-2 rounded-lg text-[13px] text-slate-700 font-semibold">{r}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <AnimatePresence>
                      {isOtherRole && (
                        <motion.div initial={{ height:0, opacity:0 }} animate={{ height:"auto", opacity:1 }} exit={{ height:0, opacity:0 }} className="pt-2">
                          <Input 
                            value={form.customRole} onChange={(e) => setField("customRole", e.target.value)}
                            placeholder="Specify your role"
                            className="h-10 bg-white border-slate-100 rounded-lg px-3 text-[13px] font-semibold transition-all focus:border-blue-600"
                          />
                          <FieldError field="customRole" />
                        </motion.div>
                      )}
                    </AnimatePresence>
                    <FieldError field="role" />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-[9px] font-black text-slate-400 uppercase tracking-widest pl-1">Tell us what you're interested in</Label>
                  <textarea 
                    value={form.notes} onChange={(e) => setField("notes", e.target.value)}
                    placeholder="Specific features, scale of your portfolio, etc..."
                    className="w-full min-h-[100px] p-4 text-[13px] bg-slate-50/50 border border-slate-100 rounded-xl focus:outline-none focus:bg-white focus:border-blue-600 shadow-sm transition-all resize-none font-semibold text-slate-600"
                  />
                </div>

                <div className="pt-4">
                  <Button 
                    type="submit" disabled={loading}
                    className="w-full h-14 bg-blue-600 hover:bg-blue-700 text-white font-black text-base rounded-2xl shadow-xl shadow-blue-600/20 transition-all hover:scale-[1.01] flex items-center justify-center gap-2 active:scale-[0.99]"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Access Video Demo <ArrowRight className="w-4 h-4" /></>}
                  </Button>
                  <p className="text-center text-[9px] text-slate-400 font-bold uppercase tracking-widest mt-4 italic">Secure & Confidential</p>
                </div>
              </form>
            </div>
          </motion.div>
        </div>
      </main>

      <footer className="py-12 px-6 border-t border-slate-100">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6 text-[11px]">
          <p className="font-bold text-slate-400 uppercase tracking-[0.2em]">&copy; 2026 CRE Financial Suite</p>
          <div className="flex gap-8">
            {["Safety", "Terms", "Privacy"].map(t => (
              <a key={t} href="#" className="font-black text-slate-400 hover:text-slate-900 uppercase tracking-widest transition-colors">{t}</a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
