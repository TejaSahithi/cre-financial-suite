import React from "react";
import { motion } from "framer-motion";
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
  return (
    <section id="features" className="py-20 px-6 bg-[var(--bg-2)]">
      <div className="max-w-7xl mx-auto">
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-12">
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
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.04 }}
              className="group relative bg-[var(--surface)] rounded-[8px] border border-[var(--border-cre)] p-5 shadow-[var(--card-shadow)] hover:shadow-[var(--card-hover-shadow)] transition-all duration-300 cursor-default"
            >
              <div className="w-10 h-10 rounded-[8px] border border-[color-mix(in_srgb,var(--accent)_45%,var(--border-cre))] bg-[var(--surface-2)] flex items-center justify-center mb-4 text-[var(--accent)] shadow-[var(--shadow-soft)]">
                <f.icon className="w-5 h-5" />
              </div>
              <h3 className="text-sm font-bold text-[var(--ink)] mb-1.5">{f.title}</h3>
              <p className="text-[var(--muted)] text-xs leading-relaxed">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
