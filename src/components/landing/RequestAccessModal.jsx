import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, CheckCircle2, Building2, Send, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const steps = [
  { step: "01", title: "Submit Request", desc: "Complete the form with your organization details." },
  { step: "02", title: "Consultation", desc: "Our team contacts you to discuss your portfolio needs." },
  { step: "03", title: "Credentials Issued", desc: "Receive secure login credentials via email." },
  { step: "04", title: "Onboard & Go Live", desc: "Reset password, complete setup, and start budgeting." },
];

export default function RequestAccessModal({ onClose }) {
  const [form, setForm] = useState({
    full_name: "", email: "", company_name: "", role: "",
    property_count: "", message: "", plan_interest: "professional",
  });
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setLoading(true);
    await accessRequestService.create({
      ...form,
      property_count: parseInt(form.property_count) || 0,
      status: "pending",
    });
    setLoading(false);
    setSubmitted(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.3 }}
        className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full relative max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute top-4 right-4 w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center transition-colors z-10">
          <X className="w-4 h-4 text-gray-500" />
        </button>

        <AnimatePresence mode="wait">
          {!submitted ? (
            <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col md:flex-row">
              {/* Left panel */}
              <div className="bg-gradient-to-br from-[#0f1a2e] to-[#1a2f52] p-8 md:w-[42%] rounded-l-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 w-40 h-40 bg-blue-500/10 rounded-full blur-3xl" />
                <div className="absolute bottom-0 left-0 w-32 h-32 bg-indigo-500/10 rounded-full blur-2xl" />

                <div className="relative z-10">
                  <div className="w-10 h-10 bg-gradient-to-br from-blue-400 to-blue-600 rounded-xl flex items-center justify-center mb-5 shadow-lg">
                    <Building2 className="w-5 h-5 text-white" />
                  </div>
                  <h2 className="text-xl font-bold text-white mb-2">Request a Demo</h2>
                  <p className="text-white/40 text-sm mb-8 leading-relaxed">
                    Fill in your details to request a demo. Our team will review your request and reach out to schedule a personalized walkthrough of the platform.
                  </p>
                  <div className="space-y-5">
                    {steps.map((item, i) => (
                      <div key={i} className="flex gap-3">
                        <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                          <span className="text-blue-400 font-bold text-xs">{item.step}</span>
                        </div>
                        <div>
                          <p className="text-white font-semibold text-sm">{item.title}</p>
                          <p className="text-white/30 text-xs leading-relaxed">{item.desc}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Right form */}
              <div className="p-8 md:w-[58%]">
                <h3 className="text-lg font-bold text-gray-900 mb-1">Request Demo</h3>
                <p className="text-gray-400 text-xs mb-6">Fields marked with * are required. Already have an account? <button onClick={onClose} className="text-blue-600 hover:underline font-semibold">Sign In</button></p>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-gray-700 text-xs font-semibold">Full Name *</Label>
                      <Input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Jane Smith" className="mt-1 h-10" />
                    </div>
                    <div>
                      <Label className="text-gray-700 text-xs font-semibold">Work Email *</Label>
                      <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="jane@company.com" className="mt-1 h-10" />
                    </div>
                  </div>
                  <div>
                    <Label className="text-gray-700 text-xs font-semibold">Company Name *</Label>
                    <Input value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} placeholder="Acme Real Estate Partners" className="mt-1 h-10" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-gray-700 text-xs font-semibold">Job Title *</Label>
                      <Input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="VP Finance / Asset Manager" className="mt-1 h-10" />
                    </div>
                    <div>
                      <Label className="text-gray-700 text-xs font-semibold">Number of Properties *</Label>
                      <Input type="number" value={form.property_count} onChange={(e) => setForm({ ...form, property_count: e.target.value })} placeholder="e.g. 25" className="mt-1 h-10" />
                    </div>
                  </div>
                  <div>
                    <Label className="text-gray-700 text-xs font-semibold">Plan Interest</Label>
                    <Select value={form.plan_interest} onValueChange={(v) => setForm({ ...form, plan_interest: v })}>
                      <SelectTrigger className="mt-1 h-10"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="starter">Starter — $499/mo</SelectItem>
                        <SelectItem value="professional">Professional — $1,499/mo</SelectItem>
                        <SelectItem value="enterprise">Enterprise — Custom</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-gray-700 text-xs font-semibold">Additional Notes</Label>
                    <Textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} rows={3} placeholder="Tell us about your current workflow or specific requirements..." className="mt-1" />
                  </div>
                  <p className="text-[11px] text-gray-400">
                    By submitting, you agree to our Terms of Service and Privacy Policy.
                  </p>
                </div>
                <Button
                  onClick={handleSubmit}
                  disabled={!form.full_name || !form.email || !form.company_name || loading}
                  className="w-full mt-5 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600 text-white font-semibold h-11 rounded-lg shadow-md gap-2"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {loading ? "Submitting..." : "Request Demo"}
                </Button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="success" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-20 px-8">
              <div className="w-20 h-20 mx-auto mb-5 rounded-full bg-emerald-100 flex items-center justify-center">
                <CheckCircle2 className="w-10 h-10 text-emerald-600" />
              </div>
              <h3 className="text-2xl font-bold text-gray-900 mb-3">Demo Request Submitted!</h3>
              <p className="text-gray-500 text-sm mb-2 max-w-md mx-auto">
                Thank you! Our team will review your request and reach out within <strong>24–48 hours</strong> to schedule your personalized demo.
              </p>
              <p className="text-gray-400 text-xs mb-8 max-w-sm mx-auto">
                Keep an eye on your inbox for a confirmation email with next steps.
              </p>
              <Button onClick={onClose} variant="outline" className="rounded-lg px-8">
                Close
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}