import React from "react";
import { motion } from "framer-motion";
import { DollarSign, Building2, Calculator, FileText, ArrowUpRight, PieChart } from "lucide-react";

export default function DashboardPreview({ onRequestAccess }) {
  return (
    <section id="platform-preview" className="py-24 px-6 bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-7xl mx-auto">
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-14">
          <div className="inline-flex items-center gap-2 bg-indigo-50 border border-indigo-100 rounded-full px-4 py-1.5 mb-4">
            <span className="text-indigo-600 text-xs font-bold tracking-wide uppercase">Live Platform Preview</span>
          </div>
          <h2 className="text-3xl md:text-4xl font-extrabold text-gray-900">
            Your command center for <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-blue-600">CRE finance</span>
          </h2>
          <p className="mt-4 text-gray-500 max-w-2xl mx-auto">Real-time dashboards, intelligent workflows, and enterprise-grade reporting — all in one platform.</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="relative"
        >
          {/* Browser chrome */}
          <div className="bg-[#1a2744] rounded-t-2xl px-5 py-3.5 flex items-center gap-3">
            <div className="flex gap-2">
              <div className="w-3 h-3 rounded-full bg-red-400/80" />
              <div className="w-3 h-3 rounded-full bg-yellow-400/80" />
              <div className="w-3 h-3 rounded-full bg-green-400/80" />
            </div>
            <div className="flex-1 bg-white/10 rounded-lg h-7 flex items-center px-3">
              <span className="text-white/40 text-xs">app.creplatform.io/dashboard</span>
            </div>
          </div>

          {/* Dashboard content */}
          <div className="bg-white rounded-b-2xl border border-t-0 border-gray-200 shadow-2xl shadow-gray-200/50 p-6 md:p-8">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Portfolio Overview</h3>
                <p className="text-xs text-gray-400">Last updated: Just now</p>
              </div>
              <div className="flex gap-2">
                <div className="px-3 py-1.5 bg-blue-50 text-blue-700 text-xs font-semibold rounded-lg">Q1 2026</div>
                <div className="px-3 py-1.5 bg-gray-100 text-gray-600 text-xs font-medium rounded-lg">All Properties</div>
              </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              {[
                { label: "Total Properties", value: "25", icon: Building2, change: "+3 YTD", color: "blue" },
                { label: "Total Leased SF", value: "4.2M", icon: FileText, change: "+3.1%", color: "emerald" },
                { label: "Annual Budget", value: "$35.4M", icon: DollarSign, change: "+5.8%", color: "violet" },
                { label: "Active CAM Pool", value: "$4.7M", icon: Calculator, change: "+6.2%", color: "amber" },
              ].map((item, i) => (
                <div key={i} className="bg-gradient-to-br from-gray-50 to-white rounded-xl p-4 border border-gray-100 hover:border-gray-200 transition-colors">
                  <div className="flex items-center justify-between mb-3">
                    <div className={`w-8 h-8 rounded-lg bg-${item.color}-50 flex items-center justify-center`}>
                      <item.icon className={`w-4 h-4 text-${item.color}-600`} />
                    </div>
                    <span className="text-xs text-emerald-600 font-semibold bg-emerald-50 px-2 py-0.5 rounded-full">{item.change}</span>
                  </div>
                  <div className="text-2xl font-bold text-gray-900">{item.value}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{item.label}</div>
                </div>
              ))}
            </div>

            {/* Chart + Actions */}
            <div className="grid md:grid-cols-3 gap-5">
              <div className="md:col-span-2 bg-gray-50 rounded-xl p-6 border border-gray-100">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-sm font-bold text-gray-700">Budget vs Actuals — 2026</span>
                  <div className="flex gap-3 text-xs">
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded bg-blue-500" /> Budget</div>
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded bg-emerald-500" /> Actual</div>
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
                      <div className="flex-1 bg-blue-400 rounded-t opacity-80" style={{ height: `${m.b}%` }} />
                      <div className="flex-1 bg-emerald-400 rounded-t opacity-80" style={{ height: `${m.a}%` }} />
                    </div>
                  ))}
                </div>
                <div className="flex justify-between mt-2 text-[10px] text-gray-400">
                  {["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map(m => (
                    <span key={m}>{m}</span>
                  ))}
                </div>
              </div>

              <div className="bg-gray-50 rounded-xl p-5 border border-gray-100">
                <p className="text-sm font-bold text-gray-700 mb-4">Quick Actions</p>
                {[
                  { label: "Upload Lease", icon: FileText },
                  { label: "Create Budget", icon: DollarSign },
                  { label: "Run CAM Calc", icon: Calculator },
                  { label: "View Reports", icon: PieChart },
                ].map((a, i) => (
                  <div key={i} className="flex items-center gap-3 py-2.5 border-b border-gray-100 last:border-0 group cursor-pointer">
                    <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center group-hover:bg-blue-100 transition-colors">
                      <a.icon className="w-3.5 h-3.5 text-blue-600" />
                    </div>
                    <span className="text-gray-600 text-xs font-medium flex-1">{a.label}</span>
                    <ArrowUpRight className="w-3 h-3 text-gray-300 group-hover:text-blue-500 transition-colors" />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* CTA overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-white via-transparent to-transparent rounded-2xl flex items-end justify-center pb-8 opacity-0 hover:opacity-100 transition-opacity duration-500 cursor-pointer" onClick={onRequestAccess}>
            <div className="bg-[#1a2744] text-white px-8 py-3 rounded-full text-sm font-semibold shadow-xl">
              Request Access to Explore →
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}