import React from "react";
import { motion } from "framer-motion";
import {
  BarChart3, FileText, Calculator, Shield, ClipboardCheck, TrendingUp,
  Layers, Target, GitBranch, LineChart, FolderOpen, Users
} from "lucide-react";

const features = [
  { icon: BarChart3, title: "Portfolio Dashboard", desc: "Real-time NOI, occupancy, and variance alerts across all your properties.", color: "from-blue-500 to-blue-600" },
  { icon: FileText, title: "AI Lease Extraction", desc: "Upload lease PDFs and get structured data with confidence scoring.", color: "from-violet-500 to-purple-600" },
  { icon: Calculator, title: "CAM Engine", desc: "Pro-rata, gross-up, base year, caps, CPI escalation, and custom rules.", color: "from-emerald-500 to-green-600" },
  { icon: ClipboardCheck, title: "Budget Studio", desc: "Lease-driven, manual, or AI-assisted budgets with approval workflows.", color: "from-amber-500 to-orange-600" },
  { icon: TrendingUp, title: "Revenue Projection", desc: "Rent schedules with escalation modeling and YoY comparison.", color: "from-cyan-500 to-blue-600" },
  { icon: Target, title: "Variance Engine", desc: "Budget vs actual analysis with automated alerts for expense spikes.", color: "from-rose-500 to-pink-600" },
  { icon: Layers, title: "Reconciliation", desc: "Import actuals, recompute CAM pools, generate tenant adjustments.", color: "from-indigo-500 to-blue-600" },
  { icon: LineChart, title: "Advanced Analytics", desc: "Expense per SqFt benchmarks, NOI margins, and portfolio scoring.", color: "from-teal-500 to-emerald-600" },
  { icon: Users, title: "Tenant Management", desc: "Complete tenant profiles with rent schedules and document management.", color: "from-blue-500 to-indigo-600" },
  { icon: GitBranch, title: "Approval Workflows", desc: "Configurable workflows for budgets, leases, and reconciliations.", color: "from-orange-500 to-red-600" },
  { icon: FolderOpen, title: "Document Management", desc: "Centralized repository for leases, invoices, and reports.", color: "from-purple-500 to-violet-600" },
  { icon: Shield, title: "Audit & Governance", desc: "Immutable audit logs with full compliance and SOC 2 support.", color: "from-slate-500 to-gray-600" },
];

export default function FeaturesSection() {
  return (
    <section id="features" className="py-24 px-6 bg-white">
      <div className="max-w-7xl mx-auto">
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-16">
          <div className="inline-flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-full px-4 py-1.5 mb-4">
            <span className="text-blue-600 text-xs font-bold tracking-wide uppercase">Platform Capabilities</span>
          </div>
          <h2 className="text-3xl md:text-4xl font-extrabold text-gray-900">
            Everything you need for
            <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-cyan-600">CRE financial management</span>
          </h2>
          <p className="mt-4 text-gray-500 max-w-2xl mx-auto text-base">
            Every module purpose-built for commercial real estate — from lease ingestion to year-end reconciliation.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {features.map((f, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.04 }}
              className="group relative bg-white rounded-xl border border-gray-200 p-6 hover:border-blue-200 hover:shadow-lg hover:shadow-blue-500/5 transition-all duration-300 cursor-default"
            >
              <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${f.color} flex items-center justify-center mb-4 shadow-sm group-hover:scale-110 transition-transform duration-300`}>
                <f.icon className="w-5 h-5 text-white" />
              </div>
              <h3 className="text-sm font-bold text-gray-900 mb-1.5">{f.title}</h3>
              <p className="text-gray-500 text-xs leading-relaxed">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}