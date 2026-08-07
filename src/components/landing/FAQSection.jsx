import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const faqs = [
  { q: "How does the AI lease extraction work?", a: "Upload your lease PDF and our AI extracts key terms including rent, dates, escalation clauses, CAM rules, and more. Each field includes a confidence score, and you can override any extracted value with full audit logging." },
  { q: "How do I get access to the platform?", a: "Submit a request through our access form. Our team will review your application and schedule a brief consultation. Once approved, you'll receive secure login credentials via email. Reset your password on first login, then complete the guided onboarding wizard." },
  { q: "Can I import existing budgets and expenses?", a: "Yes. We support CSV and Excel bulk imports with intelligent column mapping, validation, and partial import capabilities." },
  { q: "How is data isolated between organizations?", a: "Every record is tagged with an organization ID. Row-level isolation ensures no cross-organization data access. SuperAdmin access requires explicit impersonation with full audit logging." },
  { q: "What CAM allocation methods are supported?", a: "Pro-rata by square footage, equal distribution, weighted allocation, and direct expense allocation. Each can be configured per lease with support for caps, base year deductions, CPI escalation, and gross-up clauses." },
  { q: "Is there a year-end reconciliation module?", a: "Yes. Import actual expenses, recalculate the CAM pool, reapply lease rules and caps, and generate tenant adjustment statements with 90-day deadline tracking." },
];

export default function FAQSection() {
  const [openIndex, setOpenIndex] = useState(null);

  return (
    <section id="faq" className="py-20 px-6 bg-[var(--surface)]">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-14">
          <div className="inline-flex items-center gap-2 bg-[var(--surface-2)] border border-[var(--border-cre)] rounded-[8px] px-4 py-1.5 mb-4">
            <span className="text-[var(--accent)] text-xs font-bold tracking-wide uppercase">FAQ</span>
          </div>
          <h2 className="text-[28px] font-bold text-[var(--ink)] tracking-[-0.03em]">Frequently Asked Questions</h2>
          <p className="mt-3 text-[var(--muted)] text-sm">Everything you need to know about the platform.</p>
        </div>
        <div className="space-y-3">
          {faqs.map((item, i) => (
            <div
              key={i}
              className={`rounded-[8px] border transition-all duration-200 overflow-hidden ${
                openIndex === i ? "border-[var(--accent)] bg-[var(--accent-soft)] shadow-[var(--shadow-soft)]" : "border-[var(--border-cre)] hover:border-[var(--border-strong)] bg-[var(--surface)]"
              }`}
            >
              <button
                onClick={() => setOpenIndex(openIndex === i ? null : i)}
                className="w-full flex items-center justify-between p-5 text-left"
              >
                <span className="font-semibold text-[var(--ink)] text-sm pr-4">{item.q}</span>
                <div className={`w-7 h-7 rounded-[8px] flex items-center justify-center flex-shrink-0 transition-colors ${openIndex === i ? "bg-[var(--surface)]" : "bg-[var(--surface-2)]"}`}>
                  <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${openIndex === i ? "rotate-180 text-[var(--accent)]" : "text-[var(--muted)]"}`} />
                </div>
              </button>
              <AnimatePresence>
                {openIndex === i && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}>
                    <p className="px-5 pb-5 text-[var(--muted)] leading-relaxed text-sm">{item.a}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
