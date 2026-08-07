import React from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight, Shield, Zap, Clock } from "lucide-react";
import { motion } from "framer-motion";

export default function CTASection({ onRequestAccess }) {
  return (
    <section className="py-20 px-6 relative overflow-hidden border-y border-[var(--border-cre)] bg-[var(--surface)]">
      <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="max-w-3xl mx-auto text-center relative z-10">
        <h2 className="text-[28px] font-bold text-[var(--ink)] leading-[1.08] tracking-[-0.03em]">
          Ready to modernize your
          <br />
          <span className="text-[var(--accent)]">
            CRE financial operations?
          </span>
        </h2>
        <p className="mt-5 text-[var(--muted)] max-w-xl mx-auto text-sm leading-relaxed">
          Replace spreadsheets and legacy systems with a modern, AI-powered platform built specifically for commercial real estate.
        </p>
        <div className="mt-8">
          <Button
            onClick={onRequestAccess}
            className="bg-[var(--accent)] hover:bg-[var(--accent)] text-white font-semibold px-9 h-11 text-sm shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow)] rounded-[8px] gap-2 transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100"
          >
            Request Access <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-6">
          {[
            { icon: Zap, text: "Setup in under 10 minutes" },
            { icon: Shield, text: "SOC 2 compliant & secure" },
            { icon: Clock, text: "14-day free trial included" },
          ].map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <item.icon className="w-4 h-4 text-[var(--accent)]" />
              <span className="text-[var(--muted)] text-sm">{item.text}</span>
            </div>
          ))}
        </div>
      </motion.div>
    </section>
  );
}
