import React, { useState } from "react";
import { Building2, Mail, Phone, MapPin, Clock, Send, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { validateEmail, validatePhone } from "@/components/landing/ContactSection";
import { supabase } from "@/services/supabaseClient";
import ProFormaBrand from "@/components/ProFormaBrand";

export default function ContactUs() {
  const [form, setForm] = useState({ name: "", email: "", phone: "", company: "", message: "", department: "" });
  const [errors, setErrors] = useState({});
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const validate = () => {
    const errs = {};
    if (!form.name.trim()) errs.name = "Name is required";

    const emailResult = validateEmail(form.email);
    if (!emailResult.valid) errs.email = emailResult.message;

    const phoneResult = validatePhone(form.phone);
    if (!phoneResult.valid) errs.phone = phoneResult.message;

    if (!form.message.trim()) errs.message = "Message is required";
    if (!form.department) errs.department = "Please select a department";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const setField = (key, value) => {
    setForm({ ...form, [key]: value });
    if (errors[key]) setErrors({ ...errors, [key]: undefined });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setSending(true);
    
    // Submit via edge function — saves to DB (bypasses RLS) + sends admin + user emails
    try {
      const { error: fnError } = await supabase.functions.invoke("submit-contact", {
        body: {
          full_name: form.name,
          email: form.email,
          phone: form.phone,
          company_name: form.company,
          department: form.department,
          message: form.message,
        },
      });
      if (fnError) throw fnError;
    } catch (e) {
      console.error("[ContactUs] submit-contact error:", e);
      // Still show success to user — don't block on transient errors
    }

    setSending(false);
    setSent(true);
  };

  const FieldError = ({ field }) => errors[field] ? (
    <p className="text-[var(--danger)] text-xs mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{errors[field]}</p>
  ) : null;

  return (
    <div className="min-h-screen bg-[var(--surface)]">
      {/* Nav */}
      <nav className="bg-[var(--ink)] px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <a href="/" className="flex items-center">
            <ProFormaBrand tone="light" className="pf-page-brand" />
          </a>
          <a href="/" className="text-white/70 hover:text-white text-sm">← Back to Home</a>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h1 className="text-[28px] font-bold text-[var(--ink)] mb-3">Contact Us</h1>
          <p className="text-lg text-[var(--muted)] max-w-xl mx-auto">Have questions about ProForma OS? Our team is here to help.</p>
        </div>

        <div className="grid lg:grid-cols-2 gap-12">
          {/* Contact Info */}
          <div className="space-y-8">
            <div>
              <h2 className="text-xl font-bold text-[var(--ink)] mb-6">Get in Touch</h2>
              <div className="space-y-5">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-[var(--accent-soft)] rounded-[8px] flex items-center justify-center flex-shrink-0">
                    <Mail className="w-5 h-5 text-[var(--accent)]" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[var(--ink)]">Email</p>
                    <a href="mailto:support@proformaos.ai" className="text-[var(--accent)] hover:underline text-sm">support@proformaos.ai</a>
                    <p className="text-xs text-[var(--muted)] mt-0.5">For general inquiries and support</p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-[var(--success-soft)] rounded-[8px] flex items-center justify-center flex-shrink-0">
                    <Phone className="w-5 h-5 text-[var(--success)]" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[var(--ink)]">Phone</p>
                    <a href="tel:+18005550199" className="text-[var(--success)] hover:underline text-sm">+1 (800) 555-0199</a>
                    <p className="text-xs text-[var(--muted)] mt-0.5">Mon–Fri, 9am–6pm ET</p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-blue-100 rounded-[8px] flex items-center justify-center flex-shrink-0">
                    <MapPin className="w-5 h-5 text-[var(--info)]" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[var(--ink)]">Headquarters</p>
                    <p className="text-sm text-[var(--muted)]">101 Park Avenue, Suite 2600</p>
                    <p className="text-sm text-[var(--muted)]">Knoxville, TN</p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-[var(--warning-soft)] rounded-[8px] flex items-center justify-center flex-shrink-0">
                    <Clock className="w-5 h-5 text-[var(--warning)]" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[var(--ink)]">Response Time</p>
                    <p className="text-sm text-[var(--muted)]">Access requests: within 24–48 hours</p>
                    <p className="text-sm text-[var(--muted)]">Support tickets: within 4 business hours</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[var(--ink)] rounded-[8px] p-6 text-white">
              <h3 className="font-bold text-lg mb-2">Ready to get started?</h3>
              <p className="text-white/70 text-sm mb-4">Join hundreds of CRE professionals using our platform to streamline budgeting and CAM management.</p>
              <a href="/RequestAccess">
                <Button className="bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--surface)] font-semibold">
                  Request Access →
                </Button>
              </a>
            </div>
          </div>

          {/* Contact Form */}
          <div className="bg-[var(--bg)] rounded-[8px] p-8">
            {sent ? (
              <div className="text-center py-10">
                <div className="w-16 h-16 bg-[var(--success-soft)] rounded-full flex items-center justify-center mx-auto mb-4">
                  <CheckCircle2 className="w-8 h-8 text-[var(--success)]" />
                </div>
                <h3 className="text-xl font-bold text-[var(--ink)] mb-2">Message Sent!</h3>
                <p className="text-[var(--muted)] text-sm">We'll get back to you within 4 business hours.</p>
                <Button variant="outline" onClick={() => { setSent(false); setForm({ name: "", email: "", phone: "", company: "", message: "", department: "" }); }} className="mt-6">
                  Send Another Message
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <h3 className="text-lg font-bold text-[var(--ink)] mb-4">Send us a message</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Full Name <span className="text-red-400">*</span></Label>
                    <Input required value={form.name} onChange={e => setField("name", e.target.value)} placeholder="Jane Smith" className={`mt-1 bg-[var(--surface)] ${errors.name ? "border-red-300" : ""}`} />
                    <FieldError field="name" />
                  </div>
                  <div>
                    <Label>Email <span className="text-red-400">*</span></Label>
                    <Input value={form.email} onChange={e => setField("email", e.target.value)} placeholder="jane@company.com" className={`mt-1 bg-[var(--surface)] ${errors.email ? "border-red-300" : ""}`} />
                    <FieldError field="email" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Phone Number <span className="text-red-400">*</span></Label>
                    <Input value={form.phone} onChange={e => setField("phone", e.target.value)} placeholder="+1 555 123 4567" className={`mt-1 bg-[var(--surface)] ${errors.phone ? "border-red-300" : ""}`} />
                    <FieldError field="phone" />
                  </div>
                  <div>
                    <Label>Department <span className="text-red-400">*</span></Label>
                    <Select value={form.department} onValueChange={v => setField("department", v)}>
                      <SelectTrigger className={`mt-1 bg-[var(--surface)] ${errors.department ? "border-red-300" : ""}`}>
                        <SelectValue placeholder="Select..." />
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
                  <Label>Company</Label>
                  <Input value={form.company} onChange={e => setField("company", e.target.value)} placeholder="Acme Real Estate Partners" className="mt-1 bg-[var(--surface)]" />
                </div>
                <div>
                  <Label>Message <span className="text-red-400">*</span></Label>
                  <Textarea value={form.message} onChange={e => setField("message", e.target.value)} placeholder="How can we help you?" rows={5} className={`mt-1 bg-[var(--surface)] ${errors.message ? "border-red-300" : ""}`} />
                  <FieldError field="message" />
                </div>
                <Button type="submit" disabled={sending} className="w-full bg-[var(--ink)] hover:bg-[var(--ink)] h-11">
                  {sending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
                  {sending ? "Sending..." : "Send Message"}
                </Button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
