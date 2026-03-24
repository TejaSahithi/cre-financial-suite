import React from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight, Shield, Zap, Clock } from "lucide-react";
import { motion } from "framer-motion";

export default function CTASection({ onRequestAccess }) {
  return (
    <section className="py-24 px-6 relative overflow-hidden" style={{ background: "linear-gradient(135deg, #0f1a2e 0%, #1a2f52 50%, #0f1a2e 100%)" }}>
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl" />
      <div className="absolute bottom-0 right-1/4 w-80 h-80 bg-indigo-500/10 rounded-full blur-3xl" />

      <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="max-w-3xl mx-auto text-center relative z-10">
        <h2 className="text-3xl md:text-4xl font-extrabold text-white leading-tight">
          Ready to modernize your
          <br />
          <span className="bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
            CRE financial operations?
          </span>
        </h2>
        <p className="mt-6 text-white/40 max-w-xl mx-auto text-base leading-relaxed">
          Replace spreadsheets and legacy systems with a modern, AI-powered platform built specifically for commercial real estate.
        </p>
        <div className="mt-9">
          <Button
            onClick={onRequestAccess}
            className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white font-semibold px-10 h-12 text-sm shadow-lg shadow-blue-500/25 rounded-lg gap-2"
          >
            Request Access <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-8">
          {[
            { icon: Zap, text: "Setup in under 10 minutes" },
            { icon: Shield, text: "SOC 2 compliant & secure" },
            { icon: Clock, text: "14-day free trial included" },
          ].map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <item.icon className="w-4 h-4 text-blue-400/50" />
              <span className="text-white/40 text-sm">{item.text}</span>
            </div>
          ))}
        </div>
      </motion.div>
    </section>
  );
}