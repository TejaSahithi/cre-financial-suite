import React, { useState } from "react";
import { Building2, Mail, Phone, MapPin, Clock, Send, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { sendEmail } from "@/services/integrations";
import { validateEmail, validatePhone } from "@/components/landing/ContactSection";
import { supabase } from "@/services/supabaseClient";

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
    
    // Save to database
    try {
      await supabase.from("access_requests").insert({
        full_name: form.name,
        email: form.email,
        phone: form.phone,
        company_name: form.company,
        department: form.department,
        message: form.message,
        request_type: "contact",
        status: "pending_approval"
      });
    } catch (e) {
      console.error("Failed to log contact request in DB:", e);
    }

    // Internal Notification
    await sendEmail({
      to: "support@cresuite.org",
      subject: `[${form.department === "sales" ? "Sales" : "Support"}] Contact from ${form.name} @ ${form.company}`,
      body: `Name: ${form.name}\nEmail: ${form.email}\nPhone: ${form.phone}\nCompany: ${form.company}\nDept: ${form.department}\n\nMessage:\n${form.message}`
    });

    // Auto-reply to user
    await sendEmail({
      to: form.email,
      subject: "We received your request",
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <p>Hi ${form.name},</p>
          <p>Thank you for reaching out to us.</p>
          <p>Your request has been received and our team will get back to you shortly.</p>
          <p>Request Type: ${form.department === "sales" ? "Sales" : "Technical Support"}</p>
          <p>In the meantime, you can:</p>
          <ul>
            <li>Explore our demo</li>
            <li>Learn more about the platform capabilities</li>
          </ul>
          <p>We appreciate your interest.</p>
          <br/>
          <p>Best regards,<br/>CRE Financial Suite Team</p>
        </div>
      `
    });

    setSending(false);
    setSent(true);
  };

  const FieldError = ({ field }) => errors[field] ? (
    <p className="text-red-500 text-xs mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{errors[field]}</p>
  ) : null;

  return (
    <div className="min-h-screen bg-white">
      {/* Nav */}
      <nav className="bg-[#1a2744] px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <a href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center">
              <Building2 className="w-5 h-5 text-white" />
            </div>
            <span className="text-white font-bold text-lg">CRE PLATFORM</span>
          </a>
          <a href="/" className="text-white/70 hover:text-white text-sm">← Back to Home</a>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-slate-900 mb-3">Contact Us</h1>
          <p className="text-lg text-slate-500 max-w-xl mx-auto">Have questions about CRE Platform? Our team is here to help.</p>
        </div>

        <div className="grid lg:grid-cols-2 gap-12">
          {/* Contact Info */}
          <div className="space-y-8">
            <div>
              <h2 className="text-xl font-bold text-slate-900 mb-6">Get in Touch</h2>
              <div className="space-y-5">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center flex-shrink-0">
                    <Mail className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">Email</p>
                    <a href="mailto:support@cresuite.org" className="text-blue-600 hover:underline text-sm">support@cresuite.org</a>
                    <p className="text-xs text-slate-400 mt-0.5">For general inquiries and support</p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center flex-shrink-0">
                    <Phone className="w-5 h-5 text-emerald-600" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">Phone</p>
                    <a href="tel:+18005550199" className="text-emerald-600 hover:underline text-sm">+1 (800) 555-0199</a>
                    <p className="text-xs text-slate-400 mt-0.5">Mon–Fri, 9am–6pm ET</p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center flex-shrink-0">
                    <MapPin className="w-5 h-5 text-purple-600" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">Headquarters</p>
                    <p className="text-sm text-slate-600">101 Park Avenue, Suite 2600</p>
                    <p className="text-sm text-slate-600">New York, NY 10178</p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center flex-shrink-0">
                    <Clock className="w-5 h-5 text-amber-600" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">Response Time</p>
                    <p className="text-sm text-slate-600">Access requests: within 24–48 hours</p>
                    <p className="text-sm text-slate-600">Support tickets: within 4 business hours</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[#1a2744] rounded-2xl p-6 text-white">
              <h3 className="font-bold text-lg mb-2">Ready to get started?</h3>
              <p className="text-white/70 text-sm mb-4">Join hundreds of CRE professionals using our platform to streamline budgeting and CAM management.</p>
              <a href="/RequestAccess">
                <Button className="bg-white text-[#1a2744] hover:bg-white/90 font-semibold">
                  Request Access →
                </Button>
              </a>
            </div>
          </div>

          {/* Contact Form */}
          <div className="bg-slate-50 rounded-2xl p-8">
            {sent ? (
              <div className="text-center py-10">
                <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <CheckCircle2 className="w-8 h-8 text-emerald-600" />
                </div>
                <h3 className="text-xl font-bold text-slate-900 mb-2">Message Sent!</h3>
                <p className="text-slate-500 text-sm">We'll get back to you within 4 business hours.</p>
                <Button variant="outline" onClick={() => { setSent(false); setForm({ name: "", email: "", phone: "", company: "", message: "", department: "" }); }} className="mt-6">
                  Send Another Message
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <h3 className="text-lg font-bold text-slate-900 mb-4">Send us a message</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Full Name <span className="text-red-400">*</span></Label>
                    <Input required value={form.name} onChange={e => setField("name", e.target.value)} placeholder="Jane Smith" className={`mt-1 bg-white ${errors.name ? "border-red-300" : ""}`} />
                    <FieldError field="name" />
                  </div>
                  <div>
                    <Label>Email <span className="text-red-400">*</span></Label>
                    <Input value={form.email} onChange={e => setField("email", e.target.value)} placeholder="jane@company.com" className={`mt-1 bg-white ${errors.email ? "border-red-300" : ""}`} />
                    <FieldError field="email" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Phone Number <span className="text-red-400">*</span></Label>
                    <Input value={form.phone} onChange={e => setField("phone", e.target.value)} placeholder="+1 555 123 4567" className={`mt-1 bg-white ${errors.phone ? "border-red-300" : ""}`} />
                    <FieldError field="phone" />
                  </div>
                  <div>
                    <Label>Department <span className="text-red-400">*</span></Label>
                    <Select value={form.department} onValueChange={v => setField("department", v)}>
                      <SelectTrigger className={`mt-1 bg-white ${errors.department ? "border-red-300" : ""}`}>
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
                  <Input value={form.company} onChange={e => setField("company", e.target.value)} placeholder="Acme Real Estate Partners" className="mt-1 bg-white" />
                </div>
                <div>
                  <Label>Message <span className="text-red-400">*</span></Label>
                  <Textarea value={form.message} onChange={e => setField("message", e.target.value)} placeholder="How can we help you?" rows={5} className={`mt-1 bg-white ${errors.message ? "border-red-300" : ""}`} />
                  <FieldError field="message" />
                </div>
                <Button type="submit" disabled={sending} className="w-full bg-[#1a2744] hover:bg-[#243b67] h-11">
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