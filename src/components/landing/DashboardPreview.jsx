import React from "react";
import { motion } from "framer-motion";
import { DollarSign, Building2, Calculator, FileText, ArrowUpRight, PieChart } from "lucide-react";

export default function DashboardPreview({ onRequestAccess }) {
  const metrics = [
    { label: "Total Properties", value: "25", icon: Building2, change: "+3 YTD", tone: "text-[var(--info)] bg-[var(--info-soft)]" },
    { label: "Total Leased SF", value: "4.2M", icon: FileText, change: "+3.1%", tone: "text-[var(--success)] bg-[var(--success-soft)]" },
    { label: "Annual Budget", value: "$35.4M", icon: DollarSign, change: "+5.8%", tone: "text-[var(--accent)] bg-[var(--accent-soft)]" },
    { label: "Active CAM Pool", value: "$4.7M", icon: Calculator, change: "+6.2%", tone: "text-[var(--warning)] bg-[var(--warning-soft)]" },
  ];

  return (
    <section id="platform-preview" className="py-20 px-6 bg-[var(--bg)]">
      <div className="max-w-7xl mx-auto">
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-12">
          <div className="inline-flex items-center gap-2 bg-[var(--surface)] border border-[var(--border-cre)] rounded-[8px] px-4 py-1.5 mb-4">
            <span className="text-[var(--accent)] text-xs font-bold tracking-wide uppercase">Live Platform Preview</span>
          </div>
          <h2 className="text-[28px] font-bold text-[var(--ink)] tracking-[-0.03em]">
            Your command center for <span className="text-[var(--accent)]">CRE finance</span>
          </h2>
          <p className="mt-4 text-[var(--muted)] max-w-2xl mx-auto text-sm">Real-time dashboards, intelligent workflows, and enterprise-grade reporting in one operational workspace.</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="relative"
        >
          {/* Dashboard content */}
          <div className="overflow-hidden rounded-[8px] border border-[var(--border-cre)] bg-[var(--surface)] shadow-[var(--shadow)]">
            <div className="flex items-center justify-between border-b border-[var(--border-cre)] bg-[var(--surface-2)] px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-[8px] border border-[color-mix(in_srgb,var(--accent)_50%,var(--border-cre))] bg-[var(--surface)] flex items-center justify-center text-[var(--accent)]">
                  <Building2 className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-bold text-[var(--ink)]">CRE Platform</p>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Budgeting & CAM</p>
                </div>
              </div>
              <div className="hidden rounded-[8px] border border-[var(--border-cre)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--muted)] md:block">
                app.creplatform.io/dashboard
              </div>
            </div>

          <div className="p-5 md:p-7">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-lg font-bold text-[var(--ink)]">Portfolio Overview</h3>
                <p className="text-xs text-[var(--muted)]">Last updated: Just now</p>
              </div>
              <div className="flex gap-2">
                <div className="px-3 py-1.5 bg-[var(--accent-soft)] text-[var(--accent)] text-xs font-semibold rounded-[8px]">Q1 2026</div>
                <div className="px-3 py-1.5 bg-[var(--surface-2)] text-[var(--muted)] text-xs font-medium rounded-[8px]">All Properties</div>
              </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              {metrics.map((item, i) => (
                <div key={i} className="bg-[var(--surface)] rounded-[8px] p-4 border border-[var(--border-cre)] shadow-[var(--card-shadow)]">
                  <div className="flex items-center justify-between mb-3">
                    <div className={`w-8 h-8 rounded-[8px] flex items-center justify-center ${item.tone}`}>
                      <item.icon className="w-4 h-4" />
                    </div>
                    <span className="text-xs text-[var(--success)] font-semibold bg-[var(--success-soft)] px-2 py-0.5 rounded-[8px]">{item.change}</span>
                  </div>
                  <div className="text-2xl font-bold text-[var(--ink)] tabular-nums">{item.value}</div>
                  <div className="text-xs text-[var(--muted)] mt-0.5">{item.label}</div>
                </div>
              ))}
            </div>

            {/* Chart + Actions */}
            <div className="grid md:grid-cols-3 gap-5">
              <div className="md:col-span-2 bg-[var(--surface-2)] rounded-[8px] p-5 border border-[var(--border-cre)]">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-sm font-bold text-[var(--ink)]">Budget vs Actuals - 2026</span>
                  <div className="flex gap-3 text-xs">
                    <div className="flex items-center gap-1.5 text-[var(--muted)]"><div className="w-2.5 h-2.5 rounded bg-[var(--accent)]" /> Budget</div>
                    <div className="flex items-center gap-1.5 text-[var(--muted)]"><div className="w-2.5 h-2.5 rounded bg-[var(--success)]" /> Actual</div>
                  </div>
                </div>
                <div className="flex items-end gap-2 h-32">
                  {[
                    { b: 65, a: 58 }, { b: 72, a: 68 }, { b: 60, a: 55 },
                    { b: 78, a: 82 }, { b: 70, a: 65 }, { b: 85, a: 78 },
                    { b: 68, a: 62 }, { b: 75, a: 70 }, { b: 80, a: 76 },
                    { b: 72, a: 68 }, { b: 65, a: 60 }, { b: 77, a: 72 },
                  ].map((m, i) => (
                    <div key={i} className="flex-1 flex gap-0.5 items-end h-full">
                      <div className="flex-1 bg-[var(--accent)] rounded-t opacity-80" style={{ height: `${m.b}%` }} />
                      <div className="flex-1 bg-[var(--success)] rounded-t opacity-80" style={{ height: `${m.a}%` }} />
                    </div>
                  ))}
                </div>
                <div className="flex justify-between mt-2 text-[10px] text-[var(--muted)]">
                  {["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map(m => (
                    <span key={m}>{m}</span>
                  ))}
                </div>
              </div>

              <div className="bg-[var(--surface-2)] rounded-[8px] p-5 border border-[var(--border-cre)]">
                <p className="text-sm font-bold text-[var(--ink)] mb-4">Quick Actions</p>
                {[
                  { label: "Upload Lease", icon: FileText },
                  { label: "Create Budget", icon: DollarSign },
                  { label: "Run CAM Calc", icon: Calculator },
                  { label: "View Reports", icon: PieChart },
                ].map((a, i) => (
                  <div key={i} className="flex items-center gap-3 py-2.5 border-b border-[var(--border-cre)] last:border-0 group cursor-pointer">
                    <div className="w-7 h-7 rounded-[8px] bg-[var(--surface)] flex items-center justify-center text-[var(--accent)] transition-colors">
                      <a.icon className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-[var(--muted)] text-xs font-medium flex-1">{a.label}</span>
                    <ArrowUpRight className="w-3 h-3 text-[var(--muted)] group-hover:text-[var(--accent)] transition-colors" />
                  </div>
                ))}
              </div>
            </div>
          </div>
          </div>

          {/* CTA overlay */}
          <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--surface)_84%,transparent)] rounded-[8px] flex items-end justify-center pb-8 opacity-0 hover:opacity-100 transition-opacity duration-500 cursor-pointer" onClick={onRequestAccess}>
            <div className="bg-[var(--accent)] text-white px-8 py-3 rounded-[8px] text-sm font-semibold shadow-[var(--shadow)]">
              Request Access to Explore
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
