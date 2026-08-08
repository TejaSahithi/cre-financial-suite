import React, { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  BarChart3, FileText, Calculator, Shield, ClipboardCheck, TrendingUp,
  Layers, Target, GitBranch, LineChart, FolderOpen, Users
} from "lucide-react";

const features = [
  { icon: BarChart3, title: "Portfolio Dashboard", desc: "Real-time NOI, occupancy, and variance alerts across all your properties." },
  { icon: FileText, title: "AI Lease Extraction", desc: "Upload lease PDFs and get structured data with confidence scoring." },
  { icon: Calculator, title: "CAM Engine", desc: "Pro-rata, gross-up, base year, caps, CPI escalation, and custom rules." },
  { icon: ClipboardCheck, title: "Budget Studio", desc: "Lease-driven, manual, or AI-assisted budgets with approval workflows." },
  { icon: TrendingUp, title: "Revenue Projection", desc: "Rent schedules with escalation modeling and YoY comparison." },
  { icon: Target, title: "Variance Engine", desc: "Budget vs actual analysis with automated alerts for expense spikes." },
  { icon: Layers, title: "Reconciliation", desc: "Import actuals, recompute CAM pools, generate tenant adjustments." },
  { icon: LineChart, title: "Advanced Analytics", desc: "Expense per SqFt benchmarks, NOI margins, and portfolio scoring." },
  { icon: Users, title: "Tenant Management", desc: "Complete tenant profiles with rent schedules and document management." },
  { icon: GitBranch, title: "Approval Workflows", desc: "Configurable workflows for budgets, leases, and reconciliations." },
  { icon: FolderOpen, title: "Document Management", desc: "Centralized repository for leases, invoices, and reports." },
  { icon: Shield, title: "Audit & Governance", desc: "Immutable audit logs with full compliance and SOC 2 support." },
];

export default function FeaturesSection() {
  const prefersReducedMotion = useReducedMotion();
  const [selectedFeatureIndex, setSelectedFeatureIndex] = useState(0);

  return (
    <section id="features" className="py-20 px-6 bg-[var(--bg-2)]">
      <div className="max-w-7xl mx-auto">
        <motion.div
          initial={prefersReducedMotion ? false : { opacity: 0, y: 20 }}
          whileInView={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-12"
        >
          <div className="inline-flex items-center gap-2 bg-[var(--surface)] border border-[var(--border-cre)] rounded-[8px] px-4 py-1.5 mb-4">
            <span className="text-[var(--accent)] text-xs font-bold tracking-wide uppercase">Platform Capabilities</span>
          </div>
          <h2 className="text-[28px] font-bold text-[var(--ink)] tracking-[-0.03em]">
            Everything you need for
            <br />
            <span className="text-[var(--accent)]">CRE financial management</span>
          </h2>
          <p className="mt-4 text-[var(--muted)] max-w-2xl mx-auto text-sm">
            Every module is purpose-built for commercial real estate, from lease ingestion to year-end reconciliation.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {features.map((f, i) => (
            <motion.button
              key={i}
              type="button"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 16 }}
              whileInView={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
              animate={selectedFeatureIndex === i && !prefersReducedMotion ? { scale: 1.025 } : { scale: 1 }}
              whileHover={prefersReducedMotion ? undefined : { y: -3 }}
              whileTap={prefersReducedMotion ? undefined : { scale: selectedFeatureIndex === i ? 1.005 : 0.99 }}
              viewport={{ once: true, margin: "-70px" }}
              transition={{ duration: 0.38, delay: i * 0.085, ease: "easeOut" }}
              onClick={() => setSelectedFeatureIndex(i)}
              className={`group relative text-left bg-[var(--surface)] rounded-[8px] border p-5 shadow-[var(--card-shadow)] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-2)] ${
                selectedFeatureIndex === i
                  ? "border-[color-mix(in_srgb,var(--accent)_72%,var(--border-cre))] bg-[color-mix(in_srgb,var(--accent)_8%,var(--surface))] shadow-[var(--shadow)]"
                  : "border-[var(--border-cre)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)] hover:shadow-[var(--card-hover-shadow)]"
              }`}
            >
              <div className={`w-10 h-10 rounded-[8px] border flex items-center justify-center mb-4 shadow-[var(--shadow-soft)] transition-all duration-200 ${
                selectedFeatureIndex === i
                  ? "border-[color-mix(in_srgb,var(--accent)_75%,var(--border-cre))] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[color-mix(in_srgb,var(--accent)_45%,var(--border-cre))] bg-[var(--surface-2)] text-[var(--accent)] group-hover:border-[color-mix(in_srgb,var(--accent)_65%,var(--border-cre))]"
              }`}>
                <f.icon className="w-5 h-5" />
              </div>
              <h3 className={`text-sm text-[var(--ink)] mb-1.5 ${selectedFeatureIndex === i ? "font-bold" : "font-semibold"}`}>{f.title}</h3>
              <p className="text-[var(--muted)] text-xs leading-relaxed">{f.desc}</p>
            </motion.button>
          ))}
        </div>
      </div>
    </section>
  );
}
