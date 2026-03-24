import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Send, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { motion } from "framer-motion";

// ─── Validation Helpers ─────────────────────────────────
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PHONE_REGEX = /^\+?[\d]{7,15}$/; // E.164-ish: optional +, 7-15 digits

/**
 * Validate email format. Replace body with API call when ready.
 * @param {string} email
 * @returns {{ valid: boolean, message?: string }}
 */
export function validateEmail(email) {
  if (!email.trim()) return { valid: false, message: "Email is required" };
  if (!EMAIL_REGEX.test(email)) return { valid: false, message: "Enter a valid email address" };
  // TODO: Hook in API validation (e.g., Abstract API, ZeroBounce)
  // const res = await fetch(`https://api.example.com/validate?email=${email}`);
  return { valid: true };
}

/**
 * Validate phone in E.164 format. Replace body with API call when ready.
 * @param {string} phone
 * @returns {{ valid: boolean, message?: string }}
 */
export function validatePhone(phone) {
  if (!phone.trim()) return { valid: false, message: "Phone number is required" };
  const cleaned = phone.replace(/[\s\-().]/g, "");
  if (!PHONE_REGEX.test(cleaned)) return { valid: false, message: "Enter a valid phone number (e.g., +1 555 123 4567)" };
  // TODO: Hook in API validation (e.g., Twilio Lookup)
  return { valid: true };
}

export default function ContactSection() {
  const [form, setForm] = useState({ name: "", email: "", phone: "", message: "", department: "" });
  const [errors, setErrors] = useState({});
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);

  const validate = () => {
    const errs = {};
    if (!form.name.trim()) errs.name = "Name is required";

    const emailResult = validateEmail(form.email);
    if (!emailResult.valid) { errs.email = emailResult.message; setEmailVerified(false); }

    const phoneResult = validatePhone(form.phone);
    if (!phoneResult.valid) { errs.phone = phoneResult.message; setPhoneVerified(false); }

    if (!form.message.trim()) errs.message = "Message is required";
    if (!form.department) errs.department = "Please select a department";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleEmailBlur = () => {
    const result = validateEmail(form.email);
    if (result.valid) { setEmailVerified(true); setErrors(p => ({ ...p, email: undefined })); }
    else { setEmailVerified(false); setErrors(p => ({ ...p, email: result.message })); }
  };

  const handlePhoneBlur = () => {
    const result = validatePhone(form.phone);
    if (result.valid) { setPhoneVerified(true); setErrors(p => ({ ...p, phone: undefined })); }
    else { setPhoneVerified(false); setErrors(p => ({ ...p, phone: result.message })); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setSending(true);
    try {
      // Send via Resend or generic email service
      const { sendEmail } = await import("@/services/integrations");
      await sendEmail({
        to: form.department === "sales" ? "sales@cresuite.com" : "support@cresuite.com",
        subject: `[${form.department === "sales" ? "Sales" : "Support"}] Contact from ${form.name}`,
        body: `Name: ${form.name}\nEmail: ${form.email}\nPhone: ${form.phone}\nDept: ${form.department}\n\n${form.message}`
      });
      setSent(true);
    } catch (err) {
      console.error("Contact form error:", err);
    }
    setSending(false);
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

  return (
    <section id="contact-us" className="py-20 px-6 bg-white">
      <div className="max-w-3xl mx-auto">
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-10">
          <h2 className="text-3xl font-extrabold text-slate-900">Contact Us</h2>
          <p className="text-slate-500 mt-3 text-sm max-w-md mx-auto">Have questions? Reach out and our team will get back to you within 4 business hours.</p>
        </motion.div>

        {sent ? (
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-12">
            <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-emerald-600" />
            </div>
            <h3 className="text-xl font-bold text-slate-900 mb-2">Message Sent!</h3>
            <p className="text-slate-500 text-sm">We'll get back to you within 4 business hours.</p>
            <Button variant="outline" onClick={() => { setSent(false); setForm({ name: "", email: "", phone: "", message: "", department: "" }); }} className="mt-6">
              Send Another Message
            </Button>
          </motion.div>
        ) : (
          <motion.form initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} onSubmit={handleSubmit} className="bg-slate-50 rounded-2xl border border-slate-200/80 p-8 space-y-5">
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Full Name <span className="text-red-400">*</span></Label>
                <Input value={form.name} onChange={e => setField("name", e.target.value)} placeholder="Jane Smith" className={`mt-1.5 h-11 bg-white ${errors.name ? "border-red-500 ring-1 ring-red-500 bg-red-50" : ""}`} />
                <FieldError field="name" />
              </div>
              <div>
                <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Email <span className="text-red-400">*</span></Label>
                <div className="relative mt-1.5">
                  <Input type="email" value={form.email} onChange={e => setField("email", e.target.value)} onBlur={handleEmailBlur} placeholder="jane@company.com" className={`h-11 bg-white pr-10 ${errors.email ? "border-red-500 ring-1 ring-red-500 bg-red-50" : emailVerified ? "border-emerald-400 ring-1 ring-emerald-400" : ""}`} />
                  {emailVerified && <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500" />}
                  {errors.email && <AlertCircle className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-red-500" />}
                </div>
                <FieldError field="email" />
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Phone Number <span className="text-red-400">*</span></Label>
                <div className="relative mt-1.5">
                  <Input value={form.phone} onChange={e => setField("phone", e.target.value)} onBlur={handlePhoneBlur} placeholder="+1 555 123 4567" className={`h-11 bg-white pr-10 ${errors.phone ? "border-red-500 ring-1 ring-red-500 bg-red-50" : phoneVerified ? "border-emerald-400 ring-1 ring-emerald-400" : ""}`} />
                  {phoneVerified && <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500" />}
                  {errors.phone && <AlertCircle className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-red-500" />}
                </div>
                <FieldError field="phone" />
              </div>
              <div>
                <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Department <span className="text-red-400">*</span></Label>
                <Select value={form.department} onValueChange={v => setField("department", v)}>
                  <SelectTrigger className={`mt-1.5 h-11 bg-white ${errors.department ? "border-red-500 ring-1 ring-red-500 bg-red-50" : ""}`}>
                    <SelectValue placeholder="Select department..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sales">Sales</SelectItem>
                    <SelectItem value="support">Technical Support</SelectItem>
                  </SelectContent>
                </Select>
                <FieldError field="department" />
              </div>
            </div>
            <div>
              <Label className="text-slate-700 text-xs font-semibold uppercase tracking-wider">Message <span className="text-red-400">*</span></Label>
              <Textarea value={form.message} onChange={e => setField("message", e.target.value)} placeholder="How can we help you?" rows={4} className={`mt-1.5 bg-white ${errors.message ? "border-red-500 ring-1 ring-red-500 bg-red-50" : ""}`} />
              <FieldError field="message" />
            </div>
            <Button type="submit" disabled={sending} className="w-full bg-[#1a2744] hover:bg-[#243b67] h-12 rounded-xl font-semibold gap-2">
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {sending ? "Sending..." : "Send Message"}
            </Button>
          </motion.form>
        )}
      </div>
    </section>
  );
}
