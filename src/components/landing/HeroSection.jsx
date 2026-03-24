import React from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight, Sparkles, Play, Shield, Zap, Building2 } from "lucide-react";
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

export default function HeroSection({ onRequestAccess }) {
  const scrollToFeatures = () => {
    document.getElementById("features")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <section className="pt-16">
      {/* Hero */}
      <div className="relative overflow-hidden" style={{ background: "linear-gradient(135deg, #0f1a2e 0%, #1a2f52 50%, #0f1a2e 100%)" }}>
        {/* Background grid pattern */}
        <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")" }} />
        
        {/* Floating elements */}
        <div className="absolute top-20 left-10 w-72 h-72 bg-blue-500/10 rounded-full blur-3xl" />
        <div className="absolute bottom-20 right-10 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl" />
        
        <div className="max-w-6xl mx-auto px-6 py-28 md:py-36 relative z-10">
          <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7 }} className="text-center">
            <div className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-400/20 rounded-full px-5 py-2 mb-8">
              <Sparkles className="w-4 h-4 text-blue-400" />
              <span className="text-blue-300 text-sm font-medium">Trusted by 500+ commercial properties nationwide</span>
            </div>

            <h1 className="text-4xl md:text-5xl lg:text-[3.5rem] font-extrabold text-white leading-[1.1] tracking-tight">
              The Operating System for
              <br />
              <span className="bg-gradient-to-r from-blue-400 via-cyan-400 to-blue-400 bg-clip-text text-transparent">
                Commercial Real Estate Finance
              </span>
            </h1>

            <p className="mt-7 text-base md:text-lg text-white/50 max-w-2xl mx-auto leading-relaxed">
              Enterprise-grade budgeting, CAM automation, and lease intelligence — purpose-built for asset managers, property managers, and CRE finance teams managing complex portfolios.
            </p>

            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button
                onClick={onRequestAccess}
                className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white font-semibold px-8 h-12 text-sm shadow-lg shadow-blue-500/25 rounded-lg"
              >
                Request Demo <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
              <Button
                variant="outline"
                onClick={scrollToFeatures}
                className="border-white/20 text-white hover:bg-white/10 bg-transparent font-medium px-8 h-12 text-sm rounded-lg gap-2"
              >
                <Play className="w-4 h-4" /> See How It Works
              </Button>
            </div>

            {/* Trust signals */}
            <div className="mt-10 flex flex-wrap items-center justify-center gap-6 text-white/30 text-xs">
              <div className="flex items-center gap-1.5"><Shield className="w-3.5 h-3.5" /> SOC 2 Compliant</div>
              <div className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5" /> 99.9% Uptime SLA</div>
              <div className="flex items-center gap-1.5"><Building2 className="w-3.5 h-3.5" /> Enterprise Ready</div>
            </div>
          </motion.div>
        </div>
      </div>

      {/* Stats bar */}
      <div className="bg-white border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-6 py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
            {stats.map((s, i) => (
              <motion.div key={i} initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: 0.1 + i * 0.1 }}>
                <div className="text-3xl md:text-4xl font-extrabold text-[#1a2744]">{s.value}</div>
                <div className="text-sm text-gray-400 mt-1 font-medium">{s.label}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>

      {/* Trusted by */}
      <div className="bg-slate-50 py-6 border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-6 text-center">
          <p className="text-[10px] font-bold text-gray-400 tracking-[0.2em] uppercase mb-4">Trusted by Leading CRE Firms</p>
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-3">
            {trustedFirms.map((firm, i) => (
              <span key={i} className="text-gray-400 text-sm font-semibold tracking-wide">{firm}</span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}