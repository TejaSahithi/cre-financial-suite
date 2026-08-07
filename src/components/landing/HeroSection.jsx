import React from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight, Sparkles, Play, Shield, Zap, Building2, BarChart3, Calculator, FileCheck2 } from "lucide-react";
import { motion } from "framer-motion";

const stats = [
  { value: "500+", label: "Properties Managed" },
  { value: "$2.4B", label: "Assets Under Management" },
  { value: "98%", label: "CAM Accuracy Rate" },
  { value: "60%", label: "Time Saved on Reconciliation" },
];

const trustedFirms = [
  "Westfield Commercial", "Pinnacle Properties", "Summit Group",
  "CoreLink Capital", "Pacific Realty", "Landmark Partners",
];

export default function HeroSection({ onRequestAccess, onRequestDemo }) {
  const scrollToFeatures = () => {
    document.getElementById("features")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <section className="pt-16">
      {/* Hero */}
      <div className="relative overflow-hidden border-b border-[var(--border-cre)] bg-[var(--bg)]">
        <div className="absolute inset-x-0 top-0 h-px bg-[var(--border-cre)]" />

        <div className="max-w-6xl mx-auto px-6 py-20 md:py-24 relative z-10">
          <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7 }} className="text-center">
            <div className="inline-flex items-center gap-2 rounded-[8px] border border-[var(--border-cre)] bg-[var(--surface)] px-4 py-2 mb-7 shadow-[var(--shadow-soft)]">
              <Sparkles className="w-4 h-4 text-[var(--accent)]" />
              <span className="text-[var(--muted)] text-sm font-semibold">Trusted by 500+ commercial properties nationwide</span>
            </div>

            <h1 className="text-[28px] font-bold text-[var(--ink)] leading-[1.08] tracking-[-0.03em]">
              The Operating System for
              <br />
              <span className="text-[var(--accent)]">
                Commercial Real Estate Finance
              </span>
            </h1>

            <p className="mt-6 text-base text-[var(--muted)] max-w-2xl mx-auto leading-relaxed">
              Enterprise-grade budgeting, CAM automation, and lease intelligence purpose-built for asset managers, property managers, and CRE finance teams managing complex portfolios.
            </p>

            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
              <Button
                onClick={onRequestAccess}
                className="bg-[var(--accent)] hover:bg-[var(--accent)] text-white font-semibold px-7 h-11 text-sm shadow-[var(--shadow-soft)] rounded-[8px]"
              >
                Request Platform Access <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
              <Button
                variant="outline"
                onClick={onRequestDemo}
                className="border-[var(--border-cre)] text-[var(--ink)] hover:bg-[var(--surface-2)] bg-[var(--surface)] font-semibold px-7 h-11 text-sm rounded-[8px] gap-2"
              >
                <Play className="w-4 h-4" /> Request Video Demo
              </Button>
            </div>

            {/* Trust signals */}
            <div className="mt-8 flex flex-wrap items-center justify-center gap-5 text-[var(--muted)] text-xs">
              <div className="flex items-center gap-1.5"><Shield className="w-3.5 h-3.5 text-[var(--accent)]" /> SOC 2 Compliant</div>
              <div className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5 text-[var(--accent)]" /> 99.9% Uptime SLA</div>
              <div className="flex items-center gap-1.5"><Building2 className="w-3.5 h-3.5 text-[var(--accent)]" /> Enterprise Ready</div>
            </div>

            <div className="mt-10 grid gap-3 text-left md:grid-cols-3">
              {[
                { icon: BarChart3, label: "Portfolio variance", value: "$2.4B AUM", meta: "Budget and actuals in one view" },
                { icon: Calculator, label: "CAM automation", value: "98% accuracy", meta: "Recoveries tied to lease rules" },
                { icon: FileCheck2, label: "Lease intelligence", value: "500+ properties", meta: "Document-backed finance workflows" },
              ].map((item, i) => (
                <div key={i} className="rounded-[8px] border border-[var(--border-cre)] bg-[var(--surface)] p-4 shadow-[var(--shadow-soft)]">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-[color-mix(in_srgb,var(--accent)_50%,var(--border-cre))] bg-[var(--surface-2)] text-[var(--accent)]">
                      <item.icon className="h-4 w-4" />
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--muted)]">{item.label}</span>
                  </div>
                  <p className="text-[22px] font-bold tabular-nums text-[var(--ink)]">{item.value}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">{item.meta}</p>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>

      {/* Stats bar */}
      <div className="bg-[var(--surface)] border-b border-[var(--border-cre)]">
        <div className="max-w-6xl mx-auto px-6 py-9">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
            {stats.map((s, i) => (
              <motion.div key={i} initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: 0.1 + i * 0.1 }}>
                <div className="text-[28px] font-bold text-[var(--ink)] tabular-nums">{s.value}</div>
                <div className="text-xs text-[var(--muted)] mt-1 font-medium">{s.label}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>

      {/* Trusted by */}
      <div className="bg-[var(--surface-2)] py-6 border-b border-[var(--border-cre)]">
        <div className="max-w-6xl mx-auto px-6 text-center">
          <p className="text-[10px] font-bold text-[var(--muted)] tracking-[0.2em] uppercase mb-4">Trusted by Leading CRE Firms</p>
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-3">
            {trustedFirms.map((firm, i) => (
              <span key={i} className="text-[var(--muted)] text-sm font-semibold tracking-wide">{firm}</span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
